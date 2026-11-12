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
use uuid::Uuid;
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
    let (key, secret, _, _) = credentials(s)?;
    let now = Utc::now().timestamp();
    let mut claims = json!({"iss":key,"nbf":now-5,"exp":now+60,"iat":now,"video":video});
    if let Some(id) = identity {
        claims["sub"] = json!(id)
    }
    if let Some(n) = name {
        claims["name"] = json!(n)
    }
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| Error::Internal.into())
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
        if method == "RemoveParticipant" && status.as_u16() == 404 {
            return Ok(json!({}));
        }
        tracing::warn!(%status,method,"LiveKit request failed");
        return Err(Error::Unavailable("Operação de mídia não confirmada".into()).into());
    }
    response
        .json()
        .await
        .map_err(|_| Error::Unavailable("Resposta de mídia inválida".into()).into())
}
pub async fn token(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    db::require_permission(&s.pool, cid, a.user.id, p::CONNECT).await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    if !matches!(kind.as_str(), "voice" | "dm" | "group") {
        return Err(Error::Invalid("Este canal não aceita chamadas".into()).into());
    }
    let banned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND until_at>now())").bind(cid).bind(a.user.id).fetch_one(&s.pool).await?;
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
    let muted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2)",
    )
    .bind(cid)
    .bind(a.user.id)
    .fetch_one(&s.pool)
    .await?;
    crate::auth::recheck(&s, &a.claims).await?;
    let effective = db::permissions(&s.pool, cid, a.user.id).await?;
    if effective & p::CONNECT == 0 {
        return Err(Error::Forbidden.into());
    }
    let can_publish = !muted && effective & p::PUBLISH != 0;
    let token = jwt(
        &s,
        Some(&identity),
        Some(&a.user.display_name),
        json!({"roomJoin":true,"room":room,"canPublish":can_publish,"canSubscribe":true,"canPublishData":false,"canUpdateOwnMetadata":false}),
    )?;
    sqlx::query("INSERT INTO media_members(channel_id,user_id,session_id,identity) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,session_id) DO UPDATE SET issued_at=now(),identity=EXCLUDED.identity").bind(cid).bind(a.user.id).bind(a.sid).bind(identity).execute(&s.pool).await?;
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
    credentials(&s)?;
    let mut tx = s.pool.begin().await?;
    if b.action == "remove" {
        sqlx::query("INSERT INTO media_bans(channel_id,user_id,until_at) VALUES($1,$2,now()+interval '65 seconds') ON CONFLICT(channel_id,user_id) DO UPDATE SET until_at=EXCLUDED.until_at").bind(cid).bind(b.user_id).execute(&mut *tx).await?;
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
    let identities: Vec<String> =
        sqlx::query_scalar("SELECT identity FROM media_members WHERE channel_id=$1 AND user_id=$2")
            .bind(cid)
            .bind(b.user_id)
            .fetch_all(&s.pool)
            .await?;
    let room = format!("harmony-{cid}");
    for identity in identities {
        if b.action == "remove" {
            rpc(
                &s,
                "RemoveParticipant",
                &room,
                json!({"room":room,"identity":identity}),
            )
            .await?;
        } else {
            rpc(&s,"UpdateParticipant",&room,json!({"room":room,"identity":identity,"permission":{"canPublish":b.action=="unmute" && db::permissions(&s.pool,cid,b.user_id).await?&p::PUBLISH!=0,"canSubscribe":true,"canPublishData":false}})).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn revoke_user(s: &AppState, uid: Uuid) {
    if credentials(s).is_err() {
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
        let _ = rpc(
            s,
            "RemoveParticipant",
            &room,
            json!({"room":room,"identity":identity}),
        )
        .await;
    }
}
pub async fn revoke_guild_user(s: &AppState, gid: Uuid, uid: Uuid) {
    if credentials(s).is_err() {
        return;
    }
    let rows=sqlx::query("SELECT mm.channel_id,mm.identity FROM media_members mm JOIN channels c ON c.id=mm.channel_id WHERE mm.user_id=$1 AND c.guild_id=$2")
        .bind(uid).bind(gid).fetch_all(&s.pool).await;
    let Ok(rows) = rows else { return };
    for row in rows {
        let room = format!("harmony-{}", row.get::<Uuid, _>("channel_id"));
        let identity: String = row.get("identity");
        let _ = rpc(
            s,
            "RemoveParticipant",
            &room,
            json!({"room":room,"identity":identity}),
        )
        .await;
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
        let parsed = identity
            .split_once(':')
            .and_then(|(u, se)| Some((u.parse::<Uuid>().ok()?, se.parse::<Uuid>().ok()?)));
        let mut allowed = false;
        let mut can_publish = false;
        if let Some((uid, sid)) = parsed {
            let active=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM sessions ss JOIN users u ON u.id=ss.user_id WHERE ss.id=$1 AND u.id=$2 AND ss.revoked_at IS NULL AND ss.expires_at>now() AND NOT u.disabled)")
                .bind(sid).bind(uid).fetch_one(&s.pool).await.unwrap_or(false);
            let banned=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND until_at>now())")
                .bind(cid).bind(uid).fetch_one(&s.pool).await.unwrap_or(true);
            let effective = db::permissions(&s.pool, cid, uid).await.unwrap_or(0);
            allowed = active && !banned && effective & p::CONNECT != 0;
            let muted = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2)",
            )
            .bind(cid)
            .bind(uid)
            .fetch_one(&s.pool)
            .await
            .unwrap_or(true);
            can_publish = effective & p::PUBLISH != 0 && !muted;
        }
        if !allowed {
            let _ = rpc(
                s,
                "RemoveParticipant",
                &room,
                json!({"room":room,"identity":identity}),
            )
            .await;
        } else if participant_can_publish(participant) != can_publish {
            let _=rpc(s,"UpdateParticipant",&room,json!({"room":room,"identity":identity,"permission":{"canPublish":can_publish,"canSubscribe":true,"canPublishData":false}})).await;
        }
    }
}
pub async fn reconcile(s: AppState) {
    use futures_util::StreamExt;
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
    let (key, secret, _, _) = credentials(&s)?;
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
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions ss JOIN users u ON u.id=ss.user_id WHERE ss.id=$1 AND u.id=$2 AND ss.revoked_at IS NULL AND ss.expires_at>now() AND NOT u.disabled)").bind(sid).bind(uid).fetch_one(&s.pool).await?;
    if !active {
        return Err(Error::Unauthorized.into());
    }
    db::require_permission(&s.pool, cid, uid, p::CONNECT).await?;
    let banned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND until_at>now())").bind(cid).bind(uid).fetch_one(&s.pool).await?;
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
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
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
