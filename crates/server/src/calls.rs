//! Authenticated, bounded signaling for real direct calls. SDP/ICE are ephemeral.
//! Publication enforcement also requires recipients to apply authoritative rosters;
//! this signaling server cannot inspect or revoke already exchanged media keys.
use crate::{
    AppState,
    auth::{self, Auth, Claims},
    error::ApiResult,
};
use axum::{
    Json,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use harmony_domain::{Error, permissions as p};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const MAX_PEERS: usize = 256;
const MAX_FRAME: usize = 64 * 1024;
const CHECK_DEADLINE: Duration = Duration::from_millis(500);
const WRITE_DEADLINE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Media {
    microphone: bool,
    camera: bool,
    screen: bool,
    screen_audio: bool,
}
#[derive(Clone, Serialize)]
struct PublicPeer {
    peer_id: Uuid,
    user_id: Uuid,
    display_name: String,
    can_publish: bool,
    media: Media,
}
struct Peer {
    public: PublicPeer,
    channel: Uuid,
    guild: Option<Uuid>,
    claims: Claims,
    outgoing: mpsc::Sender<Value>,
    cancel: watch::Sender<Option<&'static str>>,
}
#[derive(Clone, Default)]
pub struct CallRegistry(Arc<Mutex<HashMap<Uuid, Peer>>>);
fn snapshot(peers: &HashMap<Uuid, Peer>, cid: Uuid) -> Vec<PublicPeer> {
    let mut result = peers
        .values()
        .filter(|p| p.channel == cid)
        .map(|p| p.public.clone())
        .collect::<Vec<_>>();
    result.sort_by_key(|p| p.peer_id);
    result
}
// No await while the registry mutex is held. Slow consumers are removed and
// cancelled through a separate channel, even if their bounded queue is full.
fn broadcast(peers: &mut HashMap<Uuid, Peer>, cid: Uuid) {
    loop {
        let event = json!({"type":"roster","participants":snapshot(peers,cid)});
        let failed = peers
            .iter()
            .filter(|(_, p)| p.channel == cid)
            .filter_map(|(id, p)| p.outgoing.try_send(event.clone()).err().map(|_| *id))
            .collect::<Vec<_>>();
        if failed.is_empty() {
            break;
        }
        for id in failed {
            if let Some(peer) = peers.remove(&id) {
                let _ = peer
                    .cancel
                    .send(Some("Consumidor de sinalização lento; reconecte"));
            }
        }
    }
}
impl CallRegistry {
    pub fn revoke_user(&self, uid: Uuid, guild: Option<Uuid>) {
        if let Ok(mut peers) = self.0.lock() {
            let ids = peers
                .iter()
                .filter(|(_, p)| {
                    p.public.user_id == uid && guild.is_none_or(|g| p.guild == Some(g))
                })
                .map(|(id, _)| *id)
                .collect::<Vec<_>>();
            for id in ids {
                remove(
                    &mut peers,
                    id,
                    "Sua sessão ou acesso à comunidade foi revogado",
                );
            }
        }
    }
    pub fn moderate(&self, cid: Uuid, uid: Uuid, remove_peer: bool) {
        if let Ok(mut peers) = self.0.lock() {
            let id = peers
                .iter()
                .find(|(_, p)| p.channel == cid && p.public.user_id == uid)
                .map(|(id, _)| *id);
            if let Some(id) = id {
                if remove_peer {
                    remove(&mut peers, id, "Você foi removido da chamada");
                } else {
                    // Unmute is granted only after the next fresh ACL check.
                    if let Some(peer) = peers.get_mut(&id) {
                        peer.public.can_publish = false;
                        peer.public.media = Media::default();
                    }
                    broadcast(&mut peers, cid);
                }
            }
        }
    }
    fn remove(&self, id: Uuid, reason: &'static str) {
        if let Ok(mut peers) = self.0.lock() {
            remove(&mut peers, id, reason);
        }
    }
    fn update(&self, id: Uuid, can_publish: bool, claims: Option<Claims>) -> bool {
        let Ok(mut peers) = self.0.lock() else {
            return false;
        };
        let Some(peer) = peers.get_mut(&id) else {
            return false;
        };
        if let Some(claims) = claims {
            peer.claims = claims;
        }
        if peer.public.can_publish != can_publish {
            peer.public.can_publish = can_publish;
            if !can_publish {
                peer.public.media = Media::default();
            }
            let cid = peer.channel;
            broadcast(&mut peers, cid);
        }
        peers.contains_key(&id)
    }
}
fn remove(peers: &mut HashMap<Uuid, Peer>, id: Uuid, reason: &'static str) {
    if let Some(peer) = peers.remove(&id) {
        let _ = peer.cancel.send(Some(reason));
        broadcast(peers, peer.channel);
    }
}
struct Access {
    can_publish: bool,
    guild: Option<Uuid>,
}
async fn access(s: &AppState, cid: Uuid, c: &Claims) -> ApiResult<Access> {
    // Only used AFTER strict JWT admission. A legitimate refresh increments the
    // session version; it must not interrupt an already admitted socket. Its old
    // access expiry still applies until strict same-session reauthentication.
    if c.exp <= chrono::Utc::now().timestamp() as usize {
        return Err(Error::Unauthorized.into());
    }
    // A single acquisition and SQLite read snapshot avoids accumulating pool
    // queue/scheduler latency four times per check (twice for each signal).
    // This is still a fresh read; no authorization result is cached.
    let (valid, effective, kind, guild, banned, muted):
        (bool, i64, Option<String>, Option<Uuid>, bool, bool) = sqlx::query_as(
        "SELECT
          EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.id=$1 AND u.id=$2 AND s.version>=$3 AND u.auth_version=$4
              AND s.revoked_at IS NULL AND julianday(s.expires_at)>julianday('now') AND NOT u.disabled),
          COALESCE((SELECT permissions FROM effective_channel_permissions ep
            WHERE ep.channel_id=$5 AND ep.user_id=$2),0),
          c.kind,c.guild_id,
          EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$5 AND user_id=$2 AND julianday(until_at)>julianday('now')),
          EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$5 AND user_id=$2)
         FROM (SELECT 1) AS singleton LEFT JOIN channels c ON c.id=$5"
    ).bind(c.sid).bind(c.sub).bind(c.ver).bind(c.uv).bind(cid).fetch_one(&s.pool).await?;
    if !valid {
        return Err(Error::Unauthorized.into());
    }
    if effective & (p::VIEW | p::CONNECT) != p::VIEW | p::CONNECT {
        return Err(Error::Forbidden.into());
    }
    let kind = kind.ok_or(Error::NotFound)?;
    if !matches!(kind.as_str(), "voice" | "dm" | "group") {
        return Err(Error::Forbidden.into());
    }
    if banned {
        return Err(Error::Forbidden.into());
    }
    Ok(Access {
        can_publish: !muted && effective & p::PUBLISH != 0,
        guild,
    })
}
async fn checked(s: &AppState, cid: Uuid, c: &Claims) -> ApiResult<Access> {
    tokio::time::timeout(CHECK_DEADLINE, access(s, cid, c))
        .await
        .map_err(|_| Error::Unavailable("Não foi possível confirmar o acesso à chamada".into()))?
}
fn ice(s: &AppState) -> Value {
    if s.config.call_stun_urls.is_empty() {
        json!([])
    } else {
        json!([{"urls":s.config.call_stun_urls}])
    }
}
pub async fn info(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    checked(&s, cid, &a.claims).await?;
    s.limit(&format!("call-info:{}", a.user.id), 90, 60)?;
    let peers = s.calls.0.lock().map_err(|_| Error::Internal)?;
    Ok(Json(
        json!({"transport":s.config.media_transport,"max_participants":s.config.max_room_participants,
        "max_video_bitrate":s.config.max_bitrate,"ice_servers":ice(&s),"participants":snapshot(&peers,cid)}),
    ))
}
pub async fn upgrade(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| session(socket, s))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Join {
    r#type: String,
    token: String,
    channel_id: Uuid,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    Signal {
        to: Uuid,
        data: Value,
    },
    Media {
        microphone: bool,
        camera: bool,
        screen: bool,
        screen_audio: bool,
    },
    Ping,
    Reauth {
        token: String,
    },
}
fn valid_signal(data: &Value) -> bool {
    let Some(object) = data.as_object() else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    if let Some(receive) = object.get("receive").and_then(Value::as_object) {
        return receive.len() == 1
            && receive
                .get("screen_height")
                .and_then(Value::as_u64)
                .is_some_and(|height| {
                    matches!(height, 0 | 144 | 240 | 360 | 480 | 720 | 1080 | 1440 | 2160)
                });
    }
    if let Some(d) = object.get("description").and_then(Value::as_object) {
        return d.len() == 2
            && matches!(
                d.get("type").and_then(Value::as_str),
                Some("offer" | "answer")
            )
            && d.get("sdp")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty() && s.len() <= 48 * 1024 && !s.contains('\0'));
    }
    let Some(c) = object.get("candidate") else {
        return false;
    };
    if c.is_null() {
        return true;
    }
    let Some(c) = c.as_object() else {
        return false;
    };
    c.keys().all(|k| {
        matches!(
            k.as_str(),
            "candidate" | "sdpMid" | "sdpMLineIndex" | "usernameFragment"
        )
    }) && c
        .get("candidate")
        .and_then(Value::as_str)
        .is_some_and(|s| s.len() <= 4096 && !s.contains('\0'))
        && ["sdpMid", "usernameFragment"].iter().all(|k| {
            c.get(*k).is_none_or(|v| {
                v.is_null()
                    || v.as_str()
                        .is_some_and(|s| s.len() <= 256 && !s.contains('\0'))
            })
        })
        && c.get("sdpMLineIndex")
            .is_none_or(|v| v.is_null() || v.as_u64().is_some_and(|n| n <= 3))
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(
        tokio::time::timeout(
            WRITE_DEADLINE,
            socket.send(Message::Text(value.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn close(socket: &mut WebSocket, reason: &str, code: &str) {
    let _ = send(socket, json!({"type":"closed","reason":reason,"code":code})).await;
    let _ = tokio::time::timeout(WRITE_DEADLINE, socket.send(Message::Close(None))).await;
}
async fn session(mut socket: WebSocket, s: AppState) {
    let Ok(Some(Ok(Message::Text(frame)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    let join = serde_json::from_str::<Join>(&frame)
        .ok()
        .filter(|j| j.r#type == "auth" && j.token.len() <= 4096);
    let Some(join) = join else {
        close(&mut socket, "Entrada inválida", "invalid_request").await;
        return;
    };
    if s.config.media_transport != "p2p" {
        close(
            &mut socket,
            "Esta instância usa LiveKit",
            "transport_disabled",
        )
        .await;
        return;
    }
    let Ok(Ok(a)) = tokio::time::timeout(CHECK_DEADLINE, auth::authenticate(&s, &join.token)).await
    else {
        close(
            &mut socket,
            "Sessão inválida; entre novamente",
            "unauthorized",
        )
        .await;
        return;
    };
    if s.limit(&format!("call-join:{}", a.user.id), 20, 60)
        .is_err()
    {
        close(&mut socket, "Muitas tentativas; aguarde", "rate_limited").await;
        return;
    }
    let Ok(access) = checked(&s, join.channel_id, &a.claims).await else {
        close(&mut socket, "Acesso à chamada negado", "forbidden").await;
        return;
    };
    let id = Uuid::now_v7();
    let (tx, mut rx) = mpsc::channel(64);
    let (cancel, mut cancellation) = watch::channel(None);
    let admitted = {
        let mut peers = match s.calls.0.lock() {
            Ok(p) => p,
            Err(_) => return,
        };
        if peers.values().any(|p| p.public.user_id == a.user.id) {
            Err((
                "Você já está em uma chamada; saia dela antes de entrar",
                "already_connected",
            ))
        } else if peers.len() >= MAX_PEERS
            || snapshot(&peers, join.channel_id).len() >= s.config.max_room_participants as usize
        {
            Err((
                "Esta chamada atingiu o limite de participantes",
                "room_full",
            ))
        } else {
            peers.insert(
                id,
                Peer {
                    public: PublicPeer {
                        peer_id: id,
                        user_id: a.user.id,
                        display_name: a.user.display_name,
                        can_publish: access.can_publish,
                        media: Media::default(),
                    },
                    channel: join.channel_id,
                    guild: access.guild,
                    claims: a.claims.clone(),
                    outgoing: tx,
                    cancel,
                },
            );
            let ready = json!({"type":"ready","peer_id":id,"channel_id":join.channel_id,"participants":snapshot(&peers,join.channel_id),
                "max_participants":s.config.max_room_participants,"max_video_bitrate":s.config.max_bitrate,"ice_servers":ice(&s)});
            broadcast(&mut peers, join.channel_id);
            Ok(ready)
        }
    };
    let ready = match admitted {
        Ok(r) => r,
        Err((reason, code)) => {
            close(&mut socket, reason, code).await;
            return;
        }
    };
    if !send(&mut socket, ready).await {
        s.calls.remove(id, "Conexão perdida");
        return;
    }
    let mut claims = a.claims;
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_ping = Instant::now();
    let mut window = Instant::now();
    let (mut count, mut bytes, mut descriptions) = (0usize, 0usize, 0usize);
    let reason = loop {
        tokio::select! {
            biased;
            _=cancellation.changed()=> { break cancellation.borrow().unwrap_or("Chamada encerrada"); }
            _=interval.tick()=> {
                if last_ping.elapsed()>=Duration::from_secs(35) { break "Sinalização inativa; reconecte"; }
                match checked(&s,join.channel_id,&claims).await {
                    Ok(access)=>if !s.calls.update(id,access.can_publish,None) { break "Chamada encerrada"; },
                    Err(_)=>break "Sua sessão ou permissão da chamada não está mais válida",
                }
            }
            frame=rx.recv()=> match frame { Some(v)=>if !send(&mut socket,v).await { break "Sinalização indisponível"; },None=>break "Chamada encerrada" },
            frame=socket.recv()=> {
                let Some(Ok(Message::Text(frame)))=frame else { break "Conexão encerrada"; };
                if window.elapsed()>=Duration::from_secs(10) { window=Instant::now(); count=0; bytes=0; descriptions=0; }
                count+=1; bytes+=frame.len();
                if count>384 || bytes>512*1024 { break "Limite de sinalização excedido"; }
                let Ok(input)=serde_json::from_str::<Input>(&frame) else { break "Mensagem de sinalização inválida"; };
                match input {
                    Input::Ping=> { last_ping=Instant::now(); if !send(&mut socket,json!({"type":"pong"})).await { break "Conexão perdida"; } },
                    Input::Reauth { token }=> {
                        if token.len()>4096 { break "Credencial inválida"; }
                        let Ok(Ok((next,access)))=tokio::time::timeout(CHECK_DEADLINE,async {
                            let next=auth::authenticate(&s,&token).await?;
                            let access=checked(&s,join.channel_id,&next.claims).await?;
                            Ok::<_,crate::error::ApiError>((next,access))
                        }).await else { break "Reautenticação inválida"; };
                        if next.claims.sub!=claims.sub || next.claims.sid!=claims.sid { break "A reautenticação deve manter a mesma sessão"; }
                        claims=next.claims;
                        if !s.calls.update(id,access.can_publish,Some(claims.clone())) { break "Chamada encerrada"; }
                        if !send(&mut socket,json!({"type":"authenticated"})).await { break "Conexão perdida"; }
                    },
                    Input::Media { microphone,camera,screen,screen_audio }=> {
                        let Ok(access)=checked(&s,join.channel_id,&claims).await else { break "Acesso revogado"; };
                        let Ok(mut peers)=s.calls.0.lock() else { break "Chamada indisponível"; };
                        let Some(peer)=peers.get_mut(&id) else { break "Chamada encerrada"; };
                        peer.public.can_publish=access.can_publish;
                        peer.public.media=if access.can_publish { Media { microphone,camera,screen,screen_audio:screen_audio && screen } } else { Media::default() };
                        broadcast(&mut peers,join.channel_id);
                    },
                    Input::Signal { to,data }=> {
                        if !valid_signal(&data) || to==id { break "Destinatário ou sinalização inválida"; }
                        if data.get("description").is_some() { descriptions+=1; if descriptions>48 { break "Limite de negociação excedido"; } }
                        let target=s.calls.0.lock().ok().and_then(|peers| peers.get(&to).filter(|p| p.channel==join.channel_id).map(|p| p.claims.clone()));
                        // ICE may already be in flight when a peer leaves. Reject routing
                        // to absent/cross-channel IDs without disconnecting innocent peers
                        // or revealing whether an ID exists in another channel.
                        let Some(target)=target else { continue; };
                        let checks=tokio::join!(checked(&s,join.channel_id,&claims),checked(&s,join.channel_id,&target));
                        let Ok(sender_access)=checks.0 else { break "Acesso à sinalização não confirmado"; };
                        let Ok(target_access)=checks.1 else { s.calls.remove(to,"Acesso à chamada revogado"); continue; };
                        s.calls.update(id,sender_access.can_publish,None);
                        s.calls.update(to,target_access.can_publish,None);
                        let Ok(mut peers)=s.calls.0.lock() else { break "Chamada indisponível"; };
                        if !peers.contains_key(&id) { break "Chamada encerrada"; }
                        let Some(target)=peers.get(&to).filter(|p| p.channel==join.channel_id) else { continue; };
                        if target.outgoing.try_send(json!({"type":"signal","from":id,"data":data})).is_err() { remove(&mut peers,to,"Consumidor de sinalização lento; reconecte"); }
                    },
                }
            }
        }
    };
    s.calls.remove(id, reason);
    close(&mut socket, reason, "call_closed").await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    async fn contended_database() -> (
        AppState,
        Uuid,
        Vec<Claims>,
        Arc<AtomicU64>,
        std::path::PathBuf,
    ) {
        let directory =
            std::env::temp_dir().join(format!("harmony-call-contention-{}", Uuid::now_v7()));
        std::fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let latency = Arc::new(AtomicU64::new(0));
        let delayed = latency.clone();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .min_connections(8)
            .max_connections(8)
            .before_acquire(move |_, _| {
                let delay = delayed.load(Ordering::Relaxed);
                Box::pin(async move {
                    // Controlled pool-queue latency, not delayed SQL or a fake
                    // authorization response. All migrations/queries are real.
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    Ok(true)
                })
            })
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(directory.join("calls.db"))
                    .create_if_missing(true)
                    .foreign_keys(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        harmony_database::migrate(&pool).await.unwrap();
        let channel = Uuid::now_v7();
        sqlx::query("INSERT INTO channels(id,name,kind) VALUES($1,'Eight participants','group')")
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        let mut claims = Vec::new();
        let now = chrono::Utc::now().timestamp() as usize;
        for index in 0..8 {
            let uid = Uuid::now_v7();
            let sid = Uuid::now_v7();
            sqlx::query("INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,'Fixture','not-a-login-hash')")
                .bind(uid).bind(format!("contention_{index}")).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO sessions(id,user_id,refresh_hash,expires_at) VALUES($1,$2,$3,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))")
                .bind(sid).bind(uid).bind(format!("fixture_{index}")).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO channel_members(channel_id,user_id) VALUES($1,$2)")
                .bind(channel)
                .bind(uid)
                .execute(&pool)
                .await
                .unwrap();
            claims.push(Claims {
                sub: uid,
                sid,
                ver: 1,
                uv: 1,
                exp: now + 600,
                iat: now,
                iss: "harmony".into(),
                aud: "harmony-client".into(),
            });
        }
        let config = crate::config::Config::from_env().expect("integration test environment");
        let state = AppState::new(pool, config).await.unwrap();
        (state, channel, claims, latency, directory)
    }

    #[tokio::test]
    #[ignore = "requires HARMONY_JWT_SECRET and test storage configuration"]
    async fn eight_authorized_peers_survive_bounded_pool_contention() {
        let (state, channel, claims, latency, directory) = contended_database().await;
        latency.store(150, Ordering::Relaxed);
        let started = Instant::now();
        let results =
            futures_util::future::join_all(claims.iter().map(|c| checked(&state, channel, c)))
                .await;
        let accepted = results
            .iter()
            .filter(|r| r.as_ref().is_ok_and(|a| a.can_publish && a.guild.is_none()))
            .count();
        eprintln!(
            "authorized peers: {accepted}/8; elapsed={}ms",
            started.elapsed().as_millis()
        );
        state.pool.close().await;
        std::fs::remove_dir_all(directory).unwrap();
        assert_eq!(
            accepted, 8,
            "Valid participants must remain authorized within the existing deadline under bounded pool acquisition latency"
        );
    }

    #[tokio::test]
    #[ignore = "requires HARMONY_JWT_SECRET and test storage configuration"]
    async fn authorization_still_fails_closed_when_database_exceeds_deadline() {
        let (state, channel, claims, latency, directory) = contended_database().await;
        latency.store(650, Ordering::Relaxed);
        let started = Instant::now();
        let result = checked(&state, channel, &claims[0]).await;
        let elapsed = started.elapsed();
        eprintln!("database deadline rejected after {}ms", elapsed.as_millis());
        state.pool.close().await;
        std::fs::remove_dir_all(directory).unwrap();
        assert!(matches!(
            result,
            Err(crate::error::ApiError(Error::Unavailable(_)))
        ));
        assert!(
            elapsed < Duration::from_secs(2),
            "The bounded fail-closed guarantee must remain intact"
        );
    }
    // Contract assertions use committed SQLite state, not a mock ACL response.
    #[tokio::test]
    #[ignore = "requires HARMONY_JWT_SECRET and test storage configuration"]
    async fn access_snapshot_preserves_identity_precedence_and_fresh_revocation() {
        async fn verdict(
            s: &AppState,
            cid: Uuid,
            claims: &Claims,
        ) -> Result<(bool, Option<Uuid>), &'static str> {
            match access(s, cid, claims).await {
                Ok(a) => Ok((a.can_publish, a.guild)),
                Err(crate::error::ApiError(Error::Unauthorized)) => Err("unauthorized"),
                Err(crate::error::ApiError(Error::Forbidden)) => Err("forbidden"),
                Err(crate::error::ApiError(Error::NotFound)) => Err("not_found"),
                Err(_) => Err("database_failure"),
            }
        }
        let (state, channel, claims, _, directory) = contended_database().await;
        let valid = &claims[0];
        assert_eq!(
            verdict(&state, channel, valid).await,
            Ok((true, None)),
            "Private groups legitimately have no guild"
        );
        let missing = Uuid::now_v7();
        assert_eq!(
            verdict(&state, missing, valid).await,
            Err("forbidden"),
            "Absent ACL must deny without disclosing channel existence"
        );
        for change in 0..5 {
            let mut invalid = valid.clone();
            match change {
                0 => invalid.sid = Uuid::now_v7(),
                1 => invalid.sub = claims[1].sub,
                2 => invalid.ver += 1,
                3 => invalid.uv += 1,
                _ => invalid.exp = chrono::Utc::now().timestamp() as usize,
            }
            assert_eq!(
                verdict(&state, channel, &invalid).await,
                Err("unauthorized")
            );
            assert_eq!(
                verdict(&state, missing, &invalid).await,
                Err("unauthorized"),
                "Identity failure must precede missing channel/ACL"
            );
        }
        sqlx::query("UPDATE sessions SET version=version+1 WHERE id=$1")
            .bind(valid.sid)
            .execute(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            verdict(&state, channel, valid).await,
            Ok((true, None)),
            "Admitted claims survive legitimate refresh rotation"
        );
        for sql in [
            "UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=$1",
            "UPDATE sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=$1",
        ] {
            sqlx::query(sql)
                .bind(valid.sid)
                .execute(&state.pool)
                .await
                .unwrap();
            assert_eq!(verdict(&state, channel, valid).await, Err("unauthorized"));
            sqlx::query("UPDATE sessions SET revoked_at=NULL,expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE id=$1").bind(valid.sid).execute(&state.pool).await.unwrap();
        }
        for sql in [
            "UPDATE users SET disabled=true WHERE id=$1",
            "UPDATE users SET auth_version=auth_version+1 WHERE id=$1",
        ] {
            sqlx::query(sql)
                .bind(valid.sub)
                .execute(&state.pool)
                .await
                .unwrap();
            assert_eq!(verdict(&state, channel, valid).await, Err("unauthorized"));
            sqlx::query("UPDATE users SET disabled=false,auth_version=1 WHERE id=$1")
                .bind(valid.sub)
                .execute(&state.pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO media_mutes(channel_id,user_id) VALUES($1,$2)")
            .bind(channel)
            .bind(valid.sub)
            .execute(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            verdict(&state, channel, valid).await,
            Ok((false, None)),
            "Mute preserves reception but forbids publication"
        );
        sqlx::query("INSERT INTO media_bans(channel_id,user_id,until_at) VALUES($1,$2,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))").bind(channel).bind(valid.sub).execute(&state.pool).await.unwrap();
        assert_eq!(verdict(&state, channel, valid).await, Err("forbidden"));
        sqlx::query("UPDATE media_bans SET until_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE channel_id=$1").bind(channel).execute(&state.pool).await.unwrap();
        assert_eq!(
            verdict(&state, channel, valid).await,
            Ok((false, None)),
            "Expired ban lifts, existing mute remains authoritative"
        );
        sqlx::query("DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2")
            .bind(channel)
            .bind(valid.sub)
            .execute(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            verdict(&state, channel, valid).await,
            Err("forbidden"),
            "Every read observes committed membership removal"
        );
        sqlx::query("ALTER TABLE sessions RENAME TO unavailable_sessions")
            .execute(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            verdict(&state, channel, valid).await,
            Err("database_failure"),
            "Missing identity storage must fail closed"
        );
        state.pool.close().await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn signaling_has_bounded_typed_payloads_without_spoofable_fields() {
        assert!(valid_signal(
            &json!({"description":{"type":"offer","sdp":"v=0\r\n"}})
        ));
        assert!(valid_signal(&json!({"candidate":null})));
        for height in [0, 144, 240, 360, 480, 720, 1080, 1440, 2160] {
            assert!(valid_signal(&json!({"receive":{"screen_height":height}})));
        }
        for invalid in [
            json!({"receive":{"screen_height":999}}),
            json!({"receive":{"screen_height":720,"user_id":"forged"}}),
            json!({"receive":{"screen_height":"720"}}),
        ] {
            assert!(!valid_signal(&invalid));
        }
        assert!(valid_signal(
            &json!({"candidate":{"candidate":"candidate:test","sdpMid":"3","sdpMLineIndex":3,"usernameFragment":"test"}})
        ));
        for invalid in [
            json!({}),
            json!({"candidate":null,"from":"spoof"}),
            json!({"description":{"type":"rollback","sdp":""}}),
            json!({"candidate":{"candidate":"x","sdpMLineIndex":4}}),
            json!({"description":{"type":"offer","sdp":"x".repeat(49*1024)}}),
        ] {
            assert!(!valid_signal(&invalid));
        }
        assert!(serde_json::from_value::<Input>(json!({"type":"signal","to":Uuid::now_v7(),"from":"spoof","data":{"candidate":null}})).is_err());
    }
    #[test]
    fn full_outbound_queue_revokes_peer_without_blocking_other_receivers() {
        let channel = Uuid::now_v7();
        let mut peers = HashMap::new();
        let mut receivers = Vec::new();
        let mut cancellations = Vec::new();
        let mut ids = Vec::new();
        for index in 0..2 {
            let id = Uuid::now_v7();
            let (outgoing, receiver) = mpsc::channel(64);
            if index == 0 {
                for _ in 0..64 {
                    outgoing.try_send(json!({"type":"fixture"})).unwrap();
                }
            }
            let (cancel, cancellation) = watch::channel(None);
            peers.insert(
                id,
                Peer {
                    public: PublicPeer {
                        peer_id: id,
                        user_id: id,
                        display_name: "Fixture".into(),
                        can_publish: true,
                        media: Media::default(),
                    },
                    channel,
                    guild: None,
                    claims: Claims {
                        sub: id,
                        sid: id,
                        ver: 1,
                        uv: 1,
                        exp: usize::MAX,
                        iat: 0,
                        iss: "harmony".into(),
                        aud: "harmony-client".into(),
                    },
                    outgoing,
                    cancel,
                },
            );
            ids.push(id);
            receivers.push(receiver);
            cancellations.push(cancellation);
        }
        broadcast(&mut peers, channel);
        assert!(!peers.contains_key(&ids[0]));
        assert!(peers.contains_key(&ids[1]));
        assert!(cancellations[0].borrow().is_some());
        let mut last = None;
        while let Ok(value) = receivers[1].try_recv() {
            last = Some(value);
        }
        assert_eq!(last.unwrap()["participants"].as_array().unwrap().len(), 1);
    }
}
