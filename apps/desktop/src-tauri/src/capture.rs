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

/// One UI transaction. The copy operation must return only metadata, after
/// releasing pixel/TLS borrows. No worker deadline or second queue is involved.
#[cfg(any(windows, test))]
fn copy_and_publish_notifying<T>(
    lease: &harmony_native_capture::pipeline::FrameLease,
    sequence: u64,
    copy: impl FnOnce() -> Result<T, String>,
    before_send: impl FnOnce() -> Result<bool, String>,
    send: impl FnOnce(T) -> Result<(), String>,
    clock: impl FnOnce() -> std::time::Duration,
    mut progress: impl FnMut(),
) -> Result<bool, String> {
    if !lease.is_current(sequence) || lease.pixels_available() {
        return Err("Sequência da captura inválida.".into());
    }
    let metadata = copy()?;
    if !lease.finish_copy(sequence) {
        return Err("Sequência da cópia inválida.".into());
    }
    progress();
    if !before_send()? {
        return Ok(false);
    }
    if !lease.begin_send(sequence) {
        return Err("Sequência da publicação inválida.".into());
    }
    send(metadata)?;
    if !lease.finish_send(sequence, clock()) {
        return Err("Conclusão da publicação inválida.".into());
    }
    progress();
    Ok(true)
}
#[cfg(test)]
fn copy_and_publish<T>(
    lease: &harmony_native_capture::pipeline::FrameLease,
    sequence: u64,
    copy: impl FnOnce() -> Result<T, String>,
    before_send: impl FnOnce() -> Result<bool, String>,
    send: impl FnOnce(T) -> Result<(), String>,
    clock: impl FnOnce() -> std::time::Duration,
) -> Result<bool, String> {
    copy_and_publish_notifying(lease, sequence, copy, before_send, send, clock, || {})
}
#[cfg(any(windows, test))]
fn acknowledge_and_notify(
    lease: &harmony_native_capture::pipeline::FrameLease,
    sequence: u64,
    notify: impl FnOnce(),
) -> bool {
    if !lease.ack(sequence) {
        return false;
    }
    notify();
    true
}

