//! Private S3 reservations. Finalization copies to a server-only key before validating,
//! so a still-valid upload URL cannot modify a published attachment.
use crate::{AppState, auth::Auth, db, error::ApiResult};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue},
};
use harmony_domain::Error;
use s3::{Bucket, Region, creds::Credentials};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;
fn unavailable() -> crate::error::ApiError {
    Error::Unavailable("Armazenamento indisponível".into()).into()
}
fn bucket(s: &AppState, public: bool) -> ApiResult<Box<Bucket>> {
    let endpoint = if public {
        s.config
            .s3_public_endpoint
            .as_ref()
            .or(s.config.s3_endpoint.as_ref())
    } else {
        s.config.s3_endpoint.as_ref()
    }
    .ok_or_else(|| Error::Unavailable("Anexos não configurados nesta instância".into()))?;
    let access = s.config.s3_access.as_deref().ok_or_else(unavailable)?;
    let secret = s.config.s3_secret.as_deref().ok_or_else(unavailable)?;
    let credentials = Credentials::new(Some(access), Some(secret), None, None, None)
        .map_err(|_| unavailable())?;
    let mut b = Bucket::new(
        &s.config.s3_bucket,
        Region::Custom {
            region: s.config.s3_region.clone(),
            endpoint: endpoint.clone(),
        },
        credentials,
    )
    .map_err(|_| unavailable())?
    .with_path_style();
    b.set_request_timeout(Some(std::time::Duration::from_secs(20)));
    Ok(b)
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
    let store = bucket(&s, true)?;
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
    let mut tx = s.pool.begin().await?;
    db::tx_require_permission(&mut tx, cid, a.user.id, harmony_domain::permissions::ATTACH).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(674622902)")
        .execute(&mut *tx)
        .await?;
    let used: i64 = sqlx::query_scalar("SELECT harmony_storage_used()")
        .fetch_one(&mut *tx)
        .await?;
    if b.size > s.config.storage_quota.saturating_sub(used) {
        return Err(Error::Conflict("Cota de armazenamento esgotada".into()).into());
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM uploads WHERE user_id=$1 AND status='pending' AND expires_at>now()",
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
    sqlx::query("INSERT INTO uploads(id,channel_id,user_id,object_key,name,size,content_type,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',now()+interval '10 minutes')").bind(id).bind(cid).bind(a.user.id).bind(&key).bind(&b.name).bind(b.size).bind(&b.content_type).execute(&mut *tx).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_str(&b.content_type)
            .map_err(|_| Error::Invalid("Tipo inválido".into()))?,
    );
    headers.insert(
        "content-length",
        HeaderValue::from_str(&b.size.to_string()).map_err(|_| Error::Internal)?,
    );
    let url = store
        .presign_put(&key, 300, Some(headers), None)
        .await
        .map_err(|_| unavailable())?;
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
    let store = bucket(&s, false)?;
    let mut tx = s.pool.begin().await?;
    let cid: Uuid = sqlx::query_scalar("SELECT channel_id FROM uploads WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(a.user.id)
        .fetch_one(&mut *tx)
        .await?;
    db::tx_require_permission(&mut tx, cid, a.user.id, harmony_domain::permissions::ATTACH).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(674622902)")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT * FROM uploads WHERE id=$1 AND user_id=$2 FOR UPDATE")
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
    let (head, code) = store
        .head_object(&old_key)
        .await
        .map_err(|_| unavailable())?;
    if code != 200 || head.content_length != Some(expected) {
        return Err(Error::Invalid("Tamanho recebido difere da reserva".into()).into());
    }
    let final_key = format!("objects/{id}/original");
    let copied = store
        .copy_object_internal(&old_key, &final_key)
        .await
        .map_err(|_| unavailable())?;
    if copied != 200 {
        return Err(unavailable());
    }
    let (head, code) = store
        .head_object(&final_key)
        .await
        .map_err(|_| unavailable())?;
    let bytes = store
        .get_object_range(
            &final_key,
            0,
            Some((expected as u64).saturating_sub(1).min(8191)),
        )
        .await
        .map_err(|_| unavailable())?;
    let valid = code == 200
        && head.content_length == Some(expected)
        && validate_type(&content_type, bytes.as_slice());
    if !valid {
        let _ = store.delete_object(&final_key).await;
        sqlx::query("UPDATE uploads SET status='rejected' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let _ = store.delete_object(&old_key).await;
        return Err(
            Error::Invalid("Conteúdo não corresponde ao tipo/tamanho declarado".into()).into(),
        );
    }
    if row.get::<chrono::DateTime<chrono::Utc>, _>("expires_at") <= chrono::Utc::now() {
        let _ = store.delete_object(&final_key).await;
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
    let _ = store.delete_object(&old_key).await;
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
    let mut query = HashMap::new();
    query.insert("response-content-disposition".into(), "attachment".into());
    query.insert(
        "response-content-type".into(),
        "application/octet-stream".into(),
    );
    let url = bucket(&s, true)?
        .presign_get(row.get::<String, _>("object_key"), 60, Some(query))
        .await
        .map_err(|_| unavailable())?;
    Ok(Json(json!({"url":url,"expires_in":60})))
}
pub async fn cleanup(s: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        tick.tick().await;
        let Ok(store) = bucket(&s, false) else {
            continue;
        };
        for _ in 0..100 {
            let Ok(mut tx) = s.pool.begin().await else {
                break;
            };
            let row=sqlx::query("SELECT id,user_id,status FROM uploads WHERE expires_at<clock_timestamp() AND NOT temporary_cleaned ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(&mut *tx).await;
            let Ok(Some(row)) = row else { break };
            let id: Uuid = row.get("id");
            let uid: Uuid = row.get("user_id");
            let Ok(result) = store.delete_object(format!("pending/{uid}/{id}")).await else {
                break;
            };
            if !matches!(result.status_code(), 200 | 204 | 404) {
                break;
            }
            let status: String = row.get("status");
            if status != "ready" {
                let Ok(result) = store.delete_object(format!("objects/{id}/original")).await else {
                    break;
                };
                if !matches!(result.status_code(), 200 | 204 | 404) {
                    break;
                }
            }
            if sqlx::query("UPDATE uploads SET temporary_cleaned=true,status=CASE WHEN status='pending' THEN 'rejected' ELSE status END WHERE id=$1")
                .bind(id).execute(&mut *tx).await.is_err() {break}
            if tx.commit().await.is_err() {
                break;
            }
        }
        let _ = sqlx::query("DELETE FROM used_refresh_tokens WHERE expires_at<now()")
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
    let derivatives:Vec<Value> = sqlx::query_scalar("SELECT jsonb_strip_nulls(jsonb_build_object('kind',d.kind,'content_type',d.content_type,'size',d.size,'width',d.width,'height',d.height)) FROM media_derivatives d JOIN media_jobs j ON j.attempt_id=d.attempt_id WHERE j.upload_id=$1 AND j.status='ready' AND d.ready ORDER BY d.kind").bind(id).fetch_all(&s.pool).await?;
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
    let row = sqlx::query("SELECT d.object_key,d.content_type,d.size FROM media_derivatives d JOIN media_jobs j ON j.attempt_id=d.attempt_id WHERE j.upload_id=$1 AND j.status='ready' AND d.ready AND d.kind=$2").bind(id).bind(kind).fetch_one(&s.pool).await?;
    let content_type: String = row.get("content_type");
    let mut query = HashMap::new();
    query.insert("response-content-type".into(), content_type.clone());
    query.insert("response-content-disposition".into(), "inline".into());
    let url = bucket(&s, true)?
        .presign_get(row.get::<String, _>("object_key"), 60, Some(query))
        .await
        .map_err(|_| unavailable())?;
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
}
