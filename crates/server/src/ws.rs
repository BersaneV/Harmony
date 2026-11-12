use crate::{AppState, auth, db};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;

pub async fn upgrade(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| session(socket, s))
}
async fn typing(s: &AppState, a: &auth::Auth, text: &str) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("typing") {
        return;
    }
    let Some(cid) = value
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
    else {
        return;
    };
    if db::channel_access(&s.pool, cid, a.user.id).await.is_ok() {
        s.events
            .send(json!({"type":"typing","channel_id":cid,"user_id":a.user.id}))
            .ok();
    }
}
async fn permitted_event(s: &AppState, a: &auth::Auth, mut event: Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) == Some("session.revoked") {
        return None;
    }
    if let Some(cid) = event
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
    {
        if db::channel_access(&s.pool, cid, a.user.id).await.is_err() {
            return None;
        }
        if let Some(id) = event
            .get("message_id")
            .and_then(Value::as_str)
            .and_then(|v| v.parse().ok())
        {
            event["message"] = json!(db::message(&s.pool, id, a.user.id).await.ok()?);
        }
    }
    Some(event)
}
async fn session(mut socket: WebSocket, s: AppState) {
    let first = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if frame.get("type").and_then(Value::as_str) != Some("auth") {
        return;
    }
    let Some(token) = frame.get("token").and_then(Value::as_str) else {
        return;
    };
    let Ok(a) = auth::authenticate(&s, token).await else {
        return;
    };
    let mut events = s.events.subscribe();
    if socket
        .send(Message::Text(
            json!({"type":"ready","version":1}).to_string().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let (mut send, mut recv) = socket.split();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if auth::recheck(&s,&a.claims).await.is_err() {
                    let _=send.send(Message::Close(None)).await;
                    break;
                }
                if send.send(Message::Ping(vec![].into())).await.is_err() {break}
            },
            incoming=recv.next()=>{
                match incoming {
                    Some(Ok(Message::Text(text)))=>{
                        if auth::recheck(&s,&a.claims).await.is_err() {break}
                        if s.limit(&format!("ws:{}",a.user.id),60,60).is_err() {break}
                        typing(&s,&a,&text).await;
                    },
                    Some(Ok(Message::Ping(value)))=>{
                        if send.send(Message::Pong(value)).await.is_err() {break}
                    },
                    Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                    _=>{}
                }
            },
            event=events.recv()=>{
                if auth::recheck(&s,&a.claims).await.is_err() {
                    let _=send.send(Message::Close(None)).await;
                    break;
                }
                match event {
                    Ok(event)=>{
                        let Some(event)=permitted_event(&s,&a,event).await else {continue};
                        if send.send(Message::Text(event.to_string().into())).await.is_err() {break}
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{
                        if send.send(Message::Text(json!({"type":"resync"}).to_string().into())).await.is_err() {break}
                    },
                    Err(_)=>break,
                }
            }
        }
    }
}
