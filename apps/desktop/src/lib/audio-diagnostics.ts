// Deliberately project fields; never serialize SDK objects, errors or device IDs.
import type { CallSnapshot } from "./call";

export type AudioEvent =
  | "call-start"
  | "sample"
  | "call-end"
  | "device-change"
  | "playback-error"
  | "output-error"
  | "capture-error"
  | "export";
const errors = new Set([
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "OverconstrainedError",
  "AbortError",
  "InvalidStateError",
  "NotSupportedError",
  "SecurityError",
]);
export function audioErrorCode(error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error ? error.name : null;
  return typeof name === "string" && errors.has(name) ? name : "unknown";
}
export function audioRoute(id: string | undefined): string {
  return id === "communications"
    ? "communications"
    : !id || id === "default"
      ? "default"
      : "custom";
}
export function audioTrack(track: MediaStreamTrack | undefined | null) {
  if (!track) return null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings();
  } catch {
    /* Ended/unsupported track. */
  }
  const numeric = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) ? n : null;
  return {
    kind: track.kind === "audio" ? "audio" : "video",
    enabled: track.enabled,
    muted: track.muted,
    state: track.readyState === "live" ? "live" : "ended",
    sampleRate: numeric(settings.sampleRate),
    channelCount: numeric(settings.channelCount),
    echoCancellation:
      typeof settings.echoCancellation === "boolean"
        ? settings.echoCancellation
        : null,
    noiseSuppression:
      typeof settings.noiseSuppression === "boolean"
        ? settings.noiseSuppression
        : null,
    autoGainControl:
      typeof settings.autoGainControl === "boolean"
        ? settings.autoGainControl
        : null,
    suppressLocalAudioPlayback:
      typeof (settings as { suppressLocalAudioPlayback?: boolean })
        .suppressLocalAudioPlayback === "boolean"
        ? (settings as { suppressLocalAudioPlayback?: boolean })
            .suppressLocalAudioPlayback
        : null,
  };
}
function audioMetric(
  m: CallSnapshot["participants"][number]["stats"]["received"]["microphone"],
) {
  const finite = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) ? n : null;
  return m
    ? {
        bitrate: finite(m.bitrate),
        audioLevel: finite(m.audioLevel),
        packetsLost: finite(m.packetsLost),
        jitterMs: finite(m.jitterMs),
      }
    : null;
}
export function p2pAudioSnapshot(
  s: CallSnapshot,
  deafened: boolean,
  input: string,
  output: string,
) {
  return {
    engine: "p2p",
    state: s.state,
    deafened,
    input: audioRoute(input),
    output: audioRoute(output),
    microphone: audioTrack(s.localTracks.microphone),
    screenAudio: audioTrack(s.localTracks.screen_audio),
    peers: s.participants.slice(0, 32).map((p) => ({
      connection: p.connection,
      route: p.stats.route,
      receivedVoice: audioMetric(p.stats.received.microphone),
      receivedScreenAudio: audioMetric(p.stats.received.screen_audio),
      sentVoice: audioMetric(p.stats.sent.microphone),
      sentScreenAudio: audioMetric(p.stats.sent.screen_audio),
      voiceTrack: audioTrack(p.tracks.microphone),
      screenAudioTrack: audioTrack(p.tracks.screen_audio),
    })),
  };
}
export function playbackSnapshot(elements: ArrayLike<HTMLMediaElement>) {
  return Array.from(elements)
    .slice(0, 32)
    .map((e) => ({
      paused: e.paused,
      muted: e.muted,
      volume: e.volume,
      readyState: e.readyState,
      errorCode: e.error?.code ?? null,
      output: audioRoute((e as HTMLMediaElement & { sinkId?: string }).sinkId),
    }));
}
export class AudioDiagnosticLog {
  private entries: { at: string; event: AudioEvent; data: unknown }[] = [];
  constructor(private now = () => Date.now()) {}
  add(event: AudioEvent, data: unknown) {
    const time = this.now();
    this.entries = this.entries.filter(
      (e) => Date.parse(e.at) >= time - 10 * 60_000,
    );
    this.entries.push({
      at: new Date(time).toISOString(),
      event,
      data: structuredClone(data),
    });
    while (
      new TextEncoder().encode(JSON.stringify(this.entries)).length > 600_000
    )
      this.entries.shift();
    if (this.entries.length > 180)
      this.entries.splice(0, this.entries.length - 180);
  }
  clear() {
    this.entries = [];
  }
  report(version: string) {
    const time = this.now();
    this.entries = this.entries.filter(
      (e) => Date.parse(e.at) >= time - 10 * 60_000,
    );
    return {
      format: "harmony.audio-diagnostic.v1",
      version,
      created_at: new Date(time).toISOString(),
      privacy: {
        audio_recorded: false,
        automatic_upload: false,
        history: "memory_only_max_10_minutes_180_entries_600KB",
      },
      entries: structuredClone(this.entries),
      limitations: [
        "Não mede o som dos outros aplicativos nem identifica sozinho a causa.",
        "Nível de áudio e volume são metadados; nenhum áudio é gravado.",
        "A troca Bluetooth A2DP/HFP precisa ser correlacionada com o PC e o fone afetados.",
      ],
    };
  }
}
export const audioDiagnostics = new AudioDiagnosticLog();
