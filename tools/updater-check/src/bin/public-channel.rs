//! Real HTTPS channel verification using the pinned repository public key.
//! Downloads and verifies with the same plugin as Harmony; never installs.
use semver::Version;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tauri::Url;
use tauri_plugin_updater::UpdaterExt;

const FEED: &str =
    "https://github.com/BersaneV/Harmony/releases/download/update-channel/latest.json";
const MAX_PACKAGE: u64 = 128 * 1024 * 1024;

fn secure(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn asset_allowed(url: &Url, announced: &Version, current: &Version) -> bool {
    announced > current
        && announced.build.is_empty()
        && secure(url)
        && url.query().is_none()
        && url.host_str() == Some("github.com")
        && url.path()
            == format!(
                "/BersaneV/Harmony/releases/download/v{announced}/Harmony_{announced}_x64-setup.exe"
            )
}

fn redirect_allowed(url: &Url) -> bool {
    secure(url)
        && match url.host_str() {
            Some("github.com") => url
                .path()
                .starts_with("/BersaneV/Harmony/releases/download/"),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
            _ => false,
        }
}

fn client(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 || !redirect_allowed(attempt.url()) {
                attempt.error("update redirect rejected")
            } else {
                attempt.follow()
            }
        }))
}

async fn check(current: Version) -> Result<Value, &'static str> {
    let config_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/tauri.conf.json");
    let config: Value = serde_json::from_slice(
        &std::fs::read(config_path).map_err(|_| "repository_config_unavailable")?,
    )
    .map_err(|_| "repository_config_invalid")?;
    let updater_config = &config["plugins"]["updater"];
    if updater_config["endpoints"] != json!([FEED])
        || updater_config["requireSignedVersion"] != true
        || updater_config["allowDowngrades"] != false
    {
        return Err("repository_update_policy_mismatch");
    }
    let public_key = updater_config["pubkey"]
        .as_str()
        .filter(|key| !key.is_empty())
        .ok_or("repository_public_key_missing")?;
    let expected = Version::parse(
        config["version"]
            .as_str()
            .ok_or("repository_version_missing")?,
    )
    .map_err(|_| "repository_version_invalid")?;
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().version = current.clone();
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey":public_key,
            "endpoints":[FEED],
            "requireSignedVersion":true,
            "allowDowngrades":false
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .map_err(|_| "mock_runtime_failed")?;
    let updater = app
        .updater_builder()
        .target("windows-x86_64")
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .configure_client(client)
        .build()
        .map_err(|_| "updater_builder_failed")?;
    let update = tokio::time::timeout(Duration::from_secs(30), updater.check())
        .await
        .map_err(|_| "channel_check_timeout")?
        .map_err(|_| "channel_check_failed")?;
    match update {
        None if current < expected => Err("expected_release_not_offered"),
        None => Ok(json!({
            "passed":true,"status":"no_update","feed":FEED,
            "current_version":current.to_string(),"expected_release":expected.to_string(),
            "scope":"real HTTPS check; MockRuntime selecting Windows x64; no installation"
        })),
        Some(update) => {
            let announced =
                Version::parse(&update.version).map_err(|_| "invalid_announced_version")?;
            if announced != expected || !asset_allowed(&update.download_url, &announced, &current) {
                return Err("unexpected_release_or_asset");
            }
            let bytes = tokio::time::timeout(
                Duration::from_secs(180),
                update.download_with_limit(MAX_PACKAGE, |_, _| {}, || {}),
            )
            .await
            .map_err(|_| "download_timeout")?
            .map_err(|_| "download_or_signature_rejected")?;
            Ok(json!({
                "passed":true,"status":"verified","feed":FEED,
                "current_version":current.to_string(),"version":announced.to_string(),
                "artifact_url":update.download_url.as_str(),"bytes":bytes.len(),
                "artifact_sha256":format!("{:x}",Sha256::digest(&bytes)),
                "public_key_text_sha256":format!("{:x}",Sha256::digest(public_key.as_bytes())),
                "scope":"real HTTPS check/download and official signature/version verification; MockRuntime selecting Windows x64; no installation"
            }))
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: public-channel CURRENT_VERSION");
        std::process::exit(2);
    }
    let Ok(current) = Version::parse(&args[1]) else {
        eprintln!("CURRENT_VERSION must be a semantic version");
        std::process::exit(2);
    };
    match check(current).await {
        Ok(result) => println!("{result}"),
        Err(code) => {
            // Never log temporary GitHub CDN query credentials from request errors.
            println!("{}", json!({"passed":false,"error":code,"feed":FEED}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_release_url_and_strict_version_are_required() {
        let good = "https://github.com/BersaneV/Harmony/releases/download/v0.2.0/Harmony_0.2.0_x64-setup.exe";
        let next = Version::parse("0.2.0").unwrap();
        let current = Version::parse("0.1.0").unwrap();
        assert!(asset_allowed(&good.parse().unwrap(), &next, &current));
        assert!(!asset_allowed(&good.parse().unwrap(), &next, &next));
        for bad in [
            good.replace("https:", "http:"),
            good.replace("BersaneV", "someone"),
            good.replace("github.com", "github.com.example.org"),
            good.replace("github.com", "token@github.com"),
            format!("{good}?x=1"),
            format!("{good}#fragment"),
            good.replace("x64-setup.exe", "arm64-setup.exe"),
        ] {
            assert!(!asset_allowed(&bad.parse().unwrap(), &next, &current));
        }
    }

    #[test]
    fn redirects_require_https_and_github_release_hosts() {
        assert!(redirect_allowed(&FEED.parse().unwrap()));
        assert!(redirect_allowed(
            &"https://release-assets.githubusercontent.com/x?temporary=credential"
                .parse()
                .unwrap()
        ));
        for bad in [
            "http://release-assets.githubusercontent.com/x",
            "https://127.0.0.1/x",
            "https://github.com/another/repo/releases/download/a",
            "https://release-assets.githubusercontent.com.evil.test/x",
            "https://release-assets.githubusercontent.com:444/x",
        ] {
            assert!(!redirect_allowed(&bad.parse().unwrap()));
        }
    }
}
