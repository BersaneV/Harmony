use harmony_server::{AppState, config::Config};
use sqlx::postgres::PgPoolOptions;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "harmony_server=info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let bind = config.bind.clone();
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    let state = AppState::new(pool, config).await.map_err(|e| e.0)?;
    harmony_server::initialize(&state).await.map_err(|e| e.0)?;
    harmony_server::background(state.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address=%bind,"Harmony API ready");
    axum::serve(
        listener,
        harmony_server::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        tokio::signal::ctrl_c().await.ok();
    })
    .await?;
    Ok(())
}