#[tauri::command]
pub async fn native_capture_available(window: WebviewWindow) -> Result<bool, String> {
    owned(&window)?;
    #[cfg(windows)]
    {
        Ok(
            tauri::async_runtime::spawn_blocking(harmony_native_capture::Capture::supported)
                .await
                .unwrap_or(false),
        )
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
        byte_len,
        pipeline::{FrameLease, FramePipeline, ProfileEpoch},
        Capture, FramePacer, ProducerWake, Profile as CaptureProfile, Source,
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
        profile: Mutex<ProfileEpoch>,
        stop: AtomicBool,
        done: AtomicBool,
        lease: FrameLease,
        wake: Option<ProducerWake>,
        pixels: Mutex<Vec<u8>>,
    }
    impl Run {
        fn notify(&self) {
            if let Some(wake) = &self.wake {
                let _ = wake.signal();
            }
        }
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
                    run.notify();
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
            profile: Mutex::new(ProfileEpoch::new(p)?),
            bounds: Mutex::new((0, 0)),
            stop: AtomicBool::new(false),
            done: AtomicBool::new(false),
            lease: FrameLease::default(),
            wake: ProducerWake::new(),
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
                        self.run.notify();
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
            failure.notify();
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
        let mut pipeline = FramePipeline::default();
        let mut deferred_error = None;
        while !run.stop.load(Ordering::Acquire) {
            pipeline.poll(start.elapsed(), &run.lease)?;
            // The already-queued UI callback owns both copy and publication.
            // Source-close/prefetch failure still drains its lease or watchdog.
            // A prefetch error must not close the SharedBuffer still leased to
            // JS. Preserve that lease until its ACK (or the original watchdog).
            if deferred_error.is_some() || capture.is_closed() {
                if !run.lease.waiting() {
                    return Err(deferred_error
                        .take()
                        .unwrap_or_else(|| "A janela compartilhada foi fechada.".into()));
                }
                pacer.sleep_or_wake(Duration::from_micros(500), run.wake.as_ref());
                continue;
            }
            let reserved = {
                // Revision check and lease reservation share the profile lock.
                // A later profile command sees an already in-flight old frame.
                let profile = locked(&run.profile)?;
                pipeline.reserve_frame(
                    start.elapsed(),
                    *profile,
                    &run.lease,
                    !capture.is_closed(),
                    run.stop.load(Ordering::Acquire),
                )?
            };
            if let Some(frame) = reserved {
                post_frame(
                    window,
                    run.clone(),
                    frames.clone(),
                    Frame {
                        id: run.id.clone(),
                        sequence: frame.sequence,
                        allocation: 0,
                        width: frame.width,
                        height: frame.height,
                        timestamp_us: frame.captured_at.as_micros() as u64,
                        fps: frame.fps,
                        error: None,
                        backend: capture.backend(),
                    },
                    start,
                )?;
                continue;
            }
            let profile = *locked(&run.profile)?;
            let now = start.elapsed();
            if pipeline.can_capture(
                now,
                profile,
                &run.lease,
                !capture.is_closed(),
                run.stop.load(Ordering::Acquire),
            ) {
                capture.set_profile(profile.settings())?;
                let begun = start.elapsed();
                let captured = capture.frame(&mut *locked(&run.pixels)?);
                let finished = start.elapsed();
                match captured {
                    Ok(Some((width, height))) => {
                        *locked(&run.bounds)? = capture.source_dimensions();
                        pipeline.captured(begun, finished, width, height, profile, &run.lease)?;
                    }
                    Ok(None) => {
                        // The pool drains to newest, including resize/Recreate.
                        // Empty polls do not consume a successful capture period.
                        pacer.sleep(Duration::from_millis(1));
                    }
                    Err(error) => deferred_error = Some(error),
                }
            } else {
                pacer.sleep_or_wake(pipeline.wait(now, profile, &run.lease), run.wake.as_ref());
            }
        }
        Ok(())
    }
    fn post_frame(
        window: &WebviewWindow,
        run: Arc<Run>,
        frames: Channel<Frame>,
        meta: Frame,
        clock_start: Instant,
    ) -> Result<(), String> {
        let page = window.clone();
        window.with_webview(move|view| {
            if run.stop.load(Ordering::Acquire) {return;}
            let sequence=meta.sequence;
            let error_meta=meta.clone();
            let result=(||->Result<bool,String> {
                owned(&page)?;
                if run.stop.load(Ordering::Acquire) {return Ok(false);}
                copy_and_publish_notifying(&run.lease,sequence,|| {
                    let mut meta=meta;
                    let pixels=locked(&run.pixels)?;
                    let len=byte_len(meta.width,meta.height)?;
                    if pixels.len()!=len {return Err("Quadro de captura inválido.".into());}
                    SHARED.with(|state|->Result<(),String> {
                        let mut buffers=state.borrow_mut();
                        let capacity=len.next_power_of_two().min(harmony_native_capture::MAX_BYTES);
                        if buffers.get(&run.id).is_none_or(|b|b.capacity<len) {
                            let allocation=buffers.get(&run.id).map_or(1,|b|b.allocation+1);
                            let environment:ICoreWebView2Environment12=view.environment().cast().map_err(|_|"Atualize o WebView2 para usar a captura nativa.")?;
                            let webview:ICoreWebView2_17=unsafe{view.controller().CoreWebView2()}.and_then(|w|w.cast()).map_err(|_|"O WebView2 não suporta a captura nativa.")?;
                            let buffer=unsafe{environment.CreateSharedBuffer(capacity as u64)}.map_err(|_|"Não foi possível reservar a captura.")?;
                            let data=serde_json::json!({"harmony_native_capture":run.client,"allocation":allocation}).to_string();
                            let data:Vec<u16>=data.encode_utf16().chain(Some(0)).collect();
                            unsafe{webview.PostSharedBufferToScript(&buffer,COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,PCWSTR(data.as_ptr()))}.map_err(|_|"Não foi possível iniciar a prévia nativa.")?;
                            if let Some(old)=buffers.insert(run.id.clone(),Shared{buffer,capacity,allocation}) {let _=unsafe{old.buffer.Close()};}
                        }
                        let shared=buffers.get(&run.id).unwrap();
                        let mut destination=std::ptr::null_mut();
                        unsafe{shared.buffer.Buffer(&mut destination)}.map_err(|_|"O quadro da captura foi encerrado.")?;
                        if destination.is_null() {return Err("O quadro da captura foi encerrado.".into());}
                        // Preserve the exact read-only SharedBuffer and byte copy.
                        unsafe{std::ptr::copy_nonoverlapping(pixels.as_ptr(),destination,len);}
                        meta.allocation=shared.allocation;
                        Ok(())
                    })?;
                    // No Vec lock or TLS borrow may survive into Channel::send,
                    // whose reentrant ACK is allowed while Sending.
                    drop(pixels);
                    Ok(meta)
                },|| {
                    if run.stop.load(Ordering::Acquire) {return Ok(false);}
                    owned(&page)?;
                    Ok(!run.stop.load(Ordering::Acquire))
                },|frame|frames.send(frame).map_err(|_|"A prévia da captura foi encerrada.".into()),||clock_start.elapsed(),||run.notify())
            })();
            if let Err(error)=result {
                run.stop.store(true,Ordering::Release); run.notify();
                let _=frames.send(Frame{error:Some(error),..error_meta});
            }
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
        acknowledge_and_notify(&run.lease, sequence, || run.notify());
        Ok(())
    }
    pub fn profile(store: &Store, id: &str, p: Profile) -> Result<(u32, u32), String> {
        let p = convert(p)?;
        let run = active(store, id)?;
        let (w, h) = *locked(&run.bounds)?;
        let size = p.size(w, h)?;
        locked(&run.profile)?.replace(p)?;
        run.notify();
        Ok(size)
    }
    pub fn stop(store: &Store, id: &str) {
        if let Ok(runs) = store.runs.lock() {
            for run in runs.values().filter(|run| run.id == id || run.client == id) {
                run.stop.store(true, Ordering::Release);
                run.notify();
            }
        }
    }
    pub fn cancel_all(store: &Store) {
        if let Ok(runs) = store.runs.lock() {
            for run in runs.values() {
                run.stop.store(true, Ordering::Release);
                run.notify();
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

#[cfg(test)]
mod frame_callback_tests {
    use super::copy_and_publish;
    use harmony_native_capture::{
        pipeline::{FrameLease, FramePipeline, ProfileEpoch},
        Profile,
    };
    use std::{
        cell::{Cell, RefCell},
        sync::Mutex,
        time::Duration,
    };
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }
    fn reserve() -> (FramePipeline, FrameLease, u64) {
        let (mut p, l) = (FramePipeline::default(), FrameLease::default());
        let e = ProfileEpoch::new(Profile {
            height: 720,
            fps: 60,
        })
        .unwrap();
        p.captured(ms(0), ms(4), 1280, 720, e, &l).unwrap();
        let f = p.reserve_frame(ms(4), e, &l, true, false).unwrap().unwrap();
        (p, l, f.sequence)
    }
    #[test]
    fn one_callback_copies_unlocks_rechecks_sends_and_accepts_reentrant_ack() {
        let (mut p, l, seq) = reserve();
        let events = RefCell::new(Vec::new());
        let pixels = Mutex::new(vec![1u8]);
        let tls = RefCell::new(0);
        let sent = copy_and_publish(
            &l,
            seq,
            || {
                let _pixels = pixels.lock().unwrap();
                let _tls = tls.borrow_mut();
                assert!(!l.pixels_available());
                events.borrow_mut().push("copy");
                Ok("metadata")
            },
            || {
                assert!(pixels.try_lock().is_ok());
                assert!(tls.try_borrow_mut().is_ok());
                assert!(l.pixels_available());
                assert!(!l.ack(seq));
                events.borrow_mut().push("fresh guard");
                Ok(true)
            },
            |meta| {
                assert_eq!(meta, "metadata");
                assert!(pixels.try_lock().is_ok());
                assert!(tls.try_borrow_mut().is_ok());
                events.borrow_mut().push("send");
                assert!(l.ack(seq));
                assert!(l.waiting());
                Ok(())
            },
            || {
                events.borrow_mut().push("actual completion");
                ms(8)
            },
        )
        .unwrap();
        assert!(sent);
        assert_eq!(
            *events.borrow(),
            ["copy", "fresh guard", "send", "actual completion"]
        );
        assert!(!l.waiting());
        p.poll(ms(9), &l).unwrap();
    }

    #[test]
    fn fresh_stop_and_origin_failure_after_copy_never_publish_or_fake_ack() {
        for origin_failure in [false, true] {
            let (mut p, l, seq) = reserve();
            let sends = Cell::new(0);
            let clock = Cell::new(0);
            let result = copy_and_publish(
                &l,
                seq,
                || Ok(()),
                || {
                    if origin_failure {
                        Err("origin revoked".into())
                    } else {
                        Ok(false)
                    }
                },
                |()| {
                    sends.set(sends.get() + 1);
                    Ok(())
                },
                || {
                    clock.set(clock.get() + 1);
                    ms(8)
                },
            );
            if origin_failure {
                assert!(result.is_err());
            } else {
                assert!(!result.unwrap());
            }
            assert_eq!(sends.get(), 0);
            assert_eq!(clock.get(), 0);
            assert!(l.pixels_available());
            assert!(l.waiting());
            assert!(!l.ack(seq));
            let e = ProfileEpoch::new(Profile {
                height: 720,
                fps: 60,
            })
            .unwrap();
            assert!(!p.can_capture(ms(17), e, &l, true, true));
        }
    }

    #[test]
    fn copy_and_channel_failures_do_not_release_shared_or_count_completion() {
        let (_, l, seq) = reserve();
        let calls = Cell::new(0);
        assert!(copy_and_publish(
            &l,
            seq,
            || Err::<(), _>("copy".into()),
            || Ok(true),
            |()| {
                calls.set(1);
                Ok(())
            },
            || ms(8)
        )
        .is_err());
        assert_eq!(calls.get(), 0);
        assert!(!l.pixels_available());
        assert!(!l.ack(seq));
        let (mut p, l, seq) = reserve();
        assert!(copy_and_publish(
            &l,
            seq,
            || Ok(()),
            || Ok(true),
            |()| {
                assert!(l.ack(seq));
                Err("channel".into())
            },
            || ms(8)
        )
        .is_err());
        assert!(l.waiting());
        assert_eq!(l.pending_sequence(), 0);
        let e = ProfileEpoch::new(Profile {
            height: 720,
            fps: 60,
        })
        .unwrap();
        p.captured(ms(17), ms(21), 1280, 720, e, &l).unwrap();
        assert!(p
            .reserve_frame(ms(22), e, &l, true, false)
            .unwrap()
            .is_none());
    }

    #[test]
    fn wrong_or_duplicate_ui_callback_cannot_copy_or_publish_twice() {
        let (_, l, seq) = reserve();
        let copies = Cell::new(0);
        let sends = Cell::new(0);
        let result = copy_and_publish(
            &l,
            seq + 1,
            || {
                copies.set(1);
                Ok(())
            },
            || Ok(true),
            |()| {
                sends.set(1);
                Ok(())
            },
            || ms(8),
        );
        assert!(result.is_err());
        assert_eq!((copies.get(), sends.get()), (0, 0));
        assert!(copy_and_publish(
            &l,
            seq,
            || {
                copies.set(copies.get() + 1);
                Ok(())
            },
            || Ok(true),
            |()| {
                sends.set(sends.get() + 1);
                assert!(l.ack(seq));
                Ok(())
            },
            || ms(8)
        )
        .unwrap());
        assert!(copy_and_publish(
            &l,
            seq,
            || {
                copies.set(copies.get() + 1);
                Ok(())
            },
            || Ok(true),
            |()| {
                sends.set(sends.get() + 1);
                Ok(())
            },
            || ms(9)
        )
        .is_err());
        assert_eq!((copies.get(), sends.get()), (1, 1));
    }

    #[test]
    fn reentrant_ack_allows_one_prefetch_but_reservation_waits_for_send_return() {
        let (p, l, seq) = reserve();
        let p = RefCell::new(p);
        let e = ProfileEpoch::new(Profile {
            height: 720,
            fps: 60,
        })
        .unwrap();
        assert!(copy_and_publish(
            &l,
            seq,
            || Ok(()),
            || Ok(true),
            |()| {
                assert!(l.ack(seq));
                let mut p = p.borrow_mut();
                p.captured(ms(17), ms(21), 1280, 720, e, &l).unwrap();
                assert!(p
                    .reserve_frame(ms(21), e, &l, true, false)
                    .unwrap()
                    .is_none());
                assert!(l.waiting());
                Ok(())
            },
            || ms(22)
        )
        .unwrap());
        let mut p = p.into_inner();
        p.poll(ms(23), &l).unwrap();
        assert_eq!(
            p.reserve_frame(ms(23), e, &l, true, false)
                .unwrap()
                .unwrap()
                .sequence,
            seq + 1
        );
    }

    #[test]
    fn committed_callback_drains_after_source_close_but_late_send_keeps_original_watchdog() {
        let (mut p, l, seq) = reserve();
        let e = ProfileEpoch::new(Profile {
            height: 720,
            fps: 60,
        })
        .unwrap();
        assert!(p
            .reserve_frame(ms(5), e, &l, false, false)
            .unwrap()
            .is_none());
        assert!(copy_and_publish(
            &l,
            seq,
            || Ok(()),
            || Ok(true),
            |()| {
                assert!(l.ack(seq));
                Ok(())
            },
            || ms(8)
        )
        .unwrap());
        assert!(!l.waiting());
        p.poll(ms(9), &l).unwrap();
        let (mut p, l, seq) = reserve();
        assert!(copy_and_publish(
            &l,
            seq,
            || Ok(()),
            || Ok(true),
            |()| {
                assert!(l.ack(seq));
                Ok(())
            },
            || ms(5005)
        )
        .unwrap());
        assert!(!l.waiting());
        assert!(p.poll(ms(5005), &l).is_err());
    }

    #[test]
    fn progress_notifies_after_unlock_and_only_after_confirmed_copy_and_send() {
        let (mut p, l, seq) = reserve();
        let events = RefCell::new(Vec::new());
        let calls = Cell::new(0);
        let pixels = Mutex::new(vec![1u8]);
        let ok = super::copy_and_publish_notifying(
            &l,
            seq,
            || {
                let _guard = pixels.lock().unwrap();
                events.borrow_mut().push("copy");
                Ok(())
            },
            || {
                assert_eq!(calls.get(), 1);
                assert!(!l.ack(seq));
                events.borrow_mut().push("guard");
                Ok(true)
            },
            |_| {
                events.borrow_mut().push("send");
                assert!(super::acknowledge_and_notify(&l, seq, || events
                    .borrow_mut()
                    .push("ack")));
                assert!(l.waiting());
                Ok(())
            },
            || {
                events.borrow_mut().push("clock");
                ms(8)
            },
            || {
                assert!(pixels.try_lock().is_ok());
                assert!(l.pixels_available());
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    assert!(l.waiting());
                    events.borrow_mut().push("copy-ready");
                } else {
                    assert!(!l.waiting());
                    events.borrow_mut().push("sent-complete");
                }
            },
        )
        .unwrap();
        assert!(ok);
        assert_eq!(calls.get(), 2);
        assert_eq!(
            *events.borrow(),
            [
                "copy",
                "copy-ready",
                "guard",
                "send",
                "ack",
                "clock",
                "sent-complete"
            ]
        );
        p.poll(ms(9), &l).unwrap();
    }
    #[test]
    fn early_wrong_and_duplicate_ack_are_quiet_and_never_release_the_lease() {
        let (_, l, seq) = reserve();
        let wakes = Cell::new(0);
        for wrong in [0, seq, seq + 1] {
            assert!(!super::acknowledge_and_notify(&l, wrong, || wakes.set(wakes.get() + 1)));
        }
        assert_eq!(wakes.get(), 0);
        assert!(!l.pixels_available());
        assert!(l.waiting());
        assert!(l.finish_copy(seq));
        assert!(!super::acknowledge_and_notify(&l, seq, || wakes.set(wakes.get() + 1)));
        assert!(l.begin_send(seq));
        assert!(super::acknowledge_and_notify(&l, seq, || wakes.set(wakes.get() + 1)));
        assert_eq!(wakes.get(), 1);
        assert!(l.waiting());
        assert!(!super::acknowledge_and_notify(&l, seq, || wakes.set(wakes.get() + 1)));
        assert_eq!(wakes.get(), 1);
        assert!(l.finish_send(seq, ms(8)));
        assert!(!l.waiting());
    }
    #[test]
    fn failed_copy_guard_or_send_never_signal_a_successful_send() {
        for failure in 0..3 {
            let (_, l, seq) = reserve();
            let wakes = Cell::new(0);
            let result = super::copy_and_publish_notifying(
                &l,
                seq,
                || {
                    if failure == 0 {
                        Err("copy".into())
                    } else {
                        Ok(())
                    }
                },
                || Ok(failure != 1),
                |_| Err("send".into()),
                || ms(8),
                || wakes.set(wakes.get() + 1),
            );
            assert_eq!(wakes.get(), u32::from(failure != 0));
            assert_eq!(result.is_ok(), failure == 1);
            assert!(l.waiting());
        }
        let (_, l, seq) = reserve();
        let wakes = Cell::new(0);
        assert!(super::copy_and_publish_notifying(
            &l,
            seq + 1,
            || Ok(()),
            || Ok(true),
            |_| Ok(()),
            || ms(8),
            || wakes.set(wakes.get() + 1)
        )
        .is_err());
        assert_eq!(wakes.get(), 0);
    }
}
