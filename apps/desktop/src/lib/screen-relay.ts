import {
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import type {
  LocalTrack,
  RemoteTrackPublication,
  TrackPublishOptions,
} from "livekit-client";
import { getCaptureSettings } from "./capture-track";
import { publishOptions, validateProfile } from "./stream";
import type { StreamProfile } from "./stream";

export type RelaySource = "screen" | "screen_audio";
export interface ScreenRelayRef {
  track_sid: string;
  generation: string;
}
export interface ScreenRelayPeer {
  peer_id: string;
  user_id: string;
  can_publish: boolean;
  screen_sfu?: boolean;
  media: { screen: boolean; screen_audio: boolean };
}
export interface ScreenRelayAuthority {
  /** Generation of the authenticated call, not a generation supplied by media. */
  generation: string;
  self: ScreenRelayPeer;
  peers: ScreenRelayPeer[];
}
export interface ScreenRelayGrant {
  token: string;
  url: string;
  room: string;
  peer_id: string;
  max_video_bitrate: number;
}
/** Supply only after the capture owner enforces this maximum for the entire
 * publication. Instantaneous getSettings()/publication dimensions are no proof. */
export interface ScreenRelayCaptureBound {
  readonly max_height: number;
}
export interface RelayDecodeSample {
  framesDecoded: number;
  bytesReceived: number;
  width: number;
  height: number;
  stats?: RelayRtpSample;
}
export interface RelayAudioSample {
  bytesReceived: number;
  totalSamplesReceived: number;
  totalSamplesDuration: number;
  concealedSamples: number;
  stats?: RelayRtpSample;
}
/** Raw source-scoped SDK counters. Time is the RTCStats timestamp in ms. */
export interface RelayRtpSample {
  rowId: string;
  timestamp: number;
  bytes: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  audioLevel: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  iceRttMs: number | null;
  maxBitrate: number | null;
}
export interface ScreenRelayMediaStats {
  /** Bits/s and frames/s derived from consecutive SDK counter observations. */
  bitrate: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  audioLevel: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  iceRttMs: number | null;
  maxBitrate: number | null;
  timestamp: number;
}
export interface ScreenRelayStatsEvent {
  direction: "sent" | "received";
  source: RelaySource;
  /** Logical screen reference; audio also remains tied to this video generation. */
  ref: ScreenRelayRef;
  /** Actual source publication SID, which differs for screen audio. */
  publication_sid: string;
  peer_id?: string;
  stats: ScreenRelayMediaStats | null;
}
export interface RelayPublication {
  sid: string;
  name: string;
  source: RelaySource | "other";
  width?: number;
  height?: number;
  muted: boolean;
  subscribe(enabled: boolean): void;
  track?: {
    media: MediaStreamTrack;
    sample(): Promise<RelayDecodeSample | RelayAudioSample | null>;
    playoutDelay?: RelayPlayoutDelay;
  };
}
/** Optional receiver control, scoped to one SDK track/receiver/publication binding.
 * retain installs cleanup before any SDK call, including a reentrant setter.
 * Readback confirms the requested hint, never the browser's effective delay. */
export interface RelayPlayoutDelay {
  apply(
    seconds: number,
    ref: ScreenRelayRef,
    current: () => boolean,
    retain: (cleanup: () => void) => void,
  ): (() => void) | undefined;
}
export interface RelayParticipant {
  identity: string;
  metadata: string | undefined;
  publications: RelayPublication[];
}
export interface RelayLocalPublication {
  sid: string;
  track: MediaStreamTrack;
  sampleStats?(): Promise<RelayRtpSample | null>;
}
export type RelayPublishOptions = Omit<TrackPublishOptions, "source"> & {
  source: RelaySource;
};
/** The SDK adapter owns publications, while the call engine owns captures. */
export interface RelayRoom {
  connect(
    url: string,
    token: string,
    options: { autoSubscribe: false },
  ): Promise<void>;
  disconnect(stopTracks: false): Promise<void>;
  connected(): boolean;
  identity(): string;
  metadata(): string | undefined;
  name(): string;
  participants(): RelayParticipant[];
  onChange(listener: () => void): () => void;
  publish(
    track: MediaStreamTrack,
    options: RelayPublishOptions,
  ): Promise<RelayLocalPublication>;
  unpublish(publication: RelayLocalPublication): Promise<void>;
}
interface RelayEnvironment {
  room(): RelayRoom;
  nonce(): string;
  interval?: number;
}
export interface ScreenRelayCallbacks {
  onStats?(event: ScreenRelayStatsEvent): void;
  /** P2P must stay enabled until the matching remote SID/generation is ready. */
  onAck(value: { peer_id: string; screen_sfu: ScreenRelayRef | null }): void;
  onTrack(value: {
    peer_id: string;
    source: RelaySource;
    track: MediaStreamTrack | null;
    ref: ScreenRelayRef;
  }): void;
  /** A full SDK reconnection can replace the local publication SID. */
  onLocalPublication?(ref: ScreenRelayRef | null): void;
  onFallback?(peer_id: string, reason: string): void;
  onError?(error: Error): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const names: Record<RelaySource, string> = {
  screen: "harmony-screen:",
  screen_audio: "harmony-screen-audio:",
};
function namedGeneration(publication: RelayPublication): string | undefined {
  if (publication.source === "other") return;
  const prefix = names[publication.source];
  if (!publication.name.startsWith(prefix)) return;
  const generation = publication.name.slice(prefix.length);
  return opaque.test(generation) && opaque.test(publication.sid)
    ? generation
    : undefined;
}
function generationHeight(generation: string): number | undefined {
  const match = /_h([1-9][0-9]*)(?:_a[01])?$/.exec(generation);
  if (!match) return;
  const height = Number(match[1]);
  return Number.isSafeInteger(height) && height > 0 ? height : undefined;
}
function generationRequiresAudio(generation: string): boolean {
  return generation.endsWith("_a1");
}
function boundPeer(
  identity: string,
  metadata: string | undefined,
): { user_id: string; peer_id: string } | undefined {
  const parts = identity.split(":");
  if (
    parts.length !== 2 ||
    !uuid.test(parts[0]) ||
    !uuid.test(parts[1]) ||
    !metadata
  )
    return;
  try {
    const value: unknown = JSON.parse(metadata);
    if (
      !value ||
      typeof value !== "object" ||
      !("harmony_peer_id" in value) ||
      typeof value.harmony_peer_id !== "string" ||
      !uuid.test(value.harmony_peer_id)
    )
      return;
    return { user_id: parts[0], peer_id: value.harmony_peer_id };
  } catch {
    return;
  }
}
const relayError = (error: unknown) =>
  error instanceof Error
    ? error
    : new Error("A conexão de tela com o servidor foi interrompida.");

type StatsRow = RTCStats & Record<string, unknown>;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const counter = (value: unknown): number | null => {
  const result = number(value);
  return result !== null && result >= 0 ? result : null;
};
const dimension = (value: unknown): number | null => {
  const result = number(value);
  return result !== null && result > 0 ? result : null;
};
function reportRows(report: RTCStatsReport | undefined): Map<string, StatsRow> {
  const rows = new Map<string, StatsRow>();
  report?.forEach((row) => rows.set(row.id, row as StatsRow));
  return rows;
}
function sourceRow(
  rows: Map<string, StatsRow>,
  direction: "sent" | "received",
  source: RelaySource,
  trackId: string,
): StatsRow | undefined {
  const kind = source === "screen" ? "video" : "audio";
  const eligible = [...rows.values()].filter(
    (row) =>
      row.type === (direction === "sent" ? "outbound-rtp" : "inbound-rtp") &&
      !row.isRemote &&
      (row.kind ?? row.mediaType) === kind &&
      !String(rows.get(String(row.codecId))?.mimeType ?? "")
        .toLowerCase()
        .endsWith("/rtx"),
  );
  const identity = (row: StatsRow) =>
    row.trackIdentifier ??
    rows.get(String(row.mediaSourceId))?.trackIdentifier ??
    rows.get(String(row.trackId))?.trackIdentifier;
  const matching = eligible.filter((row) => identity(row) === trackId);
  if (matching.length === 1) return matching[0];
  // Sender/receiver.getStats is source-scoped. Do not guess if an SDK/browser
  // returns several unidentifiable sources, or explicitly identifies another.
  return matching.length === 0 &&
    eligible.length === 1 &&
    identity(eligible[0]) === undefined
    ? eligible[0]
    : undefined;
}
function rtpSample(
  rows: Map<string, StatsRow>,
  row: StatsRow | undefined,
  direction: "sent" | "received",
  source: RelaySource,
  maxBitrate: number | null = null,
): RelayRtpSample | null {
  const timestamp = counter(row?.timestamp);
  if (!row || timestamp === null) return null;
  const linkedRemote = rows.get(String(row.remoteId));
  const remote =
    linkedRemote?.type === "remote-inbound-rtp"
      ? linkedRemote
      : [...rows.values()].find(
          (value) =>
            value.type === "remote-inbound-rtp" && value.localId === row.id,
        );
  const loss = direction === "received" ? row : remote;
  const transport = rows.get(String(row.transportId));
  const pair =
    transport?.type === "transport"
      ? rows.get(String(transport.selectedCandidatePairId))
      : undefined;
  const rtt =
    pair?.type === "candidate-pair" ? counter(pair.currentRoundTripTime) : null;
  const jitter = counter(loss?.jitter);
  const audioLevel =
    source === "screen_audio"
      ? counter(
          row.audioLevel ?? rows.get(String(row.mediaSourceId))?.audioLevel,
        )
      : null;
  return {
    rowId: row.id,
    timestamp,
    bytes: counter(direction === "sent" ? row.bytesSent : row.bytesReceived),
    frames:
      source === "screen"
        ? counter(direction === "sent" ? row.framesEncoded : row.framesDecoded)
        : null,
    width: source === "screen" ? dimension(row.frameWidth) : null,
    height: source === "screen" ? dimension(row.frameHeight) : null,
    audioLevel: audioLevel !== null && audioLevel <= 1 ? audioLevel : null,
    packetsLost: number(loss?.packetsLost),
    jitterMs: jitter === null ? null : jitter * 1000,
    iceRttMs: rtt === null ? null : rtt * 1000,
    maxBitrate,
  };
}
function senderBitrate(sender: RTCRtpSender | undefined): number | null {
  try {
    const encodings = sender?.getParameters().encodings;
    if (!encodings?.length) return null;
    const active = encodings.filter((encoding) => encoding.active !== false);
    if (active.some((encoding) => counter(encoding.maxBitrate) === null))
      return null;
    return active.reduce((sum, encoding) => sum + encoding.maxBitrate!, 0);
  } catch {
    return null;
  }
}

interface PlayoutOwner {
  baseline: number | null | undefined;
  retired: boolean;
}
const playoutOwners = new WeakMap<RTCRtpReceiver, PlayoutOwner>();
function liveKitRoom(): RelayRoom {
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
    stopLocalTrackOnUnpublish: false,
    disconnectOnPageLeave: false,
  });
  const local = new Map<RelayLocalPublication, LocalTrack>();
  type Remote = NonNullable<RemoteTrackPublication["track"]>;
  const delayBindings = new WeakMap<
    Remote,
    {
      receiver: RTCRtpReceiver | undefined;
      media: MediaStreamTrack;
      sid: string;
      name: string;
      control: RelayPlayoutDelay;
    }
  >();
  const playoutDelay = (
    publication: RemoteTrackPublication,
  ): RelayPlayoutDelay => {
    const track = publication.track!,
      receiver = track.receiver as
        (RTCRtpReceiver & { playoutDelayHint?: number | null }) | undefined,
      media = track.mediaStreamTrack,
      sid = publication.trackSid,
      name = publication.trackName;
    const previous = delayBindings.get(track);
    if (
      previous &&
      previous.receiver === receiver &&
      previous.media === media &&
      previous.sid === sid &&
      previous.name === name
    )
      return previous.control;
    const control: RelayPlayoutDelay = {
      apply: (seconds, ref, current, retain) => {
        let owner: PlayoutOwner | undefined;
        let applying = true;
        const valid = () =>
          !!receiver &&
          publication.track === track &&
          track.receiver === receiver &&
          track.mediaStreamTrack === media &&
          media.kind === "video" &&
          media.readyState === "live" &&
          publication.source === Track.Source.ScreenShare &&
          !publication.isMuted &&
          publication.trackSid === sid &&
          publication.trackName === name &&
          sid === ref.track_sid &&
          name === `${names.screen}${ref.generation}` &&
          ref.generation.endsWith("_a0") &&
          seconds === 0.24 &&
          "playoutDelayHint" in receiver &&
          current();
        const cleanup = () => {
          if (!receiver || !owner || playoutOwners.get(receiver) !== owner)
            return;
          owner.retired = true;
          try {
            // SDK removetrack clears the hint and receiver before our cleanup.
            // Never overwrite another binding or a subsequently changed hint.
            if (
              track.receiver === receiver &&
              track.mediaStreamTrack === media
            ) {
              const value = receiver.playoutDelayHint;
              if (playoutOwners.get(receiver) === owner && value === seconds)
                receiver.playoutDelayHint = owner.baseline;
            }
          } catch {
            /* A disappearing optional receiver must not stop media. */
          }
          if (!applying && playoutOwners.get(receiver) === owner)
            playoutOwners.delete(receiver);
        };
        try {
          if (!valid() || !receiver) return;
          const prior = playoutOwners.get(receiver);
          const baseline = prior ? prior.baseline : receiver.playoutDelayHint;
          if (!valid() || playoutOwners.get(receiver) !== prior) return;
          owner = { baseline, retired: false };
          playoutOwners.set(receiver, owner);
          retain(cleanup);
          if (
            !valid() ||
            owner.retired ||
            playoutOwners.get(receiver) !== owner
          ) {
            cleanup();
            return;
          }
          track.setPlayoutDelay(seconds);
          if (
            !valid() ||
            owner.retired ||
            playoutOwners.get(receiver) !== owner
          ) {
            cleanup();
            return;
          }
          const requested = track.getPlayoutDelay();
          if (
            !valid() ||
            owner.retired ||
            playoutOwners.get(receiver) !== owner ||
            requested !== seconds
          ) {
            cleanup();
            return;
          }
          return cleanup;
        } catch {
          cleanup();
          return;
        } finally {
          applying = false;
          if (owner?.retired) cleanup();
        }
      },
    };
    delayBindings.set(track, { receiver, media, sid, name, control });
    return control;
  };
  const remotePublication = (
    publication: RemoteTrackPublication,
  ): RelayPublication => ({
    sid: publication.trackSid,
    name: publication.trackName,
    source:
      publication.source === Track.Source.ScreenShare
        ? "screen"
        : publication.source === Track.Source.ScreenShareAudio
          ? "screen_audio"
          : "other",
    width: publication.dimensions?.width,
    height: publication.dimensions?.height,
    muted: publication.isMuted,
    subscribe: (enabled) => publication.setSubscribed(enabled),
    ...(publication.track
      ? {
          track: {
            media: publication.track.mediaStreamTrack,
            ...(publication.source === Track.Source.ScreenShare
              ? { playoutDelay: playoutDelay(publication) }
              : {}),
            sample: async () => {
              const track = publication.track,
                sid = publication.trackSid;
              if (!track) return null;
              const receiver = track.receiver,
                media = track.mediaStreamTrack;
              const report = await track.getRTCStatsReport();
              if (
                publication.track !== track ||
                publication.trackSid !== sid ||
                track.receiver !== receiver ||
                track.mediaStreamTrack !== media
              )
                return null;
              const source =
                publication.source === Track.Source.ScreenShare
                  ? "screen"
                  : publication.source === Track.Source.ScreenShareAudio
                    ? "screen_audio"
                    : undefined;
              if (!source) return null;
              const rows = reportRows(report),
                row = sourceRow(rows, "received", source, media.id);
              const stats = rtpSample(rows, row, "received", source);
              let sample: RelayDecodeSample | RelayAudioSample | null = null;
              if (row) {
                if (
                  source === "screen_audio" &&
                  !row.isRemote &&
                  typeof row.bytesReceived === "number" &&
                  typeof row.totalSamplesReceived === "number" &&
                  typeof row.totalSamplesDuration === "number" &&
                  typeof row.concealedSamples === "number"
                )
                  sample = {
                    bytesReceived: row.bytesReceived,
                    totalSamplesReceived: row.totalSamplesReceived,
                    totalSamplesDuration: row.totalSamplesDuration,
                    concealedSamples: row.concealedSamples,
                    ...(stats ? { stats } : {}),
                  };
                if (
                  source === "screen" &&
                  !row.isRemote &&
                  typeof row.framesDecoded === "number" &&
                  typeof row.bytesReceived === "number" &&
                  typeof row.frameWidth === "number" &&
                  typeof row.frameHeight === "number"
                )
                  sample = {
                    framesDecoded: row.framesDecoded,
                    bytesReceived: row.bytesReceived,
                    width: row.frameWidth,
                    height: row.frameHeight,
                    ...(stats ? { stats } : {}),
                  };
              }
              return sample;
            },
          },
        }
      : {}),
  });
  return {
    connect: (url, token, options) => room.connect(url, token, options),
    disconnect: (stopTracks) => room.disconnect(stopTracks),
    connected: () => room.state === ConnectionState.Connected,
    identity: () => room.localParticipant.identity,
    metadata: () => room.localParticipant.metadata,
    name: () => room.name,
    participants: () =>
      [...room.remoteParticipants.values()].map((participant) => ({
        identity: participant.identity,
        metadata: participant.metadata,
        publications: [...participant.trackPublications.values()].map(
          remotePublication,
        ),
      })),
    onChange: (listener) => {
      const events = [
        RoomEvent.ConnectionStateChanged,
        RoomEvent.Disconnected,
        RoomEvent.Reconnecting,
        RoomEvent.Reconnected,
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.ParticipantMetadataChanged,
        RoomEvent.ParticipantPermissionsChanged,
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.TrackSubscribed,
        RoomEvent.TrackUnsubscribed,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
      ];
      for (const event of events) room.on(event, listener);
      return () => {
        for (const event of events) room.off(event, listener);
      };
    },
    publish: async (track, options) => {
      const settings = getCaptureSettings(track);
      const wrapped =
        track.kind === "video"
          ? new LocalVideoTrack(
              track,
              {
                width: settings.width,
                height: settings.height,
                frameRate: settings.frameRate,
              },
              true,
            )
          : new LocalAudioTrack(track, undefined, true);
      await room.localParticipant.publishTrack(wrapped, {
        ...options,
        source:
          options.source === "screen"
            ? Track.Source.ScreenShare
            : Track.Source.ScreenShareAudio,
      });
      const owned = {
        get sid() {
          return (
            [...room.localParticipant.trackPublications.values()].find(
              (entry) => entry.track === wrapped,
            )?.trackSid ?? ""
          );
        },
        track,
        sampleStats: async () => {
          const sid = owned.sid,
            sender = wrapped.sender,
            media = wrapped.mediaStreamTrack;
          const report = await wrapped.getRTCStatsReport();
          if (
            !sid ||
            owned.sid !== sid ||
            wrapped.sender !== sender ||
            wrapped.mediaStreamTrack !== media
          )
            return null;
          const rows = reportRows(report);
          return rtpSample(
            rows,
            sourceRow(rows, "sent", options.source, media.id),
            "sent",
            options.source,
            senderBitrate(sender),
          );
        },
      };
      local.set(owned, wrapped);
      return owned;
    },
    unpublish: async (publication) => {
      const existing = local.get(publication);
      // false is essential: this raw native/browser capture still belongs to P2P.
      if (existing) {
        await room.localParticipant.unpublishTrack(existing, false);
        local.delete(publication);
      }
    },
  };
}
const browserEnvironment: RelayEnvironment = {
  room: liveKitRoom,
  nonce: () => crypto.randomUUID(),
  interval: 500,
};
interface Candidate {
  peer_id: string;
  identity: string;
  video: RelayPublication;
  audio?: RelayPublication;
  audioRequired: boolean;
  maxHeight?: number;
  ref: ScreenRelayRef;
  ready: boolean;
  blocked: boolean;
  sampling: boolean;
  playoutAttempted?: boolean;
  playoutCleanup?: () => void;
  emitted: Partial<Record<RelaySource, MediaStreamTrack>>;
}
interface LocalScreen {
  publication: RelayLocalPublication;
  ref: ScreenRelayRef;
  key: string;
  profile: StreamProfile;
}
interface Measurement {
  event: Omit<ScreenRelayStatsEvent, "stats">;
  baseline?: RelayRtpSample;
}

