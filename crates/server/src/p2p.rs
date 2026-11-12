//! Opt-in, short-lived network probes. Production calls still use LiveKit.
//! Only SDP/ICE and application ping are relayed; none is persisted or logged.
use crate::{
    AppState,
    auth::{self, Auth, Claims},
    db,
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
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use uuid::Uuid;

const LIFETIME: Duration = Duration::from_secs(120);
const MAX_PROBES: usize = 64;

#[derive(Clone, Default)]
pub struct ProbeRegistry(Arc<Mutex<HashMap<String, Probe>>>);
struct Peer {
    claims: Claims,
    tx: Option<mpsc::Sender<Value>>,
}
struct Probe {
    channel: Uuid,
    host_name: String,
    expires: Instant,
    owner: Peer,
    guest: Option<Peer>,
    offered: bool,
    answered: bool,
}
impl ProbeRegistry {
    fn close(&self, id: &str, reason: &str) -> Option<Uuid> {
        if let Ok(mut probes) = self.0.lock()
            && let Some(probe) = probes.remove(id)
        {
            for peer in [Some(probe.owner), probe.guest].into_iter().flatten() {
                if let Some(tx) = peer.tx {
                    let _ = tx.try_send(json!({"type":"closed","reason":reason}));
                }
            }
            return Some(probe.channel);
        }
        None
    }
}

fn changed(s: &AppState, cid: Uuid) {
    // Discovery details require a fresh authenticated GET, not a broadcast.
    let _ = s
        .events
        .send(json!({"type":"p2p.changed","channel_id":cid}));
}

fn close(s: &AppState, id: &str, reason: &str) {
    if let Some(cid) = s.p2p.close(id, reason) {
        changed(s, cid);
    }
}

async fn eligible(s: &AppState, cid: Uuid, claims: &Claims) -> ApiResult<()> {
    if !s.config.p2p_enabled {
        return Err(Error::NotFound.into());
    }
    auth::recheck(s, claims).await?;
    db::require_permission(&s.pool, cid, claims.sub, p::VIEW | p::CONNECT | p::PUBLISH).await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    if !matches!(kind.as_str(), "voice" | "dm" | "group") {
        return Err(Error::Forbidden.into());
    }
    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_mutes WHERE channel_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM media_bans WHERE channel_id=$1 AND user_id=$2 AND julianday(until_at)>julianday('now'))")
        .bind(cid).bind(claims.sub).fetch_one(&s.pool).await?;
    if blocked {
        return Err(Error::Forbidden.into());
    }
    Ok(())
}

