//! Narrow RTC signaling gateway. The media service remains private; no Twirp,
//! arbitrary upstream, cookies or client-supplied proxy identity are forwarded.
use crate::{AppState, error::ApiResult};
use axum::{
    extract::{
        OriginalUri, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Uri, header},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use harmony_domain::Error;
use std::time::Duration;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message as UpstreamMessage, protocol::WebSocketConfig},
};

const MAX_FRAME: usize = 1_048_576;

fn target(s: &AppState, uri: &Uri, headers: &HeaderMap) -> ApiResult<(url::Url, String)> {
    endpoint(
        s.config.livekit_enabled(),
        s.config.livekit_api_url.as_deref(),
        uri,
        headers,
    )
}
fn endpoint(
    enabled: bool,
    base: Option<&str>,
    uri: &Uri,
    headers: &HeaderMap,
) -> ApiResult<(url::Url, String)> {
    if !enabled
        || !matches!(
            uri.path(),
            "/rtc" | "/rtc/v1" | "/rtc/validate" | "/rtc/v1/validate"
        )
    {
        return Err(Error::NotFound.into());
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > 16_384 {
        return Err(Error::Unauthorized.into());
    }
    let tokens: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == "access_token")
        .map(|(_, token)| token.into_owned())
        .collect();
    if tokens.len() > 1 {
        return Err(Error::Unauthorized.into());
    }
    let authorization = headers
        .get(header::AUTHORIZATION)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|v| v.strip_prefix("Bearer "))
                .ok_or(Error::Unauthorized)
        })
        .transpose()?;
    if authorization.is_some_and(|v| tokens.first().is_some_and(|q| q != v)) {
        return Err(Error::Unauthorized.into());
    }
    let token = authorization
        .map(str::to_owned)
        .or_else(|| tokens.into_iter().next())
        .filter(|v| !v.is_empty() && v.len() <= 8192)
        .ok_or(Error::Unauthorized)?;
    // This deployment runs its SFU in the same sandbox. Deliberately accept only
    // a configured loopback HTTP origin; request headers cannot select a host.
    let mut upstream =
        url::Url::parse(base.ok_or(Error::Forbidden)?).map_err(|_| Error::Internal)?;
    if upstream.scheme() != "http"
        || !matches!(upstream.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
            && !matches!(upstream.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback())
        || !upstream.username().is_empty()
        || upstream.password().is_some()
        || upstream.query().is_some()
        || upstream.fragment().is_some()
        || !matches!(upstream.path(), "" | "/")
    {
        return Err(Error::Unavailable("Gateway de mídia requer origem local".into()).into());
    }
    upstream.set_path(uri.path());
    let filtered: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key != "access_token")
        .collect();
    upstream
        .query_pairs_mut()
        .clear()
        .extend_pairs(filtered)
        .append_pair("access_token", &token);
    Ok((upstream, token))
}

pub async fn signal(
    State(s): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> ApiResult<Response> {
    let (mut upstream, token) = target(&s, &uri, &headers)?;
    if uri.path().ends_with("/validate") {
        let _admission = crate::media::admit_token_guard(&s, &token).await?;
        let response = s
            .http
            .get(upstream)
            .send()
            .await
            .map_err(|_| Error::Unavailable("Servidor de mídia indisponível".into()))?;
        let status = response.status();
        // Validation is a bounded status probe, not a general-purpose HTTP proxy.
        return Ok((
            status,
            if status.is_success() {
                "OK"
            } else {
                "Media admission failed"
            },
        )
            .into_response());
    }
    let upgrade = upgrade.map_err(|_| Error::Forbidden)?;
    let admission = crate::media::admit_token_guard(&s, &token).await?;
    upstream.set_scheme("ws").map_err(|_| Error::Internal)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME))
        .max_write_buffer_size(MAX_FRAME * 2);
    let (mut remote, _) = tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_with_config(upstream.as_str(), Some(config), true),
    )
    .await
    .map_err(|_| Error::Unavailable("Tempo de conexão de mídia excedido".into()))?
    .map_err(|_| Error::Unavailable("Servidor de mídia indisponível".into()))?;
    // LiveKit sends JoinResponse/ResumeResponse first. Keep identity serialization
    // until the upstream actually admitted this socket, closing the mute/join gap.
    let initial = tokio::time::timeout(Duration::from_secs(10), remote.next())
        .await
        .map_err(|_| Error::Unavailable("Mídia não confirmou a conexão".into()))?
        .transpose()
        .map_err(|_| Error::Unavailable("Mídia não confirmou a conexão".into()))?
        .ok_or(Error::Unavailable("Mídia encerrou a conexão".into()))?;
    if !matches!(
        initial,
        UpstreamMessage::Binary(_) | UpstreamMessage::Text(_)
    ) {
        return Err(Error::Forbidden.into());
    }
    if let Err(error) = admission.recheck(&s).await {
        let _ = remote.close(None).await;
        return Err(error);
    }
    drop(admission);
    Ok(upgrade
        .max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| async move { forward(socket, remote, initial).await })
        .into_response())
}