/** Optional screen-only relay. It never captures devices and cannot disable P2P.
 * Callers retain P2P until onAck supplies this exact publication reference. */
export class ScreenRelay {
  private room?: RelayRoom;
  private grant?: ScreenRelayGrant;
  private authority?: ScreenRelayAuthority;
  private candidates = new Map<string, Candidate>();
  private heights = new Map<string, number>();
  private run = 0;
  private publicationEpoch = 0;
  private connected = false;
  private unlisten?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();
  private screen?: LocalScreen;
  private audio?: RelayLocalPublication;
  private announcedLocal?: string;
  private retiring = false;
  private closing: Promise<void> = Promise.resolve();
  private measurements = new Map<string, Measurement>();
  private publisherSampling = new Set<RelayLocalPublication>();
  private audioRetiring = false;

  constructor(
    private callbacks: ScreenRelayCallbacks,
    private environment: RelayEnvironment = browserEnvironment,
  ) {}

  async connect(
    grant: ScreenRelayGrant,
    authority: ScreenRelayAuthority,
  ): Promise<void> {
    const closing = this.close(),
      run = this.run;
    await closing;
    if (run !== this.run) throw new Error("A conexão de tela foi cancelada.");
    if (
      !authority.generation ||
      authority.self.screen_sfu !== true ||
      grant.peer_id !== authority.self.peer_id
    )
      throw new Error(
        "A chamada não autorizou a conexão de tela com o servidor.",
      );
    const room = this.environment.room();
    this.room = room;
    this.grant = { ...grant };
    this.authority = authority;
    this.unlisten = room.onChange(() => {
      if (run === this.run) this.reconcile();
    });
    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
      if (run !== this.run || this.room !== room)
        throw new Error("A conexão de tela foi cancelada.");
      const self = boundPeer(room.identity(), room.metadata());
      if (
        !self ||
        self.peer_id !== authority.self.peer_id ||
        self.user_id !== authority.self.user_id ||
        room.name() !== grant.room
      )
        throw new Error(
          "O servidor de mídia retornou uma identidade incompatível com a chamada.",
        );
      this.connected = true;
      this.timer = setInterval(
        () => this.sample(),
        this.environment.interval ?? 500,
      );
      this.reconcile();
    } catch (error) {
      if (run === this.run) await this.close();
      else await room.disconnect(false);
      throw relayError(error);
    }
  }
  updateAuthority(authority: ScreenRelayAuthority): void {
    if (
      !this.authority ||
      authority.generation !== this.authority.generation ||
      authority.self.peer_id !== this.authority.self.peer_id ||
      authority.self.user_id !== this.authority.self.user_id ||
      authority.self.screen_sfu !== true
    ) {
      void this.close();
      return;
    }
    const revoked =
      this.authority.self.can_publish && !authority.self.can_publish;
    this.authority = authority;
    if (revoked) {
      this.publicationEpoch++;
      void this.setScreen(
        null,
        { height: 0, fps: 0, bitrate: 0, audio: false, content: "text" },
        0,
      ).catch((error) => this.callbacks.onError?.(relayError(error)));
    }
    this.reconcile();
  }
  setReceiveHeight(peer_id: string, height: number): void {
    if (!Number.isSafeInteger(height) || height < 0)
      throw new Error("Limite de recepção inválido.");
    if ((this.heights.get(peer_id) ?? 0) === height) return;
    this.heights.set(peer_id, height);
    const previous = this.candidates.get(peer_id);
    if (previous) {
      this.withdraw(previous);
      this.candidates.delete(peer_id);
    }
    this.reconcile();
  }
  private mayPublish(run: number, epoch: number, room: RelayRoom) {
    return (
      run === this.run &&
      epoch === this.publicationEpoch &&
      this.room === room &&
      this.connected &&
      room.connected() &&
      this.authority?.self.can_publish === true &&
      this.authority.self.screen_sfu === true
    );
  }
  setScreen(
    track: MediaStreamTrack | null,
    profile: StreamProfile,
    maxBitrate: number,
    captureBound?: ScreenRelayCaptureBound,
  ): Promise<ScreenRelayRef | null> {
    if (track && (track.kind !== "video" || track.readyState !== "live"))
      return Promise.reject(
        new Error("A fonte de tela deve fornecer vídeo ativo."),
      );
    const appliedProfile = { ...profile };
    const maxHeight = captureBound?.max_height;
    let options: TrackPublishOptions | undefined;
    try {
      if (
        track &&
        maxHeight !== undefined &&
        (!Number.isSafeInteger(maxHeight) ||
          maxHeight <= 0 ||
          (getCaptureSettings(track).height ?? 0) > maxHeight)
      )
        throw new Error("O limite máximo de captura não foi confirmado.");
      if (track)
        options = publishOptions(
          validateProfile(
            appliedProfile,
            Math.min(maxBitrate, this.grant?.max_video_bitrate ?? 0),
          ),
          Math.min(maxBitrate, this.grant?.max_video_bitrate ?? 0),
        );
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.run,
      epoch = this.publicationEpoch,
      room = this.room;
    const key = JSON.stringify({
      profile,
      maxBitrate,
      maxHeight,
      settings: track ? getCaptureSettings(track) : null,
    });
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (!room) {
          if (!track) return null;
          throw new Error("A conexão de tela não está ativa.");
        }
        if (
          run !== this.run ||
          epoch !== this.publicationEpoch ||
          room !== this.room
        ) {
          if (!track) return null;
          throw new Error("A publicação da tela foi cancelada.");
        }
        if (track && !this.mayPublish(run, epoch, room))
          throw new Error("A publicação da tela não está autorizada.");
        if (
          track &&
          this.screen?.publication.track === track &&
          this.screen.key === key
        ) {
          this.announceLocal();
          return this.screen.ref;
        }
        const previousAudio = this.audio?.track;
        const audio = this.audio,
          screen = this.screen;
        this.retiring = true;
        this.announceLocal();
        const retired = await Promise.allSettled([
          ...(audio ? [room.unpublish(audio)] : []),
          ...(screen ? [room.unpublish(screen.publication)] : []),
        ]);
        this.retiring = false;
        const failed = retired.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          // Keep both handles until close retries cleanup and disconnects the
          // room. Never leave video live because audio unpublish rejected.
          if (this.room === room) void this.close();
          throw failed.reason;
        }
        if (this.audio === audio) this.audio = undefined;
        if (this.screen === screen) this.screen = undefined;
        if (!track) return null;
        if (!this.mayPublish(run, epoch, room))
          throw new Error("A publicação da tela foi cancelada.");
        // The immutable source envelope belongs to this publication generation.
        // Unknown captures stay available to Auto, while capped peers use P2P.
        const generation = `${this.environment.nonce()}_${maxHeight === undefined ? "u" : `h${maxHeight}`}_a${appliedProfile.audio ? 1 : 0}`;
        if (!opaque.test(generation))
          throw new Error("Geração de tela inválida.");
        const publication = await room.publish(track, {
          ...options,
          name: `${names.screen}${generation}`,
          source: "screen",
        });
        if (!this.mayPublish(run, epoch, room)) {
          await room.unpublish(publication);
          throw new Error("A publicação da tela foi cancelada.");
        }
        if (!opaque.test(publication.sid)) {
          await room.unpublish(publication);
          throw new Error("Identificador de publicação inválido.");
        }
        const ref = { track_sid: publication.sid, generation };
        this.screen = { publication, ref, key, profile: appliedProfile };
        this.announceLocal();
        if (
          previousAudio &&
          appliedProfile.audio &&
          previousAudio.readyState === "live"
        )
          await this.publishAudio(room, previousAudio, run, epoch);
        return ref;
      });
    this.queue = operation;
    return operation;
  }
  setScreenAudio(track: MediaStreamTrack | null): Promise<void> {
    if (track && (track.kind !== "audio" || track.readyState !== "live"))
      return Promise.reject(
        new Error("O áudio da tela deve fornecer áudio ativo."),
      );
    const run = this.run,
      epoch = this.publicationEpoch,
      room = this.room;
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (!room) {
          if (!track) return;
          throw new Error("A conexão de tela não está ativa.");
        }
        if (
          run !== this.run ||
          epoch !== this.publicationEpoch ||
          room !== this.room
        ) {
          if (!track) return;
          throw new Error("A publicação do áudio da tela foi cancelada.");
        }
        if (
          track &&
          (!this.mayPublish(run, epoch, room) ||
            !this.screen ||
            !this.screen.profile.audio)
        )
          throw new Error(
            "Compartilhe uma tela com áudio antes de publicar seu áudio.",
          );
        if (this.audio?.track === track) return;
        const old = this.audio;
        if (old) {
          this.audioRetiring = true;
          this.clearMeasurements(
            (event) =>
              event.direction === "sent" && event.source === "screen_audio",
          );
          try {
            await room.unpublish(old);
          } catch (error) {
            if (this.room === room) void this.close();
            throw error;
          } finally {
            this.audioRetiring = false;
          }
        }
        if (this.audio === old) this.audio = undefined;
        if (track) await this.publishAudio(room, track, run, epoch);
      });
    this.queue = operation;
    return operation;
  }
  private async publishAudio(
    room: RelayRoom,
    track: MediaStreamTrack,
    run: number,
    epoch: number,
  ) {
    const screen = this.screen;
    if (!screen || !this.mayPublish(run, epoch, room))
      throw new Error("A publicação do áudio da tela foi cancelada.");
    const publication = await room.publish(track, {
      source: "screen_audio",
      name: `${names.screen_audio}${screen.ref.generation}`,
      audioPreset: { maxBitrate: 128_000 },
      dtx: false,
    });
    if (!this.mayPublish(run, epoch, room) || this.screen !== screen) {
      await room.unpublish(publication);
      throw new Error("A publicação do áudio da tela foi cancelada.");
    }
    this.audio = publication;
  }
  private member(participant: RelayParticipant): ScreenRelayPeer | undefined {
    const bound = boundPeer(participant.identity, participant.metadata);
    if (!bound) return;
    const members = this.authority?.peers.filter(
      (peer) =>
        peer.peer_id === bound.peer_id && peer.user_id === bound.user_id,
    );
    if (members?.length !== 1) return;
    const member = members[0];
    return member.can_publish &&
      member.screen_sfu === true &&
      member.media.screen
      ? member
      : undefined;
  }
  private reconcile() {
    const room = this.room;
    this.announceLocal();
    const desired = new Map<
      string,
      {
        participant: RelayParticipant;
        member: ScreenRelayPeer;
        video: RelayPublication;
        audio?: RelayPublication;
        generation: string;
      }[]
    >();
    if (room && this.connected && room.connected()) {
      for (const participant of room.participants()) {
        const member = this.member(participant);
        const videos = participant.publications.filter(
          (publication) =>
            publication.source === "screen" &&
            !publication.muted &&
            !!namedGeneration(publication),
        );
        let selected: RelayPublication | undefined;
        if (member && videos.length === 1) {
          const video = videos[0],
            height = this.heights.get(member.peer_id) ?? 0,
            maximum = generationHeight(namedGeneration(video)!);
          if (
            !height ||
            (maximum !== undefined &&
              maximum <= height &&
              (video.height == null || video.height <= maximum))
          )
            selected = video;
          else
            this.callbacks.onFallback?.(
              member.peer_id,
              "A tela do servidor não tem limite máximo confirmado dentro do teto de recepção; mantenha a conexão direta.",
            );
        }
        const generation = selected && namedGeneration(selected);
        const audios =
          selected && member?.media.screen_audio
            ? participant.publications.filter(
                (publication) =>
                  publication.source === "screen_audio" &&
                  !publication.muted &&
                  namedGeneration(publication) === generation,
              )
            : [];
        const audio = audios.length === 1 ? audios[0] : undefined;
        for (const publication of participant.publications)
          if (publication !== selected && publication !== audio)
            publication.subscribe(false);
        if (member && selected && generation) {
          const list = desired.get(member.peer_id) ?? [];
          list.push({
            participant,
            member,
            video: selected,
            audio,
            generation,
          });
          desired.set(member.peer_id, list);
        }
      }
    }
    for (const [peer_id, current] of this.candidates) {
      const entries = desired.get(peer_id),
        next = entries?.length === 1 ? entries[0] : undefined;
      if (
        !next ||
        next.participant.identity !== current.identity ||
        next.video.sid !== current.ref.track_sid ||
        next.generation !== current.ref.generation ||
        next.video.track?.media !== current.video.track?.media ||
        next.video.track?.playoutDelay !== current.video.track?.playoutDelay ||
        (next.member.media.screen_audio ||
          generationRequiresAudio(next.generation)) !== current.audioRequired ||
        next.audio?.sid !== current.audio?.sid ||
        next.audio?.track?.media !== current.audio?.track?.media
      ) {
        this.withdraw(current);
        this.candidates.delete(peer_id);
      }
    }
    for (const [peer_id, entries] of desired) {
      if (entries.length !== 1) {
        for (const entry of entries) {
          entry.video.subscribe(false);
          entry.audio?.subscribe(false);
        }
        continue;
      }
      const next = entries[0];
      let candidate = this.candidates.get(peer_id);
      if (!candidate) {
        candidate = {
          peer_id,
          identity: next.participant.identity,
          video: next.video,
          audio: next.audio,
          audioRequired:
            next.member.media.screen_audio ||
            generationRequiresAudio(next.generation),
          maxHeight: generationHeight(next.generation),
          ref: { track_sid: next.video.sid, generation: next.generation },
          ready: false,
          blocked: false,
          sampling: false,
          emitted: {},
        };
        this.candidates.set(peer_id, candidate);
      } else {
        candidate.video = next.video;
        candidate.audio = next.audio;
      }
      candidate.video.subscribe(!candidate.blocked);
      candidate.audio?.subscribe(!candidate.blocked);
      if (candidate.ready) this.emitTracks(candidate);
    }
  }
  private withdraw(candidate: Candidate) {
    // Retire the silent-screen hint before unsubscribe or an audio-enabled epoch.
    const cleanup = candidate.playoutCleanup;
    candidate.playoutCleanup = undefined;
    try {
      cleanup?.();
    } catch {
      /* Optional receiver control cannot block fallback. */
    }
    this.clearMeasurements(
      (event) =>
        event.direction === "received" &&
        event.peer_id === candidate.peer_id &&
        event.ref.track_sid === candidate.ref.track_sid &&
        event.ref.generation === candidate.ref.generation,
    );
    candidate.video.subscribe(false);
    candidate.audio?.subscribe(false);
    const emitted = candidate.emitted;
    candidate.emitted = {};
    if (candidate.ready) {
      candidate.ready = false;
      // Tell the sender to restore P2P before discarding the displayed SFU media.
      this.callbacks.onAck({ peer_id: candidate.peer_id, screen_sfu: null });
    }
    for (const source of ["screen", "screen_audio"] as const) {
      if (emitted[source])
        this.callbacks.onTrack({
          peer_id: candidate.peer_id,
          source,
          track: null,
          ref: candidate.ref,
        });
    }
  }
  private announceLocal() {
    const screen = this.screen;
    const sid = screen?.publication.sid;
    if (
      !this.connected ||
      !this.room?.connected() ||
      !screen ||
      this.retiring ||
      !sid ||
      !opaque.test(sid)
    ) {
      this.clearMeasurements((event) => event.direction === "sent");
      if (this.announcedLocal) {
        this.announcedLocal = undefined;
        this.callbacks.onLocalPublication?.(null);
      }
      return;
    }
    if (screen.ref.track_sid !== sid)
      screen.ref = { track_sid: sid, generation: screen.ref.generation };
    const key = `${sid}:${screen.ref.generation}`;
    if (key !== this.announcedLocal) {
      this.clearMeasurements((event) => event.direction === "sent");
      this.announcedLocal = key;
      this.callbacks.onLocalPublication?.(screen.ref);
    }
  }
  private emitTracks(candidate: Candidate) {
    for (const source of ["screen", "screen_audio"] as const) {
      const track = (source === "screen" ? candidate.video : candidate.audio)
        ?.track?.media;
      if (track !== candidate.emitted[source]) {
        if (track || candidate.emitted[source])
          this.callbacks.onTrack({
            peer_id: candidate.peer_id,
            source,
            track: track ?? null,
            ref: candidate.ref,
          });
        if (track) candidate.emitted[source] = track;
        else delete candidate.emitted[source];
      }
    }
  }
  private sample() {
    this.samplePublisher();
    for (const candidate of this.candidates.values()) {
      const video = candidate.video,
        track = video.track,
        ref = { ...candidate.ref };
      if (candidate.sampling || candidate.blocked || !track) continue;
      candidate.sampling = true;
      void track
        .sample()
        .then(async (sample) => {
          if (
            this.candidates.get(candidate.peer_id) !== candidate ||
            candidate.video.sid !== video.sid ||
            candidate.video.track?.media !== track.media ||
            candidate.ref.track_sid !== ref.track_sid ||
            candidate.ref.generation !== ref.generation ||
            !this.room?.connected() ||
            !this.connected
          ) {
            return;
          }
          if (track.media.readyState !== "live") {
            this.withdraw(candidate);
            candidate.blocked = true;
            return;
          }
          if (
            !sample ||
            !("framesDecoded" in sample) ||
            !Number.isFinite(sample.framesDecoded) ||
            sample.framesDecoded < 1 ||
            !Number.isFinite(sample.bytesReceived) ||
            sample.bytesReceived < 1 ||
            !Number.isFinite(sample.width) ||
            sample.width <= 0 ||
            !Number.isFinite(sample.height) ||
            sample.height <= 0
          ) {
            this.clearMeasurements(
              (event) =>
                event.direction === "received" &&
                event.peer_id === candidate.peer_id &&
                event.ref.track_sid === ref.track_sid &&
                event.ref.generation === ref.generation,
            );
            return;
          }
          const limit = this.heights.get(candidate.peer_id) ?? 0;
          if (
            limit &&
            (candidate.maxHeight === undefined ||
              sample.height > Math.min(limit, candidate.maxHeight))
          ) {
            this.withdraw(candidate);
            candidate.blocked = true;
            this.callbacks.onFallback?.(
              candidate.peer_id,
              "O vídeo recebido excedeu o limite de recepção; mantenha a conexão direta.",
            );
            return;
          }
          let audioStats: RelayRtpSample | undefined;
          let audioSid: string | undefined;
          if (candidate.audioRequired) {
            const publication = candidate.audio,
              audio = publication?.track;
            const sample =
              audio?.media.readyState === "live" ? await audio.sample() : null;
            if (
              this.candidates.get(candidate.peer_id) !== candidate ||
              candidate.audio?.sid !== publication?.sid ||
              candidate.audio?.track?.media !== audio?.media ||
              !this.room?.connected()
            )
              return;
            if (
              !sample ||
              !Number.isFinite(sample.bytesReceived) ||
              sample.bytesReceived < 1 ||
              !("totalSamplesReceived" in sample) ||
              !Number.isFinite(sample.totalSamplesReceived) ||
              sample.totalSamplesReceived < 1 ||
              !Number.isFinite(sample.totalSamplesDuration) ||
              sample.totalSamplesDuration <= 0 ||
              !Number.isFinite(sample.concealedSamples) ||
              sample.concealedSamples < 0 ||
              sample.totalSamplesReceived <= sample.concealedSamples
            ) {
              if (candidate.ready) this.withdraw(candidate);
              return;
            }
            audioStats = sample.stats;
            audioSid = publication?.sid;
          }
          const delay = track.playoutDelay;
          if (
            ref.generation.endsWith("_a0") &&
            !candidate.audioRequired &&
            delay &&
            !candidate.playoutAttempted
          ) {
            const current = () => {
              const room = this.room;
              if (
                !this.connected ||
                !room?.connected() ||
                this.candidates.get(candidate.peer_id) !== candidate ||
                candidate.blocked ||
                candidate.video.sid !== ref.track_sid ||
                candidate.ref.track_sid !== ref.track_sid ||
                candidate.ref.generation !== ref.generation ||
                candidate.video.name !== `${names.screen}${ref.generation}` ||
                candidate.video.source !== "screen" ||
                candidate.video.muted ||
                candidate.video.track?.media !== track.media ||
                candidate.video.track?.playoutDelay !== delay ||
                track.media.kind !== "video" ||
                track.media.readyState !== "live" ||
                candidate.audioRequired ||
                candidate.audio ||
                !Number.isFinite(sample.framesDecoded) ||
                sample.framesDecoded < 1 ||
                !Number.isFinite(sample.bytesReceived) ||
                sample.bytesReceived < 1 ||
                !Number.isFinite(sample.width) ||
                sample.width <= 0 ||
                !Number.isFinite(sample.height) ||
                sample.height <= 0
              )
                return false;
              const height = this.heights.get(candidate.peer_id) ?? 0;
              if (
                height &&
                (candidate.maxHeight === undefined ||
                  sample.height > Math.min(height, candidate.maxHeight))
              )
                return false;
              const participants = room
                .participants()
                .filter((p) => p.identity === candidate.identity);
              if (participants.length !== 1) return false;
              const member = this.member(participants[0]);
              if (
                !member ||
                member.peer_id !== candidate.peer_id ||
                member.media.screen_audio
              )
                return false;
              const videos = participants[0].publications.filter(
                (p) =>
                  p.source === "screen" && !p.muted && !!namedGeneration(p),
              );
              return (
                videos.length === 1 &&
                videos[0].sid === ref.track_sid &&
                namedGeneration(videos[0]) === ref.generation &&
                videos[0].track?.media === track.media &&
                videos[0].track?.playoutDelay === delay &&
                (!height ||
                  videos[0].height == null ||
                  videos[0].height <= Math.min(height, candidate.maxHeight!))
              );
            };
            if (!current()) return;
            candidate.playoutAttempted = true;
            try {
              const cleanup = delay.apply(0.24, ref, current, (cleanup) => {
                candidate.playoutCleanup = cleanup;
              });
              if (!current()) {
                cleanup?.();
                return;
              }
              candidate.playoutCleanup = cleanup;
            } catch {
              const cleanup = candidate.playoutCleanup;
              candidate.playoutCleanup = undefined;
              try {
                cleanup?.();
              } catch {
                /* Optional hint failure keeps the existing media/ACK path. */
              }
            }
            if (!current()) return;
          }
          if (!candidate.ready) {
            candidate.ready = true;
            this.emitTracks(candidate);
            if (
              this.candidates.get(candidate.peer_id) === candidate &&
              this.room?.connected()
            )
              this.callbacks.onAck({
                peer_id: candidate.peer_id,
                screen_sfu: candidate.ref,
              });
          }
          if (
            this.candidates.get(candidate.peer_id) === candidate &&
            candidate.ready &&
            this.room?.connected()
          ) {
            this.recordMeasurement(
              {
                direction: "received",
                source: "screen",
                peer_id: candidate.peer_id,
                ref,
                publication_sid: video.sid,
              },
              sample.stats ?? null,
            );
            if (candidate.audioRequired && audioSid)
              this.recordMeasurement(
                {
                  direction: "received",
                  source: "screen_audio",
                  peer_id: candidate.peer_id,
                  ref,
                  publication_sid: audioSid,
                },
                audioStats ?? null,
              );
          }
        })
        .catch((error) => {
          if (this.candidates.get(candidate.peer_id) !== candidate) return;
          this.withdraw(candidate);
          this.callbacks.onError?.(relayError(error));
        })
        .finally(() => {
          candidate.sampling = false;
        });
    }
  }
  private notifyStats(event: ScreenRelayStatsEvent) {
    // Observing stats must never change capture, ACK, publication or fallback.
    try {
      this.callbacks.onStats?.(event);
    } catch {
      /* observer isolation */
    }
  }
  private clearMeasurements(
    predicate: (event: Measurement["event"]) => boolean,
  ) {
    for (const [key, measurement] of this.measurements)
      if (predicate(measurement.event)) {
        this.measurements.delete(key);
        this.notifyStats({ ...measurement.event, stats: null });
      }
  }
  private recordMeasurement(
    event: Measurement["event"],
    sample: RelayRtpSample | null,
  ) {
    const key = `${event.direction}:${event.peer_id ?? "local"}:${event.source}`;
    let previous = this.measurements.get(key);
    if (
      previous &&
      (previous.event.publication_sid !== event.publication_sid ||
        previous.event.ref.track_sid !== event.ref.track_sid ||
        previous.event.ref.generation !== event.ref.generation)
    ) {
      this.clearMeasurements((value) => value === previous!.event);
      previous = undefined;
    }
    const measurement: Measurement = {
      event: { ...event, ref: { ...event.ref } },
    };
    this.measurements.set(key, measurement);
    if (!sample || counter(sample.timestamp) === null) {
      this.notifyStats({ ...measurement.event, stats: null });
      return;
    }
    const before = previous?.baseline;
    const delta =
      before &&
      sample.timestamp > before.timestamp &&
      before.rowId === sample.rowId &&
      !(
        sample.bytes !== null &&
        before.bytes !== null &&
        sample.bytes < before.bytes
      ) &&
      !(
        sample.frames !== null &&
        before.frames !== null &&
        sample.frames < before.frames
      )
        ? sample.timestamp - before.timestamp
        : null;
    const bitrate =
      delta && sample.bytes !== null && before?.bytes != null
        ? ((sample.bytes - before.bytes) * 8000) / delta
        : null;
    const fps =
      delta && sample.frames !== null && before?.frames != null
        ? ((sample.frames - before.frames) * 1000) / delta
        : null;
    measurement.baseline = { ...sample };
    this.notifyStats({
      ...measurement.event,
      stats: {
        bitrate,
        fps,
        width: sample.width,
        height: sample.height,
        audioLevel: sample.audioLevel,
        packetsLost: sample.packetsLost,
        jitterMs: sample.jitterMs,
        iceRttMs: sample.iceRttMs,
        maxBitrate: sample.maxBitrate,
        timestamp: sample.timestamp,
      },
    });
  }
  private samplePublisher() {
    const room = this.room,
      screen = this.screen,
      run = this.run;
    if (!room?.connected() || !this.connected || this.retiring || !screen)
      return;
    const ref = { ...screen.ref };
    for (const [source, publication] of [
      ["screen", screen.publication],
      ["screen_audio", this.audio],
    ] as const) {
      if (
        !publication ||
        (source === "screen_audio" && this.audioRetiring) ||
        this.publisherSampling.has(publication)
      )
        continue;
      const sid = publication.sid;
      if (!sid) continue;
      this.publisherSampling.add(publication);
      const current = () =>
        this.run === run &&
        this.room === room &&
        room.connected() &&
        this.connected &&
        !this.retiring &&
        this.screen === screen &&
        this.screen.ref.track_sid === ref.track_sid &&
        this.screen.ref.generation === ref.generation &&
        publication.sid === sid &&
        (source === "screen"
          ? this.screen.publication === publication
          : this.audio === publication && !this.audioRetiring);
      void Promise.resolve()
        .then(() => publication.sampleStats?.() ?? null)
        .then((sample) => {
          if (current())
            this.recordMeasurement(
              { direction: "sent", source, ref, publication_sid: sid },
              sample,
            );
        })
        .catch(() => {
          if (current())
            this.recordMeasurement(
              { direction: "sent", source, ref, publication_sid: sid },
              null,
            );
        })
        .finally(() => this.publisherSampling.delete(publication));
    }
  }
  close(): Promise<void> {
    this.run++;
    this.publicationEpoch++;
    this.connected = false;
    this.retiring = false;
    this.clearMeasurements(() => true);
    clearInterval(this.timer);
    this.timer = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    for (const candidate of this.candidates.values()) this.withdraw(candidate);
    this.candidates.clear();
    const room = this.room,
      screen = this.screen,
      audio = this.audio;
    this.room = undefined;
    this.screen = undefined;
    this.audio = undefined;
    this.announceLocal();
    this.authority = undefined;
    this.grant = undefined;
    if (!room) return this.closing;
    const cleanup = [
      screen && room.unpublish(screen.publication),
      audio && room.unpublish(audio),
      room.disconnect(false),
      this.queue,
    ];
    this.closing = Promise.allSettled(cleanup).then(() => {});
    return this.closing;
  }
}
