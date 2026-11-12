#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

fn credential_origin(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value).map_err(|_| "Endereço inválido.")?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("A origem deve usar HTTPS; HTTP é permitido apenas em loopback.".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.harmony.desktop", &credential_origin(server)?)
        .map_err(|_| "Não foi possível acessar o cofre de credenciais do sistema.".into())
}

#[tauri::command]
fn store_refresh_token(server: String, token: Option<String>) -> Result<(), String> {
    let entry = entry(&server)?;
    match token {
        Some(value) => {
            if value.len() < 20 || value.len() > 2048 || !value.is_ascii() {
                return Err("Formato de sessão inválido.".into());
            }
            entry.set_password(&value).map_err(|_| {
                "Não foi possível salvar a sessão no cofre. Verifique o acesso ao gerenciador de credenciais.".into()
            })
        }
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Não foi possível remover a sessão do cofre.".into()),
        },
    }
}

#[tauri::command]
fn load_refresh_token(server: String) -> Result<Option<String>, String> {
    match entry(&server)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Não foi possível ler a sessão do cofre.".into()),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Link inválido.")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 8192
    {
        return Err("Apenas links HTTP e HTTPS sem credenciais são permitidos.".into());
    }
    open::that(parsed.as_str()).map_err(|_| "Não foi possível abrir o navegador.".into())
}

#[tauri::command]
fn set_push_to_talk(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let key = Shortcut::new(None, Code::F9);
    if enabled {
        if !app.global_shortcut().is_registered(key) {
            app.global_shortcut().register(key).map_err(|_| {
                "Não foi possível registrar F9. Outro aplicativo pode estar usando este atalho."
                    .to_string()
            })?;
        }
    } else {
        app.global_shortcut()
            .unregister(key)
            .map_err(|_| "Não foi possível liberar o atalho F9.".to_string())?;
        let _ = app.emit_to("main", "ptt-state", false);
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(updates::UpdateState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut == &Shortcut::new(None, Code::F9) {
                        let _ = app.emit_to(
                            "main",
                            "ptt-state",
                            event.state() == ShortcutState::Pressed,
                        );
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            store_refresh_token,
            load_refresh_token,
            open_external_url,
            set_push_to_talk,
            updates::check_update,
            updates::download_update,
            updates::cancel_update,
            updates::install_update,
            updates::update_status
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    url.scheme() == "tauri"
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(1420))
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Falha ao iniciar Harmony");
}

#[cfg(test)]
mod tests {
    use super::credential_origin;
    #[test]
    fn accepts_only_secure_origins_and_loopback() {
        assert_eq!(
            credential_origin("https://chat.example.org/").unwrap(),
            "https://chat.example.org"
        );
        assert!(credential_origin("http://127.0.0.1:8080").is_ok());
        assert!(credential_origin("http://chat.example.org").is_err());
        assert!(credential_origin("https://token@chat.example.org").is_err());
        assert!(credential_origin("https://chat.example.org/path").is_err());
        assert!(credential_origin("https://chat.example.org?token=secret").is_err());
        assert!(credential_origin("file:///etc/passwd").is_err());
    }
}