async fn forward(
    mut client: WebSocket,
    mut remote: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    initial: UpstreamMessage,
) {
    let first = match initial {
        UpstreamMessage::Binary(v) => Message::Binary(v),
        UpstreamMessage::Text(v) => Message::Text(v.as_str().into()),
        _ => return,
    };
    if client.send(first).await.is_err() {
        let _ = remote.close(None).await;
        return;
    }
    loop {
        tokio::select! {
            incoming = client.next() => {
                let Some(Ok(message)) = incoming else { break };
                let message = match message { Message::Binary(v) => UpstreamMessage::Binary(v), Message::Text(v) => UpstreamMessage::Text(v.as_str().into()), Message::Ping(v) => UpstreamMessage::Ping(v), Message::Pong(v) => UpstreamMessage::Pong(v), Message::Close(_) => break };
                if !matches!(tokio::time::timeout(Duration::from_secs(10), remote.send(message)).await, Ok(Ok(()))) { break; }
            }
            incoming = remote.next() => {
                let Some(Ok(message)) = incoming else { break };
                let message = match message { UpstreamMessage::Binary(v) => Message::Binary(v), UpstreamMessage::Text(v) => Message::Text(v.as_str().into()), UpstreamMessage::Ping(v) => Message::Ping(v), UpstreamMessage::Pong(v) => Message::Pong(v), UpstreamMessage::Close(_) => break, UpstreamMessage::Frame(_) => continue };
                if !matches!(tokio::time::timeout(Duration::from_secs(10), client.send(message)).await, Ok(Ok(()))) { break; }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), remote.close(None)).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), client.send(Message::Close(None))).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_rtc_paths_can_reach_the_loopback_service() {
        for path in ["/rtc", "/rtc/v1", "/rtc/validate", "/rtc/v1/validate"] {
            let uri = format!("{path}?access_token=jwt&sdk=js&protocol=15")
                .parse()
                .unwrap();
            let (url, token) =
                endpoint(true, Some("http://127.0.0.1:7880"), &uri, &HeaderMap::new()).unwrap();
            assert_eq!(url.path(), path);
            assert_eq!(url.host_str(), Some("127.0.0.1"));
            assert_eq!(token, "jwt");
            assert_eq!(
                url.query_pairs()
                    .filter(|(k, _)| k == "access_token")
                    .count(),
                1
            );
            assert!(
                endpoint(
                    false,
                    Some("http://127.0.0.1:7880"),
                    &uri,
                    &HeaderMap::new()
                )
                .is_err()
            );
        }
        for path in [
            "/twirp/livekit.RoomService/DeleteRoom",
            "/rtc/../twirp",
            "/rtc/v2",
            "/rtc/",
        ] {
            assert!(
                endpoint(
                    true,
                    Some("http://127.0.0.1:7880"),
                    &format!("{path}?access_token=jwt").parse().unwrap(),
                    &HeaderMap::new()
                )
                .is_err()
            );
        }
    }
    #[test]
    fn conflicting_or_ambiguous_credentials_fail_closed() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer other".parse().unwrap());
        for query in [
            "access_token=jwt",
            "access_token=other&access_token=other",
            "access_token=other&access%5ftoken=other",
        ] {
            assert!(
                endpoint(
                    true,
                    Some("http://127.0.0.1:7880"),
                    &format!("/rtc?{query}").parse().unwrap(),
                    &headers
                )
                .is_err()
            );
        }
        let (url, token) = endpoint(
            true,
            Some("http://127.0.0.1:7880"),
            &"/rtc?sdk=js".parse().unwrap(),
            &headers,
        )
        .unwrap();
        assert_eq!(token, "other");
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "access_token")
                .unwrap()
                .1,
            "other"
        );
    }
    #[test]
    fn headers_and_query_cannot_select_a_nonlocal_upstream() {
        let uri = "/rtc?access_token=jwt&host=169.254.169.254"
            .parse()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "169.254.169.254".parse().unwrap());
        headers.insert("x-forwarded-host", "attacker.invalid".parse().unwrap());
        for base in [
            "http://localhost:7880",
            "http://169.254.169.254",
            "https://127.0.0.1:7880",
            "http://127.0.0.1:7880/private",
            "http://user:pw@127.0.0.1:7880",
            "http://127.0.0.1:7880?next=x",
        ] {
            assert!(
                endpoint(true, Some(base), &uri, &headers).is_err(),
                "{base}"
            );
        }
        for base in ["http://127.0.0.1:7880", "http://[::1]:7880"] {
            assert!(endpoint(true, Some(base), &uri, &headers).is_ok());
        }
    }
}
