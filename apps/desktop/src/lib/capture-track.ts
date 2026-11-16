/** Capture controls belong to the source adapter, not to a browser-generated
 * track's settings. This port contains no desktop/framework dependencies. */
export interface CaptureTrackControl {
  settings(): MediaTrackSettings;
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
  /** Enforced maximum for subsequent frames, including source resize. */
  maxHeight?(): number | undefined;
  release(): void;
}
const controls = new WeakMap<MediaStreamTrack, CaptureTrackControl>();
const released = new WeakSet<MediaStreamTrack>();

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
export function getCaptureBound(
  track: MediaStreamTrack,
): { max_height: number } | undefined {
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
    const actual = getCaptureSettings(track).height;
    return typeof maximum === "number" &&
      Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      typeof actual === "number" &&
      Number.isFinite(actual) &&
      actual > 0 &&
      actual <= maximum
      ? { max_height: maximum }
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
  const control = controls.get(track);
  if (!control) {
    track.stop();
    return;
  }
  if (released.has(track)) return;
  released.add(track);
  control.release();
}
