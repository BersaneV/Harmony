//! The Windows communications preference belongs to the current user, not to a
//! WebView. Only an explicit UI action changes it. Never touch endpoint/session
//! volumes, Bluetooth services, drivers or the system-wide/default devices.
use serde::Serialize;

#[derive(Serialize)]
pub struct AudioStatus {
    supported: bool,
    pub(crate) ducking_preference: Option<u32>,
}

#[tauri::command]
pub fn windows_audio_status() -> Result<AudioStatus, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(AudioStatus {
            supported: true,
            ducking_preference: win::preference()?,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(AudioStatus {
            supported: false,
            ducking_preference: None,
        })
    }
}

#[tauri::command]
pub fn disable_windows_audio_ducking() -> Result<AudioStatus, String> {
    #[cfg(target_os = "windows")]
    {
        win::disable()?;
        let status = windows_audio_status()?;
        if status.ducking_preference != Some(3) {
            return Err("O Windows não confirmou a alteração de áudio.".into());
        }
        Ok(status)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Este ajuste está disponível apenas no Windows.".into())
    }
}

#[cfg(target_os = "windows")]
mod win {
    use windows::{
        core::w,
        Win32::{
            Foundation::ERROR_FILE_NOT_FOUND,
            System::Registry::{
                RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD,
            },
        },
    };

    pub fn preference() -> Result<Option<u32>, String> {
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Multimedia\\Audio"),
                w!("UserDuckingPreference"),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut size),
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        result.ok().map_err(|_| {
            "Não foi possível ler a preferência de comunicações do Windows.".to_string()
        })?;
        Ok(Some(value))
    }

    pub fn disable() -> Result<(), String> {
        let value = 3u32;
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Multimedia\\Audio"),
                w!("UserDuckingPreference"),
                REG_DWORD.0,
                Some((&value as *const u32).cast()),
                std::mem::size_of::<u32>() as u32,
            )
        }.ok().map_err(|_| "O Windows não permitiu alterar a preferência de comunicações. Use Som → Comunicações → Não fazer nada.".into())
    }
}
