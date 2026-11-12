//! Private reservations backed by local objects or optional S3. File capabilities
//! are bound to a live session and current channel ACLs at every HTTP request.
use crate::{AppState, auth::Auth, db, error::ApiResult};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use futures_util::StreamExt;
use harmony_domain::Error;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
fn unavailable() -> crate::error::ApiError {
    Error::Unavailable("Armazenamento indisponível".into()).into()
}
#[derive(Serialize, Deserialize)]
struct FileClaims {
    #[serde(flatten)]
    session: crate::auth::Claims,
    file_id: Uuid,
    file_kind: String,
    operation: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileQuery {
    token: String,
}

fn file_url(
    s: &AppState,
    a: &Auth,
    id: Uuid,
    kind: &str,
    operation: &str,
    ttl: usize,
) -> ApiResult<String> {
    let mut session = a.claims.clone();
    session.aud = "harmony-files".into();
    session.exp = session.exp.min(Utc::now().timestamp() as usize + ttl);
    let claims = FileClaims {
        session,
        file_id: id,
        file_kind: kind.into(),
        operation: operation.into(),
    };
    let token = jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(s.config.jwt_secret.as_bytes()),
    )
    .map_err(|_| Error::Internal)?;
    Ok(format!(
        "{}/api/files/{id}/{kind}?token={token}",
        s.config.public_api_url.trim_end_matches('/')
    ))
}
async fn file_session(
    s: &AppState,
    query: &FileQuery,
    id: Uuid,
    kind: &str,
    operation: &str,
) -> ApiResult<crate::auth::Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["harmony"]);
    validation.set_audience(&["harmony-files"]);
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<FileClaims>(
        &query.token,
        &DecodingKey::from_secret(s.config.jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| Error::Unauthorized)?
    .claims;
    if claims.file_id != id || claims.file_kind != kind || claims.operation != operation {
        return Err(Error::Forbidden.into());
    }
    crate::auth::recheck(s, &claims.session).await?;
    Ok(claims.session)
}

pub async fn file_put(
    State(s): State<AppState>,
    Path((id, kind)): Path<(Uuid, String)>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<StatusCode> {
    if kind != "pending" {
        return Err(Error::NotFound.into());
    }
    let claims = file_session(&s, &query, id, &kind, "write").await?;
    s.limit(&format!("file-put:{}", claims.sub), 60, 3600)?;
    // Reject immediately when all slots are occupied; queued request bodies must
    // not accumulate in memory or create unbounded temporary files.
    let _permit = s
        .file_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::RateLimited)?;
    let row = sqlx::query("SELECT channel_id,size,content_type,status FROM uploads WHERE id=$1 AND user_id=$2 AND julianday(expires_at)>julianday('now')").bind(id).bind(claims.sub).fetch_one(&s.pool).await?;
    let cid: Uuid = row.get("channel_id");
    db::require_permission(
        &s.pool,
        cid,
        claims.sub,
        harmony_domain::permissions::ATTACH,
    )
    .await?;
    if row.get::<String, _>("status") != "pending" {
        return Err(Error::Conflict("Upload já finalizado".into()).into());
    }
    let expected: i64 = row.get("size");
    let content_type: String = row.get("content_type");
    if expected <= 0
        || expected > s.config.max_upload
        || headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some(content_type.as_str())
        || headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            != Some(expected)
    {
        return Err(Error::Invalid("Tipo ou tamanho difere da reserva".into()).into());
    }
    let mut staged = s
        .store
        .stage(expected as u64)
        .await
        .map_err(|_| unavailable())?;
    let transfer = async {
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::Invalid("Upload interrompido".into()))?;
            staged.write(&chunk).await.map_err(|_| {
                Error::Invalid("Upload excedeu a reserva ou não pôde ser gravado".into())
            })?;
        }
        if staged.size() != expected as u64 {
            return Err(Error::Invalid("Upload incompleto".into()));
        }
        Ok::<(), Error>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), transfer)
        .await
        .map_err(|_| Error::Invalid("Tempo de upload esgotado".into()))??;
    // The same write transaction excludes complete(), cleanup and another PUT.
    // A body received before completion can never overwrite the published file.
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    crate::auth::recheck(&s, &claims).await?;
    db::tx_require_permission(
        &mut tx,
        cid,
        claims.sub,
        harmony_domain::permissions::ATTACH,
    )
    .await?;
    let key: Option<String> = sqlx::query_scalar("SELECT object_key FROM uploads WHERE id=$1 AND user_id=$2 AND status='pending' AND julianday(expires_at)>julianday('now')").bind(id).bind(claims.sub).fetch_optional(&mut *tx).await?;
    let key = key.ok_or_else(|| Error::Conflict("Reserva já finalizada ou expirada".into()))?;
    s.store
        .publish(staged, &key, &content_type)
        .await
        .map_err(|_| unavailable())?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

