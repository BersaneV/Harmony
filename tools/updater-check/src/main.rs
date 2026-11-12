//! Exercises the official updater's check/download verification with MockRuntime.
//! Deliberately has no install call and never executes downloaded bytes.
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri_plugin_updater::UpdaterExt;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if !(4..=6).contains(&args.len()) {
        eprintln!(
            "usage: harmony-updater-check LOOPBACK_MANIFEST_URL PUBLIC_KEY_FILE CURRENT_VERSION [MAX_BYTES] [cancel-after-chunk]"
        );
        std::process::exit(2);
    }
    // Keep the probe local; real signed artifacts can be mirrored by the test
    // HTTP server without introducing an installation or arbitrary network path.
    let endpoint: tauri::Url = args[1].parse().expect("manifest URL");
    if endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || endpoint.port().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        eprintln!("probe requires an isolated loopback manifest");
        std::process::exit(2);
    }
    let pubkey = std::fs::read_to_string(Path::new(&args[2])).expect("read public key");
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().version = args[3].parse().expect("current semver");
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": pubkey.trim(),
            "endpoints": [args[1]],
            "requireSignedVersion": true,
            "allowDowngrades": false,
            // Only this synthetic, loopback-only harness permits HTTP.
            "dangerousInsecureTransportProtocol": true
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .expect("mock runtime");
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .target("windows-x86_64-nsis")
        .build()
        .expect("updater builder");
    let cap = args.get(4).map(|v| v.parse::<u64>().expect("byte cap"));
    let downloaded = AtomicU64::new(0);
    let cancel = CancellationToken::new();
    let cancel_after_chunk = args
        .get(5)
        .is_some_and(|value| value == "cancel-after-chunk");
    let outcome = match updater.check().await {
        Ok(None) => serde_json::json!({"status":"no_update"}),
        Ok(Some(update)) if update.download_url.origin() != endpoint.origin() => {
            serde_json::json!({"status":"rejected","error":"probe requires loopback artifact on manifest origin"})
        }
        Ok(Some(update)) => {
            let future = update.download_with_limit(
                cap.unwrap_or(128 * 1024 * 1024),
                |chunk, total| {
                    let observed =
                        downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                    if cancel_after_chunk
                        || cap.is_some_and(|max| observed > max || total.is_some_and(|n| n > max))
                    {
                        cancel.cancel();
                    }
                },
                || {},
            );
            tokio::select! { biased;
                _ = cancel.cancelled() => serde_json::json!({"status":"cancelled","downloaded":downloaded.load(Ordering::Relaxed)}),
                result = future => match result {
                    _ if cancel.is_cancelled() => serde_json::json!({"status":"cancelled","downloaded":downloaded.load(Ordering::Relaxed)}),
                    Err(tauri_plugin_updater::Error::DownloadTooLarge) => serde_json::json!({"status":"capped","downloaded":downloaded.load(Ordering::Relaxed)}),
                    Ok(bytes) => serde_json::json!({"status":"verified","bytes":bytes.len()}),
                    Err(error) => serde_json::json!({"status":"rejected","error":format!("{error:?}")}),
                }
            }
        }
        Err(error) => serde_json::json!({"status":"rejected","error":format!("{error:?}")}),
    };
    println!("{outcome}");
}
