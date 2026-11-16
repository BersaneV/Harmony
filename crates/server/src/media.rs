//! LiveKit Twirp adapter. Tokens never grant room creation or administration to clients.
use crate::{AppState, auth::Auth, db, error::ApiResult};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use harmony_domain::permissions as p;
use harmony_domain::{self as domain, Error};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

/// Only the directory lookup is synchronous. RPC/ACL waits hold one identity's
/// asynchronous lock; unrelated rooms and identities continue independently.
#[derive(Clone, Default)]
pub(crate) struct MediaOperations(Arc<Mutex<OperationDirectory>>);
type OperationDirectory = HashMap<(Uuid, String), Weak<AsyncMutex<()>>>;
impl MediaOperations {
    async fn lock(&self, cid: Uuid, identity: &str) -> ApiResult<OwnedMutexGuard<()>> {
        let identity = identity_parts(identity)
            .map_or_else(|| identity.to_owned(), |(uid, sid)| format!("{uid}:{sid}"));
        let operation = {
            let mut directory = self.0.lock().map_err(|_| Error::Internal)?;
            directory.retain(|_, operation| operation.strong_count() > 0);
            let key = (cid, identity);
            if let Some(operation) = directory.get(&key).and_then(Weak::upgrade) {
                operation
            } else {
                let operation = Arc::new(AsyncMutex::new(()));
                directory.insert(key, Arc::downgrade(&operation));
                operation
            }
        };
        Ok(operation.lock_owned().await)
    }
}
fn identity_parts(identity: &str) -> Option<(Uuid, Uuid)> {
    let (uid, sid) = identity.split_once(':')?;
    Some((uid.parse().ok()?, sid.parse().ok()?))
}
fn credentials(s: &AppState) -> ApiResult<(&str, &str, &str, &str)> {
    match (
        &s.config.livekit_key,
        &s.config.livekit_secret,
        &s.config.livekit_url,
        &s.config.livekit_api_url,
    ) {
        (Some(k), Some(sec), Some(url), Some(api)) => Ok((k, sec, url, api)),
        _ => Err(Error::Unavailable("Mídia não configurada nesta instância".into()).into()),
    }
}
fn jwt(
    s: &AppState,
    identity: Option<&str>,
    name: Option<&str>,
    video: Value,
) -> ApiResult<String> {
    jwt_with_metadata(s, identity, name, video, None)
}
fn jwt_with_metadata(
    s: &AppState,
    identity: Option<&str>,
    name: Option<&str>,
    video: Value,
    metadata: Option<String>,
) -> ApiResult<String> {
    let (key, secret, _, _) = credentials(s)?;
    let now = Utc::now().timestamp();
    let mut claims = json!({"iss":key,"nbf":now-5,"exp":now+60,"iat":now,"video":video});
    if let Some(id) = identity {
        claims["sub"] = json!(id)
    }
    if let Some(n) = name {
        claims["name"] = json!(n)
    }
    if let Some(metadata) = metadata {
        claims["metadata"] = json!(metadata);
    }
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| Error::Internal.into())
}

fn publication_grant(room: &str, can_publish: bool, screen_only: bool) -> Value {
    let mut grant = json!({"roomJoin":true,"room":room,"canPublish":can_publish,"canSubscribe":true,"canPublishData":false,"canUpdateOwnMetadata":false});
    if screen_only {
        grant["canPublishSources"] = json!(["screen_share", "screen_share_audio"]);
    }
    grant
}

