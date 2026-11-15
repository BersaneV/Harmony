//! OS-selected capture item, bounded frame pool, reusable GPU staging texture.
use super::{Dib, Profile, Source};
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
            if make(D3D_DRIVER_TYPE_HARDWARE, &mut device, &mut context).is_err() {
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
            let closed = Arc::new(AtomicBool::new(false));
            let closing = closed.clone();
            let closed_token = item.Closed(&TypedEventHandler::<
                GraphicsCaptureItem,
                windows::core::IInspectable,
            >::new(move |_, _| {
                closing.store(true, Ordering::Release);
                Ok(())
            }))?;
            let ready = Arc::new(AtomicBool::new(false));
            let arrived = ready.clone();
            let frame_token = pool.FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                windows::core::IInspectable,
            >::new(move |_, _| {
                arrived.store(true, Ordering::Release);
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
    pub fn read(&mut self, raw: &mut Option<Dib>) -> Result<bool, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("A janela compartilhada foi fechada.".into());
        }
        if !self.ready.swap(false, Ordering::AcqRel) {
            return Ok(false);
        }
        let mut frame = match self.pool.TryGetNextFrame() {
            Ok(f) => f,
            Err(e) if e.code().0 == 0x80004003u32 as i32 => return Ok(false),
            Err(_) => return Err("A captura do Windows foi encerrada.".into()),
        };
        while let Ok(newer) = self.pool.TryGetNextFrame() {
            let _ = frame.Close();
            frame = newer;
        }
        let result = (|| -> Result<bool, String> {
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
                return Ok(false);
            }
            let access: IDirect3DDxgiInterfaceAccess = frame
                .Surface()
                .and_then(|s| s.cast())
                .map_err(|_| "Quadro Direct3D indisponível.")?;
            let texture: ID3D11Texture2D =
                unsafe { access.GetInterface() }.map_err(|_| "Textura de captura indisponível.")?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.Width < w || desc.Height < h {
                return Err("Formato de captura não suportado.".into());
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
            unsafe { self.context.CopyResource(staging, &texture) };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            }
            .map_err(|_| "Não foi possível mapear o quadro da captura.")?;
            let copied = (|| -> Result<(), String> {
                if mapped.pData.is_null() || (mapped.RowPitch as usize) < w as usize * 4 {
                    return Err("Layout de captura inválido.".into());
                }
                if raw.as_ref().is_none_or(|d| d.width != w || d.height != h) {
                    *raw = Some(Dib::new(w, h)?);
                }
                let target = raw.as_ref().unwrap();
                for row in 0..h as usize {
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                            target.bits.as_ptr().add(row * w as usize * 4),
                            w as usize * 4,
                        );
                    }
                }
                Ok(())
            })();
            unsafe { self.context.Unmap(staging, 0) };
            copied?;
            Ok(true)
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
