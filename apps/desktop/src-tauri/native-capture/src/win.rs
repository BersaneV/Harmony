use crate::{byte_len, Profile};
use std::{
    mem::size_of,
    ptr::{null_mut, NonNull},
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::Threading::{
        CreateEventW, CreateWaitableTimerExW, GetCurrentProcessId, SetEvent, SetWaitableTimer,
        WaitForMultipleObjects, WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
        TIMER_ALL_ACCESS,
    },
    UI::WindowsAndMessaging::*,
};
#[path = "wgc.rs"]
mod wgc;

/// One auto-reset notification owned by a run. It carries no frame/ACK credit.
/// Arc keeps the kernel handle alive through every worker wait and UI signal.
#[derive(Clone)]
pub struct ProducerWake(std::sync::Arc<WakeHandle>);
struct WakeHandle {
    handle: std::os::windows::io::OwnedHandle,
    failed: std::sync::atomic::AtomicBool,
}
impl ProducerWake {
    pub fn new() -> Option<Self> {
        use std::os::windows::io::FromRawHandle;
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if handle.is_null() {
            return None;
        }
        Some(Self(std::sync::Arc::new(WakeHandle {
            handle: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) },
            failed: std::sync::atomic::AtomicBool::new(false),
        })))
    }
    fn usable(&self) -> bool {
        !self.0.failed.load(std::sync::atomic::Ordering::Acquire)
    }
    fn disable(&self) {
        self.0
            .failed
            .store(true, std::sync::atomic::Ordering::Release);
    }
    fn raw(&self) -> HANDLE {
        use std::os::windows::io::AsRawHandle;
        self.0.handle.as_raw_handle()
    }
    /// API failure only disables the optimization; authoritative state is untouched.
    pub fn signal(&self) -> bool {
        if !self.usable() {
            return false;
        }
        if unsafe { SetEvent(self.raw()) } == 0 {
            self.disable();
            return false;
        }
        true
    }
}
#[derive(Debug, PartialEq, Eq)]
enum WakeWait {
    Progress,
    Timer,
    Fallback,
}

