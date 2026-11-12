mod acl;
mod admin;
mod auth;
mod chat;
mod community;
pub mod config;
mod db;
mod error;
mod media;
mod p2p;
mod uploads;
mod ws;
use crate::{
    config::Config,
    error::{ApiError, ApiResult},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use harmony_domain::Error;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, broadcast};
#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub store: Arc<harmony_storage::Store>,
    pub file_slots: Arc<Semaphore>,
    pub p2p: p2p::ProbeRegistry,
    pub config: Arc<Config>,
    pub events: broadcast::Sender<Value>,
    pub password_slots: Arc<Semaphore>,
    pub dummy_hash: String,
    pub http: reqwest::Client,
    limits: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}
impl AppState {
    pub async fn new(pool: SqlitePool, config: Config) -> ApiResult<Self> {
        let (events, _) = broadcast::channel(512);
        let store = harmony_storage::Store::new(&config.storage).map_err(|_| Error::Internal)?;
        let mut s = Self {
            pool,
            store: Arc::new(store),
            file_slots: Arc::new(Semaphore::new(4)),
            p2p: Default::default(),
            config: Arc::new(config),
            events,
            password_slots: Arc::new(Semaphore::new(2)),
            dummy_hash: String::new(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| Error::Internal)?,
            limits: Default::default(),
        };
        s.dummy_hash = auth::password_hash(&s, auth::random_token()).await?;
        Ok(s)
    }
    pub fn limit(&self, key: &str, max: u32, window: u64) -> ApiResult<()> {
        let mut limits = self.limits.lock().map_err(|_| Error::Internal)?;
        let now = Instant::now();
        if limits.len() > 10000 {
            limits.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(3600));
            if limits.len() > 10000 {
                return Err(Error::RateLimited.into());
            }
        }
        let entry = limits.entry(key.into()).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(window) {
            *entry = (now, 0)
        }
        if entry.1 >= max {
            return Err(Error::RateLimited.into());
        }
        entry.1 += 1;
        Ok(())
    }
}
async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    let ip = if std::env::var("HARMONY_TRUST_PROXY").as_deref() == Ok("true")
        && peer.is_some_and(|p| p.is_loopback())
    {
        req.headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse::<std::net::IpAddr>().ok())
            .or(peer)
    } else {
        peer
    }
    .map(|v| v.to_string())
    .unwrap_or_else(|| "local".into());
    let login = req.uri().path().starts_with("/api/auth/");
    if let Err(e) = s.limit(
        &format!("http:{}:{ip}", if login { "auth" } else { "app" }),
        if login { 60 } else { 1200 },
        60,
    ) {
        return e.into_response();
    }
    let response = next.run(req).await;
    if response.status().is_client_error()
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"))
    {
        return (response.status(),Json(json!({"error":{"code":"invalid_request","message":"Requisição inválida: confira formato, campos e limites"}}))).into_response();
    }
    response
}
async fn health(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&s.pool).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn instance(State(s): State<AppState>) -> Json<Value> {
    Json(
        json!({"name":s.config.instance_name,"registration":"invite","max_upload_bytes":s.config.max_upload,"max_video_bitrate":s.config.max_bitrate,"version":env!("CARGO_PKG_VERSION")}),
    )
}
pub fn router(s: AppState) -> Router {
    let origins = s
        .config
        .public_origin
        .split(',')
        .filter_map(|v| v.trim().parse::<HeaderValue>().ok())
        .collect::<Vec<_>>();
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::PUT,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let mut routes = Router::new();
    if let Some(web) = &s.config.web_dir {
        routes = routes
            .route_service(
                "/",
                tower_http::services::ServeFile::new(web.join("index.html")),
            )
            .route_service(
                "/harmony.svg",
                tower_http::services::ServeFile::new(web.join("harmony.svg")),
            )
            .nest_service(
                "/assets",
                tower_http::services::ServeDir::new(web.join("assets")),
            );
    }
    routes
        .route("/health", get(health))
        .route("/api/instance", get(instance))
        .route("/api/internal/media-admit", get(media::admit))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/refresh", post(auth::refresh))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/reset", post(auth::reset))
        .route("/api/me", get(auth::me).patch(auth::update_me))
        .route(
            "/api/guilds",
            get(community::guilds).post(community::create_guild),
        )
        .route("/api/guilds/{id}/members", get(community::members))
        .route(
            "/api/guilds/{id}/members/{user_id}",
            patch(community::update_member).delete(community::remove_member),
        )
        .route(
            "/api/guilds/{id}/channels",
            get(community::channels).post(community::create_channel),
        )
        .route("/api/guilds/{id}/invites", post(community::guild_invite))
        .route("/api/invites/accept", post(community::accept_invite))
        .route(
            "/api/guilds/{id}/roles",
            get(acl::roles).post(acl::create_role),
        )
        .route(
            "/api/roles/{id}",
            patch(acl::update_role).delete(acl::delete_role),
        )
        .route(
            "/api/guilds/{id}/members/{user_id}/roles/{role_id}",
            put(acl::assign_role).delete(acl::unassign_role),
        )
        .route(
            "/api/channels/{id}/permissions",
            get(acl::overrides).put(acl::set_override),
        )
        .route("/api/users/search", get(community::users_search))
        .route(
            "/api/friends",
            get(community::friends).post(community::add_friend),
        )
        .route("/api/friends/{id}/accept", post(community::accept_friend))
        .route(
            "/api/friends/{id}",
            axum::routing::delete(community::remove_friend),
        )
        .route(
            "/api/conversations",
            get(community::conversations).post(community::create_conversation),
        )
        .route(
            "/api/channels/{id}/messages",
            get(chat::history).post(chat::send),
        )
        .route("/api/messages/{id}", patch(chat::edit).delete(chat::delete))
        .route(
            "/api/messages/{id}/reactions/{emoji}",
            put(chat::add_reaction).delete(chat::remove_reaction),
        )
        .route("/api/channels/{id}/read", post(chat::mark_read))
        .route("/api/search", get(chat::search))
        .route("/api/ws", get(ws::upgrade))
        .route(
            "/api/channels/{id}/p2p-probes",
            get(p2p::info).post(p2p::create),
        )
        .route("/api/p2p/ws", get(p2p::upgrade))
        .route("/api/channels/{id}/media-token", post(media::token))
        .route("/api/channels/{id}/moderate", post(media::moderate))
        .route("/api/channels/{id}/uploads", post(uploads::reserve))
        .route(
            "/api/files/{id}/{kind}",
            get(uploads::file_get).put(uploads::file_put),
        )
        .route("/api/uploads/{id}/complete", post(uploads::complete))
        .route("/api/uploads/{id}/download", get(uploads::download))
        .route("/api/uploads/{id}/media", get(uploads::media_status))
        .route(
            "/api/uploads/{id}/derivatives/{kind}",
            get(uploads::derivative),
        )
        .route("/api/admin/users", get(admin::users))
        .route("/api/admin/users/{id}", patch(admin::update_user))
        .route("/api/admin/users/{id}/reset", post(admin::reset_user))
        .route("/api/admin/invites", post(admin::invites))
        .route("/api/admin/audit", get(admin::audit))
        .route("/api/admin/stats", get(admin::stats))
        .fallback(|| async { ApiError(Error::NotFound) })
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn_with_state(s.clone(), guard))
        .layer(cors)
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::if_not_present(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            ),
        )
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::if_not_present(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        )
        .with_state(s)
}
pub async fn initialize(s: &AppState) -> ApiResult<()> {
    harmony_database::migrate(&s.pool).await.map_err(|e| {
        tracing::error!(error=%e,"migration failed");
        Error::Internal
    })?;
    auth::bootstrap(s).await
}
pub fn background(s: AppState) {
    tokio::spawn(chat::dispatch_outbox(s.clone()));
    tokio::spawn(media::reconcile(s.clone()));
    tokio::spawn(uploads::cleanup(s));
}