fn selected_range(header: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    if size == 0 {
        return Err(());
    }
    let Some(value) = header else {
        return Ok((0, size - 1, false));
    };
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let count = end.parse::<u64>().map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        return Ok((size.saturating_sub(count), size - 1, true));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok((start, end, true))
}

pub async fn file_get(
    State(s): State<AppState>,
    Path((id, kind)): Path<(Uuid, String)>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    if !matches!(kind.as_str(), "original" | "thumbnail" | "faststart") {
        return Err(Error::NotFound.into());
    }
    let claims = file_session(&s, &query, id, &kind, "read").await?;
    authorize_media(&s, claims.sub, id).await?;
    let (key, size, content_type, disposition) = if kind == "original" {
        let row = sqlx::query("SELECT object_key,size FROM uploads WHERE id=$1 AND status='ready'")
            .bind(id)
            .fetch_one(&s.pool)
            .await?;
        (
            row.get::<String, _>("object_key"),
            row.get::<i64, _>("size"),
            "application/octet-stream".to_string(),
            "attachment",
        )
    } else {
        let row = sqlx::query("SELECT d.object_key,d.size,d.content_type FROM media_derivatives d JOIN media_jobs j ON j.attempt_id=d.attempt_id WHERE j.upload_id=$1 AND j.status='ready' AND d.ready AND d.kind=$2").bind(id).bind(&kind).fetch_one(&s.pool).await?;
        (
            row.get::<String, _>("object_key"),
            row.get::<i64, _>("size"),
            row.get::<String, _>("content_type"),
            "inline",
        )
    };
    if size <= 0 {
        return Err(unavailable());
    }
    let size = size as u64;
    let range = headers
        .get(header::RANGE)
        .map(|v| v.to_str())
        .transpose()
        .map_err(|_| Error::Invalid("Range inválido".into()))?;
    let (start, end, partial) = match selected_range(range, size) {
        Ok(range) => range,
        Err(_) => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{size}"))],
            )
                .into_response());
        }
    };
    if s.store.size(&key).await.map_err(|_| unavailable())? != size {
        return Err(unavailable());
    }
    let stream = s
        .store
        .stream_range(&key, start, end)
        .await
        .map_err(|_| unavailable())?;
    // Recheck after metadata IO as well. Subsequent requests reauthorize; bytes
    // from an already-started download cannot be recalled after revocation.
    crate::auth::recheck(&s, &claims).await?;
    authorize_media(&s, claims.sub, id).await?;
    let mut response = axum::http::Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(Body::from_stream(stream))
        .map_err(|_| Error::Internal.into())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Upload {
    name: String,
    size: i64,
    content_type: String,
}
pub async fn reserve(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Json(b): Json<Upload>,
) -> ApiResult<Json<Value>> {
    db::require_permission(&s.pool, cid, a.user.id, harmony_domain::permissions::ATTACH).await?;
    s.limit(&format!("upload:{}", a.user.id), 30, 3600)?;
    if b.size <= 0 || b.size > s.config.max_upload {
        return Err(Error::Invalid("Tamanho de anexo fora do limite".into()).into());
    }
    if b.name.is_empty()
        || b.name.chars().count() > 180
        || b.name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(Error::Invalid("Nome de arquivo inválido".into()).into());
    }
    let allowed = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "video/mp4",
        "video/webm",
        "audio/ogg",
        "audio/mpeg",
        "audio/wav",
        "audio/mp4",
        "application/pdf",
        "application/zip",
        "text/plain",
        "application/octet-stream",
    ];
    if !allowed.contains(&b.content_type.as_str()) {
        return Err(Error::Invalid(
            "Tipo de arquivo não permitido; envie como arquivo binário".into(),
        )
        .into());
    }
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    db::tx_require_permission(&mut tx, cid, a.user.id, harmony_domain::permissions::ATTACH).await?;
    crate::auth::recheck(&s, &a.claims).await?;
    let used: i64 = sqlx::query_scalar("SELECT used_bytes FROM harmony_storage_usage")
        .fetch_one(&mut *tx)
        .await?;
    if b.size > s.config.storage_quota.saturating_sub(used) {
        return Err(Error::Conflict("Cota de armazenamento esgotada".into()).into());
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM uploads WHERE user_id=$1 AND status='pending' AND julianday(expires_at)>julianday('now')",
    )
    .bind(a.user.id)
    .fetch_one(&mut *tx)
    .await?;
    if pending >= 5 {
        return Err(
            Error::Conflict("Finalize os uploads pendentes antes de enviar outros".into()).into(),
        );
    }
    let id = Uuid::now_v7();
    let key = format!("pending/{}/{id}", a.user.id);
    sqlx::query("INSERT INTO uploads(id,channel_id,user_id,object_key,name,size,content_type,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'))").bind(id).bind(cid).bind(a.user.id).bind(&key).bind(&b.name).bind(b.size).bind(&b.content_type).execute(&mut *tx).await?;
    let url = file_url(&s, &a, id, "pending", "write", 300)?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"url":url,"headers":{"Content-Type":b.content_type},"expires_in":300}),
    ))
}
pub async fn complete(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    crate::auth::recheck(&s, &a.claims).await?;
    let cid: Uuid = sqlx::query_scalar("SELECT channel_id FROM uploads WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(a.user.id)
        .fetch_one(&mut *tx)
        .await?;
    db::tx_require_permission(&mut tx, cid, a.user.id, harmony_domain::permissions::ATTACH).await?;
    let row = sqlx::query("SELECT * FROM uploads WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(a.user.id)
        .fetch_one(&mut *tx)
        .await?;
    let status: String = row.get("status");
    let name: String = row.get("name");
    let expected: i64 = row.get("size");
    let content_type: String = row.get("content_type");
    if status == "ready" {
        return Ok(Json(
            json!({"id":id,"name":name,"size":expected,"content_type":content_type}),
        ));
    }
    if status != "pending"
        || row.get::<chrono::DateTime<chrono::Utc>, _>("expires_at") <= chrono::Utc::now()
    {
        return Err(Error::Invalid("Reserva expirada ou rejeitada".into()).into());
    }
    let old_key: String = row.get("object_key");
    let received = s.store.size(&old_key).await.map_err(|_| unavailable())?;
    if received != expected as u64 {
        return Err(Error::Invalid("Tamanho recebido difere da reserva".into()).into());
    }
    let final_key = format!("objects/{id}/original");
    s.store
        .copy(&old_key, &final_key, expected as u64, &content_type)
        .await
        .map_err(|_| unavailable())?;
    let bytes = s
        .store
        .read_range(
            &final_key,
            0,
            (expected as u64).saturating_sub(1).min(8191),
            8192,
        )
        .await
        .map_err(|_| unavailable())?;
    let valid = s.store.size(&final_key).await.map_err(|_| unavailable())? == expected as u64
        && validate_type(&content_type, &bytes);
    if !valid {
        let _ = s.store.delete(&final_key).await;
        sqlx::query("UPDATE uploads SET status='rejected' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let _ = s.store.delete(&old_key).await;
        return Err(
            Error::Invalid("Conteúdo não corresponde ao tipo/tamanho declarado".into()).into(),
        );
    }
    if row.get::<chrono::DateTime<chrono::Utc>, _>("expires_at") <= chrono::Utc::now() {
        let _ = s.store.delete(&final_key).await;
        return Err(
            Error::Invalid("Reserva expirou durante a validação; envie novamente".into()).into(),
        );
    }
    sqlx::query("UPDATE uploads SET status='ready',object_key=$1 WHERE id=$2")
        .bind(&final_key)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO media_jobs(upload_id,status) VALUES($1,CASE WHEN $2 LIKE 'image/%' OR $2 LIKE 'video/%' OR $2 LIKE 'audio/%' THEN 'queued' ELSE 'unsupported' END) ON CONFLICT DO NOTHING")
        .bind(id).bind(&content_type).execute(&mut *tx).await?;
    tx.commit().await?;
    let _ = s.store.delete(&old_key).await;
    Ok(Json(
        json!({"id":id,"name":name,"size":expected,"content_type":content_type}),
    ))
}
fn validate_type(expected: &str, bytes: &[u8]) -> bool {
    if expected == "application/octet-stream" {
        return true;
    }
    if expected == "text/plain" {
        return std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0);
    }
    let actual = infer::get(bytes).map(|t| t.mime_type());
    match (expected, actual) {
        (a, Some(b)) if a == b => true,
        ("audio/wav", Some("audio/x-wav")) => true,
        ("video/webm", Some("video/x-matroska")) => true,
        ("audio/ogg", Some("application/ogg")) => true,
        _ => false,
    }
}
pub async fn download(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row=sqlx::query("SELECT u.*,m.deleted FROM uploads u LEFT JOIN messages m ON m.id=u.message_id WHERE u.id=$1 AND u.status='ready'").bind(id).fetch_one(&s.pool).await?;
    db::channel_access(&s.pool, row.get("channel_id"), a.user.id).await?;
    let message_id: Option<Uuid> = row.get("message_id");
    if (message_id.is_none() && row.get::<Uuid, _>("user_id") != a.user.id)
        || row.get::<Option<bool>, _>("deleted").unwrap_or(false)
    {
        return Err(Error::Forbidden.into());
    }
    let url = file_url(&s, &a, id, "original", "read", 60)?;
    Ok(Json(json!({"url":url,"expires_in":60})))
}
pub async fn cleanup(s: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        tick.tick().await;
        let _ = s.store.cleanup_staging().await;
        for _ in 0..100 {
            let Ok(mut tx) = s.pool.begin_with("BEGIN IMMEDIATE").await else {
                break;
            };
            let row=sqlx::query("SELECT id,user_id,status FROM uploads WHERE julianday(expires_at)<julianday('now') AND NOT temporary_cleaned ORDER BY expires_at LIMIT 1").fetch_optional(&mut *tx).await;
            let Ok(Some(row)) = row else { break };
            let id: Uuid = row.get("id");
            let uid: Uuid = row.get("user_id");
            let Ok(()) = s.store.delete(&format!("pending/{uid}/{id}")).await else {
                break;
            };
            let status: String = row.get("status");
            if status != "ready" {
                let Ok(()) = s.store.delete(&format!("objects/{id}/original")).await else {
                    break;
                };
            }
            if sqlx::query("UPDATE uploads SET temporary_cleaned=true,status=CASE WHEN status='pending' THEN 'rejected' ELSE status END WHERE id=$1")
                .bind(id).execute(&mut *tx).await.is_err() {break}
            if tx.commit().await.is_err() {
                break;
            }
        }
        let _ = sqlx::query(
            "DELETE FROM used_refresh_tokens WHERE julianday(expires_at)<julianday('now')",
        )
        .execute(&s.pool)
        .await;
    }
}

// All derivative access shares the authorization of the original, including
// unattached owner-only uploads and message tombstones. Signed URLs last 60s.
async fn authorize_media(s: &AppState, user: Uuid, id: Uuid) -> ApiResult<()> {
    let row = sqlx::query("SELECT u.channel_id,u.user_id,u.message_id,m.deleted FROM uploads u LEFT JOIN messages m ON m.id=u.message_id WHERE u.id=$1 AND u.status='ready'")
        .bind(id).fetch_one(&s.pool).await?;
    db::channel_access(&s.pool, row.get("channel_id"), user).await?;
    if (row.get::<Option<Uuid>, _>("message_id").is_none() && row.get::<Uuid, _>("user_id") != user)
        || row.get::<Option<bool>, _>("deleted").unwrap_or(false)
    {
        return Err(Error::Forbidden.into());
    }
    Ok(())
}
pub async fn media_status(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize_media(&s, a.user.id, id).await?;
    let row = sqlx::query("SELECT status,metadata,error_code FROM media_jobs WHERE upload_id=$1")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    let rows = sqlx::query("SELECT d.kind,d.content_type,d.size,d.width,d.height FROM media_derivatives d JOIN media_jobs j ON j.attempt_id=d.attempt_id WHERE j.upload_id=$1 AND j.status='ready' AND d.ready ORDER BY d.kind").bind(id).fetch_all(&s.pool).await?;
    let derivatives: Vec<Value> = rows.into_iter().map(|r| {
        let mut value = json!({"kind":r.get::<String,_>("kind"),"content_type":r.get::<String,_>("content_type"),"size":r.get::<i64,_>("size")});
        if let Some(width) = r.get::<Option<i32>,_>("width") { value["width"] = json!(width); }
        if let Some(height) = r.get::<Option<i32>,_>("height") { value["height"] = json!(height); }
        value
    }).collect();
    Ok(Json(
        json!({"status":row.get::<String,_>("status"),"metadata":row.get::<Option<Value>,_>("metadata"),"error_code":row.get::<Option<String>,_>("error_code"),"derivatives":derivatives}),
    ))
}
pub async fn derivative(
    State(s): State<AppState>,
    a: Auth,
    Path((id, kind)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    authorize_media(&s, a.user.id, id).await?;
    if !matches!(kind.as_str(), "thumbnail" | "faststart") {
        return Err(Error::NotFound.into());
    }
    let row = sqlx::query("SELECT d.object_key,d.content_type,d.size FROM media_derivatives d JOIN media_jobs j ON j.attempt_id=d.attempt_id WHERE j.upload_id=$1 AND j.status='ready' AND d.ready AND d.kind=$2").bind(id).bind(&kind).fetch_one(&s.pool).await?;
    let content_type: String = row.get("content_type");
    let url = file_url(&s, &a, id, &kind, "read", 60)?;
    Ok(Json(
        json!({"url":url,"expires_in":60,"content_type":content_type,"size":row.get::<i64,_>("size")}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_html_disguised_as_image() {
        assert!(!validate_type("image/png", b"<html>bad</html>"));
        assert!(!validate_type("text/plain", b"a\0b"));
        assert!(validate_type("image/png", b"\x89PNG\r\n\x1a\nanything"));
    }
    #[test]
    fn media_ranges_are_bounded_and_support_seeking() {
        assert_eq!(selected_range(None, 10), Ok((0, 9, false)));
        assert_eq!(selected_range(Some("bytes=2-4"), 10), Ok((2, 4, true)));
        assert_eq!(selected_range(Some("bytes=7-"), 10), Ok((7, 9, true)));
        assert_eq!(selected_range(Some("bytes=-3"), 10), Ok((7, 9, true)));
        assert_eq!(selected_range(Some("bytes=2-999"), 10), Ok((2, 9, true)));
        for value in [
            "bytes=10-",
            "bytes=4-2",
            "bytes=-0",
            "bytes=0-1,3-4",
            "bytes=invalid",
            "items=1-2",
        ] {
            assert!(selected_range(Some(value), 10).is_err(), "{value}");
        }
    }
}
