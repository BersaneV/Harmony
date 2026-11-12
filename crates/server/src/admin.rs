use crate::{
    AppState,
    auth::{Auth, hash, password_valid, random_token, require_admin},
    community::{Invite, issue_invite},
    db,
    error::ApiResult,
};
use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{Duration, Utc};
use harmony_domain::Error;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub async fn users(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    let rows = sqlx::query("SELECT * FROM public_users ORDER BY created_at,id LIMIT 1000")
        .fetch_all(&s.pool)
        .await?;
    let items = rows.iter().map(db::user_row).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disable {
    disabled: bool,
}
pub async fn update_user(
    State(s): State<AppState>,
    a: Auth,
    Path(uid): Path<Uuid>,
    Json(b): Json<Disable>,
) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    if uid == a.user.id {
        return Err(Error::Invalid("Não é possível bloquear a própria conta".into()).into());
    }
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT is_admin FROM users WHERE id=$1")
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
    if row.get::<bool, _>("is_admin") {
        return Err(Error::Forbidden.into());
    }
    sqlx::query("UPDATE users SET disabled=$1,auth_version=auth_version+1 WHERE id=$2")
        .bind(b.disabled)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=$1",
    )
    .bind(uid)
    .execute(&mut *tx)
    .await?;
    db::audit(
        &mut tx,
        a.user.id,
        if b.disabled {
            "user.disable"
        } else {
            "user.enable"
        },
        Some(uid),
    )
    .await?;
    tx.commit().await?;
    s.events.send(json!({"type":"session.revoked"})).ok();
    crate::media::revoke_user(&s, uid).await;
    Ok(Json(json!(db::user(&s.pool, uid).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reset {
    password: String,
}
pub async fn reset_user(
    State(s): State<AppState>,
    a: Auth,
    Path(uid): Path<Uuid>,
    Json(b): Json<Reset>,
) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    s.limit(&format!("reset:{}", a.user.id), 5, 60)?;
    let encoded: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(a.user.id)
        .fetch_one(&s.pool)
        .await?;
    if !password_valid(&s, b.password, encoded).await? {
        return Err(Error::Unauthorized.into());
    }
    let _ = db::user(&s.pool, uid).await?;
    let token = random_token();
    let expires = Utc::now() + Duration::minutes(15);
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("SELECT id FROM users WHERE id=$1")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE password_resets SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=$1 AND used_at IS NULL")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO password_resets(hash,user_id,expires_at) VALUES($1,$2,$3)")
        .bind(hash(&token))
        .bind(uid)
        .bind(expires)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET auth_version=auth_version+1 WHERE id=$1")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=$1",
    )
    .bind(uid)
    .execute(&mut *tx)
    .await?;
    db::audit(&mut tx, a.user.id, "password.reset.issue", Some(uid)).await?;
    tx.commit().await?;
    s.events.send(json!({"type":"session.revoked"})).ok();
    crate::media::revoke_user(&s, uid).await;
    Ok(Json(json!({"token":token,"expires_at":expires})))
}
pub async fn invites(
    State(s): State<AppState>,
    a: Auth,
    Json(b): Json<Invite>,
) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    issue_invite(&s, a.user.id, None, b).await
}
pub async fn audit(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    let items = sqlx::query("SELECT * FROM audit ORDER BY created_at DESC,id DESC LIMIT 200")
        .fetch_all(&s.pool).await?.into_iter().map(|r|json!({
            "id":r.get::<Uuid,_>("id"),"actor_id":r.get::<Option<Uuid>,_>("actor_id"),
            "action":r.get::<String,_>("action"),"target_id":r.get::<Option<Uuid>,_>("target_id"),
            "created_at":r.get::<chrono::DateTime<Utc>,_>("created_at")
        })).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
pub async fn stats(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    let row=sqlx::query("SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM guilds) AS guilds,(SELECT count(*) FROM channels) AS channels,(SELECT count(*) FROM messages WHERE NOT deleted) AS messages,(SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND julianday(expires_at)>julianday('now')) AS sessions,(SELECT (SELECT used_bytes FROM harmony_storage_usage)) AS storage_bytes,(SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size())) AS database_bytes").fetch_one(&s.pool).await?;
    Ok(Json(
        json!({"users":row.get::<i64,_>("users"),"guilds":row.get::<i64,_>("guilds"),"channels":row.get::<i64,_>("channels"),"messages":row.get::<i64,_>("messages"),"sessions":row.get::<i64,_>("sessions"),"storage_bytes":row.get::<i64,_>("storage_bytes"),"database_bytes":row.get::<i64,_>("database_bytes"),"storage_quota_bytes":s.config.storage_quota,"max_upload_bytes":s.config.max_upload,"max_video_bitrate":s.config.max_bitrate,"media_configured":s.config.livekit_url.is_some(),"storage_configured":true}),
    ))
}
