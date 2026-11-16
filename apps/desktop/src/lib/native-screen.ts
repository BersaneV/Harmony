import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCaptureSettings, registerCaptureTrack } from "./capture-track";

export interface NativeSource {
  key: string;
  title: string;
}
export interface NativeCaptureProfile {
  height: number;
  fps: number;
}
interface NativeStarted {
  id: string;
  source_handle: number;
  source_title: string;
  width: number;
  height: number;
  backend: string;
}
export interface NativeFrame {
  id: string;
  sequence: number;
  allocation: number;
  width: number;
  height: number;
  timestamp_us: number;
  fps: number | null;
  error: string | null;
  backend?: string;
}
export interface NativeSharedBufferEvent {
  additionalData: unknown;
  getBuffer(): ArrayBuffer;
}
export interface NativeWebview {
  addEventListener(
    name: "sharedbufferreceived",
    listener: (event: NativeSharedBufferEvent) => void,
  ): void;
  removeEventListener(
    name: "sharedbufferreceived",
    listener: (event: NativeSharedBufferEvent) => void,
  ): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}
interface FrameCopy {
  close(): void;
}
interface FrameLayout {
  format: "BGRX";
  codedWidth: number;
  codedHeight: number;
  timestamp: number;
}
interface FrameWriter {
  write(frame: FrameCopy): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface CaptureObservation {
  track: MediaStreamTrack;
  settings: () => MediaTrackSettings;
  label: string;
  backend: string;
}
/** Injectable infrastructure boundary for lifecycle/backpressure tests. The
 * production path always invokes Tauri and consumes WebView2 shared buffers. */
export interface NativeCaptureEnvironment {
  nonce(): string;
  start(
    key: string,
    client: string,
    profile: NativeCaptureProfile,
    listener: (frame: NativeFrame) => void,
  ): Promise<NativeStarted>;
  profile(id: string, profile: NativeCaptureProfile): Promise<[number, number]>;
  ack(id: string, sequence: number): Promise<void>;
  stop(id: string): Promise<void>;
  listen(
    client: string,
    listener: (event: NativeSharedBufferEvent) => void,
  ): () => void;
  releaseBuffer(buffer: ArrayBuffer): void;
  generator(): { track: MediaStreamTrack; writer: FrameWriter };
  frame(bytes: Uint8Array<ArrayBuffer>, layout: FrameLayout): FrameCopy;
  observe(detail: CaptureObservation): void;
}
type NativeWindow = Window & {
  chrome?: { webview?: NativeWebview };
  MediaStreamTrackGenerator?: new (options: {
    kind: "video";
  }) => MediaStreamTrack & {
    writable: WritableStream<FrameCopy>;
  };
};

/** One page-lifetime listener routes simultaneous preview/published captures.
 * Session subscriptions are removed at stop; late native posts still release
 * their orphaned buffers instead of retaining WebView2 allocations. */
export class NativeBufferRouter {
  private listeners = new Map<
    string,
    (event: NativeSharedBufferEvent) => void
  >();
  constructor(webview: NativeWebview) {
    webview.addEventListener("sharedbufferreceived", (event) => {
      const data = event.additionalData;
      if (
        !data ||
        typeof data !== "object" ||
        !("harmony_native_capture" in data) ||
        typeof data.harmony_native_capture !== "string"
      )
        return;
      const listener = this.listeners.get(data.harmony_native_capture);
      if (listener) listener(event);
      else webview.releaseBuffer(event.getBuffer());
    });
  }
  listen(
    client: string,
    listener: (event: NativeSharedBufferEvent) => void,
  ): () => void {
    this.listeners.set(client, listener);
    return () => {
      if (this.listeners.get(client) === listener)
        this.listeners.delete(client);
    };
  }
}
const bufferRouters = new WeakMap<NativeWebview, NativeBufferRouter>();

function desktopEnvironment(): NativeCaptureEnvironment {
  const host = window as NativeWindow;
  const webview = host.chrome?.webview;
  const Generator = host.MediaStreamTrackGenerator;
  if (
    !isTauri() ||
    !webview?.releaseBuffer ||
    !Generator ||
    typeof VideoFrame === "undefined"
  )
    throw new Error(
      "Captura nativa indisponível. Escolha a captura do navegador.",
    );
  return {
    nonce: () => crypto.randomUUID(),
    start: (key, client, profile, listener) => {
      const frames = new Channel<NativeFrame>();
      frames.onmessage = listener;
      return invoke<NativeStarted>("native_capture_start", {
        key,
        client,
        profile,
        frames,
      });
    },
    profile: (id, profile) => invoke("native_capture_profile", { id, profile }),
    ack: (id, sequence) => invoke("native_capture_ack", { id, sequence }),
    stop: (id) => invoke("native_capture_stop", { id }),
    listen: (client, listener) => {
      let router = bufferRouters.get(webview);
      if (!router) {
        router = new NativeBufferRouter(webview);
        bufferRouters.set(webview, router);
      }
      return router.listen(client, listener);
    },
    releaseBuffer: (buffer) => webview.releaseBuffer(buffer),
    generator: () => {
      const track = new Generator({ kind: "video" });
      return { track, writer: track.writable.getWriter() };
    },
    // VideoFrame copies the read-only shared pixels. Never transfer/detach the
    // shared ArrayBuffer or modify it; Rust may reuse it only after ACK.
    frame: (bytes, layout) => new VideoFrame(bytes, layout),
    observe: (detail) =>
      window.dispatchEvent(
        new CustomEvent("harmony-native-screen", { detail }),
      ),
  };
}
export async function nativeScreenAvailable(): Promise<boolean> {
  try {
    desktopEnvironment();
    return await invoke<boolean>("native_capture_available");
  } catch {
    return false;
  }
}
export function nativeScreenSources(): Promise<NativeSource[]> {
  return invoke<NativeSource[]>("native_capture_sources");
}
const abortError = () =>
  new DOMException("A seleção da janela foi cancelada.", "AbortError");
const captureError = (error: unknown) =>
  error instanceof Error
    ? error
    : new Error(
        typeof error === "string"
          ? error
          : "A captura nativa foi interrompida.",
      );
const positiveInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0;
function constraintLimit(
  value: ConstrainDouble | undefined,
): number | undefined {
  if (typeof value === "number") return value;
  return value?.max ?? value?.exact ?? value?.ideal;
}

export async function createNativeScreenTrack(
  key: string,
  profile: NativeCaptureProfile,
  options: { signal?: AbortSignal } = {},
  environment: NativeCaptureEnvironment = desktopEnvironment(),
): Promise<MediaStreamTrack> {
  if (options.signal?.aborted) throw abortError();
  const { track, writer } = environment.generator();
  const client = environment.nonce();
  let id: string | undefined;
  let closed = false;
  let failure: Error | undefined;
  let announced = false;
  let observed = false;
  let source: NativeStarted | undefined;
  let currentProfile = { ...profile, fps: profile.fps || 30 };
  let captureBound = profile.height > 0 ? profile.height : undefined;
  let settings: MediaTrackSettings = {};
  let latestFrame: NativeFrame | undefined;
  let consumedFrame: NativeFrame | undefined;
  let pending: NativeFrame | undefined;
  let sequence = 0;
  let writing = false;
  let allocation: { number: number; buffer: ArrayBuffer } | undefined;
  let unlisten: (() => void) | undefined;
  let rejectStart!: (reason: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  // Infrastructure setup can fail before Promise.race attaches its handler.
  void interrupted.catch(() => {});
  const stoppedIds = new Set<string>();
  const profileWaiters = new Set<{
    width: number;
    height: number;
    after: number;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function completedProfile() {
    for (const waiter of profileWaiters) {
      if (
        consumedFrame &&
        consumedFrame.sequence > waiter.after &&
        consumedFrame.width <= waiter.width &&
        consumedFrame.height <= waiter.height
      ) {
        clearTimeout(waiter.timer);
        profileWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
  function observeCapture() {
    if (observed || !announced || !source || !consumedFrame || closed) return;
    observed = true;
    environment.observe({
      track,
      settings: () => getCaptureSettings(track),
      label: `native-window:${source.source_handle}`,
      backend: consumedFrame.backend ?? source.backend,
    });
  }

  function stopNative(value: string) {
    if (stoppedIds.has(value)) return;
    stoppedIds.add(value);
    void environment.stop(value).catch(() => {});
  }
  function releaseBuffer() {
    if (!allocation) return;
    const buffer = allocation.buffer;
    allocation = undefined;
    environment.releaseBuffer(buffer);
  }
  function close(error?: Error, ended = false) {
    if (closed) return;
    closed = true;
    failure = error;
    options.signal?.removeEventListener("abort", aborted);
    track.removeEventListener("ended", trackEnded);
    unlisten?.();
    unlisten = undefined;
    pending = undefined;
    for (const waiter of profileWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new Error("A captura terminou."));
    }
    profileWaiters.clear();
    stopNative(id ?? client);
    // Abort breaks a pending writer.write without retaining the capture lease.
    void writer.abort(error).catch(() => {});
    track.stop();
    releaseBuffer();
    if (ended) track.dispatchEvent(new Event("ended"));
    if (error && !announced) rejectStart(error);
  }
  function aborted() {
    close(abortError(), announced);
  }
  function trackEnded() {
    close(new Error("A captura terminou."));
  }

  function receiveFrame(meta: NativeFrame) {
    if (closed) {
      if (meta.id) stopNative(meta.id);
      return;
    }
    if (!meta.id || (id && id !== meta.id)) {
      close(new Error("Identificador da captura inválido."), true);
      return;
    }
    id = meta.id;
    if (meta.error) {
      close(captureError(meta.error), true);
      return;
    }
    if (
      !positiveInteger(meta.sequence) ||
      !positiveInteger(meta.allocation) ||
      !positiveInteger(meta.width) ||
      !positiveInteger(meta.height) ||
      meta.width > 8192 ||
      meta.height > 8192 ||
      meta.width * meta.height * 4 > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(meta.timestamp_us) ||
      meta.timestamp_us < 0
    ) {
      close(new Error("Quadro da captura inválido."), true);
      return;
    }
    if (meta.sequence <= sequence || pending?.sequence === meta.sequence)
      return;
    if (writing || pending) {
      close(
        new Error("A captura recebeu um quadro sem liberar o anterior."),
        true,
      );
      return;
    }
    latestFrame = meta;
    pending = meta;
    void pump();
  }
  async function pump() {
    if (
      closed ||
      writing ||
      !pending ||
      allocation?.number !== pending.allocation
    )
      return;
    const meta = pending,
      shared = allocation.buffer;
    pending = undefined;
    sequence = meta.sequence;
    writing = true;
    let writingCopy = true;
    let frame: FrameCopy | undefined;
    try {
      const length = meta.width * meta.height * 4;
      if (shared.byteLength < length)
        throw new Error("Buffer da captura incompleto.");
      frame = environment.frame(new Uint8Array(shared, 0, length), {
        format: "BGRX",
        codedWidth: meta.width,
        codedHeight: meta.height,
        timestamp: meta.timestamp_us,
      });
      await writer.write(frame);
      frame.close();
      frame = undefined;
      // ACK may let the next channel event arrive before its invoke reply.
      // The writer is already free; do not mistake that event for a violation.
      writing = false;
      writingCopy = false;
      if (!closed) {
        consumedFrame = meta;
        settings = {
          width: meta.width,
          height: meta.height,
          ...(meta.fps != null && Number.isFinite(meta.fps) && meta.fps >= 0
            ? { frameRate: meta.fps }
            : {}),
        };
        completedProfile();
        observeCapture();
        await environment.ack(meta.id, meta.sequence);
      }
    } catch (error) {
      close(captureError(error), true);
    } finally {
      frame?.close();
      if (writingCopy) writing = false;
    }
  }
  function receiveBuffer(event: NativeSharedBufferEvent) {
    const data = event.additionalData;
    if (
      !data ||
      typeof data !== "object" ||
      !("harmony_native_capture" in data) ||
      data.harmony_native_capture !== client ||
      !("allocation" in data) ||
      typeof data.allocation !== "number" ||
      !positiveInteger(data.allocation)
    )
      return;
    try {
      const buffer = event.getBuffer();
      if (closed || (allocation && data.allocation <= allocation.number)) {
        if (buffer !== allocation?.buffer) environment.releaseBuffer(buffer);
        return;
      }
      releaseBuffer();
      allocation = { number: data.allocation, buffer };
      void pump();
    } catch (error) {
      close(captureError(error), true);
    }
  }
  registerCaptureTrack(track, {
    settings: () => settings,
    maxHeight: () => (closed ? undefined : captureBound),
    applyConstraints: async (constraints) => {
      if (closed || !id) throw failure ?? new Error("A captura terminou.");
      const height = constraintLimit(constraints.height) ?? 0;
      const fps = constraintLimit(constraints.frameRate) ?? currentProfile.fps;
      const next = { height, fps };
      // Native profile application can precede its IPC reply and the next
      // consumed frame. During that interval advertise the larger bound, or
      // unknown if either side is automatic. A failed reply stays conservative.
      captureBound =
        captureBound && height ? Math.max(captureBound, height) : undefined;
      const before = consumedFrame?.sequence ?? 0;
      const [width, actualHeight] = await environment.profile(id, next);
      if (closed) throw failure ?? new Error("A captura terminou.");
      const maxWidth = constraintLimit(constraints.width);
      if (
        !positiveInteger(width) ||
        !positiveInteger(actualHeight) ||
        (height && actualHeight > height) ||
        (maxWidth && width > maxWidth)
      ) {
        const error = new Error(
          "A captura não respeitou os limites de resolução.",
        );
        close(error, true);
        throw error;
      }
      // The native profile reply describes the next frames. Wait until the
      // generator actually consumes safe geometry before H264 can attach.
      // A static WGC window may produce no new frames; an already-consumed
      // frame is sufficient when every queued/current frame fits the limit.
      if (
        !consumedFrame ||
        !latestFrame ||
        latestFrame.width > width ||
        latestFrame.height > actualHeight ||
        consumedFrame.width > width ||
        consumedFrame.height > actualHeight
      ) {
        await new Promise<void>((resolve, reject) => {
          const waiter = {
            width,
            height: actualHeight,
            after: before,
            resolve,
            reject,
            timer: setTimeout(
              () =>
                close(
                  new Error("A captura não confirmou o novo perfil."),
                  true,
                ),
              5000,
            ),
          };
          profileWaiters.add(waiter);
          completedProfile();
        });
      }
      currentProfile = next;
      captureBound = height > 0 ? height : undefined;
    },
    release: () => close(),
  });
  try {
    unlisten = environment.listen(client, receiveBuffer);
    track.addEventListener("ended", trackEnded, { once: true });
    options.signal?.addEventListener("abort", aborted, { once: true });
    // Listen before invoking: a shared buffer/frame may beat the start reply.
    const starting = environment
      .start(key, client, currentProfile, receiveFrame)
      .then((started) => {
        if (closed) {
          stopNative(started.id);
          throw failure ?? abortError();
        }
        if (id && id !== started.id)
          throw new Error("A origem da captura mudou.");
        id = started.id;
        source = started;
        if (!consumedFrame)
          settings = { width: started.width, height: started.height };
      });
    await Promise.race([starting, interrupted]);
    if (closed || !source) throw failure ?? abortError();
    announced = true;
    observeCapture();
    return track;
  } catch (error) {
    const reason = captureError(error);
    close(reason);
    throw reason;
  }
}
