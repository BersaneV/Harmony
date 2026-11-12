use crate::{
    AppState, db,
    error::{ApiError, ApiResult},
};
use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{StatusCode, request::Parts},
};
use chrono::Utc;
use harmony_domain::{self as domain, Error, User};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, Transaction};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub sid: Uuid,
    pub ver: i64,
    pub uv: i64,
    pub exp: usize,
    pub iat: usize,
    pub iss: String,
    pub aud: String,
}
#[derive(Clone)]
pub struct Auth {
    pub user: User,
    pub sid: Uuid,
    pub claims: Claims,
}
impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(Error::Unauthorized)?;
        authenticate(state, token).await
    }
}
pub async fn authenticate(state: &AppState, token: &str) -> ApiResult<Auth> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["harmony"]);
    validation.set_audience(&["harmony-client"]);
    validation.leeway = 0;
    let c = jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| Error::Unauthorized)?
    .claims;
    recheck(state, &c).await?;
    let user = db::user(&state.pool, c.sub).await?;
    Ok(Auth {
        user,
        sid: c.sid,
        claims: c,
    })
}
pub async fn recheck(state: &AppState, c: &Claims) -> ApiResult<()> {
    if c.exp <= Utc::now().timestamp() as usize {
        return Err(Error::Unauthorized.into());
    }
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.id=$2 AND s.version=$3 AND u.auth_version=$4 AND s.revoked_at IS NULL AND julianday(s.expires_at)>julianday('now') AND NOT u.disabled)").bind(c.sid).bind(c.sub).bind(c.ver).bind(c.uv).fetch_one(&state.pool).await?;
    if !valid {
        return Err(Error::Unauthorized.into());
    }
    Ok(())
}
pub fn require_admin(a: &Auth) -> ApiResult<()> {
    if a.user.is_admin {
        Ok(())
    } else {
        Err(Error::Forbidden.into())
    }
}
pub fn random_token() -> String {
    let mut data = [0u8; 32];
    OsRng.fill_bytes(&mut data);
    hex::encode(data)
}
pub fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
pub async fn password_hash(state: &AppState, password: String) -> ApiResult<String> {
    domain::password(&password)?;
    let permit = state
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| Error::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|_| Error::Internal)
    })
    .await
    .map_err(|_| Error::Internal)?
    .map_err(Into::into)
}
pub async fn password_valid(
    state: &AppState,
    password: String,
    encoded: String,
) -> ApiResult<bool> {
    if password.len() > 512 {
        return Ok(false);
    }
    let permit = state
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| Error::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&encoded).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::Internal.into())
}
async fn response(
    state: &AppState,
    user_id: Uuid,
    sid: Uuid,
    ver: i64,
    uv: i64,
    refresh: String,
) -> ApiResult<Json<Value>> {
    let now = Utc::now().timestamp() as usize;
    let c = Claims {
        sub: user_id,
        sid,
        ver,
        uv,
        iat: now,
        exp: now + 600,
        iss: "harmony".into(),
        aud: "harmony-client".into(),
    };
    let access = jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &c,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|_| Error::Internal)?;
    Ok(Json(
        json!({"access_token":access,"refresh_token":refresh,"user":db::user(&state.pool,user_id).await?}),
    ))
}
async fn new_session(
    state: &AppState,
    user_id: Uuid,
    expected: Option<(String, i64)>,
) -> ApiResult<Json<Value>> {
    let sid = Uuid::now_v7();
    let refresh = random_token();
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT auth_version,disabled,password_hash FROM users WHERE id=$1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    if row.get::<bool, _>("disabled") {
        return Err(Error::Unauthorized.into());
    }
    let uv: i64 = row.get("auth_version");
    if let Some((old_hash, old_version)) = expected
        && (row.get::<String, _>("password_hash") != old_hash || uv != old_version)
    {
        return Err(Error::Unauthorized.into());
    }
    sqlx::query("INSERT INTO sessions(id,user_id,refresh_hash,expires_at) VALUES($1,$2,$3,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'))").bind(sid).bind(user_id).bind(hash(&refresh)).execute(&mut *tx).await?;
    tx.commit().await?;
    response(state, user_id, sid, 1, uv, refresh).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    username: String,
    password: String,
}
pub async fn login(State(state): State<AppState>, Json(b): Json<Login>) -> ApiResult<Json<Value>> {
    let username = domain::username(&b.username).map_err(|_| Error::Unauthorized)?;
    state.limit(&format!("login:{username}"), 10, 60)?;
    let row =
        sqlx::query("SELECT id,password_hash,disabled,auth_version FROM users WHERE username=$1")
            .bind(&username)
            .fetch_optional(&state.pool)
            .await?;
    let encoded = row
        .as_ref()
        .map(|r| r.get::<String, _>("password_hash"))
        .unwrap_or_else(|| state.dummy_hash.clone());
    let valid = password_valid(&state, b.password, encoded).await?;
    let r = row
        .filter(|r| valid && !r.get::<bool, _>("disabled"))
        .ok_or(Error::Unauthorized)?;
    new_session(
        &state,
        r.get("id"),
        Some((r.get("password_hash"), r.get("auth_version"))),
    )
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    username: String,
    display_name: Option<String>,
    password: String,
    invite_token: Option<String>,
}
pub async fn register(
    State(state): State<AppState>,
    Json(b): Json<Register>,
) -> ApiResult<Json<Value>> {
    let username = domain::username(&b.username)?;
    let display_name = domain::name(b.display_name.as_deref().unwrap_or(&username))?;
    let encoded = password_hash(&state, b.password).await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    // Creating an account is public. An optional onboarding invitation still
    // joins its community atomically and must be valid when explicitly sent.
    let invite = match b.invite_token.as_deref() {
        Some(token) => consume_invite(&mut tx, token).await?,
        None => None,
    };
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(username)
        .bind(display_name)
        .bind(encoded)
        .execute(&mut *tx)
        .await?;
    if let Some(guild) = invite {
        sqlx::query("INSERT INTO guild_members(guild_id,user_id,role) VALUES($1,$2,'member')")
            .bind(guild)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    new_session(&state, id, None).await
}
pub async fn consume_invite(
    tx: &mut Transaction<'_, Sqlite>,
    token: &str,
) -> ApiResult<Option<Uuid>> {
    let row=sqlx::query("UPDATE invites SET uses=uses+1 WHERE hash=$1 AND julianday(expires_at)>julianday('now') AND uses<max_uses RETURNING guild_id").bind(hash(token)).fetch_optional(&mut **tx).await?.ok_or_else(||Error::Invalid("Convite inválido, expirado ou esgotado".into()))?;
    Ok(row.get("guild_id"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refresh {
    refresh_token: String,
}
pub async fn refresh(
    State(state): State<AppState>,
    Json(b): Json<Refresh>,
) -> ApiResult<Json<Value>> {
    let digest = hash(&b.refresh_token);
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let row=sqlx::query("SELECT s.id,s.user_id,s.version,s.expires_at,u.auth_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=$1 AND s.revoked_at IS NULL AND julianday(s.expires_at)>julianday('now') AND NOT u.disabled").bind(&digest).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        let old: Option<Uuid> = sqlx::query_scalar(
            "SELECT session_id FROM used_refresh_tokens WHERE hash=$1 AND julianday(expires_at)>julianday('now')",
        )
        .bind(&digest)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(id) = old {
            sqlx::query(
                "UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=$1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            state.events.send(json!({"type":"session.revoked"})).ok();
        }
        return Err(Error::Unauthorized.into());
    };
    let sid: Uuid = row.get("id");
    let uid: Uuid = row.get("user_id");
    let ver: i64 = row.get::<i64, _>("version") + 1;
    let uv: i64 = row.get("auth_version");
    let token = random_token();
    sqlx::query("INSERT INTO used_refresh_tokens(hash,session_id,expires_at) VALUES($1,$2,$3)")
        .bind(&digest)
        .bind(sid)
        .bind(row.get::<chrono::DateTime<Utc>, _>("expires_at"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sessions SET refresh_hash=$1,version=$2 WHERE id=$3")
        .bind(hash(&token))
        .bind(ver)
        .bind(sid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    response(&state, uid, sid, ver, uv, token).await
}
pub async fn logout(
    State(state): State<AppState>,
    Json(b): Json<Refresh>,
) -> ApiResult<StatusCode> {
    sqlx::query("UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE refresh_hash=$1 OR id IN (SELECT session_id FROM used_refresh_tokens WHERE hash=$1 AND julianday(expires_at)>julianday('now'))").bind(hash(&b.refresh_token)).execute(&state.pool).await?;
    state.events.send(json!({"type":"session.revoked"})).ok();
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reset {
    token: String,
    password: String,
}
pub async fn reset(State(state): State<AppState>, Json(b): Json<Reset>) -> ApiResult<StatusCode> {
    let encoded = password_hash(&state, b.password).await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let id:Uuid=sqlx::query_scalar("UPDATE password_resets SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE hash=$1 AND used_at IS NULL AND julianday(expires_at)>julianday('now') RETURNING user_id").bind(hash(&b.token)).fetch_optional(&mut *tx).await?.ok_or_else(||Error::Invalid("Código inválido, expirado ou já usado".into()))?;
    sqlx::query("UPDATE users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2")
        .bind(encoded)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=$1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    db::audit(&mut tx, id, "password.reset", Some(id)).await?;
    tx.commit().await?;
    state.events.send(json!({"type":"session.revoked"})).ok();
    crate::media::revoke_user(&state, id).await;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn me(auth: Auth) -> Json<User> {
    Json(auth.user)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateMe {
    display_name: Option<String>,
    preferences: Option<Value>,
}
pub async fn update_me(
    State(state): State<AppState>,
    a: Auth,
    Json(b): Json<UpdateMe>,
) -> ApiResult<Json<User>> {
    let name = b.display_name.map(|v| domain::name(&v)).transpose()?;
    if let Some(p) = &b.preferences {
        domain::preferences(p)?
    }
    sqlx::query("UPDATE users SET display_name=COALESCE($1,display_name),preferences=COALESCE($2,preferences) WHERE id=$3").bind(name).bind(b.preferences).bind(a.user.id).execute(&state.pool).await?;
    Ok(Json(db::user(&state.pool, a.user.id).await?))
}
pub async fn bootstrap(state: &AppState) -> ApiResult<()> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if count == 0 {
        let username = std::env::var("HARMONY_BOOTSTRAP_USERNAME").map_err(|_| {
            Error::Unavailable("Banco vazio: configure HARMONY_BOOTSTRAP_USERNAME/PASSWORD".into())
        })?;
        let password = std::env::var("HARMONY_BOOTSTRAP_PASSWORD")
            .map_err(|_| Error::Unavailable("Senha inicial ausente".into()))?;
        if password.starts_with("CHANGE_ME") {
            return Err(
                Error::Invalid("Use uma senha inicial própria, não o placeholder".into()).into(),
            );
        }
        let username = domain::username(&username)?;
        let encoded = password_hash(state, password).await?;
        sqlx::query("INSERT INTO users(id,username,display_name,password_hash,is_admin) VALUES($1,$2,$2,$3,true)").bind(Uuid::now_v7()).bind(username).bind(encoded).execute(&mut *tx).await?;
        tracing::info!("administrator initialized");
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn state(pool: sqlx::SqlitePool) -> AppState {
        let config = crate::config::Config::from_env().expect("integration test environment");
        AppState::new(pool, config).await.unwrap()
    }
    async fn account(s: &AppState) -> (Uuid, String) {
        let id = Uuid::now_v7();
        let encoded = password_hash(s, "test password long enough".into())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,'Test',$3)",
        )
        .bind(id)
        .bind(format!("test_{}", id.simple()))
        .bind(&encoded)
        .execute(&s.pool)
        .await
        .unwrap();
        (id, encoded)
    }
    #[sqlx::test(migrations = "../../migrations-sqlite")]
    #[ignore = "requires HARMONY_JWT_SECRET and test storage configuration"]
    async fn password_reset_wins_over_inflight_old_password_login(pool: sqlx::SqlitePool) {
        let s = state(pool).await;
        let (id, encoded) = account(&s).await;
        // This is the snapshot whose password was already verified before reset.
        let snapshot = (encoded, 1);
        sqlx::query("UPDATE users SET auth_version=auth_version+1 WHERE id=$1")
            .bind(id)
            .execute(&s.pool)
            .await
            .unwrap();
        assert!(matches!(
            new_session(&s, id, Some(snapshot)).await,
            Err(ApiError(Error::Unauthorized))
        ));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id=$1")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    #[sqlx::test(migrations = "../../migrations-sqlite")]
    #[ignore = "requires HARMONY_JWT_SECRET and test storage configuration"]
    async fn logout_consumed_refresh_revokes_current_rotation(pool: sqlx::SqlitePool) {
        let s = state(pool).await;
        let (id, _) = account(&s).await;
        let first = new_session(&s, id, None).await.unwrap().0;
        let old = first["refresh_token"].as_str().unwrap().to_string();
        let rotated = refresh(
            State(s.clone()),
            Json(Refresh {
                refresh_token: old.clone(),
            }),
        )
        .await
        .unwrap()
        .0;
        let access = rotated["access_token"].as_str().unwrap();
        assert!(authenticate(&s, access).await.is_ok());
        logout(State(s.clone()), Json(Refresh { refresh_token: old }))
            .await
            .unwrap();
        assert!(authenticate(&s, access).await.is_err());
    }
    #[sqlx::test(migrations = "../../migrations-sqlite")]
    #[ignore = "requires HARMONY_JWT_SECRET and test storage configuration"]
    async fn racing_refresh_reuse_revokes_the_session(pool: sqlx::SqlitePool) {
        let s = state(pool).await;
        let (id, _) = account(&s).await;
        let first = new_session(&s, id, None).await.unwrap().0;
        let token = first["refresh_token"].as_str().unwrap().to_string();
        let (left, right) = tokio::join!(
            refresh(
                State(s.clone()),
                Json(Refresh {
                    refresh_token: token.clone()
                })
            ),
            refresh(
                State(s.clone()),
                Json(Refresh {
                    refresh_token: token
                })
            )
        );
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        let current = left.or(right).unwrap().0;
        assert!(
            authenticate(&s, current["access_token"].as_str().unwrap())
                .await
                .is_err()
        );
    }
}
