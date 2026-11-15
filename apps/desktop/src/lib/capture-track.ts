/** Capture controls belong to the source adapter, not to a browser-generated
 * track's settings. This port contains no desktop/framework dependencies. */
export interface CaptureTrackControl {
  settings(): MediaTrackSettings;
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
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
