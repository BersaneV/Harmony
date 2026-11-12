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
    let items: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(u) FROM public_users u ORDER BY created_at,id LIMIT 1000",
    )
    .fetch_all(&s.pool)
    .await?;
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
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query("SELECT is_admin FROM users WHERE id=$1 FOR UPDATE")
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
    sqlx::query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1")
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
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL")
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
    sqlx::query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1")
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
    let items: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(a) FROM audit a ORDER BY created_at DESC,id DESC LIMIT 200",
    )
    .fetch_all(&s.pool)
    .await?;
    Ok(Json(json!({"items":items})))
}
pub async fn stats(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    require_admin(&a)?;
    let row=sqlx::query("SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM guilds) AS guilds,(SELECT count(*) FROM channels) AS channels,(SELECT count(*) FROM messages WHERE NOT deleted) AS messages,(SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>now()) AS sessions,(SELECT harmony_storage_used()) AS storage_bytes,(SELECT pg_database_size(current_database())) AS database_bytes").fetch_one(&s.pool).await?;
    Ok(Json(
        json!({"users":row.get::<i64,_>("users"),"guilds":row.get::<i64,_>("guilds"),"channels":row.get::<i64,_>("channels"),"messages":row.get::<i64,_>("messages"),"sessions":row.get::<i64,_>("sessions"),"storage_bytes":row.get::<i64,_>("storage_bytes"),"database_bytes":row.get::<i64,_>("database_bytes"),"storage_quota_bytes":s.config.storage_quota,"max_upload_bytes":s.config.max_upload,"max_video_bitrate":s.config.max_bitrate,"media_configured":s.config.livekit_url.is_some(),"storage_configured":s.config.s3_endpoint.is_some()}),
    ))
}