/// Per-producer high resolution wait. No process-wide timer resolution change,
/// spin loop or catch-up queue. Dropped frames are never replayed.
pub struct FramePacer(HANDLE);
impl Default for FramePacer {
    fn default() -> Self {
        Self::new()
    }
}
impl FramePacer {
    pub fn new() -> Self {
        Self(unsafe {
            CreateWaitableTimerExW(
                std::ptr::null(),
                std::ptr::null(),
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS,
            )
        })
    }
    pub fn sleep(&self, duration: std::time::Duration) {
        if duration.is_zero() {
            return;
        }
        let duration = duration.min(std::time::Duration::from_millis(250));
        let due = -(duration.as_nanos().div_ceil(100).max(1) as i64);
        if !self.0.is_null()
            && unsafe { SetWaitableTimer(self.0, &due, 0, None, std::ptr::null(), 0) } != 0
            && unsafe { WaitForSingleObject(self.0, 300) } == WAIT_OBJECT_0
        {
            return;
        }
        std::thread::sleep(duration);
    }
    /// Worker-only, bounded wait for the original deadline OR lease progress.
    /// A wake is only a hint: the producer must re-read all capture predicates.
    pub fn sleep_or_wake(&self, duration: std::time::Duration, wake: Option<&ProducerWake>) {
        self.wait_progress(duration, wake);
    }
    fn wait_progress(
        &self,
        duration: std::time::Duration,
        wake: Option<&ProducerWake>,
    ) -> WakeWait {
        let duration = duration.min(std::time::Duration::from_millis(250));
        let Some(wake) = wake.filter(|w| w.usable()) else {
            self.sleep(duration);
            return WakeWait::Fallback;
        };
        if duration.is_zero() {
            return WakeWait::Timer;
        }
        let start = std::time::Instant::now();
        let due = -(duration.as_nanos().div_ceil(100).max(1) as i64);
        if !self.0.is_null()
            && unsafe { SetWaitableTimer(self.0, &due, 0, None, std::ptr::null(), 0) } != 0
        {
            // Progress first consumes a sticky/coalesced notification when both
            // handles are signaled. No reset gap and no queued frame credits.
            let handles = [wake.raw(), self.0];
            let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 300) };
            if result == WAIT_OBJECT_0 {
                return WakeWait::Progress;
            }
            if result == WAIT_OBJECT_0 + 1 {
                return WakeWait::Timer;
            }
        }
        wake.disable();
        // Failure does not restart a full timer after time already spent waiting.
        self.sleep(duration.saturating_sub(start.elapsed()));
        WakeWait::Fallback
    }
}
impl Drop for FramePacer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Source {
    pub title: String,
    handle: usize,
    pid: u32,
}
impl Source {
    pub fn dimensions(&self) -> Result<(u32, u32), String> {
        let r = self.rect()?;
        Ok(((r.right - r.left) as u32, (r.bottom - r.top) as u32))
    }
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
    fn confirm_title(&self, owner: isize, selected_title: &str) -> bool {
        let text:Vec<u16>=format!("Compartilhar o conteúdo da janela ‘{}’?\n\nA prévia ficará no Harmony. Você pode encerrar a captura a qualquer momento.",selected_title).encode_utf16().chain(Some(0)).collect();
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
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
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

/// A full source frame stays on the capture thread. Only the resize path needs
/// a GDI bitmap; unchanged geometry goes straight to the caller's reusable Vec.
enum FullBuffer<'a> {
    Bytes(&'a mut Vec<u8>),
    Dib(&'a mut Option<Dib>),
}
impl FullBuffer<'_> {
    /// # Safety
    /// `source` must remain readable for every requested row, and must not
    /// overlap the destination. The WGC staging mapping owns it during this call.
    unsafe fn copy_from(
        self,
        source: *const u8,
        row_pitch: usize,
        width: u32,
        height: u32,
        #[cfg(feature = "capture-diagnostics")] diagnostics: &crate::diagnostics::Recorder,
    ) -> Result<(), String> {
        let len = byte_len(width, height)?;
        let row_bytes = width as usize * 4;
        if source.is_null()
            || row_pitch < row_bytes
            || row_pitch
                .checked_mul(height as usize - 1)
                .and_then(|offset| offset.checked_add(row_bytes))
                .is_none_or(|span| span > isize::MAX as usize)
        {
            return Err("Layout de captura inválido.".into());
        }
        #[cfg(feature = "capture-diagnostics")]
        let preparation = diagnostics.span(crate::diagnostics::Stage::BufferPrepare);
        let destination = match self {
            Self::Bytes(output) => {
                output.resize(len, 0);
                output.as_mut_ptr()
            }
            Self::Dib(raw) => {
                if raw
                    .as_ref()
                    .is_none_or(|d| d.width != width || d.height != height)
                {
                    *raw = Some(Dib::new(width, height)?);
                }
                raw.as_ref().unwrap().bits.as_ptr()
            }
        };
        #[cfg(feature = "capture-diagnostics")]
        drop(preparation);
        #[cfg(feature = "capture-diagnostics")]
        let _copy = diagnostics.span(crate::diagnostics::Stage::RowCopy);
        for row in 0..height as usize {
            unsafe {
                std::ptr::copy_nonoverlapping(
                    source.add(row * row_pitch),
                    destination.add(row * row_bytes),
                    row_bytes,
                );
            }
        }
        Ok(())
    }
}

pub struct Capture {
    raw: Option<Dib>,
    scaled: Option<Dib>,
    profile: Profile,
    wgc: wgc::Wgc,
}
/// Feature-only experiment result; no frame or permission is acquired by waiting.
#[cfg(feature = "capture-frame-ready-experiment")]
#[derive(Clone, Copy, Debug)]
pub struct FrameReadyWait {
    pub status: u8,
    pub kernel_wait: bool,
    pub timeout_ms: u32,
    pub error: u32,
    pub setup_wall_ns: u64,
    pub kernel_wall_ns: u64,
}
#[cfg(feature = "capture-frame-ready-experiment")]
#[derive(Clone, Copy, Debug)]
pub struct FrameReadyCounters {
    pub available: bool,
    pub creation_error: u32,
    pub signal_calls: u64,
    pub signal_errors: u64,
    pub signal_wall_ns: u64,
    pub signal_max_wall_ns: u64,
}
impl Capture {
    pub fn new(
        source: Source,
        profile: Profile,
        owner: isize,
        authorized: impl Fn() -> bool,
    ) -> Result<Self, String> {
        profile.validate()?;
        source.rect()?;
        let wgc = wgc::Wgc::new(&source, profile, owner, authorized)?;
        Ok(Self {
            raw: None,
            scaled: None,
            profile,
            wgc,
        })
    }
    pub fn supported() -> bool {
        wgc::Wgc::supported()
    }
    pub fn source_title(&self) -> &str {
        &self.wgc.title
    }
    pub fn source_dimensions(&self) -> (u32, u32) {
        self.wgc.dimensions()
    }
    pub fn is_closed(&self) -> bool {
        self.wgc.is_closed()
    }
    #[cfg(feature = "capture-frame-ready-experiment")]
    pub fn wait_frame_ready(
        &self,
        timeout: std::time::Duration,
        cancelled: impl Fn() -> bool,
    ) -> FrameReadyWait {
        self.wgc.wait_frame_ready(timeout, cancelled)
    }
    #[cfg(feature = "capture-frame-ready-experiment")]
    pub fn frame_ready_counters(&self) -> FrameReadyCounters {
        self.wgc.frame_ready_counters()
    }
    #[cfg(feature = "capture-diagnostics")]
    pub fn set_diagnostics_enabled(&mut self, enabled: bool) {
        self.wgc.diagnostics().set_enabled(enabled);
    }
    #[cfg(feature = "capture-diagnostics")]
    pub fn reset_diagnostics(&mut self) {
        self.wgc.diagnostics().reset_window();
    }
    #[cfg(feature = "capture-diagnostics")]
    pub fn diagnostics_snapshot(&self) -> crate::diagnostics::Snapshot {
        self.wgc.diagnostics().snapshot()
    }
    #[cfg(feature = "capture-diagnostics")]
    pub fn diagnostic_frame_observation(&self) -> Option<crate::diagnostics::FrameObservation> {
        self.wgc.diagnostics().last_frame()
    }
    pub fn dimensions(&self) -> Result<(u32, u32), String> {
        let (w, h) = self.source_dimensions();
        self.profile.size(w, h)
    }
    pub fn set_profile(&mut self, p: Profile) -> Result<(), String> {
        let p = p.validate()?;
        #[cfg(feature = "capture-readback-experiment")]
        if self.profile != p {
            self.wgc.invalidate_readback(p)?;
        }
        if self.profile.fps != p.fps {
            self.wgc.set_fps(p.fps);
        }
        self.profile = p;
        Ok(())
    }
    pub fn profile(&self) -> Profile {
        self.profile
    }
    /// Bench-only mode selection; ordinary builds have no such entry point.
    #[cfg(feature = "capture-readback-experiment")]
    pub fn set_readback_experiment(&mut self, enabled: bool) -> Result<(), String> {
        self.wgc.set_readback_experiment(enabled)
    }
    #[cfg(feature = "capture-readback-experiment")]
    pub fn reset_readback_metrics(&mut self) {
        self.wgc.reset_readback_metrics();
    }
    #[cfg(feature = "capture-readback-experiment")]
    pub fn readback_metrics_json(&self) -> String {
        self.wgc.readback_metrics_json()
    }
    #[cfg(feature = "capture-readback-experiment")]
    pub fn readback_frame_age(&self) -> Option<std::time::Duration> {
        self.wgc.readback_frame_age()
    }
    /// Writes BGRX into caller-owned storage, retaining staging/resize resources.
    pub fn backend(&self) -> &'static str {
        "native-wgc"
    }
    pub fn frame(&mut self, output: &mut Vec<u8>) -> Result<Option<(u32, u32)>, String> {
        #[cfg(feature = "capture-diagnostics")]
        let diagnostic = self.wgc.diagnostics();
        #[cfg(feature = "capture-diagnostics")]
        let mut frame_span = diagnostic.frame_span();
        let profile = self.profile;
        let Some((w, h)) = self.wgc.read(|w, h| {
            Ok(if profile.size(w, h)? == (w, h) {
                FullBuffer::Bytes(&mut *output)
            } else {
                FullBuffer::Dib(&mut self.raw)
            })
        })?
        else {
            #[cfg(feature = "capture-diagnostics")]
            frame_span.outcome(crate::diagnostics::Stage::FrameNone);
            return Ok(None);
        };
        let (width, height) = profile.size(w, h)?;
        if (width, height) == (w, h) {
            #[cfg(feature = "capture-diagnostics")]
            frame_span.outcome(crate::diagnostics::Stage::FrameSuccess);
            return Ok(Some((w, h)));
        }
        // This path retains the existing HALFTONE resize and final DIB copy.
        let raw = self.raw.as_ref().ok_or("Quadro indisponível.")?;
        let dib = {
            if self
                .scaled
                .as_ref()
                .is_none_or(|b| b.width != width || b.height != height)
            {
                self.scaled = Some(Dib::new(width, height)?);
            }
            let dst = self.scaled.as_ref().unwrap();
            unsafe {
                SetStretchBltMode(dst.dc, HALFTONE);
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
        };
        let len = byte_len(width, height)?;
        output.resize(len, 0);
        // The DIB is thread-local and GDI calls above are synchronous. This copy
        // finishes before the bitmap can be written again or its resources freed.
        unsafe {
            GdiFlush();
            std::ptr::copy_nonoverlapping(dib.bits.as_ptr(), output.as_mut_ptr(), len);
        }
        #[cfg(feature = "capture-diagnostics")]
        frame_span.outcome(crate::diagnostics::Stage::FrameSuccess);
        Ok(Some((width, height)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "capture-diagnostics")]
    #[test]
    fn diagnostic_row_timing_keeps_the_same_copy_and_invalid_pitch_guard() {
        let d = crate::diagnostics::Recorder::new();
        d.set_enabled(true);
        d.reset_window();
        let pixels = [1u8, 2, 3, 4, 99, 99, 99, 99, 5, 6, 7, 8];
        let mut output = Vec::new();
        unsafe { FullBuffer::Bytes(&mut output).copy_from(pixels.as_ptr(), 8, 1, 2, &d) }.unwrap();
        assert_eq!(output, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(
            unsafe { FullBuffer::Bytes(&mut output).copy_from(pixels.as_ptr(), 3, 1, 2, &d) }
                .is_err()
        );
        assert_eq!(output, [1, 2, 3, 4, 5, 6, 7, 8]);
        let s = d.snapshot();
        assert_eq!(
            s.metrics[crate::diagnostics::Stage::RowCopy as usize].count,
            1
        );
        assert_eq!(
            s.metrics[crate::diagnostics::Stage::BufferPrepare as usize].count,
            1
        );
    }

    #[test]
    fn full_buffer_copies_bgrx_rows_without_padding_and_reuses_the_vec() {
        let pixels = [
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, 9, 10, 11, 12, 13, 14, 15, 16,
        ];
        let mut output = Vec::with_capacity(64);
        let allocation = output.as_ptr();
        unsafe {
            FullBuffer::Bytes(&mut output).copy_from(
                pixels.as_ptr(),
                12,
                2,
                2,
                #[cfg(feature = "capture-diagnostics")]
                &crate::diagnostics::Recorder::new(),
            )
        }
        .unwrap();
        assert_eq!(output, (1..=16).collect::<Vec<_>>());
        assert_eq!(output.as_ptr(), allocation);
        unsafe {
            FullBuffer::Bytes(&mut output).copy_from(
                pixels.as_ptr(),
                12,
                1,
                1,
                #[cfg(feature = "capture-diagnostics")]
                &crate::diagnostics::Recorder::new(),
            )
        }
        .unwrap();
        assert_eq!(output, [1, 2, 3, 4]);
        assert_eq!(output.as_ptr(), allocation);
    }

    #[test]
    fn full_buffer_rejects_invalid_geometry_pitch_and_null_before_mutating_output() {
        let pixels = [0u8; 16];
        for (source, pitch, width, height) in [
            (pixels.as_ptr(), 7, 2, 2),
            (std::ptr::null(), 8, 2, 2),
            (pixels.as_ptr(), 8, 0, 2),
            (pixels.as_ptr(), 8, 8192, 8192),
            (pixels.as_ptr(), usize::MAX, 1, 2),
        ] {
            let mut output = vec![42];
            assert!(unsafe {
                FullBuffer::Bytes(&mut output).copy_from(
                    source,
                    pitch,
                    width,
                    height,
                    #[cfg(feature = "capture-diagnostics")]
                    &crate::diagnostics::Recorder::new(),
                )
            }
            .is_err());
            assert_eq!(output, [42]);
        }
    }

    #[test]
    fn dib_and_direct_destinations_receive_identical_full_bgrx_bytes() {
        let pixels = [
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, 9, 10, 11, 12, 13, 14, 15, 16,
        ];
        let mut output = Vec::new();
        let mut dib = None;
        unsafe {
            FullBuffer::Bytes(&mut output)
                .copy_from(
                    pixels.as_ptr(),
                    12,
                    2,
                    2,
                    #[cfg(feature = "capture-diagnostics")]
                    &crate::diagnostics::Recorder::new(),
                )
                .unwrap();
            FullBuffer::Dib(&mut dib)
                .copy_from(
                    pixels.as_ptr(),
                    12,
                    2,
                    2,
                    #[cfg(feature = "capture-diagnostics")]
                    &crate::diagnostics::Recorder::new(),
                )
                .unwrap();
            assert_eq!(
                std::slice::from_raw_parts(dib.as_ref().unwrap().bits.as_ptr(), output.len()),
                output
            );
        }
    }
}

#[cfg(test)]
mod producer_wake_tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn progress_before_wait_is_sticky_coalesces_and_does_not_replay() {
        let wake = ProducerWake::new().expect("real Windows auto-reset event");
        let pacer = FramePacer::new();
        assert!(wake.signal());
        assert!(wake.signal());
        assert_eq!(
            pacer.wait_progress(Duration::from_millis(200), Some(&wake)),
            WakeWait::Progress
        );
        assert_eq!(
            pacer.wait_progress(Duration::from_millis(1), Some(&wake)),
            WakeWait::Timer
        );
    }
    #[test]
    fn progress_during_wait_wakes_without_closing_the_shared_handle() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<ProducerWake>();
        let wake = ProducerWake::new().expect("real Windows auto-reset event");
        let signal = wake.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            assert!(signal.signal());
        });
        let pacer = FramePacer::new();
        let started = std::time::Instant::now();
        assert_eq!(
            pacer.wait_progress(Duration::from_millis(200), Some(&wake)),
            WakeWait::Progress
        );
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "early wake before the original timer was not observed"
        );
        thread.join().unwrap();
        assert_eq!(std::sync::Arc::strong_count(&wake.0), 1);
        assert_eq!(
            pacer.wait_progress(Duration::from_millis(1), Some(&wake)),
            WakeWait::Timer
        );
    }
    #[test]
    fn missing_or_disabled_event_uses_original_bounded_sleep() {
        let pacer = FramePacer::new();
        assert_eq!(
            pacer.wait_progress(Duration::ZERO, None),
            WakeWait::Fallback
        );
        let wake = ProducerWake::new().expect("real Windows auto-reset event");
        wake.disable();
        assert!(!wake.signal());
        assert_eq!(
            pacer.wait_progress(Duration::from_millis(1), Some(&wake)),
            WakeWait::Fallback
        );
    }
}
