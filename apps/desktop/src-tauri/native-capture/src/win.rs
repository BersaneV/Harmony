use crate::{byte_len, Profile};
use std::{
    mem::size_of,
    ptr::{null_mut, NonNull},
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::Threading::{
        CreateWaitableTimerExW, GetCurrentProcessId, SetWaitableTimer, WaitForSingleObject,
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS,
    },
    UI::WindowsAndMessaging::*,
};
#[path = "wgc.rs"]
mod wgc;

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
        if row_pitch == row_bytes {
            unsafe { std::ptr::copy_nonoverlapping(source, destination, len) };
        } else {
            for row in 0..height as usize {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        source.add(row * row_pitch),
                        destination.add(row * row_bytes),
                        row_bytes,
                    );
                }
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
    pub fn dimensions(&self) -> Result<(u32, u32), String> {
        let (w, h) = self.source_dimensions();
        self.profile.size(w, h)
    }
    pub fn set_profile(&mut self, p: Profile) -> Result<(), String> {
        let p = p.validate()?;
        if self.profile.fps != p.fps {
            self.wgc.set_fps(p.fps);
        }
        self.profile = p;
        Ok(())
    }
    pub fn profile(&self) -> Profile {
        self.profile
    }
    /// Writes BGRX into caller-owned storage, retaining staging/resize resources.
    pub fn backend(&self) -> &'static str {
        "native-wgc"
    }
    pub fn frame(&mut self, output: &mut Vec<u8>) -> Result<Option<(u32, u32)>, String> {
        let profile = self.profile;
        let Some((w, h)) = self.wgc.read(|w, h| {
            Ok(if profile.size(w, h)? == (w, h) {
                FullBuffer::Bytes(&mut *output)
            } else {
                FullBuffer::Dib(&mut self.raw)
            })
        })?
        else {
            return Ok(None);
        };
        let (width, height) = profile.size(w, h)?;
        if (width, height) == (w, h) {
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
        Ok(Some((width, height)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn full_buffer_row_reference(
        target: FullBuffer<'_>,
        source: *const u8,
        row_pitch: usize,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        // Previous implementation, including its checks and destination preparation.
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
        let destination = match target {
            FullBuffer::Bytes(output) => {
                output.resize(len, 0);
                output.as_mut_ptr()
            }
            FullBuffer::Dib(raw) => {
                if raw
                    .as_ref()
                    .is_none_or(|d| d.width != width || d.height != height)
                {
                    *raw = Some(Dib::new(width, height)?);
                }
                raw.as_ref().unwrap().bits.as_ptr()
            }
        };
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

    #[test]
    fn full_buffer_copies_bgrx_rows_without_padding_and_reuses_the_vec() {
        let pixels = [
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, 9, 10, 11, 12, 13, 14, 15, 16,
        ];
        let mut output = Vec::with_capacity(64);
        let allocation = output.as_ptr();
        unsafe { FullBuffer::Bytes(&mut output).copy_from(pixels.as_ptr(), 12, 2, 2) }.unwrap();
        assert_eq!(output, (1..=16).collect::<Vec<_>>());
        assert_eq!(output.as_ptr(), allocation);
        unsafe { FullBuffer::Bytes(&mut output).copy_from(pixels.as_ptr(), 12, 1, 1) }.unwrap();
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
                FullBuffer::Bytes(&mut output).copy_from(source, pitch, width, height)
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
                .copy_from(pixels.as_ptr(), 12, 2, 2)
                .unwrap();
            FullBuffer::Dib(&mut dib)
                .copy_from(pixels.as_ptr(), 12, 2, 2)
                .unwrap();
            assert_eq!(
                std::slice::from_raw_parts(dib.as_ref().unwrap().bits.as_ptr(), output.len()),
                output
            );
        }
    }

    fn copy_pixels(width: u32, height: u32, padding: usize, seed: u8) -> (Vec<u8>, Vec<u8>) {
        let row_bytes = width as usize * 4;
        let pitch = row_bytes + padding;
        let mut pixels = vec![0xe7; pitch * height as usize];
        let mut expected = Vec::with_capacity(byte_len(width, height).unwrap());
        for row in 0..height as usize {
            for column in 0..row_bytes {
                pixels[row * pitch + column] = (row * 17 + column * 31) as u8 ^ seed;
            }
            expected.extend_from_slice(&pixels[row * pitch..row * pitch + row_bytes]);
        }
        (pixels, expected)
    }

    fn copied_bytes<'a>(output: &'a [u8], dib: &'a Option<Dib>, len: usize) -> &'a [u8] {
        match dib {
            Some(dib) => unsafe { std::slice::from_raw_parts(dib.bits.as_ptr(), len) },
            None => output,
        }
    }

    #[test]
    fn contiguous_and_padded_copies_match_all_bytes_and_reuse_both_destinations() {
        let (width, height) = (17, 3);
        let len = byte_len(width, height).unwrap();
        for padding in [0, 256] {
            for dib_target in [false, true] {
                let mut output = if dib_target { Vec::new() } else { vec![0; len] };
                let mut dib = dib_target.then(|| Dib::new(width, height).unwrap());
                let allocation = copied_bytes(&output, &dib, len).as_ptr();
                for seed in [0, 0x5a] {
                    let (pixels, expected) = copy_pixels(width, height, padding, seed);
                    for copy in [full_buffer_candidate as CopyFn, full_buffer_row_reference] {
                        let target = if dib_target {
                            FullBuffer::Dib(&mut dib)
                        } else {
                            FullBuffer::Bytes(&mut output)
                        };
                        unsafe {
                            copy(
                                target,
                                pixels.as_ptr(),
                                width as usize * 4 + padding,
                                width,
                                height,
                            )
                        }
                        .unwrap();
                        let bytes = copied_bytes(&output, &dib, len);
                        assert_eq!(bytes, expected);
                        assert_eq!(bytes.as_ptr(), allocation);
                    }
                }
            }
        }
    }

    type CopyFn =
        for<'a> unsafe fn(FullBuffer<'a>, *const u8, usize, u32, u32) -> Result<(), String>;

    unsafe fn full_buffer_candidate(
        target: FullBuffer<'_>,
        source: *const u8,
        row_pitch: usize,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        unsafe { target.copy_from(source, row_pitch, width, height) }
    }

    fn print_copy_timing(
        layout: (u32, u32, usize),
        destination: &str,
        implementation: &str,
        samples: &mut [u128],
        complete: bool,
    ) {
        let (width, height, pitch) = layout;
        samples.sort_unstable();
        let count = samples.len();
        let metrics = if count == 0 {
            "\"status\":\"NOT_VERIFIED\",\"mean_us\":null,\"p50_us\":null,\"p95_us\":null,\"max_us\":null".to_owned()
        } else {
            let mean = samples.iter().sum::<u128>() as f64 / count as f64 / 1000.0;
            let p50 = samples[count.div_ceil(2) - 1] as f64 / 1000.0;
            let p95 = samples[(count * 95).div_ceil(100) - 1] as f64 / 1000.0;
            let maximum = samples[count - 1] as f64 / 1000.0;
            format!("\"status\":\"OBSERVED\",\"mean_us\":{mean:.3},\"p50_us\":{p50:.3},\"p95_us\":{p95:.3},\"max_us\":{maximum:.3}")
        };
        println!("HARMONY_FULL_BUFFER_COPY_TIMING {{\"scope\":\"CPU copy only; not GPU Map, actual RowPitch or capture FPS\",\"capacity_approval\":false,\"order\":\"A/B/B/A\",\"width\":{width},\"height\":{height},\"row_pitch\":{pitch},\"destination\":\"{destination}\",\"implementation\":\"{implementation}\",\"complete\":{complete},\"count\":{count},{metrics}}}");
    }

    #[test]
    #[ignore = "Windows release CPU-copy diagnostic; never a speed or FPS gate"]
    fn full_buffer_copy_timing_diagnostic() {
        use std::hint::black_box;
        use std::time::{Duration, Instant};
        if cfg!(debug_assertions) {
            println!("HARMONY_FULL_BUFFER_COPY_TIMING {{\"status\":\"NOT_VERIFIED\",\"reason\":\"run with --release\",\"capacity_approval\":false}}");
            return;
        }
        // Eight small ABBA comparisons; stop taking samples after 20 s. Source,
        // expected bytes and one reusable destination peak below 44 MiB, plus GDI.
        let started = Instant::now();
        let budget = Duration::from_secs(20);
        let implementations: [(&str, CopyFn); 2] = [
            ("A_previous_rows", full_buffer_row_reference),
            ("B_candidate_real", full_buffer_candidate),
        ];
        let mut completed_cases = 0;
        'cases: for (width, height) in [(1920, 1080), (2560, 1440)] {
            for padding in [0, 256] {
                for dib_target in [false, true] {
                    if started.elapsed() >= budget {
                        break 'cases;
                    }
                    let len = byte_len(width, height).unwrap();
                    let pitch = width as usize * 4 + padding;
                    let (pixels, expected) = copy_pixels(width, height, padding, 0x3c);
                    let mut output = if dib_target { Vec::new() } else { vec![0; len] };
                    let mut dib = dib_target.then(|| Dib::new(width, height).unwrap());
                    let allocation = copied_bytes(&output, &dib, len).as_ptr();
                    let mut measurements = [Vec::with_capacity(64), Vec::with_capacity(64)];
                    let mut complete = true;
                    // Allocation, first touch and warmup are outside timed calls.
                    for (_, copy) in implementations {
                        for repetition in 0..4 {
                            if repetition > 0 && started.elapsed() >= budget {
                                complete = false;
                                break;
                            }
                            let target = if dib_target {
                                FullBuffer::Dib(&mut dib)
                            } else {
                                FullBuffer::Bytes(&mut output)
                            };
                            unsafe {
                                black_box(copy)(
                                    black_box(target),
                                    black_box(pixels.as_ptr()),
                                    black_box(pitch),
                                    black_box(width),
                                    black_box(height),
                                )
                            }
                            .unwrap();
                        }
                        assert_eq!(copied_bytes(&output, &dib, len), expected);
                        assert_eq!(copied_bytes(&output, &dib, len).as_ptr(), allocation);
                    }
                    'batches: for arm in [0, 1, 1, 0] {
                        for _ in 0..32 {
                            if started.elapsed() >= budget {
                                complete = false;
                                break 'batches;
                            }
                            let copy = black_box(implementations[arm].1);
                            let target = if dib_target {
                                FullBuffer::Dib(&mut dib)
                            } else {
                                FullBuffer::Bytes(&mut output)
                            };
                            let source = black_box(pixels.as_ptr());
                            let pitch = black_box(pitch);
                            let width = black_box(width);
                            let height = black_box(height);
                            let before = Instant::now();
                            let copied =
                                unsafe { copy(black_box(target), source, pitch, width, height) };
                            let elapsed = before.elapsed().as_nanos();
                            copied.unwrap();
                            measurements[arm].push(elapsed);
                        }
                        // Complete byte equality and reuse checks never enter timing.
                        assert_eq!(copied_bytes(&output, &dib, len), expected);
                        assert_eq!(copied_bytes(&output, &dib, len).as_ptr(), allocation);
                    }
                    for (arm, (name, _)) in implementations.iter().enumerate() {
                        print_copy_timing(
                            (width, height, pitch),
                            if dib_target { "DIB" } else { "Vec" },
                            name,
                            &mut measurements[arm],
                            complete,
                        );
                    }
                    if !complete {
                        break 'cases;
                    }
                    completed_cases += 1;
                }
            }
        }
        println!("HARMONY_FULL_BUFFER_COPY_TIMING_END {{\"capacity_approval\":false,\"completed_cases\":{completed_cases},\"expected_cases\":8,\"elapsed_ms\":{},\"budget_ms\":20000}}", started.elapsed().as_millis());
    }
}
