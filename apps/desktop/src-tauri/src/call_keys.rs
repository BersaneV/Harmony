use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

type ShortcutBindings = (Vec<(Shortcut, &'static str)>, HashSet<u32>);
#[derive(Default)]
pub struct CallKeyState(Mutex<ShortcutBindings>);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallKeys {
    ptt: String,
    microphone: String,
    deafen: String,
}
#[derive(Clone, Serialize)]
pub struct CallKeyEvent {
    action: &'static str,
    pressed: bool,
}
fn allowed(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    if s.len() > 64 || ["Alt+F4", "Ctrl+Alt+Delete"].contains(&s) {
        return false;
    }
    let mut parts = s.split('+').collect::<Vec<_>>();
    let Some(key) = parts.pop() else { return false };
    let expected = ["Ctrl", "Alt", "Shift"]
        .into_iter()
        .filter(|m| parts.contains(m))
        .collect::<Vec<_>>();
    if parts != expected {
        return false;
    }
    let special = key
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n) && key == format!("F{n}"))
        || [
            "ScrollLock",
            "CapsLock",
            "Pause",
            "Insert",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "PrintScreen",
        ]
        .contains(&key);
    let letter = key
        .strip_prefix("Key")
        .is_some_and(|c| c.len() == 1 && c.as_bytes()[0].is_ascii_uppercase());
    let digit = ["Digit", "Numpad"].into_iter().any(|p| {
        key.strip_prefix(p)
            .is_some_and(|c| c.len() == 1 && c.as_bytes()[0].is_ascii_digit())
    });
    let ordinary = letter
        || digit
        || [
            "Space",
            "Tab",
            "Enter",
            "Backspace",
            "Delete",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Equal",
            "Minus",
            "Comma",
            "Period",
            "Slash",
            "Backquote",
            "BracketLeft",
            "BracketRight",
            "Backslash",
            "Semicolon",
            "Quote",
        ]
        .contains(&key);
    special || (ordinary && (parts.contains(&"Ctrl") || parts.contains(&"Alt")))
}

fn parse(keys: CallKeys) -> Result<Vec<(Shortcut, &'static str)>, String> {
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    for (value, action) in [
        (keys.ptt, "ptt"),
        (keys.microphone, "microphone"),
        (keys.deafen, "deafen"),
    ] {
        if !allowed(&value) {
            return Err("Atalho não permitido.".into());
        }
        if value.is_empty() {
            continue;
        }
        let shortcut: Shortcut = value.parse().map_err(|_| "Atalho inválido.")?;
        if !ids.insert(shortcut.id()) {
            return Err("Use atalhos diferentes para cada ação.".into());
        }
        result.push((shortcut, action));
    }
    Ok(result)
}
// Global-shortcut APIs marshal back to the UI thread and wait. Run the IPC
// command away from the synchronous WebView2 callback to avoid re-entry stalls.
#[tauri::command(async)]
pub fn set_call_shortcuts(
    app: tauri::AppHandle,
    keys: CallKeys,
    state: tauri::State<'_, CallKeyState>,
) -> Result<(), String> {
    let next = parse(keys)?;
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Não foi possível configurar os atalhos.")?;
    let _ = app.emit_to(
        "main",
        "call-shortcut",
        CallKeyEvent {
            action: "ptt",
            pressed: false,
        },
    );
    for (key, _) in &current.0 {
        app.global_shortcut()
            .unregister(*key)
            .map_err(|_| "Não foi possível liberar o atalho anterior.")?;
    }
    current.0.clear();
    current.1.clear();
    for (key, action) in next {
        if app.global_shortcut().register(key).is_err() {
            for (k, _) in &current.0 {
                let _ = app.global_shortcut().unregister(*k);
            }
            current.0.clear();
            return Err("Atalho em uso por outro aplicativo. Escolha outra combinação.".into());
        }
        current.0.push((key, action));
    }
    Ok(())
}
pub fn handle(app: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    let state = app.state::<CallKeyState>();
    let Ok(mut current) = state.0.try_lock() else {
        return;
    };
    let Some(action) = current
        .0
        .iter()
        .find(|(k, _)| k == shortcut)
        .map(|(_, a)| *a)
    else {
        return;
    };
    let pressed = event == ShortcutState::Pressed;
    if pressed && !current.1.insert(shortcut.id()) {
        return;
    }
    if !pressed {
        current.1.remove(&shortcut.id());
    }
    let _ = app.emit_to("main", "call-shortcut", CallKeyEvent { action, pressed });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_supported_distinct_bindings() {
        assert!(parse(CallKeys {
            ptt: "F9".into(),
            microphone: "ScrollLock".into(),
            deafen: "Ctrl+Shift+KeyD".into()
        })
        .is_ok());
        assert!(parse(CallKeys {
            ptt: "F9".into(),
            microphone: "F9".into(),
            deafen: "".into()
        })
        .is_err());
        assert!(!allowed("Alt+F4"));
        assert!(!allowed("KeyM"));
    }
}
