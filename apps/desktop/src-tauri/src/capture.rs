//! Local native capture boundary. This module never publishes network media.
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State, WebviewWindow};

#[derive(Default)]
pub struct CaptureState {
    #[cfg(windows)]
    inner: platform::Store,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Profile {
    pub height: u32,
    pub fps: u32,
}
#[derive(Serialize)]
pub struct Choice {
    pub key: String,
    pub title: String,
}
#[derive(Serialize)]
pub struct Started {
    pub id: String,
    pub source_handle: u64,
    pub source_title: String,
    pub width: u32,
    pub height: u32,
    pub backend: &'static str,
}
#[derive(Clone, Serialize)]
pub struct Frame {
    pub id: String,
    pub sequence: u64,
    pub allocation: u64,
    pub width: u32,
    pub height: u32,
    pub timestamp_us: u64,
    pub fps: Option<f64>,
    pub error: Option<String>,
    pub backend: &'static str,
}
pub(crate) fn document_allowed(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420))
}
fn owned(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Janela indisponível.")?;
    if window.label() != "main" || !document_allowed(&url) {
        return Err("Captura disponível apenas na janela local do Harmony.".into());
    }
    Ok(())
}
impl CaptureState {
    pub fn cancel_all(&self) {
        #[cfg(windows)]
        platform::cancel_all(&self.inner);
    }
}
#[tauri::command]
pub async fn native_capture_available(window: WebviewWindow) -> Result<bool, String> {
    owned(&window)?;
    #[cfg(windows)]
    {
        return Ok(tauri::async_runtime::spawn_blocking(
            harmony_native_capture::Capture::supported,
        )
        .await
        .unwrap_or(false));
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}
#[tauri::command]
pub fn native_capture_sources(
    window: WebviewWindow,
    state: State<CaptureState>,
) -> Result<Vec<Choice>, String> {
    owned(&window)?;
    #[cfg(windows)]
    {
        platform::sources(&state.inner)
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Err("Captura nativa disponível no Windows.".into())
    }
}
#[tauri::command]
pub async fn native_capture_start(
    window: WebviewWindow,
    state: State<'_, CaptureState>,
    key: String,
    client: String,
    profile: Profile,
    frames: Channel<Frame>,
) -> Result<Started, String> {
    owned(&window)?;
    harmony_native_capture::Profile {
        height: profile.height,
        fps: profile.fps,
    }
    .validate()?;
    #[cfg(windows)]
    {
        platform::start(window, &state.inner, key, client, profile, frames).await
    }
    #[cfg(not(windows))]
    {
        let _ = (state, key, client, profile, frames);
        Err("Captura nativa disponível no Windows.".into())
    }
}
#[tauri::command]
pub fn native_capture_ack(
    window: WebviewWindow,
    state: State<CaptureState>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    owned(&window)?;
    #[cfg(windows)]
    {
        platform::ack(&state.inner, &id, sequence)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, id, sequence);
        Ok(())
    }
}
#[tauri::command]
pub fn native_capture_profile(
    window: WebviewWindow,
    state: State<CaptureState>,
    id: String,
    profile: Profile,
) -> Result<(u32, u32), String> {
    owned(&window)?;
    harmony_native_capture::Profile {
        height: profile.height,
        fps: profile.fps,
    }
    .validate()?;
    #[cfg(windows)]
    {
        platform::profile(&state.inner, &id, profile)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, id, profile);
        Err("Captura nativa disponível no Windows.".into())
    }
}
#[tauri::command]
pub fn native_capture_stop(
    window: WebviewWindow,
    state: State<CaptureState>,
    id: String,
) -> Result<(), String> {
    owned(&window)?;
    #[cfg(windows)]
    {
        platform::stop(&state.inner, &id);
    }
    #[cfg(not(windows))]
    {
        let _ = (state, id);
    }
    Ok(())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use harmony_native_capture::{
        byte_len, Capture, FramePacer, Profile as CaptureProfile, Source,
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
    };
    use windows::core::{Interface, PCWSTR};
    type Choices = Option<(u64, Vec<Source>)>;
    #[derive(Default)]
    pub struct Store {
        next: AtomicU64,
        choices: Mutex<Choices>,
        runs: Mutex<HashMap<String, Arc<Run>>>,
    }
    struct Run {
        id: String,
        client: String,
        source: Source,
        bounds: Mutex<(u32, u32)>,
        profile: Mutex<CaptureProfile>,
        stop: AtomicBool,
        done: AtomicBool,
        pending: AtomicU64,
        pixels: Mutex<Vec<u8>>,
    }
    struct Shared {
        buffer: ICoreWebView2SharedBuffer,
        capacity: usize,
        allocation: u64,
    }
    thread_local! { static SHARED: RefCell<HashMap<String,Shared>>=RefCell::new(HashMap::new()); }
    impl Drop for Store {
        fn drop(&mut self) {
            if let Ok(runs) = self.runs.lock() {
                for run in runs.values() {
                    run.stop.store(true, Ordering::Release);
                }
            }
        }
    }
    fn locked<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
        m.lock().map_err(|_| "A captura foi interrompida.".into())
    }
    fn active(store: &Store, id: &str) -> Result<Arc<Run>, String> {
        locked(&store.runs)?
            .get(id)
            .filter(|r| !r.stop.load(Ordering::Acquire) && !r.done.load(Ordering::Acquire))
            .cloned()
            .ok_or("A captura terminou.".into())
    }
    fn convert(p: Profile) -> Result<CaptureProfile, String> {
        CaptureProfile {
            height: p.height,
            fps: p.fps,
        }
        .validate()
    }
    pub fn sources(store: &Store) -> Result<Vec<Choice>, String> {
        let generation = store.next.fetch_add(1, Ordering::Relaxed) + 1;
        let sources = Source::list();
        let result = sources
            .iter()
            .enumerate()
            .map(|(i, s)| Choice {
                key: format!("{generation}:{i}"),
                title: s.title.clone(),
            })
            .collect();
        *locked(&store.choices)? = Some((generation, sources));
        Ok(result)
    }
    pub async fn start(
        window: WebviewWindow,
        store: &Store,
        key: String,
        client: String,
        p: Profile,
        frames: Channel<Frame>,
    ) -> Result<Started, String> {
        let p = convert(p)?;
        if client.len() != 36 || !client.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Identificador de captura inválido.".into());
        }
        let owner = window
            .hwnd()
            .map_err(|_| "Janela do Harmony indisponível.")?
            .0 as isize;
        let (generation, index) = key.split_once(':').ok_or("Escolha uma janela.")?;
        let generation: u64 = generation.parse().map_err(|_| "Escolha uma janela.")?;
        let index: usize = index.parse().map_err(|_| "Escolha uma janela.")?;
        let source = {
            let choices = locked(&store.choices)?;
            let (current, list) = choices.as_ref().ok_or("Atualize a lista de janelas.")?;
            if *current != generation {
                return Err("A lista de janelas mudou. Escolha novamente.".into());
            }
            list.get(index).cloned().ok_or("Janela inválida.")?
        };
        let id = (store.next.fetch_add(1, Ordering::Relaxed) + 1).to_string();
        let run = Arc::new(Run {
            id: id.clone(),
            client,
            source,
            profile: Mutex::new(p),
            bounds: Mutex::new((0, 0)),
            stop: AtomicBool::new(false),
            done: AtomicBool::new(false),
            pending: AtomicU64::new(0),
            pixels: Mutex::new(Vec::new()),
        });
        {
            let mut runs = locked(&store.runs)?;
            runs.retain(|_, r| !r.done.load(Ordering::Acquire));
            if runs.len() >= 2 {
                return Err("Encerre a captura anterior antes de abrir outra prévia.".into());
            }
            runs.insert(id.clone(), run.clone());
        }
        let (response, ready) = tokio::sync::oneshot::channel();
        let failure = run.clone();
        let launched = thread::Builder::new()
            .name("harmony-capture".into())
            .spawn(move || {
                struct Finish {
                    run: Arc<Run>,
                    window: WebviewWindow,
                }
                impl Drop for Finish {
                    fn drop(&mut self) {
                        self.run.stop.store(true, Ordering::Release);
                        self.run.done.store(true, Ordering::Release);
                        close_buffer(&self.window, self.run.id.clone());
                    }
                }
                let _finish = Finish {
                    run: run.clone(),
                    window: window.clone(),
                };
                let mut response = Some(response);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                    || -> Result<(), String> {
                        let capture = Capture::new(run.source.clone(), p, owner, || {
                            !run.stop.load(Ordering::Acquire)
                        })?;
                        if run.stop.load(Ordering::Acquire) {
                            return Err("A captura foi cancelada.".into());
                        }
                        owned(&window)?;
                        *locked(&run.bounds)? = capture.source_dimensions();
                        let (width, height) = capture.dimensions()?;
                        let started = Started {
                            id: run.id.clone(),
                            source_handle: run.source.handle() as u64,
                            source_title: capture.source_title().to_string(),
                            width,
                            height,
                            backend: capture.backend(),
                        };
                        response
                            .take()
                            .unwrap()
                            .send(Ok(started))
                            .map_err(|_| "A solicitação da captura foi encerrada.")?;
                        produce(&window, &run, &frames, capture)
                    },
                ));
                if let Err(error) =
                    result.unwrap_or_else(|_| Err("A captura foi interrompida.".into()))
                {
                    if let Some(response) = response.take() {
                        let _ = response.send(Err(error));
                    } else {
                        let _ = frames.send(Frame {
                            id: run.id.clone(),
                            sequence: 0,
                            allocation: 0,
                            width: 0,
                            height: 0,
                            timestamp_us: 0,
                            fps: None,
                            error: Some(error),
                            backend: "native-wgc",
                        });
                    }
                }
            });
        if launched.is_err() {
            failure.stop.store(true, Ordering::Release);
            failure.done.store(true, Ordering::Release);
            return Err("Não foi possível iniciar a captura.".into());
        }
        ready.await.map_err(|_| "A captura foi interrompida.")?
    }
    fn produce(
        window: &WebviewWindow,
        run: &Arc<Run>,
        frames: &Channel<Frame>,
        mut capture: Capture,
    ) -> Result<(), String> {
        let start = Instant::now();
        let pacer = FramePacer::new();
        let mut deadline = start;
        let mut sequence = 0;
        let mut since = start;
        let mut count = 0;
        let mut fps = None;
        let mut unacked = start;
        while !run.stop.load(Ordering::Acquire) {
            if run.pending.load(Ordering::Acquire) != 0 {
                if unacked.elapsed() > Duration::from_secs(5) {
                    return Err("A prévia da captura deixou de responder.".into());
                }
                pacer.sleep(Duration::from_micros(500));
                continue;
            }
            let now = Instant::now();
            if now < deadline {
                pacer.sleep(deadline - now);
            }
            if run.stop.load(Ordering::Acquire) {
                break;
            }
            capture.set_profile(*locked(&run.profile)?)?;
            let Some((width, height)) = capture.frame(&mut *locked(&run.pixels)?)? else {
                // Pool is event-driven. Poll briefly for its newest frame;
                // waiting a full frame period here can halve the capture rate.
                pacer.sleep(Duration::from_millis(1));
                continue;
            };
            *locked(&run.bounds)? = capture.source_dimensions();
            sequence += 1;
            count += 1;
            let now = Instant::now();
            if since.elapsed() >= Duration::from_secs(1) {
                fps = Some(count as f64 / since.elapsed().as_secs_f64());
                since = now;
                count = 0;
            }
            run.pending.store(sequence, Ordering::Release);
            unacked = now;
            post(
                window,
                run.clone(),
                frames.clone(),
                Frame {
                    id: run.id.clone(),
                    sequence,
                    allocation: 0,
                    width,
                    height,
                    timestamp_us: start.elapsed().as_micros() as u64,
                    fps,
                    error: None,
                    backend: capture.backend(),
                },
            )?;
            deadline += capture.profile().period();
            if deadline < now {
                deadline = now;
            }
        }
        Ok(())
    }
    fn post(
        window: &WebviewWindow,
        run: Arc<Run>,
        frames: Channel<Frame>,
        mut meta: Frame,
    ) -> Result<(), String> {
        let page = window.clone();
        window.with_webview(move|view|{
            if run.stop.load(Ordering::Acquire){return;}
            let result=(||->Result<(),String>{
                owned(&page)?;
                let pixels=locked(&run.pixels)?;let len=byte_len(meta.width,meta.height)?;if pixels.len()!=len{return Err("Quadro de captura inválido.".into());}
                SHARED.with(|state|->Result<(),String>{
                    let mut buffers=state.borrow_mut();let capacity=len.next_power_of_two().min(harmony_native_capture::MAX_BYTES);
                    if buffers.get(&run.id).is_none_or(|b|b.capacity<len){
                        let allocation=buffers.get(&run.id).map_or(1,|b|b.allocation+1);
                        let environment:ICoreWebView2Environment12=view.environment().cast().map_err(|_|"Atualize o WebView2 para usar a captura nativa.")?;
                        let webview:ICoreWebView2_17=unsafe{view.controller().CoreWebView2()}.and_then(|w|w.cast()).map_err(|_|"O WebView2 não suporta a captura nativa.")?;
                        let buffer=unsafe{environment.CreateSharedBuffer(capacity as u64)}.map_err(|_|"Não foi possível reservar a captura.")?;
                        let data=serde_json::json!({"harmony_native_capture":run.client,"allocation":allocation}).to_string();let data:Vec<u16>=data.encode_utf16().chain(Some(0)).collect();
                        unsafe{webview.PostSharedBufferToScript(&buffer,COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,PCWSTR(data.as_ptr()))}.map_err(|_|"Não foi possível iniciar a prévia nativa.")?;
                        if let Some(old)=buffers.insert(run.id.clone(),Shared{buffer,capacity,allocation}){let _=unsafe{old.buffer.Close()};}
                    }
                    let shared=buffers.get(&run.id).unwrap();let mut destination=std::ptr::null_mut();
                    unsafe{shared.buffer.Buffer(&mut destination)}.map_err(|_|"O quadro da captura foi encerrado.")?;
                    if destination.is_null(){return Err("O quadro da captura foi encerrado.".into());}
                    // One in-flight lease. JS copies the BGRX bytes into VideoFrame
                    // before acknowledging this sequence; only then may we overwrite.
                    unsafe{std::ptr::copy_nonoverlapping(pixels.as_ptr(),destination,len);}
                    meta.allocation=shared.allocation;Ok(())
                })?;
                frames.send(meta.clone()).map_err(|_|"A prévia da captura foi encerrada.".to_string())
            })();
            if let Err(error)=result{run.stop.store(true,Ordering::Release);let _=frames.send(Frame{error:Some(error),..meta});}
        }).map_err(|_|"A janela do Harmony foi encerrada.".into())
    }
    fn close_buffer(window: &WebviewWindow, id: String) {
        let _ = window.with_webview(move |_| {
            SHARED.with(|s| {
                if let Some(b) = s.borrow_mut().remove(&id) {
                    let _ = unsafe { b.buffer.Close() };
                }
            })
        });
    }
    pub fn ack(store: &Store, id: &str, sequence: u64) -> Result<(), String> {
        let run = active(store, id)?;
        let _ = run
            .pending
            .compare_exchange(sequence, 0, Ordering::AcqRel, Ordering::Acquire);
        Ok(())
    }
    pub fn profile(store: &Store, id: &str, p: Profile) -> Result<(u32, u32), String> {
        let p = convert(p)?;
        let run = active(store, id)?;
        let (w, h) = *locked(&run.bounds)?;
        let size = p.size(w, h)?;
        *locked(&run.profile)? = p;
        Ok(size)
    }
    pub fn stop(store: &Store, id: &str) {
        if let Ok(runs) = store.runs.lock() {
            for run in runs.values().filter(|run| run.id == id || run.client == id) {
                run.stop.store(true, Ordering::Release);
            }
        }
    }
    pub fn cancel_all(store: &Store) {
        if let Ok(runs) = store.runs.lock() {
            for run in runs.values() {
                run.stop.store(true, Ordering::Release);
            }
        }
    }
}

#[cfg(test)]
mod origin_tests {
    use super::document_allowed;
    #[test]
    fn only_owned_document_origins_can_receive_screen_pixels() {
        for url in ["tauri://localhost/", "http://tauri.localhost/"] {
            assert!(document_allowed(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com/",
            "http://tauri.localhost:8088/",
            "https://tauri.localhost/",
            "tauri://other/",
            "http://token@tauri.localhost/",
            "http://localhost:1420/",
        ] {
            assert!(!document_allowed(&url.parse().unwrap()), "{url}");
        }
    }
}
