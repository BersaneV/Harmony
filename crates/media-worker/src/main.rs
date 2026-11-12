use harmony_media_worker::{Config, Worker};
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "harmony_media_worker=info".into()),
        )
        .init();
    let mode = std::env::args().nth(1).unwrap_or_default();
    if !matches!(mode.as_str(), "" | "--once" | "--drain" | "--check-sandbox") {
        eprintln!("usage: harmony-media-worker [--once|--drain|--check-sandbox]");
        std::process::exit(2)
    }
    let result=async {
  let config=Config::from_env()?;
  harmony_media_worker::check_sandbox(&config).await?;
  if mode=="--check-sandbox" {tracing::info!("parser sandbox ready");return Ok(())}
  let worker=Worker::connect(config).await?;
  loop {
   worker.cleanup().await?;
   let worked=worker.run_once().await?;
   if mode=="--once" || (mode=="--drain" && !worked){break}
   if !worked {tokio::select!{_ = tokio::time::sleep(std::time::Duration::from_secs(2))=>{},_ = tokio::signal::ctrl_c()=>break}}
  }
  Ok::<(),harmony_media_worker::Failure>(())
 }.await;
    if let Err(e) = result {
        tracing::error!(code = e.code, "worker stopped");
        std::process::exit(1)
    }
}
