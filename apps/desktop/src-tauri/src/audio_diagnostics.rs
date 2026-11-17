//! Read-only Core Audio metadata. No stream initialization, recording, process
//! names, raw endpoint IDs, Bluetooth control or volume setters.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Manager;

#[derive(Default, Clone)]
pub struct AudioDiagnosticState(Arc<Mutex<HashMap<String, usize>>>);

#[tauri::command]
pub async fn audio_diagnostic_snapshot(
    include_names: bool,
    state: tauri::State<'_, AudioDiagnosticState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut aliases) = state.0.try_lock() else {
            return json!({"supported": cfg!(target_os="windows"), "status":"busy"});
        };
        #[cfg(target_os = "windows")]
        {
            win::snapshot(include_names, &mut aliases)
                .unwrap_or_else(|_| json!({"supported":true,"status":"unavailable"}))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (include_names, &mut aliases);
            json!({"supported":false,"status":"unsupported"})
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .map_err(|_| "A consulta de áudio demorou demais.".to_string())?
        .map_err(|_| "Não foi possível consultar o áudio.".to_string())
}

fn checked_report(report: &str) -> Result<Value, String> {
    if report.len() > 1_048_576 {
        return Err("O relatório excede o limite de tamanho.".into());
    }
    let value: Value = serde_json::from_str(report).map_err(|_| "Relatório inválido.")?;
    if value.get("format").and_then(Value::as_str) != Some("harmony.audio-diagnostic.v1")
        || !value
            .get("entries")
            .is_some_and(|e| e.is_array() && e.as_array().is_some_and(|a| a.len() <= 180))
    {
        return Err("Formato de diagnóstico inválido.".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn save_audio_diagnostics(
    app: tauri::AppHandle,
    report: String,
) -> Result<String, String> {
    let value = checked_report(&report)?;
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "A pasta Downloads não está disponível.")?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Relógio inválido.")?
            .as_millis();
        let name = format!("Harmony-audio-{stamp}.json");
        // Fixed basename + create_new: never accept a path or overwrite a file.
        let path = directory.join(&name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "Não foi possível criar o diagnóstico em Downloads.")?;
        let result = (|| -> std::io::Result<()> {
            serde_json::to_writer(&mut file, &value)?;
            file.write_all(b"\n")?;
            file.sync_all()
        })();
        if result.is_err() {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Err("Não foi possível concluir o arquivo de diagnóstico.".to_string());
        }
        Ok(name)
    })
    .await
    .map_err(|_| "Não foi possível salvar o diagnóstico.".to_string())?
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use windows::core::Interface;
    use windows::{
        core::{w, PWSTR},
        Win32::{
            Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
            Media::Audio::{
                eCapture, eCommunications, eConsole, eMultimedia, eRender,
                Endpoints::{IAudioEndpointVolume, IAudioMeterInformation},
                IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, IMMEndpoint,
                ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATEMASK_ALL,
            },
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                    StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
                    CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
                },
                Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
            },
        },
    };
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    unsafe fn take_string(p: PWSTR) -> windows::core::Result<String> {
        let value = unsafe { p.to_string() };
        unsafe {
            CoTaskMemFree(Some(p.0.cast()));
        }
        Ok(value?)
    }
    fn alias(ids: &mut HashMap<String, usize>, id: String) -> Option<usize> {
        if let Some(n) = ids.get(&id) {
            return Some(*n);
        }
        if ids.len() >= 128 {
            return None;
        }
        let n = ids.len() + 1;
        ids.insert(id, n);
        Some(n)
    }
    fn device_alias(device: &IMMDevice, ids: &mut HashMap<String, usize>) -> Option<usize> {
        unsafe { alias(ids, take_string(device.GetId().ok()?).ok()?) }
    }
    fn name(device: &IMMDevice) -> Option<String> {
        unsafe {
            let store = device.OpenPropertyStore(STGM_READ).ok()?;
            let mut value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
            let result = PropVariantToStringAlloc(&value)
                .and_then(|s| take_string(s))
                .ok();
            let _ = PropVariantClear(&mut value);
            result.map(|s| s.chars().filter(|c| !c.is_control()).take(120).collect())
        }
    }
    fn build() -> Option<String> {
        let mut buffer = [0u16; 64];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        let ok = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
                w!("CurrentBuildNumber"),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        }
        .is_ok();
        let text = String::from_utf16_lossy(
            &buffer[..buffer.iter().position(|n| *n == 0).unwrap_or(buffer.len())],
        );
        (ok && !text.is_empty() && text.chars().all(|c| c.is_ascii_digit())).then_some(text)
    }
    pub fn snapshot(
        include_names: bool,
        ids: &mut HashMap<String, usize>,
    ) -> windows::core::Result<Value> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let _com = Com;
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let mut defaults = Vec::new();
            for (flow, direction) in [(eRender, "output"), (eCapture, "input")] {
                for (role, label) in [
                    (eConsole, "console"),
                    (eMultimedia, "multimedia"),
                    (eCommunications, "communications"),
                ] {
                    defaults.push(json!({"direction":direction,"role":label,"endpoint":enumerator.GetDefaultAudioEndpoint(flow,role).ok().and_then(|d| device_alias(&d,ids))}));
                }
            }
            let collection = enumerator.EnumAudioEndpoints(
                windows::Win32::Media::Audio::eAll,
                DEVICE_STATE(DEVICE_STATEMASK_ALL),
            )?;
            let count = collection.GetCount()?;
            let mut endpoints = Vec::new();
            for i in 0..count.min(32) {
                let Ok(device) = collection.Item(i) else {
                    continue;
                };
                let flow = device
                    .cast::<IMMEndpoint>()
                    .and_then(|e| e.GetDataFlow())
                    .ok();
                let volume = device
                    .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                    .ok();
                let peak = device
                    .Activate::<IAudioMeterInformation>(CLSCTX_ALL, None)
                    .ok()
                    .and_then(|m| m.GetPeakValue().ok());
                let sessions = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL,None).and_then(|m| m.GetSessionEnumerator()).ok().map(|list| {
                    let mut rows = Vec::new();
                    for n in 0..list.GetCount().unwrap_or(0).min(32) {
                        if let Ok(s) = list.GetSession(n) {
                            let v = s.cast::<ISimpleAudioVolume>().ok();
                            rows.push(json!({"state":s.GetState().ok().map(|s| s.0),"volume":v.as_ref().and_then(|v|v.GetMasterVolume().ok()),"muted":v.as_ref().and_then(|v|v.GetMute().ok().map(|b|b.as_bool()))}));
                        }
                    }
                    rows
                });
                endpoints.push(json!({"endpoint":device_alias(&device,ids),"direction":flow.map(|f|if f==eRender {"output"} else {"input"}),"state":device.GetState().ok().map(|s|s.0),
                    "name":if include_names {name(&device)} else {None},
                    "volume":volume.as_ref().and_then(|v|v.GetMasterVolumeLevelScalar().ok()),"muted":volume.as_ref().and_then(|v|v.GetMute().ok().map(|b|b.as_bool())),"peak":peak,"sessions":sessions}));
            }
            Ok(
                json!({"supported":true,"status":"ok","windows_build":build(),"architecture":std::env::consts::ARCH,
                "ducking_preference":super::super::audio::windows_audio_status().ok().and_then(|s|s.ducking_preference),
                "names_included":include_names,"defaults":defaults,"endpoints":endpoints,"endpoints_truncated":count>32,
                "endpoint_state_values":{"active":1,"disabled":2,"not_present":4,"unplugged":8},
                "note":"Endpoint aliases last only for this app process. Null means unavailable; session rows are anonymous and may be incomplete. No audio stream was opened."}),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_or_unbounded_exports() {
        assert!(checked_report("{}").is_err());
        assert!(checked_report(&"x".repeat(1_048_577)).is_err());
        assert!(checked_report(
            &json!({"format":"harmony.audio-diagnostic.v1","entries":vec![0;181]}).to_string()
        )
        .is_err());
        assert!(checked_report(r#"{"format":"harmony.audio-diagnostic.v1","entries":[]}"#).is_ok());
    }
}