pub async fn info(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    eligible(&s, cid, &a.claims).await?;
    s.limit(&format!("p2p-discovery:{}", a.user.id), 90, 60)?;
    let candidates = {
        let probes = s.p2p.0.lock().map_err(|_| Error::Internal)?;
        probes
            .iter()
            .filter(|(_, probe)| {
                probe.channel == cid
                    && probe.expires > Instant::now()
                    && probe.guest.is_none()
                    && probe.owner.claims.sub != a.user.id
                    && probe.owner.tx.as_ref().is_some_and(|tx| !tx.is_closed())
            })
            .map(|(id, probe)| {
                (
                    id.clone(),
                    probe.owner.claims.clone(),
                    probe.host_name.clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    let mut available = Vec::new();
    for (id, owner, host_name) in candidates {
        if eligible(&s, cid, &owner).await.is_err() {
            continue;
        }
        // The creator may leave or another participant may take the seat during
        // the database check. Never hold the registry mutex across an await.
        let probes = s.p2p.0.lock().map_err(|_| Error::Internal)?;
        if let Some(probe) = probes.get(&id)
            && probe.expires > Instant::now()
            && probe.guest.is_none()
            && probe.owner.tx.as_ref().is_some_and(|tx| !tx.is_closed())
        {
            available.push(json!({"id":id,"host_name":host_name,
                "expires_in":probe.expires.saturating_duration_since(Instant::now()).as_secs()}));
        }
    }
    Ok(Json(
        json!({"enabled":true,"duration_seconds":LIFETIME.as_secs(),"stun_configured":!s.config.p2p_stun_urls.is_empty(),"relay_configured":false,"available":available}),
    ))
}

pub async fn create(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    eligible(&s, cid, &a.claims).await?;
    s.limit(&format!("p2p-create:{}", a.user.id), 6, 60)?;
    let id = auth::random_token();
    let mut probes = s.p2p.0.lock().map_err(|_| Error::Internal)?;
    probes.retain(|_, probe| probe.expires > Instant::now());
    if probes.len() >= MAX_PROBES {
        return Err(Error::RateLimited.into());
    }
    if probes.values().any(|probe| {
        probe.owner.claims.sub == a.user.id
            || probe
                .guest
                .as_ref()
                .is_some_and(|peer| peer.claims.sub == a.user.id)
    }) {
        return Err(
            Error::Conflict("Encerre o teste P2P anterior antes de iniciar outro".into()).into(),
        );
    }
    probes.insert(
        id.clone(),
        Probe {
            channel: cid,
            host_name: a.user.display_name.clone(),
            expires: Instant::now() + LIFETIME,
            owner: Peer {
                claims: a.claims,
                tx: None,
            },
            guest: None,
            offered: false,
            answered: false,
        },
    );
    Ok(Json(json!({"probe_id":id,"expires_in":LIFETIME.as_secs()})))
}

pub async fn upgrade(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(24 * 1024)
        .max_frame_size(24 * 1024)
        .on_upgrade(move |socket| session(socket, s))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Join {
    r#type: String,
    token: String,
    probe_id: String,
    channel_id: Uuid,
}

async fn reject(socket: &mut WebSocket) {
    let _ = socket
        .send(Message::Text(
            json!({"type":"closed","reason":"Entrada não autorizada ou teste indisponível"})
                .to_string()
                .into(),
        ))
        .await;
    let _ = socket.send(Message::Close(None)).await;
}

async fn session(mut socket: WebSocket, s: AppState) {
    let Ok(Some(Ok(Message::Text(frame)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    let Ok(join) = serde_json::from_str::<Join>(&frame) else {
        reject(&mut socket).await;
        return;
    };
    if join.r#type != "auth"
        || join.probe_id.len() != 64
        || !join.probe_id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        reject(&mut socket).await;
        return;
    }
    let Ok(a) = auth::authenticate(&s, &join.token).await else {
        reject(&mut socket).await;
        return;
    };
    if eligible(&s, join.channel_id, &a.claims).await.is_err() {
        reject(&mut socket).await;
        return;
    }
    let owner_claims = s.p2p.0.lock().ok().and_then(|probes| {
        probes
            .get(&join.probe_id)
            .map(|probe| probe.owner.claims.clone())
    });
    let Some(owner_claims) = owner_claims else {
        reject(&mut socket).await;
        return;
    };
    if eligible(&s, join.channel_id, &owner_claims).await.is_err() {
        reject(&mut socket).await;
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Value>(32);
    let admitted = {
        if let Ok(mut probes) = s.p2p.0.lock() {
            let already_busy = probes.iter().any(|(id, probe)| {
                id != &join.probe_id
                    && probe.expires > Instant::now()
                    && (probe.owner.claims.sub == a.user.id
                        || probe
                            .guest
                            .as_ref()
                            .is_some_and(|peer| peer.claims.sub == a.user.id))
            });
            if already_busy {
                None
            } else {
                probes.get_mut(&join.probe_id).and_then(|probe| {
                    if probe.channel != join.channel_id || probe.expires <= Instant::now() {
                        return None;
                    }
                    let owner =
                        probe.owner.claims.sub == a.user.id && probe.owner.claims.sid == a.sid;
                    if owner {
                        if probe.owner.tx.is_some() {
                            return None;
                        }
                        probe.owner.tx = Some(tx.clone());
                    } else {
                        if probe.owner.claims.sub == a.user.id
                            || probe.guest.is_some()
                            || !probe.owner.tx.as_ref().is_some_and(|tx| !tx.is_closed())
                        {
                            return None;
                        }
                        probe.guest = Some(Peer {
                            claims: a.claims.clone(),
                            tx: Some(tx.clone()),
                        });
                    }
                    Some((owner, probe.expires))
                })
            }
        } else {
            None
        }
    };
    let Some((owner, expires)) = admitted else {
        reject(&mut socket).await;
        return;
    };
    let ready = json!({"type":"ready","role":if owner {"offerer"} else {"answerer"},"expires_in":expires.saturating_duration_since(Instant::now()).as_secs(),"ice_servers":s.config.p2p_stun_urls.iter().map(|url| json!({"urls":url})).collect::<Vec<_>>()});
    if socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        close(&s, &join.probe_id, "Participante desconectado");
        return;
    }
    changed(&s, join.channel_id);
    if !owner
        && let Ok(probes) = s.p2p.0.lock()
        && let Some(peer) = probes.get(&join.probe_id).and_then(|p| p.owner.tx.as_ref())
    {
        let _ = peer.try_send(json!({"type":"peer-ready"}));
    }
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut signals = 0;
    // The outer deadline also bounds database checks and WebSocket backpressure.
    let exchange = async {
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    let claims = if let Ok(probes) = s.p2p.0.lock() {
                        probes.get(&join.probe_id).map(|probe| [Some(probe.owner.claims.clone()), probe.guest.as_ref().map(|p|p.claims.clone())])
                    } else { None };
                    let Some(claims) = claims else { break };
                    let mut invalid = false;
                    for claims in claims.into_iter().flatten() { if eligible(&s, join.channel_id, &claims).await.is_err() { invalid = true; break; } }
                    if invalid { break; }
                }
                outgoing = rx.recv() => {
                    let Some(value) = outgoing else { break };
                    let closed = value["type"] == "closed";
                    if socket.send(Message::Text(value.to_string().into())).await.is_err() || closed { break; }
                }
                incoming = socket.recv() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if eligible(&s, join.channel_id, &a.claims).await.is_err() { break; }
                            let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                            if value["type"] == "ping" {
                                let Some(seq) = value["seq"].as_u64() else { break };
                                if s.limit(&format!("p2p-ping:{}",a.user.id),150,60).is_err() { break; }
                                if socket.send(Message::Text(json!({"type":"pong","seq":seq}).to_string().into())).await.is_err() { break; }
                                continue;
                            }
                            signals += 1;
                            if signals > 80 || !valid_signal(&value, owner) { break; }
                            let destination = {
                                if let Ok(mut probes) = s.p2p.0.lock() {
                                    probes.get_mut(&join.probe_id).and_then(|probe| {
                                        if value["type"] == "description" {
                                            let seen = if owner { &mut probe.offered } else { &mut probe.answered };
                                            if *seen { return None; } *seen = true;
                                        }
                                        (if owner { probe.guest.as_ref() } else { Some(&probe.owner) }).and_then(|p| p.tx.clone().map(|tx|(tx,p.claims.clone())))
                                    })
                                } else { None }
                            };
                            let Some((destination, recipient)) = destination else { break };
                            if eligible(&s, join.channel_id, &recipient).await.is_err() || destination.try_send(value).is_err() { break; }
                        }
                        Some(Ok(Message::Ping(value))) => { if socket.send(Message::Pong(value)).await.is_err() { break; } }
                        Some(Ok(Message::Pong(_))) => {}
                        _ => break,
                    }
                }
            }
        }
    };
    let _ = tokio::time::timeout_at(expires.into(), exchange).await;
    close(
        &s,
        &join.probe_id,
        "Teste encerrado, expirado ou permissão alterada",
    );
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        let _ = socket
            .send(Message::Text(
                json!({"type":"closed","reason":"Teste encerrado, expirado ou permissão alterada"})
                    .to_string()
                    .into(),
            ))
            .await;
        let _ = socket.send(Message::Close(None)).await;
    })
    .await;
}

