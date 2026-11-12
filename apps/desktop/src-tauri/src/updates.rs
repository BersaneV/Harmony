//! Only the native process owns update URLs, signatures and verified installer bytes.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;

const MAX_PACKAGE: u64 = 128 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    phase: &'static str,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            phase: "idle",
            version: None,
            downloaded: 0,
            total: None,
        }
    }
}
#[derive(Default)]
struct Session {
    status: Status,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    cancel: Option<CancellationToken>,
}
#[derive(Default)]
pub struct UpdateState {
    session: Mutex<Session>,
    busy: AtomicBool,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn acquire(state: &UpdateState) -> Result<Busy<'_>, String> {
    state
        .busy
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map_err(|_| "Uma operação de atualização já está em andamento.".to_string())?;
    Ok(Busy(&state.busy))
}
fn secure(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
fn valid_asset(url: &url::Url, version: &str, current: &str) -> bool {
    let (Ok(next), Ok(installed)) = (
        semver::Version::parse(version),
        semver::Version::parse(current),
    ) else {
        return false;
    };
    next > installed
        && next.build.is_empty()
        && secure(url)
        && url.query().is_none()
        && url.host_str() == Some("github.com")
        && url.path()
            == format!(
                "/BersaneV/Harmony/releases/download/v{version}/Harmony_{version}_x64-setup.exe"
            )
}
fn allowed_redirect(url: &url::Url) -> bool {
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
            if attempt.previous().len() > 5 || !allowed_redirect(attempt.url()) {
                attempt.error("Destino de atualização não permitido")
            } else {
                attempt.follow()
            }
        }))
}
fn status(state: &UpdateState) -> Status {
    state
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .clone()
}
fn emit(app: &tauri::AppHandle, state: &UpdateState) {
    let _ = app.emit_to("main", "updater-progress", status(state));
}
#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Status {
    status(&state)
}
#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Status, String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err(
            "As atualizações integradas estão disponíveis no Harmony para Windows x64.".into(),
        );
    }
    let _busy = acquire(&state)?;
    {
        let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
        *session = Session::default();
        session.status.phase = "checking";
    }
    emit(&app, &state);
    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(120))
            .configure_client(client)
            .build()
            .map_err(|_| "Não foi possível preparar o atualizador.".to_string())?;
        let update = tokio::time::timeout(Duration::from_secs(20), updater.check())
            .await
            .map_err(|_| "A consulta demorou demais. Tente novamente.".to_string())?
            .map_err(|_| {
                "Não foi possível consultar as atualizações. Verifique a conexão.".to_string()
            })?;
        if let Some(ref update) = update {
            if !valid_asset(
                &update.download_url,
                &update.version,
                &app.package_info().version.to_string(),
            ) {
                return Err("O destino ou a versão da atualização é inválido.".into());
            }
        }
        Ok(update)
    }
    .await;
    let answer = {
        let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok(update) => {
                session.status.phase = if update.is_some() {
                    "available"
                } else {
                    "current"
                };
                session.status.version = update.as_ref().map(|u| u.version.clone());
                session.update = update;
                Ok(session.status.clone())
            }
            Err(error) => {
                session.status.phase = "error";
                Err(error)
            }
        }
    };
    emit(&app, &state);
    answer
}
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Status, String> {
    let _busy = acquire(&state)?;
    let cancel = CancellationToken::new();
    let update = {
        let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
        let update = session
            .update
            .clone()
            .ok_or("Consulte as atualizações primeiro.")?;
        if !valid_asset(
            &update.download_url,
            &update.version,
            &app.package_info().version.to_string(),
        ) {
            return Err("Atualização inválida.".into());
        }
        session.bytes = None;
        session.cancel = Some(cancel.clone());
        session.status.phase = "downloading";
        session.status.downloaded = 0;
        session.status.total = None;
        update
    };
    emit(&app, &state);
    let mut last_emit = Instant::now();
    let oversized = AtomicBool::new(false);
    let download = update.download_with_limit(
        MAX_PACKAGE,
        |chunk, total| {
            let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
            session.status.downloaded = session.status.downloaded.saturating_add(chunk as u64);
            session.status.total = total;
            if session.status.downloaded > MAX_PACKAGE || total.is_some_and(|n| n > MAX_PACKAGE) {
                oversized.store(true, Ordering::Relaxed);
                cancel.cancel();
            }
            drop(session);
            if last_emit.elapsed() > Duration::from_millis(100) {
                emit(&app, &state);
                last_emit = Instant::now();
            }
        },
        || {},
    );
    let result = tokio::select! { biased;
        _ = cancel.cancelled() => Err("Download cancelado ou acima do limite permitido.".to_string()),
        result = tokio::time::timeout(Duration::from_secs(180), download) => result
            .map_err(|_| "O download demorou demais. Tente novamente.".to_string())
            .and_then(|r| r.map_err(|_| "Não foi possível verificar a atualização. A conexão, assinatura ou versão do pacote é inválida.".to_string())),
    };
    let answer = {
        let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
        session.cancel = None;
        match result {
            Ok(bytes)
                if !cancel.is_cancelled()
                    && !oversized.load(Ordering::Relaxed)
                    && bytes.len() as u64 <= MAX_PACKAGE =>
            {
                session.bytes = Some(bytes);
                session.status.phase = "ready";
                Ok(session.status.clone())
            }
            outcome => {
                session.bytes = None;
                session.status.phase = "available";
                Err(outcome
                    .err()
                    .unwrap_or_else(|| "Download cancelado ou acima do limite permitido.".into()))
            }
        }
    };
    emit(&app, &state);
    answer
}
#[tauri::command]
pub fn cancel_update(state: State<'_, UpdateState>) {
    if let Some(cancel) = &state
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cancel
    {
        cancel.cancel();
    }
}
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("Instalação disponível apenas no Windows x64.".into());
    }
    let _busy = acquire(&state)?;
    let (update, bytes) = {
        let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
        let update = session
            .update
            .clone()
            .ok_or("Consulte as atualizações primeiro.")?;
        if !valid_asset(
            &update.download_url,
            &update.version,
            &app.package_info().version.to_string(),
        ) {
            return Err("Atualização inválida.".into());
        }
        let bytes = session
            .bytes
            .take()
            .ok_or("Baixe e verifique a atualização antes de instalar.")?;
        session.status.phase = "installing";
        (update, bytes)
    };
    emit(&app, &state);
    let result = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    // On Windows the official plugin exits this process only after launching the verified installer.
    let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
    session.status.phase = "available";
    result
        .map_err(|_| "Não foi possível iniciar o instalador.".to_string())?
        .map_err(|_| "Não foi possível instalar. Baixe novamente e tente outra vez.".to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_new_versions_from_the_exact_repository() {
        let base = "https://github.com/BersaneV/Harmony/releases/download/v0.2.0/Harmony_0.2.0_x64-setup.exe";
        assert!(valid_asset(&base.parse().unwrap(), "0.2.0", "0.1.0"));
        for bad in [
            base.replace("https:", "http:"),
            base.replace("BersaneV", "attacker"),
            base.replace("github.com", "github.com.evil.test"),
            format!("{base}?redirect=1"),
            base.replace("github.com", "token@github.com"),
        ] {
            assert!(!valid_asset(&bad.parse().unwrap(), "0.2.0", "0.1.0"));
        }
        assert!(!valid_asset(&base.parse().unwrap(), "0.2.0", "0.2.0"));
        assert!(!valid_asset(&base.parse().unwrap(), "0.2.0", "0.3.0"));
    }
    #[test]
    fn redirects_stay_on_https_github_release_hosts() {
        assert!(allowed_redirect(
            &"https://release-assets.githubusercontent.com/x?token=temporary"
                .parse()
                .unwrap()
        ));
        for bad in [
            "http://release-assets.githubusercontent.com/x",
            "https://example.org/a",
            "https://github.com/other/repo",
            "https://release-assets.githubusercontent.com:444/x",
        ] {
            assert!(!allowed_redirect(&bad.parse().unwrap()));
        }
    }
    #[test]
    fn concurrent_operations_are_rejected_and_guard_releases() {
        let state = UpdateState::default();
        let guard = acquire(&state).unwrap();
        assert!(acquire(&state).is_err());
        drop(guard);
        assert!(acquire(&state).is_ok());
    }
}
