use crate::{byte_len, Profile};
use std::{
    mem::size_of,
    ptr::{null_mut, NonNull},
};
use windows_sys::Win32::{
    Foundation::*, Graphics::Gdi::*, Storage::Xps::PrintWindow,
    System::Threading::GetCurrentProcessId, UI::WindowsAndMessaging::*,
};

#[derive(Clone, Debug)]
pub struct Source {
    pub title: String,
    handle: usize,
    pid: u32,
}
impl Source {
    pub fn handle(&self) -> usize {
        self.handle
    }
    pub fn list() -> Vec<Self> {
        unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> i32 {
            let list = &mut *(data as *mut Vec<Source>);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == GetCurrentProcessId() || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
                return 1;
            }
            let len = GetWindowTextLengthW(hwnd);
            if !(1..=1024).contains(&len) {
                return 1;
            }
            let mut title = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
            let mut r = RECT::default();
            if n > 0
                && GetWindowRect(hwnd, &mut r) != 0
                && r.right - r.left >= 64
                && r.bottom - r.top >= 64
            {
                list.push(Source {
                    title: String::from_utf16_lossy(&title[..n as usize]),
                    handle: hwnd as usize,
                    pid,
                });
            }
            1
        }
        let mut list = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut list as *mut _ as LPARAM);
        }
        list
    }
    /// An OS-owned confirmation is always required, even if renderer code invokes IPC.
    pub fn confirm(&self, owner: isize) -> bool {
        let text:Vec<u16>=format!("Compartilhar o conteúdo da janela ‘{}’?\n\nA prévia ficará no Harmony. Você pode encerrar a captura a qualquer momento.",self.title).encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Harmony — autorizar captura"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(
                owner as HWND,
                text.as_ptr(),
                title.as_ptr(),
                MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2,
            ) == IDOK
        }
    }
    fn rect(&self) -> Result<RECT, String> {
        let h = self.handle as HWND;
        let mut pid = 0;
        let mut r = RECT::default();
        unsafe {
            GetWindowThreadProcessId(h, &mut pid);
            if IsWindow(h) == 0
                || IsIconic(h) != 0
                || pid != self.pid
                || GetWindowRect(h, &mut r) == 0
            {
                return Err(
                    "A janela foi fechada ou minimizada. Escolha a fonte novamente.".into(),
                );
            }
        }
        byte_len(
            (r.right - r.left).try_into().unwrap_or(0),
            (r.bottom - r.top).try_into().unwrap_or(0),
        )?;
        Ok(r)
    }
}

/// DIB resources live and die on the capture thread. They are never shared with JS.
struct Dib {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: NonNull<u8>,
    width: u32,
    height: u32,
}
impl Dib {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        byte_len(width, height)?;
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        };
        unsafe {
            let dc = CreateCompatibleDC(null_mut());
            if dc.is_null() {
                return Err("Não foi possível criar a captura do Windows.".into());
            }
            let mut bits = null_mut();
            let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
            if bitmap.is_null() || bits.is_null() {
                DeleteDC(dc);
                return Err("Não foi possível reservar o quadro da captura.".into());
            }
            let previous = SelectObject(dc, bitmap);
            Ok(Self {
                dc,
                bitmap,
                previous,
                bits: NonNull::new_unchecked(bits.cast()),
                width,
                height,
            })
        }
    }
}
impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

pub struct Capture {
    source: Source,
    raw: Option<Dib>,
    scaled: Option<Dib>,
    profile: Profile,
}
impl Capture {
    pub fn new(source: Source, profile: Profile) -> Result<Self, String> {
        profile.validate()?;
        source.rect()?;
        Ok(Self {
            source,
            raw: None,
            scaled: None,
            profile,
        })
    }
    pub fn set_profile(&mut self, p: Profile) -> Result<(), String> {
        self.profile = p.validate()?;
        Ok(())
    }
    pub fn profile(&self) -> Profile {
        self.profile
    }
    /// Writes BGRX into caller-owned storage, retaining DCs and DIBs across frames.
    pub fn frame(&mut self, output: &mut Vec<u8>) -> Result<(u32, u32), String> {
        let r = self.source.rect()?;
        let (w, h) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);
        if self
            .raw
            .as_ref()
            .is_none_or(|b| b.width != w || b.height != h)
        {
            self.raw = Some(Dib::new(w, h)?);
        }
        let raw = self.raw.as_ref().unwrap();
        unsafe {
            // WM_PRINT rendering includes off-screen portions; no Chromium capture
            // scheduler or base64 copy sits between this bitmap and the media track.
            if PrintWindow(self.source.handle as HWND, raw.dc, 2) == 0 {
                return Err("O Windows não disponibilizou o conteúdo desta janela.".into());
            }
        }
        let (width, height) = self.profile.size(w, h)?;
        let dib = if (width, height) != (w, h) {
            if self
                .scaled
                .as_ref()
                .is_none_or(|b| b.width != width || b.height != height)
            {
                self.scaled = Some(Dib::new(width, height)?);
            }
            let dst = self.scaled.as_ref().unwrap();
            unsafe {
                SetStretchBltMode(dst.dc, HALFTONE as i32);
                if StretchBlt(
                    dst.dc,
                    0,
                    0,
                    width as i32,
                    height as i32,
                    raw.dc,
                    0,
                    0,
                    w as i32,
                    h as i32,
                    SRCCOPY,
                ) == 0
                {
                    return Err("Falha ao dimensionar a captura.".into());
                }
            }
            dst
        } else {
            raw
        };
        let len = byte_len(width, height)?;
        output.resize(len, 0);
        // The DIB is thread-local and GDI calls above are synchronous. This copy
        // finishes before the bitmap can be written again or its resources freed.
        unsafe {
            GdiFlush();
            std::ptr::copy_nonoverlapping(dib.bits.as_ptr(), output.as_mut_ptr(), len);
        }
        Ok((width, height))
    }
}