fn participant_permission(s: &AppState, can_publish: bool) -> Value {
    let mut permission = json!({"canPublish":can_publish,"canSubscribe":true,"canPublishData":false,"canUpdateMetadata":false});
    if s.config.screen_sfu_enabled {
        // Twirp ParticipantPermission uses TrackSource protobuf enums, whereas
        // access-token grants use their lower-case source names.
        permission["canPublishSources"] = json!(["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);
    }
    permission
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScreenMetadata {
    harmony_peer_id: Uuid,
}
fn screen_peer_id(metadata: Option<&Value>) -> Option<Uuid> {
    let text = metadata?.as_str()?;
    if text.len() > 256 {
        return None;
    }
    serde_json::from_str::<ScreenMetadata>(text)
        .ok()
        .map(|metadata| metadata.harmony_peer_id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScreenToken {
    peer_id: Uuid,
}
pub async fn screen_token(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Json(body): Json<ScreenToken>,
) -> ApiResult<Json<Value>> {
    if !s.config.screen_sfu_enabled || s.config.media_transport != "p2p" {
        return Err(Error::Unavailable("SFU de tela não habilitado nesta instância".into()).into());
    }
    credentials(&s)?;
    crate::calls::screen_access(&s, cid, body.peer_id, a.user.id, a.sid).await?;
    s.limit(&format!("screen-media:{}", a.user.id), 20, 60)?;
    let room = format!("harmony-{cid}");
    rpc(
        &s,
        "CreateRoom",
        &room,
        json!({"name":room,"maxParticipants":s.config.max_room_participants,"emptyTimeout":120,"departureTimeout":20}),
    )
    .await?;
    let identity = format!("{}:{}", a.user.id, a.sid);
    let _operation = s.media_operations.lock(cid, &identity).await?;
    let muted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2)",
    )
    .bind(cid)
    .bind(a.user.id)
    .fetch_one(&s.pool)
    .await?;
    let effective = db::permissions(&s.pool, cid, a.user.id).await?;
    sqlx::query("INSERT INTO media_members(channel_id,user_id,session_id,identity) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,session_id) DO UPDATE SET issued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),identity=EXCLUDED.identity")
        .bind(cid).bind(a.user.id).bind(a.sid).bind(&identity).execute(&s.pool).await?;
    crate::auth::recheck(&s, &a.claims).await?;
    // CreateRoom can wait on the SFU. Never sign for a peer that left or lost
    // access while that RPC (or the following database reads) was in flight.
    let can_publish = crate::calls::screen_access(&s, cid, body.peer_id, a.user.id, a.sid).await?;
    let token = jwt_with_metadata(
        &s,
        Some(&identity),
        Some(&a.user.display_name),
        publication_grant(&room, can_publish, true),
        Some(json!({"harmony_peer_id":body.peer_id}).to_string()),
    )?;
    let (_, _, url, _) = credentials(&s)?;
    Ok(Json(
        json!({"token":token,"url":url,"room":room,"peer_id":body.peer_id,
        "max_video_bitrate":s.config.max_bitrate,"expires_in":60,"muted":muted,
        "effective_permissions":effective.to_string()}),
    ))
}
async fn rpc(s: &AppState, method: &str, room: &str, body: Value) -> ApiResult<Value> {
    let (_, _, _, api) = credentials(s)?;
    let grant = if method == "CreateRoom" {
        json!({"roomCreate":true,"room":room})
    } else if method == "ListRooms" {
        json!({"roomList":true})
    } else {
        json!({"roomAdmin":true,"room":room})
    };
    let token = jwt(s, None, None, grant)?;
    let response = s
        .http
        .post(format!(
            "{}/twirp/livekit.RoomService/{method}",
            api.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| Error::Unavailable("Servidor de mídia indisponível".into()))?;
    if !response.status().is_success() {
        let status = response.status();
        if status == StatusCode::NOT_FOUND
            && matches!(
                method,
                "GetParticipant" | "UpdateParticipant" | "RemoveParticipant"
            )
        {
            // media_members also tracks issued tokens that never connected and
            // prior sessions. Their absence is idempotent for participant-only
            // moderation; a generic proxy 404 or an auth/backend error is not.
            if let Ok(error) = response.json::<Value>().await
                && missing_participant(method, status, &error)
            {
                return Ok(if method == "GetParticipant" {
                    json!({"harmony_missing_participant":true})
                } else {
                    json!({})
                });
            }
        }
        tracing::warn!(%status,method,"LiveKit request failed");
        return Err(Error::Unavailable("Operação de mídia não confirmada".into()).into());
    }
    response
        .json()
        .await
        .map_err(|_| Error::Unavailable("Resposta de mídia inválida".into()).into())
}

fn missing_participant(method: &str, status: StatusCode, error: &Value) -> bool {
    matches!(
        method,
        "GetParticipant" | "UpdateParticipant" | "RemoveParticipant"
    ) && status == StatusCode::NOT_FOUND
        && error.get("code").and_then(Value::as_str) == Some("not_found")
        && error.get("msg").is_some_and(Value::is_string)
}
pub async fn token(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if s.config.media_transport != "livekit" {
        return Err(Error::Unavailable(
            "Esta instância usa chamadas P2P; atualize o cliente para participar".into(),
        )
        .into());
    }
    db::require_permission(&s.pool, cid, a.user.id, p::CONNECT).await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    if !matches!(kind.as_str(), "voice" | "dm" | "group") {
        return Err(Error::Invalid("Este canal não aceita chamadas".into()).into());
    }
    let banned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND julianday(until_at)>julianday('now'))").bind(cid).bind(a.user.id).fetch_one(&s.pool).await?;
    if banned {
        return Err(Error::Forbidden.into());
    }
    s.limit(&format!("media:{}", a.user.id), 20, 60)?;
    let room = format!("harmony-{cid}");
    let identity = format!("{}:{}", a.user.id, a.sid);
    rpc(
        &s,
        "CreateRoom",
        &room,
        json!({"name":room,"maxParticipants":s.config.max_room_participants,"emptyTimeout":120,"departureTimeout":20}),
    )
    .await?;
    let _operation = s.media_operations.lock(cid, &identity).await?;
    let muted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2)",
    )
    .bind(cid)
    .bind(a.user.id)
    .fetch_one(&s.pool)
    .await?;
    crate::auth::recheck(&s, &a.claims).await?;
    let effective = db::permissions(&s.pool, cid, a.user.id).await?;
    let can_publish = identity_access(&s, cid, &identity, None)
        .await?
        .ok_or(Error::Forbidden)?;
    let token = jwt(
        &s,
        Some(&identity),
        Some(&a.user.display_name),
        publication_grant(&room, can_publish, false),
    )?;
    sqlx::query("INSERT INTO media_members(channel_id,user_id,session_id,identity) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,session_id) DO UPDATE SET issued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),identity=EXCLUDED.identity").bind(cid).bind(a.user.id).bind(a.sid).bind(identity).execute(&s.pool).await?;
    let (_, _, url, _) = credentials(&s)?;
    Ok(Json(
        json!({"token":token,"url":url,"room":room,"max_video_bitrate":s.config.max_bitrate,"expires_in":60,"muted":muted,"effective_permissions":effective.to_string()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Moderate {
    user_id: Uuid,
    action: String,
}
pub async fn moderate(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Json(b): Json<Moderate>,
) -> ApiResult<StatusCode> {
    let guild: Option<Uuid> = sqlx::query_scalar("SELECT guild_id FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    let gid = guild.ok_or(Error::Forbidden)?;
    let role = db::member_role(&s.pool, gid, a.user.id).await?;
    let target_role = db::member_role(&s.pool, gid, b.user_id).await?;
    if !domain::can_manage(role.as_deref())
        || target_role.as_deref() == Some("owner")
        || (role.as_deref() != Some("owner") && target_role.as_deref() == Some("admin"))
    {
        return Err(Error::Forbidden.into());
    }
    if !matches!(b.action.as_str(), "mute" | "unmute" | "remove") {
        return Err(Error::Invalid("Ação inválida".into()).into());
    }
    if s.config.livekit_enabled() {
        credentials(&s)?;
    }
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    if b.action == "remove" {
        sqlx::query("INSERT INTO media_bans(channel_id,user_id,until_at) VALUES($1,$2,strftime('%Y-%m-%dT%H:%M:%fZ','now','+65 seconds')) ON CONFLICT(channel_id,user_id) DO UPDATE SET until_at=EXCLUDED.until_at").bind(cid).bind(b.user_id).execute(&mut *tx).await?;
    } else if b.action == "mute" {
        sqlx::query(
            "INSERT INTO media_mutes(channel_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(cid)
        .bind(b.user_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("DELETE FROM media_mutes WHERE channel_id=$1 AND user_id=$2")
            .bind(cid)
            .bind(b.user_id)
            .execute(&mut *tx)
            .await?;
    }
    db::audit(
        &mut tx,
        a.user.id,
        &format!("media.{}", b.action),
        Some(b.user_id),
    )
    .await?;
    tx.commit().await?;
    if b.action != "unmute" {
        s.calls.moderate(cid, b.user_id, b.action == "remove");
    }
    if !s.config.livekit_enabled() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let identities: Vec<String> =
        sqlx::query_scalar("SELECT identity FROM media_members WHERE channel_id=$1 AND user_id=$2")
            .bind(cid)
            .bind(b.user_id)
            .fetch_all(&s.pool)
            .await?;
    let room = format!("harmony-{cid}");
    for identity in identities {
        synchronize_identity(&s, cid, &room, &identity).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn revoke_user(s: &AppState, uid: Uuid) {
    s.calls.revoke_user(uid, None);
    if !s.config.livekit_enabled() || credentials(s).is_err() {
        return;
    }
    let rows = sqlx::query("SELECT channel_id,identity FROM media_members WHERE user_id=$1")
        .bind(uid)
        .fetch_all(&s.pool)
        .await;
    let Ok(rows) = rows else { return };
    for row in rows {
        let cid: Uuid = row.get("channel_id");
        let room = format!("harmony-{cid}");
        let identity: String = row.get("identity");
        let _ = synchronize_identity(s, cid, &room, &identity).await;
    }
}
pub async fn revoke_guild_user(s: &AppState, gid: Uuid, uid: Uuid) {
    s.calls.revoke_user(uid, Some(gid));
    if !s.config.livekit_enabled() || credentials(s).is_err() {
        return;
    }
    let rows=sqlx::query("SELECT mm.channel_id,mm.identity FROM media_members mm JOIN channels c ON c.id=mm.channel_id WHERE mm.user_id=$1 AND c.guild_id=$2")
        .bind(uid).bind(gid).fetch_all(&s.pool).await;
    let Ok(rows) = rows else { return };
    for row in rows {
        let cid = row.get::<Uuid, _>("channel_id");
        let room = format!("harmony-{cid}");
        let identity: String = row.get("identity");
        let _ = synchronize_identity(s, cid, &room, &identity).await;
    }
}
// Twirp's default marshaler emits protobuf snake_case names. Some clients opt
// into lowerCamelCase; accept both without treating a present true as absent.
fn participant_can_publish(participant: &Value) -> bool {
    participant
        .pointer("/permission/can_publish")
        .or_else(|| participant.pointer("/permission/canPublish"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}
fn restricted_screen_permission(participant: &Value) -> bool {
    let Some(permission) = participant.get("permission") else {
        return false;
    };
    let sources = permission
        .get("can_publish_sources")
        .or_else(|| permission.get("canPublishSources"))
        .and_then(Value::as_array);
    let source_id = |value: &Value| match value.as_str() {
        Some("SCREEN_SHARE") => Some(3),
        Some("SCREEN_SHARE_AUDIO") => Some(4),
        _ => value.as_u64(),
    };
    sources.is_some_and(|sources| {
        sources.len() == 2
            && sources.iter().any(|value| source_id(value) == Some(3))
            && sources.iter().any(|value| source_id(value) == Some(4))
    }) && permission
        .get("can_subscribe")
        .or_else(|| permission.get("canSubscribe"))
        .and_then(Value::as_bool)
        == Some(true)
        && !permission
            .get("can_publish_data")
            .or_else(|| permission.get("canPublishData"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && !permission
            .get("can_update_metadata")
            .or_else(|| permission.get("canUpdateMetadata"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn restricted_screen_grant(video: &Value) -> bool {
    video.get("canPublishData").and_then(Value::as_bool) == Some(false)
        && video.get("canUpdateOwnMetadata").and_then(Value::as_bool) == Some(false)
        && video.get("canSubscribe").and_then(Value::as_bool) == Some(true)
        && video.get("canPublish").and_then(Value::as_bool).is_some()
        && video
            .get("canPublishSources")
            .and_then(Value::as_array)
            .is_some_and(|sources| {
                sources.len() == 2
                    && sources.iter().any(|source| source == "screen_share")
                    && sources.iter().any(|source| source == "screen_share_audio")
            })
}
/// Caller holds the identity operation lock. Database state is read now, never
/// copied from the preceding ListParticipants or an earlier moderation action.
async fn identity_access(
    s: &AppState,
    cid: Uuid,
    identity: &str,
    metadata: Option<&Value>,
) -> ApiResult<Option<bool>> {
    let Some((uid, sid)) = identity_parts(identity) else {
        return Ok(None);
    };
    if s.config.screen_sfu_enabled {
        let Some(pid) = screen_peer_id(metadata) else {
            return Ok(None);
        };
        return match crate::calls::screen_access(s, cid, pid, uid, sid).await {
            Ok(can_publish) => Ok(Some(can_publish)),
            Err(error)
                if matches!(
                    error.0,
                    Error::Forbidden | Error::Unauthorized | Error::NotFound
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        };
    }
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions ss JOIN users u ON u.id=ss.user_id WHERE ss.id=$1 AND u.id=$2 AND ss.revoked_at IS NULL AND julianday(ss.expires_at)>julianday('now') AND NOT u.disabled)")
        .bind(sid).bind(uid).fetch_one(&s.pool).await?;
    let banned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND julianday(until_at)>julianday('now'))")
        .bind(cid).bind(uid).fetch_one(&s.pool).await?;
    let effective = db::permissions(&s.pool, cid, uid).await?;
    if !active || banned || effective & p::CONNECT == 0 {
        return Ok(None);
    }
    let muted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2)",
    )
    .bind(cid)
    .bind(uid)
    .fetch_one(&s.pool)
    .await?;
    Ok(Some(!muted && effective & p::PUBLISH != 0))
}

async fn synchronize_identity(
    s: &AppState,
    cid: Uuid,
    room: &str,
    identity: &str,
) -> ApiResult<()> {
    let _operation = s.media_operations.lock(cid, identity).await?;
    // A participant can leave/rejoin while a previously listed snapshot waits
    // for this lock. Fetch its current metadata/permissions under coordination.
    for _ in 0..3 {
        let participant = rpc(
            s,
            "GetParticipant",
            room,
            json!({"room":room,"identity":identity}),
        )
        .await?;
        if participant
            .get("harmony_missing_participant")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Ok(());
        }
        if participant.get("identity").and_then(Value::as_str) != Some(identity) {
            return Err(Error::Unavailable("Identidade de mídia não confirmada".into()).into());
        }
        let access = match identity_access(s, cid, identity, participant.get("metadata")).await {
            Ok(access) => access,
            Err(error) => {
                rpc(
                    s,
                    "RemoveParticipant",
                    room,
                    json!({"room":room,"identity":identity}),
                )
                .await?;
                return Err(error);
            }
        };
        let Some(can_publish) = access else {
            rpc(
                s,
                "RemoveParticipant",
                room,
                json!({"room":room,"identity":identity}),
            )
            .await?;
            return Ok(());
        };
        if participant_can_publish(&participant) != can_publish
            || (s.config.screen_sfu_enabled && !restricted_screen_permission(&participant))
        {
            rpc(s, "UpdateParticipant", room, json!({"room":room,"identity":identity,"permission":participant_permission(s,can_publish)})).await?;
        }
        // ACL writes need not wait on an SFU RPC. If one committed while the RPC
        // was in flight, compensate before releasing this identity's lock.
        match identity_access(s, cid, identity, participant.get("metadata")).await {
            Ok(current) if current == access => return Ok(()),
            Ok(_) => {}
            Err(error) => {
                rpc(
                    s,
                    "RemoveParticipant",
                    room,
                    json!({"room":room,"identity":identity}),
                )
                .await?;
                return Err(error);
            }
        }
    }
    // Continually changing authorization cannot leave a stale positive grant.
    rpc(
        s,
        "RemoveParticipant",
        room,
        json!({"room":room,"identity":identity}),
    )
    .await?;
    Ok(())
}
async fn reconcile_room(s: &AppState, room: String, cid: Uuid) {
    let Ok(response) = rpc(s, "ListParticipants", &room, json!({"room":room})).await else {
        return;
    };
    let Some(participants) = response.get("participants").and_then(Value::as_array) else {
        return;
    };
    for participant in participants {
        let Some(identity) = participant.get("identity").and_then(Value::as_str) else {
            continue;
        };
        let _ = synchronize_identity(s, cid, &room, identity).await;
    }
}
pub async fn reconcile(s: AppState) {
    use futures_util::StreamExt;
    if !s.config.livekit_enabled() {
        return;
    }
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if credentials(&s).is_err() {
            continue;
        }
        let Ok(response) = rpc(&s, "ListRooms", "", json!({})).await else {
            continue;
        };
        let Some(rooms) = response.get("rooms").and_then(Value::as_array) else {
            continue;
        };
        let rooms = rooms
            .iter()
            .filter_map(|r| {
                let name = r.get("name")?.as_str()?;
                let id = name.strip_prefix("harmony-")?.parse::<Uuid>().ok()?;
                Some((name.to_owned(), id))
            })
            .collect::<Vec<_>>();
        futures_util::stream::iter(rooms)
            .for_each_concurrent(4, |(room, cid)| reconcile_room(&s, room, cid))
            .await;
    }
}

/// Internal admission endpoint for Caddy forward_auth on LiveKit signaling.
/// Never accepts a client-provided forwarded address as proof of trusted proxy.
pub async fn admit(
    State(s): State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
) -> ApiResult<StatusCode> {
    if !s.config.livekit_enabled() {
        return Err(Error::Forbidden.into());
    }
    if !peer.ip().is_loopback() || std::env::var("HARMONY_TRUST_PROXY").as_deref() != Ok("true") {
        return Err(Error::Forbidden.into());
    }
    let token = if let Some(authorization) = headers.get("authorization") {
        authorization
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| !v.is_empty())
            .ok_or(Error::Unauthorized)?
    } else {
        headers
            .get("x-livekit-query-token")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
            .ok_or(Error::Unauthorized)?
    };
    admit_token(&s, token).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Shared admission decision for the trusted local gateway and any internal
/// signaling proxy. Calling this does not establish proxy/header trust.
pub(crate) async fn admit_token(s: &AppState, token: &str) -> ApiResult<()> {
    let _admission = admit_token_guard(s, token).await?;
    Ok(())
}

/// The signaling proxy retains this lease until the upstream JoinResponse.
/// It must recheck before forwarding that response, then release the lease.
pub(crate) struct MediaAdmission {
    _operation: OwnedMutexGuard<()>,
    claims: Value,
}
impl MediaAdmission {
    pub(crate) async fn recheck(&self, s: &AppState) -> ApiResult<()> {
        validate_admission(s, &self.claims).await
    }
}
pub(crate) async fn admit_token_guard(s: &AppState, token: &str) -> ApiResult<MediaAdmission> {
    if !s.config.livekit_enabled() {
        return Err(Error::Forbidden.into());
    }
    let (key, secret, _, _) = credentials(s)?;
    let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
    validation.set_issuer(&[key]);
    validation.leeway = 0;
    validation.validate_nbf = true;
    validation.validate_aud = false;
    let claims = jsonwebtoken::decode::<Value>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| Error::Unauthorized)?
    .claims;
    let identity = claims
        .get("sub")
        .and_then(Value::as_str)
        .ok_or(Error::Unauthorized)?;
    identity_parts(identity).ok_or(Error::Unauthorized)?;
    let cid = claims
        .pointer("/video/room")
        .and_then(Value::as_str)
        .and_then(|room| room.strip_prefix("harmony-"))
        .and_then(|cid| cid.parse::<Uuid>().ok())
        .ok_or(Error::Unauthorized)?;
    let operation = s.media_operations.lock(cid, identity).await?;
    validate_admission(s, &claims).await?;
    Ok(MediaAdmission {
        _operation: operation,
        claims,
    })
}
async fn validate_admission(s: &AppState, claims: &Value) -> ApiResult<()> {
    if !s.config.livekit_enabled() {
        return Err(Error::Forbidden.into());
    }
    if claims
        .get("exp")
        .and_then(Value::as_i64)
        .is_none_or(|exp| exp <= Utc::now().timestamp())
    {
        return Err(Error::Unauthorized.into());
    }
    let identity = claims
        .get("sub")
        .and_then(Value::as_str)
        .ok_or(Error::Unauthorized)?;
    let (uid, sid) = identity.split_once(':').ok_or(Error::Unauthorized)?;
    let uid: Uuid = uid.parse().map_err(|_| Error::Unauthorized)?;
    let sid: Uuid = sid.parse().map_err(|_| Error::Unauthorized)?;
    let video = claims.get("video").ok_or(Error::Unauthorized)?;
    if video.get("roomJoin").and_then(Value::as_bool) != Some(true) {
        return Err(Error::Unauthorized.into());
    }
    let cid: Uuid = video
        .get("room")
        .and_then(Value::as_str)
        .and_then(|v| v.strip_prefix("harmony-"))
        .and_then(|v| v.parse().ok())
        .ok_or(Error::Unauthorized)?;
    if s.config.screen_sfu_enabled {
        let pid = screen_peer_id(claims.get("metadata")).ok_or(Error::Forbidden)?;
        if !restricted_screen_grant(video) {
            return Err(Error::Forbidden.into());
        }
        let can_publish = crate::calls::screen_access(s, cid, pid, uid, sid).await?;
        if !can_publish && video.get("canPublish").and_then(Value::as_bool) != Some(false) {
            return Err(Error::Forbidden.into());
        }
        return Ok(());
    }
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions ss JOIN users u ON u.id=ss.user_id WHERE ss.id=$1 AND u.id=$2 AND ss.revoked_at IS NULL AND julianday(ss.expires_at)>julianday('now') AND NOT u.disabled)").bind(sid).bind(uid).fetch_one(&s.pool).await?;
    if !active {
        return Err(Error::Unauthorized.into());
    }
    db::require_permission(&s.pool, cid, uid, p::CONNECT).await?;
    let banned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND julianday(until_at)>julianday('now'))").bind(cid).bind(uid).fetch_one(&s.pool).await?;
    if banned {
        return Err(Error::Forbidden.into());
    }
    let muted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2)",
    )
    .bind(cid)
    .bind(uid)
    .fetch_one(&s.pool)
    .await?;
    let effective = db::permissions(&s.pool, cid, uid).await?;
    if (muted || effective & p::PUBLISH == 0)
        && video.get("canPublish").and_then(Value::as_bool) != Some(false)
    {
        return Err(Error::Forbidden.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screen_tokens_keep_source_limits_when_muted_and_metadata_is_typed() {
        for can_publish in [false, true] {
            let grant = publication_grant("harmony-fixture", can_publish, true);
            assert!(restricted_screen_grant(&grant));
            assert_eq!(grant["canPublish"], can_publish);
            assert!(grant.get("roomAdmin").is_none());
            assert!(grant.get("roomCreate").is_none());
            for (field, value) in [
                ("canPublishData", json!(true)),
                ("canUpdateOwnMetadata", json!(true)),
                ("canSubscribe", json!(false)),
                ("canPublishSources", json!(["screen_share", "microphone"])),
            ] {
                let mut invalid = grant.clone();
                invalid[field] = value;
                assert!(!restricted_screen_grant(&invalid));
            }
        }
        let pid = Uuid::now_v7();
        assert_eq!(
            screen_peer_id(Some(&json!(json!({"harmony_peer_id":pid}).to_string()))),
            Some(pid)
        );
        for metadata in [
            json!(null),
            json!({"harmony_peer_id":pid}),
            json!("{}"),
            json!(json!({"harmony_peer_id":pid,"user_id":pid}).to_string()),
            json!("x".repeat(257)),
        ] {
            assert_eq!(screen_peer_id(Some(&metadata)), None);
        }
    }
    #[test]
    fn screen_reconciliation_requires_the_complete_native_permission() {
        for sources in [json!(["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]), json!([3, 4])] {
            let participant =
                json!({"permission":{"can_subscribe":true,"can_publish_sources":sources}});
            assert!(restricted_screen_permission(&participant));
            for (field, value) in [
                ("can_publish_sources", json!([])),
                ("can_publish_data", json!(true)),
                ("can_update_metadata", json!(true)),
                ("can_subscribe", json!(false)),
            ] {
                let mut invalid = participant.clone();
                invalid["permission"][field] = value;
                assert!(!restricted_screen_permission(&invalid));
            }
        }
        assert!(restricted_screen_permission(
            &json!({"permission":{"canSubscribe":true,"canPublishSources":["SCREEN_SHARE_AUDIO","SCREEN_SHARE"],"canUpdateMetadata":false}})
        ));
    }
    #[test]
    fn only_attested_twirp_missing_participants_are_idempotent() {
        let absent = json!({"code":"not_found","msg":"participant does not exist"});
        for method in ["GetParticipant", "UpdateParticipant", "RemoveParticipant"] {
            assert!(missing_participant(method, StatusCode::NOT_FOUND, &absent));
            for status in [
                StatusCode::UNAUTHORIZED,
                StatusCode::FORBIDDEN,
                StatusCode::BAD_GATEWAY,
            ] {
                assert!(!missing_participant(method, status, &absent));
            }
            for body in [
                json!("proxy page not found"),
                json!({"code":"not_found"}),
                json!({"code":"unauthenticated","msg":"invalid credentials"}),
                json!({"code":"permission_denied","msg":"denied"}),
                json!({"code":"internal","msg":"backend unavailable"}),
            ] {
                assert!(!missing_participant(method, StatusCode::NOT_FOUND, &body));
            }
        }
        assert!(!missing_participant(
            "CreateRoom",
            StatusCode::NOT_FOUND,
            &absent
        ));
        assert!(!missing_participant(
            "ListParticipants",
            StatusCode::NOT_FOUND,
            &absent
        ));
    }
    #[test]
    fn twirp_participant_permissions_support_proto_names_and_camel_case() {
        // Canonical response shape observed from LiveKit 1.13.11 ListParticipants.
        let canonical = json!({"permission":{"can_subscribe":true,"can_publish":true,"can_publish_data":false}});
        assert!(participant_can_publish(&canonical));
        assert!(participant_can_publish(
            &json!({"permission":{"canPublish":true}})
        ));
        assert!(!participant_can_publish(
            &json!({"permission":{"can_publish":false}})
        ));
        assert!(!participant_can_publish(
            &json!({"permission":{"canPublish":false}})
        ));
        assert!(!participant_can_publish(
            &json!({"permission":{"can_subscribe":true}})
        ));
    }
}
