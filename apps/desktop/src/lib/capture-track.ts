/** Capture controls belong to the source adapter, not to a browser-generated
 * track's settings. This port contains no desktop/framework dependencies. */
export type CaptureContentHint = "motion" | "detail";
export interface CaptureTrackControl {
  settings(): MediaTrackSettings;
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
  /** Enforced maximum for subsequent frames, including source resize. */
  maxHeight?(): number | undefined;
  /** Optional source-owned policy; absence preserves the caller's request. */
  contentHint?(requested: CaptureContentHint): CaptureContentHint;
  release(): void;
}
export interface CaptureFrameSettings {
  width: number;
  height: number;
}
export interface CaptureSettingsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
const controls = new WeakMap<MediaStreamTrack, CaptureTrackControl>();
const released = new WeakSet<MediaStreamTrack>();
const observations = new WeakMap<MediaStreamTrack, Set<() => void>>();

function frameSettings(settings: MediaTrackSettings): CaptureFrameSettings {
  if (
    !Number.isSafeInteger(settings.width) ||
    !Number.isSafeInteger(settings.height) ||
    settings.width! <= 0 ||
    settings.height! <= 0
  )
    throw new Error("A captura não confirmou as dimensões de um quadro.");
  return { width: settings.width!, height: settings.height! };
}
/** Registered adapters own their metadata. Browser settings before the first
 * frame are provisional; read only intrinsic dimensions with current data.
 * The same track is observed, without cloning, pixel copies or a DOM surface. */
export async function resolveCaptureSettings(
  track: MediaStreamTrack,
  { signal, timeoutMs = 3000 }: CaptureSettingsOptions = {},
): Promise<CaptureFrameSettings> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error("Prazo de observação da captura inválido.");
  if (signal?.aborted)
    throw new DOMException("A captura foi cancelada.", "AbortError");
  if (track.kind !== "video" || track.readyState !== "live")
    throw new Error("A captura terminou antes de confirmar um quadro.");
  const control = controls.get(track);
  if (control) return frameSettings(control.settings());

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  const waiting = observations.get(track) ?? new Set<() => void>();
  observations.set(track, waiting);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  let ended!: () => void;
  let failed!: () => void;
  let current!: () => void;
  try {
    return await new Promise<CaptureFrameSettings>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      cancel = () =>
        fail(new DOMException("A captura foi cancelada.", "AbortError"));
      ended = () =>
        fail(new Error("A captura terminou antes de confirmar um quadro."));
      failed = () =>
        fail(new Error("Não foi possível observar um quadro da captura."));
      current = () => {
        if (settled) return;
        if (signal?.aborted) return cancel();
        if (track.readyState !== "live") return ended();
        if (video.readyState < 2) return; // HAVE_CURRENT_DATA, not loadedmetadata.
        try {
          const settings = frameSettings({
            width: video.videoWidth,
            height: video.videoHeight,
          });
          settled = true;
          resolve(settings);
        } catch (error) {
          fail(error as Error);
        }
      };
      waiting.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      track.addEventListener("ended", ended, { once: true });
      video.addEventListener("loadeddata", current);
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("ended", ended, { once: true });
      timer = setTimeout(
        () => fail(new Error("A captura não confirmou um quadro no prazo.")),
        timeoutMs,
      );
      video.srcObject = new MediaStream([track]);
      void video.play().then(current, failed);
      current();
    });
  } finally {
    clearTimeout(timer);
    waiting.delete(cancel);
    if (!waiting.size) observations.delete(track);
    signal?.removeEventListener("abort", cancel);
    track.removeEventListener("ended", ended);
    video.removeEventListener("loadeddata", current);
    video.removeEventListener("error", failed);
    video.removeEventListener("ended", ended);
    video.pause();
    video.srcObject = null;
  }
}

export function registerCaptureTrack(
  track: MediaStreamTrack,
  control: CaptureTrackControl,
): void {
  controls.set(track, control);
}
export function getCaptureSettings(
  track: MediaStreamTrack,
): MediaTrackSettings {
  return { ...(controls.get(track)?.settings() ?? track.getSettings()) };
}
/** Only an explicitly registered adapter may resolve a different hint. Labels,
 * track IDs and desktop globals do not establish the capture's origin. */
export function applyCaptureContentHint(
  track: MediaStreamTrack,
  requested: CaptureContentHint,
): CaptureContentHint {
  if (track.kind !== "video")
    throw new Error("O hint de captura só se aplica a vídeo.");
  const hint = controls.get(track)?.contentHint?.(requested) ?? requested;
  if (track.contentHint !== hint) track.contentHint = hint;
  return hint;
}
export function getCaptureBound(
  track: MediaStreamTrack,
): { max_height: number; max_width?: number } | undefined {
  try {
    if (track.readyState !== "live") return undefined;
    const control = controls.get(track);
    const constraints = control ? undefined : track.getConstraints();
    const height = constraints?.height;
    const maximum = control
      ? control.maxHeight?.()
      : height && typeof height === "object"
        ? height.max
        : undefined;
    const settings = getCaptureSettings(track);
    const actual = settings.height;
    const width = constraints?.width;
    const maxWidth = width && typeof width === "object" ? width.max : undefined;
    const widthProven =
      !control &&
      typeof maxWidth === "number" &&
      Number.isSafeInteger(maxWidth) &&
      maxWidth > 0 &&
      typeof settings.width === "number" &&
      Number.isFinite(settings.width) &&
      settings.width > 0 &&
      settings.width <= maxWidth;
    return typeof maximum === "number" &&
      Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      typeof actual === "number" &&
      Number.isFinite(actual) &&
      actual > 0 &&
      actual <= maximum
      ? { max_height: maximum, ...(widthProven ? { max_width: maxWidth } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}
export function applyCaptureConstraints(
  track: MediaStreamTrack,
  constraints: MediaTrackConstraints,
): Promise<void> {
  const control = controls.get(track);
  return control
    ? control.applyConstraints(constraints)
    : track.applyConstraints(constraints);
}
/** Used only for owned captures; remote tracks remain owned by WebRTC. */
export function releaseCaptureTrack(track?: MediaStreamTrack | null): void {
  if (!track) return;
  for (const cancel of observations.get(track) ?? []) cancel();
  const control = controls.get(track);
  if (!control) {
    track.stop();
    return;
  }
  if (released.has(track)) return;
  released.add(track);
  control.release();
}