fn valid_signal(value: &Value, owner: bool) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 2 {
        return false;
    }
    match value["type"].as_str() {
        Some("description") => {
            let Some(description) = value["description"].as_object() else {
                return false;
            };
            let Some(sdp) = value["description"]["sdp"].as_str() else {
                return false;
            };
            description.len() == 2
                && value["description"]["type"] == if owner { "offer" } else { "answer" }
                && sdp.len() <= 16 * 1024
                && sdp.starts_with("v=0")
                && !sdp.lines().any(|line| line.starts_with("m=audio"))
                && sdp
                    .lines()
                    .filter(|line| line.starts_with("m=video"))
                    .count()
                    <= 1
                && sdp
                    .lines()
                    .filter(|line| line.starts_with("m=application"))
                    .count()
                    == 1
        }
        Some("ice") => {
            let Some(candidate) = value["candidate"].as_object() else {
                return false;
            };
            candidate.len() <= 4
                && candidate.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "candidate" | "sdpMid" | "sdpMLineIndex" | "usernameFragment"
                    )
                })
                && value["candidate"]["candidate"]
                    .as_str()
                    .is_some_and(|c| c.len() <= 2048 && c.starts_with("candidate:"))
                && ["sdpMid", "usernameFragment"].iter().all(|key| {
                    value["candidate"][*key].is_null()
                        || value["candidate"][*key]
                            .as_str()
                            .is_some_and(|s| s.len() <= 256)
                })
                && (value["candidate"]["sdpMLineIndex"].is_null()
                    || value["candidate"]["sdpMLineIndex"]
                        .as_u64()
                        .is_some_and(|n| n <= 2))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_rejects_audio_and_wrong_signaling_role() {
        let description = json!({"type":"description","description":{"type":"offer","sdp":"v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}});
        assert!(valid_signal(&description, true));
        assert!(!valid_signal(&description, false));
        let mut audio = description.clone();
        audio["description"]["sdp"] = json!(format!(
            "{}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
            audio["description"]["sdp"].as_str().unwrap()
        ));
        assert!(!valid_signal(&audio, true));
        let mut injected = description.clone();
        injected["recipient"] = json!("another-channel");
        assert!(!valid_signal(&injected, true));
    }
    #[test]
    fn probe_rejects_unbounded_candidates() {
        let ice = json!({"type":"ice","candidate":{"candidate":"candidate:1 1 udp 1 127.0.0.1 9000 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"test"}});
        assert!(valid_signal(&ice, true));
        let mut invalid = ice.clone();
        invalid["candidate"]["candidate"] = json!("x".repeat(3000));
        assert!(!valid_signal(&invalid, true));
        invalid = ice.clone();
        invalid["candidate"]["sdpMLineIndex"] = json!(-1);
        assert!(!valid_signal(&invalid, true));
    }
}
