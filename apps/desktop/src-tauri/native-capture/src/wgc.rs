//! OS-selected capture item, bounded frame pool, reusable GPU staging texture.
use super::{FullBuffer, Profile, Source};
use crate::byte_len;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use windows::{
    core::{factory, Interface, HSTRING},
    Foundation::{Metadata::ApiInformation, TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::*,
            Dxgi::{Common::DXGI_FORMAT_B8G8R8A8_UNORM, IDXGIDevice},
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
            RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED, RO_INIT_SINGLETHREADED,
        },
    },
};

struct Apartment;
impl Apartment {
    fn new() -> windows::core::Result<Self> {
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Ok(Self),
            Err(e) if e.code().0 == 0x80010106u32 as i32 => {
                unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }?;
                Ok(Self)
            }
            Err(e) => Err(e),
        }
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() }
    }
}
pub struct Wgc {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    item: GraphicsCaptureItem,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    interop: IDirect3DDevice,
    staging: Option<ID3D11Texture2D>,
    size: SizeInt32,
    closed: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    closed_token: i64,
    frame_token: i64,
    #[cfg(feature = "capture-diagnostics")]
    diagnostics: std::rc::Rc<crate::diagnostics::Recorder>,
    #[cfg(feature = "capture-frame-ready-experiment")]
    frame_signal: Arc<frame_ready::Signal>,
    pub title: String,
    // Rust drops fields in declaration order, after Drop; release COM before RoUninitialize.
    _apartment: Apartment,
}
impl Wgc {
    pub fn supported() -> bool {
        let Ok(_apartment) = Apartment::new() else {
            return false;
        };
        GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }
    pub fn new(
        source: &Source,
        profile: Profile,
        owner: isize,
        authorized: impl Fn() -> bool,
    ) -> Result<Self, String> {
        let apartment =
            Apartment::new().map_err(|_| "Não foi possível iniciar a captura do Windows.")?;
        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err(
                "A captura nativa não está disponível neste Windows. Use o seletor do navegador."
                    .into(),
            );
        }
        let stage = std::cell::Cell::new("pin_item");
        let result = (|| -> windows::core::Result<Self> {
            let factory: IGraphicsCaptureItemInterop =
                factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            // Pin the actual item before consent. Reuse of HWND after this point
            // cannot silently change which OS capture item will be published.
            let item: GraphicsCaptureItem =
                unsafe { factory.CreateForWindow(HWND(source.handle as *mut _)) }?;
            let title = item.DisplayName()?.to_string();
            let size = item.Size()?;
            let width: u32 = size.Width.try_into().map_err(|_| {
                windows::core::Error::from_hresult(windows::core::HRESULT(0x80070057u32 as i32))
            })?;
            let height: u32 = size.Height.try_into().map_err(|_| {
                windows::core::Error::from_hresult(windows::core::HRESULT(0x80070057u32 as i32))
            })?;
            byte_len(width, height).map_err(|_| {
                windows::core::Error::from_hresult(windows::core::HRESULT(0x80070057u32 as i32))
            })?;
            if !authorized() || !source.confirm_title(owner, &title) || !authorized() {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80004004u32 as i32,
                )));
            }
            stage.set("d3d_device");
            let mut device = None;
            let mut context = None;
            let make = |kind, device: &mut _, context: &mut _| unsafe {
                D3D11CreateDevice(
                    None::<&windows::Win32::Graphics::Dxgi::IDXGIAdapter>,
                    kind,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(device),
                    None,
                    Some(context),
                )
            };
            #[cfg(feature = "capture-diagnostics")]
            let mut driver_type = 1;
            if make(D3D_DRIVER_TYPE_HARDWARE, &mut device, &mut context).is_err() {
                #[cfg(feature = "capture-diagnostics")]
                {
                    driver_type = 2;
                }
                make(D3D_DRIVER_TYPE_WARP, &mut device, &mut context)?;
            }
            let device: ID3D11Device = device.ok_or_else(windows::core::Error::from_thread)?;
            let context = context.ok_or_else(windows::core::Error::from_thread)?;
            let dxgi: IDXGIDevice = device.cast()?;
            let interop: IDirect3DDevice =
                unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }?.cast()?;
            stage.set("frame_pool");
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &interop,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size,
            )?;
            let session = pool.CreateCaptureSession(&item)?;
            #[cfg(feature = "capture-frame-ready-experiment")]
            let frame_signal = Arc::new(frame_ready::Signal::new());
            #[cfg(feature = "capture-frame-ready-experiment")]
            let close_signal = frame_signal.clone();
            let closed = Arc::new(AtomicBool::new(false));
            let closing = closed.clone();
            let closed_token = item.Closed(&TypedEventHandler::<
                GraphicsCaptureItem,
                windows::core::IInspectable,
            >::new(move |_, _| {
                closing.store(true, Ordering::Release);
                #[cfg(feature = "capture-frame-ready-experiment")]
                close_signal.signal();
                Ok(())
            }))?;
            let ready = Arc::new(AtomicBool::new(false));
            let arrived = ready.clone();
            #[cfg(feature = "capture-frame-ready-experiment")]
            let arrival_signal = frame_signal.clone();
            #[cfg(feature = "capture-diagnostics")]
            let diagnostics = std::rc::Rc::new(crate::diagnostics::Recorder::new());
            #[cfg(feature = "capture-diagnostics")]
            diagnostics.set_driver_type(driver_type);
            #[cfg(feature = "capture-diagnostics")]
            let notices = diagnostics.arrivals();
            let frame_token = pool.FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                windows::core::IInspectable,
            >::new(move |_, _| {
                #[cfg(feature = "capture-diagnostics")]
                notices.notify();
                arrived.store(true, Ordering::Release);
                #[cfg(feature = "capture-frame-ready-experiment")]
                arrival_signal.signal();
                Ok(())
            }))?;
            Self::set_interval(&session, profile.fps);
            stage.set("start_capture");
            session.StartCapture()?;
            Ok(Self {
                pool,
                session,
                item,
                device,
                context,
                interop,
                staging: None,
                size,
                closed,
                ready,
                closed_token,
                frame_token,
                #[cfg(feature = "capture-diagnostics")]
                diagnostics,
                #[cfg(feature = "capture-frame-ready-experiment")]
                frame_signal,
                title,
                _apartment: apartment,
            })
        })();
        result.map_err(|e| {
            if e.code().0 != 0x80004004u32 as i32 {
                eprintln!(
                    "harmony_native_capture stage={} hresult={:08X}",
                    stage.get(),
                    e.code().0 as u32
                );
            }
            if e.code().0 == 0x80004004u32 as i32 {
                "A seleção da janela foi cancelada.".into()
            } else {
                "O Windows não permitiu iniciar a captura desta janela.".into()
            }
        })
    }
    fn set_interval(session: &GraphicsCaptureSession, fps: u32) {
        if ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("MinUpdateInterval"),
        )
        .unwrap_or(false)
        {
            let _ = session.SetMinUpdateInterval(TimeSpan {
                Duration: 10_000_000 / i64::from(fps),
            });
        }
    }
    pub fn set_fps(&self, fps: u32) {
        Self::set_interval(&self.session, fps)
    }
    pub fn dimensions(&self) -> (u32, u32) {
        (self.size.Width as u32, self.size.Height as u32)
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    #[cfg(feature = "capture-frame-ready-experiment")]
    pub(super) fn wait_frame_ready(
        &self,
        timeout: std::time::Duration,
        cancelled: impl Fn() -> bool,
    ) -> super::FrameReadyWait {
        self.frame_signal
            .wait(&self.ready, &self.closed, timeout, cancelled)
    }
    #[cfg(feature = "capture-frame-ready-experiment")]
    pub(super) fn frame_ready_counters(&self) -> super::FrameReadyCounters {
        self.frame_signal.snapshot()
    }
    #[cfg(feature = "capture-diagnostics")]
    pub(super) fn diagnostics(&self) -> std::rc::Rc<crate::diagnostics::Recorder> {
        self.diagnostics.clone()
    }
    pub(super) fn read<'a>(
        &mut self,
        choose: impl FnOnce(u32, u32) -> Result<FullBuffer<'a>, String>,
    ) -> Result<Option<(u32, u32)>, String> {
        #[cfg(feature = "capture-diagnostics")]
        let diagnostic = self.diagnostics();
        #[cfg(feature = "capture-diagnostics")]
        let _read = diagnostic.span(crate::diagnostics::Stage::WgcRead);
        #[cfg(feature = "capture-diagnostics")]
        diagnostic.begin_attempt();
        if self.closed.load(Ordering::Acquire) {
            return Err("A janela compartilhada foi fechada.".into());
        }
        if !self.ready.swap(false, Ordering::AcqRel) {
            #[cfg(feature = "capture-diagnostics")]
            diagnostic.none(0);
            return Ok(None);
        }
        #[cfg(feature = "capture-diagnostics")]
        diagnostic.notice_age();
        #[cfg(feature = "capture-diagnostics")]
        let drain_span = diagnostic.span(crate::diagnostics::Stage::PoolDrain);
        let mut frame = match self.pool.TryGetNextFrame() {
            Ok(f) => f,
            // windows-core 0.62 maps a successful nullable COM result to
            // Error::empty() (code S_OK), not E_POINTER. A late FrameArrived
            // callback after draining the pool must not terminate capture.
            Err(e) if e.code().0 == 0 => {
                #[cfg(feature = "capture-diagnostics")]
                diagnostic.none(1);
                return Ok(None);
            }
            Err(e) => {
                eprintln!(
                    "harmony_native_capture stage=next_frame hresult={:08X}",
                    e.code().0 as u32
                );
                return Err("A captura do Windows foi encerrada.".into());
            }
        };
        #[cfg(feature = "capture-diagnostics")]
        let mut drained = 0;
        while let Ok(newer) = self.pool.TryGetNextFrame() {
            let _ = frame.Close();
            frame = newer;
            #[cfg(feature = "capture-diagnostics")]
            {
                drained += 1;
            }
        }
        #[cfg(feature = "capture-diagnostics")]
        {
            diagnostic.drain(drained);
            drop(drain_span);
        }
        let result = (|| -> Result<Option<(u32, u32)>, String> {
            let size = frame
                .ContentSize()
                .map_err(|_| "Tamanho de captura indisponível.")?;
            let w: u32 = size
                .Width
                .try_into()
                .map_err(|_| "Tamanho de captura inválido.")?;
            let h: u32 = size
                .Height
                .try_into()
                .map_err(|_| "Tamanho de captura inválido.")?;
            byte_len(w, h)?;
            if size != self.size {
                self.pool
                    .Recreate(
                        &self.interop,
                        DirectXPixelFormat::B8G8R8A8UIntNormalized,
                        2,
                        size,
                    )
                    .map_err(|_| "Não foi possível acompanhar o tamanho da janela.")?;
                self.size = size;
                self.staging = None;
                #[cfg(feature = "capture-diagnostics")]
                diagnostic.none(2);
                return Ok(None);
            }
            // Choose using this frame's validated geometry only after handling
            // pool resize. No callback/allocation error can bypass an Unmap.
            let target = choose(w, h)?;
            let access: IDirect3DDxgiInterfaceAccess = frame
                .Surface()
                .and_then(|s| s.cast())
                .map_err(|_| "Quadro Direct3D indisponível.")?;
            let texture: ID3D11Texture2D =
                unsafe { access.GetInterface() }.map_err(|_| "Textura de captura indisponível.")?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            byte_len(desc.Width, desc.Height)?;
            if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
                || desc.Width < w
                || desc.Height < h
                || desc.SampleDesc.Count != 1
                || desc.ArraySize != 1
                || desc.MipLevels != 1
            {
                return Err("Formato de captura não suportado.".into());
            }
            if let Some(staging) = &self.staging {
                let mut previous = D3D11_TEXTURE2D_DESC::default();
                unsafe { staging.GetDesc(&mut previous) };
                if previous.Width != desc.Width
                    || previous.Height != desc.Height
                    || previous.Format != desc.Format
                {
                    self.staging = None;
                }
            }
            if self.staging.is_none() {
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.MiscFlags = 0;
                desc.ArraySize = 1;
                desc.MipLevels = 1;
                unsafe {
                    self.device
                        .CreateTexture2D(&desc, None, Some(&mut self.staging))
                }
                .map_err(|_| "Não foi possível ler o quadro da captura.")?;
            }
            let staging = self.staging.as_ref().ok_or("Quadro indisponível.")?;
            #[cfg(feature = "capture-diagnostics")]
            let copy_span = diagnostic.span(crate::diagnostics::Stage::CopyResourceCpu);
            unsafe { self.context.CopyResource(staging, &texture) };
            #[cfg(feature = "capture-diagnostics")]
            drop(copy_span);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            #[cfg(feature = "capture-diagnostics")]
            let map_span = diagnostic.span(crate::diagnostics::Stage::MapWall);
            unsafe {
                self.context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            }
            .map_err(|_| "Não foi possível mapear o quadro da captura.")?;
            #[cfg(feature = "capture-diagnostics")]
            drop(map_span);
            let copied = unsafe {
                target.copy_from(
                    mapped.pData as *const u8,
                    mapped.RowPitch as usize,
                    w,
                    h,
                    #[cfg(feature = "capture-diagnostics")]
                    &diagnostic,
                )
            };
            #[cfg(feature = "capture-diagnostics")]
            let unmap_span = diagnostic.span(crate::diagnostics::Stage::Unmap);
            unsafe { self.context.Unmap(staging, 0) };
            #[cfg(feature = "capture-diagnostics")]
            drop(unmap_span);
            copied?;
            #[cfg(feature = "capture-diagnostics")]
            if diagnostic.enabled() {
                let getter = diagnostic.span(crate::diagnostics::Stage::TimestampGetter);
                let timestamp = frame.SystemRelativeTime().ok().map(|time| time.Duration);
                drop(getter);
                // Telemetry failure must never turn a successful copy into failure.
                diagnostic.observe_frame(timestamp);
            }
            Ok(Some((w, h)))
        })();
        let _ = frame.Close();
        result
    }
}
impl Drop for Wgc {
    fn drop(&mut self) {
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.pool.RemoveFrameArrived(self.frame_token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

#[cfg(feature = "capture-frame-ready-experiment")]
mod frame_ready {
    use super::super::{FrameReadyCounters, FrameReadyWait};
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        sync::atomic::{AtomicBool, AtomicU64, Ordering},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{CreateEventW, ResetEvent, SetEvent, WaitForSingleObject},
    };

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Point {
        BeforeReset,
        AfterReset,
        BeforeWait,
    }

    // OwnedHandle closes exactly once, after WGC and all callback Arc owners
    // are gone. No handle may close while a native wait borrows this Signal.
    pub(super) struct Signal {
        handle: Option<OwnedHandle>,
        creation_error: u32,
        calls: AtomicU64,
        errors: AtomicU64,
        total_ns: AtomicU64,
        max_ns: AtomicU64,
    }
    impl Signal {
        pub(super) fn new() -> Self {
            // Unnamed manual-reset event, initially nonsignaled and not inherited.
            let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if handle.is_null() {
                return Self::unavailable(unsafe { GetLastError() });
            }
            Self {
                handle: Some(unsafe { OwnedHandle::from_raw_handle(handle) }),
                ..Self::unavailable(0)
            }
        }
        fn unavailable(error: u32) -> Self {
            Self {
                handle: None,
                creation_error: error,
                calls: AtomicU64::new(0),
                errors: AtomicU64::new(0),
                total_ns: AtomicU64::new(0),
                max_ns: AtomicU64::new(0),
            }
        }
        pub(super) fn signal(&self) {
            let start = Instant::now();
            let ok = self
                .handle
                .as_ref()
                .is_some_and(|handle| unsafe { SetEvent(handle.as_raw_handle()) } != 0);
            let ns = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
            self.total_ns.fetch_add(ns, Ordering::Relaxed);
            self.max_ns.fetch_max(ns, Ordering::Relaxed);
            self.errors.fetch_add(u64::from(!ok), Ordering::Relaxed);
            self.calls.fetch_add(1, Ordering::Release);
        }
        pub(super) fn snapshot(&self) -> FrameReadyCounters {
            FrameReadyCounters {
                available: self.handle.is_some(),
                creation_error: self.creation_error,
                signal_calls: self.calls.load(Ordering::Acquire),
                signal_errors: self.errors.load(Ordering::Acquire),
                signal_wall_ns: self.total_ns.load(Ordering::Acquire),
                signal_max_wall_ns: self.max_ns.load(Ordering::Acquire),
            }
        }
        pub(super) fn wait(
            &self,
            ready: &AtomicBool,
            closed: &AtomicBool,
            timeout: Duration,
            cancelled: impl Fn() -> bool,
        ) -> FrameReadyWait {
            self.wait_inner(ready, closed, timeout, cancelled, |_| {})
        }
        fn wait_inner(
            &self,
            ready: &AtomicBool,
            closed: &AtomicBool,
            timeout: Duration,
            cancelled: impl Fn() -> bool,
            mut hook: impl FnMut(Point),
        ) -> FrameReadyWait {
            let start = Instant::now();
            let timeout_ms = u32::from(!timeout.is_zero()); // Clamp every positive request to at most one millisecond.
            let finish = |status, kernel_wait, kernel_wall_ns, error| {
                let total = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
                FrameReadyWait {
                    status,
                    kernel_wait,
                    timeout_ms,
                    error,
                    setup_wall_ns: total.saturating_sub(kernel_wall_ns),
                    kernel_wall_ns,
                }
            };
            if closed.load(Ordering::Acquire) {
                return finish(4, false, 0, 0);
            }
            if cancelled() {
                return finish(10, false, 0, 0);
            }
            if ready.load(Ordering::Acquire) {
                return finish(0, false, 0, 0);
            }
            let Some(handle) = &self.handle else {
                return finish(5, false, 0, self.creation_error);
            };
            hook(Point::BeforeReset);
            if unsafe { ResetEvent(handle.as_raw_handle()) } == 0 {
                return finish(6, false, 0, unsafe { GetLastError() });
            }
            hook(Point::AfterReset);
            // The callback may set the latch immediately before ResetEvent.
            // Rechecking after reset prevents that signal from being lost.
            if closed.load(Ordering::Acquire) {
                return finish(4, false, 0, 0);
            }
            if cancelled() {
                return finish(10, false, 0, 0);
            }
            if ready.load(Ordering::Acquire) {
                return finish(1, false, 0, 0);
            }
            hook(Point::BeforeWait);
            let wait_start = Instant::now();
            let outcome = unsafe { WaitForSingleObject(handle.as_raw_handle(), timeout_ms) };
            let error = if outcome == WAIT_FAILED {
                unsafe { GetLastError() }
            } else {
                0
            };
            let ns = u64::try_from(wait_start.elapsed().as_nanos()).unwrap_or(u64::MAX);
            if closed.load(Ordering::Acquire) {
                return finish(4, true, ns, 0);
            }
            if cancelled() {
                return finish(10, true, ns, 0);
            }
            match outcome {
                WAIT_OBJECT_0 => finish(
                    if ready.load(Ordering::Acquire) { 2 } else { 8 },
                    true,
                    ns,
                    0,
                ),
                WAIT_TIMEOUT => finish(
                    if ready.load(Ordering::Acquire) { 9 } else { 3 },
                    true,
                    ns,
                    0,
                ),
                _ => finish(7, true, ns, error),
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Arc;
        #[test]
        fn arrival_before_reset_is_preserved_by_latch_recheck() {
            let s = Signal::new();
            assert!(s.snapshot().available);
            let ready = AtomicBool::new(false);
            let closed = AtomicBool::new(false);
            let r = s.wait_inner(
                &ready,
                &closed,
                Duration::from_secs(9),
                || false,
                |point| {
                    if point == Point::BeforeReset {
                        ready.store(true, Ordering::Release);
                        s.signal();
                    }
                },
            );
            assert_eq!(r.status, 1);
            assert!(!r.kernel_wait);
            assert_eq!(r.timeout_ms, 1);
            assert!(ready.load(Ordering::Acquire));
        }
        #[test]
        fn arrival_after_recheck_and_close_after_reset_both_wake_without_consumption() {
            let s = Signal::new();
            assert!(s.snapshot().available);
            let ready = AtomicBool::new(false);
            let closed = AtomicBool::new(false);
            let r = s.wait_inner(
                &ready,
                &closed,
                Duration::from_millis(1),
                || false,
                |point| {
                    if point == Point::BeforeWait {
                        ready.store(true, Ordering::Release);
                        s.signal();
                    }
                },
            );
            assert_eq!(r.status, 2);
            assert!(r.kernel_wait);
            assert!(ready.load(Ordering::Acquire));
            ready.store(false, Ordering::Release);
            let r = s.wait_inner(
                &ready,
                &closed,
                Duration::from_millis(1),
                || false,
                |point| {
                    if point == Point::AfterReset {
                        closed.store(true, Ordering::Release);
                        s.signal();
                    }
                },
            );
            assert_eq!(r.status, 4);
            assert!(!r.kernel_wait);
            closed.store(false, Ordering::Release);
            let r = s.wait_inner(
                &ready,
                &closed,
                Duration::from_millis(1),
                || false,
                |point| {
                    if point == Point::BeforeWait {
                        closed.store(true, Ordering::Release);
                        s.signal();
                    }
                },
            );
            assert_eq!(r.status, 4);
            assert!(r.kernel_wait);
        }
        #[test]
        fn cancellation_and_timeout_arguments_are_bounded_without_spin() {
            let s = Signal::new();
            let ready = AtomicBool::new(false);
            let closed = AtomicBool::new(false);
            let cancel = AtomicBool::new(false);
            let r = s.wait_inner(
                &ready,
                &closed,
                Duration::from_secs(30),
                || cancel.load(Ordering::Acquire),
                |point| {
                    if point == Point::AfterReset {
                        cancel.store(true, Ordering::Release);
                    }
                },
            );
            assert_eq!(r.status, 10);
            assert!(!r.kernel_wait);
            assert_eq!(r.timeout_ms, 1);
            cancel.store(false, Ordering::Release);
            let r = s.wait(&ready, &closed, Duration::ZERO, || false);
            assert_eq!(r.status, 3);
            assert!(r.kernel_wait);
            assert_eq!(r.timeout_ms, 0);
        }
        #[test]
        fn unavailable_event_is_explicit_and_arc_owns_handle_through_callbacks() {
            let s = Signal::unavailable(5);
            let ready = AtomicBool::new(false);
            let closed = AtomicBool::new(false);
            let r = s.wait(&ready, &closed, Duration::from_secs(1), || false);
            assert_eq!(r.status, 5);
            assert_eq!(r.error, 5);
            assert!(!r.kernel_wait);
            let owner = Arc::new(Signal::new());
            assert!(owner.snapshot().available);
            let weak = Arc::downgrade(&owner);
            let callback = owner.clone();
            drop(owner);
            assert!(weak.upgrade().is_some());
            let worker = std::thread::spawn(move || {
                callback.signal();
                assert_eq!(callback.snapshot().signal_errors, 0);
            });
            worker.join().unwrap();
            assert!(weak.upgrade().is_none());
        }
    }
}
