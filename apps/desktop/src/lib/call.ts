import { api, getServer, getSession, onSession, refreshSession } from "./api";
import type { Session } from "./types";
import {
  defaultProfile,
  resolutions,
  validateProfile,
  screenDegradationPreference,
} from "./stream";
import type { StreamProfile } from "./stream";
import { classifyRoute } from "./p2p";
import { tryScreenVp8L1T1 } from "./screen-encoder";
import {
  applyCaptureConstraints,
  getCaptureSettings,
  getCaptureBound,
  releaseCaptureTrack,
} from "./capture-track";
import type {
  ScreenRelay,
  ScreenRelayAuthority,
  ScreenRelayCallbacks,
  ScreenRelayGrant,
  ScreenRelayRef,
  ScreenRelayMediaStats,
} from "./screen-relay";

/** Stable m-line order. A track ID supplied by another client is never an identity. */
export const callSources = [
  "microphone",
  "camera",
  "screen",
  "screen_audio",
] as const;
export type CallSource = (typeof callSources)[number];
const kinds = ["audio", "video", "video", "audio"] as const;
export type CallMedia = Record<CallSource, boolean>;
export type CallTracks = Partial<Record<CallSource, MediaStreamTrack>>;
export interface CallParticipant {
  peer_id: string;
  user_id: string;
  display_name: string;
  can_publish: boolean;
  screen_sfu?: boolean;
  media: CallMedia;
}
export interface CallMediaStats {
  bitrate: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  audioLevel: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  /** Present for SDK media; binds the displayed sample to its publication. */
  sourceRef?: ScreenRelayRef;
  publicationSid?: string;
  timestamp?: number;
}
export interface CallStats {
  /** ICE for the P2P connection carrying voice/camera, never the SDK video. */
  iceRttMs: number | null;
  route: "direct" | "relay" | "unknown";
  sent: Partial<Record<CallSource, CallMediaStats>>;
  received: Partial<Record<CallSource, CallMediaStats>>;
}
export interface CallPeerSnapshot extends CallParticipant {
  connection: RTCPeerConnectionState;
  tracks: CallTracks;
  stats: CallStats;
  error: string;
  receiveHeight: number;
  /** ICE statistics still describe P2P voice; SFU video has separate transport. */
  screenTransport: "p2p" | "sfu";
  screenIceRttMs: number | null;
}
export interface CallScreenUpload {
  /** Video only: one SDK publisher plus each attached P2P screen sender. */
  connections: { sfu: number; p2p: number };
  bitrate: number | null;
  partial: boolean;
  /** Sum of maxBitrate actually returned by the active RTP senders. */
  maxBitrate: number | null;
  maxBitratePartial: boolean;
}
export interface CallSnapshot {
  state: "idle" | "connecting" | "connected" | "closed" | "failed";
  reason: string;
  self: CallParticipant | null;
  participants: CallPeerSnapshot[];
  localTracks: CallTracks;
  maxVideoBitrate: number;
  maxParticipants: number;
  profile: StreamProfile;
  screenUpload: CallScreenUpload;
}
/** The injected boundary is also used by tests; production uses api.ts and browsers. */
export interface CallEnvironment {
  getServer: () => string;
  getSession: () => Session | null;
  onSession: (listener: (session: Session | null) => void) => () => void;
  refreshSession: () => Promise<Session>;
  socket: (url: string) => WebSocket;
  peer: (configuration: RTCConfiguration) => RTCPeerConnection;
  getCallConfig?: (
    channel: string,
    signal?: AbortSignal,
  ) => Promise<{ screen_sfu_enabled?: boolean }>;
  getScreenToken?: (channel: string, peer: string) => Promise<ScreenRelayGrant>;
  relayFactory?: (
    callbacks: ScreenRelayCallbacks,
  ) => CallScreenRelay | Promise<CallScreenRelay>;
}
export type CallScreenRelay = Pick<
  ScreenRelay,
  | "connect"
  | "updateAuthority"
  | "setScreen"
  | "setScreenAudio"
  | "setReceiveHeight"
  | "close"
>;
const browserEnvironment: CallEnvironment = {
  getServer,
  getSession,
  onSession,
  refreshSession,
  socket: (url) => new WebSocket(url),
  peer: (configuration) => new RTCPeerConnection(configuration),
  getCallConfig: (channel, signal) =>
    api(`/api/channels/${channel}/call`, { signal }),
  getScreenToken: (channel, peer) =>
    api(`/api/channels/${channel}/screen-token`, {
      method: "POST",
      body: { peer_id: peer },
    }),
  relayFactory: async (callbacks) => {
    const { ScreenRelay } = await import("./screen-relay");
    return new ScreenRelay(callbacks);
  },
};
type StatsRow = RTCStats & Record<string, unknown>;
type Observation = {
  bytes: number;
  timestamp: number;
  frames: number | null;
  source: CallSource;
  outbound: boolean;
};
type RelayMeasurement = ScreenRelayMediaStats & {
  sourceRef: ScreenRelayRef;
  publicationSid: string;
};
const relayOpaque = /^[A-Za-z0-9_-]{1,128}$/;
function sameRelayRef(
  a: ScreenRelayRef | undefined,
  b: ScreenRelayRef | undefined,
) {
  return (
    !!a && !!b && a.track_sid === b.track_sid && a.generation === b.generation
  );
}
function relayRef(value: unknown): ScreenRelayRef | undefined {
  if (value === null || value === undefined) return;
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.track_sid !== "string" ||
    !relayOpaque.test(value.track_sid) ||
    typeof value.generation !== "string" ||
    !relayOpaque.test(value.generation)
  )
    throw new Error("Confirmação da tela do servidor inválida.");
  return { track_sid: value.track_sid, generation: value.generation };
}
// encoding.codec is standardized, but is not present in this pinned DOM typing.
type EncodingCodec = Pick<
  RTCRtpCodecParameters,
  "mimeType" | "clockRate" | "channels" | "sdpFmtpLine"
>;
type CodecEncoding = RTCRtpEncodingParameters & { codec?: EncodingCodec };
type CodecParameters = Omit<RTCRtpSendParameters, "encodings"> & {
  encodings: CodecEncoding[];
};
interface Peer {
  member: CallParticipant;
  pc: RTCPeerConnection;
  tracks: CallTracks;
  relayTracks: CallTracks;
  relayTracksRef?: ScreenRelayRef;
  receivedRelayRef?: ScreenRelayRef;
  remoteRelayRef?: ScreenRelayRef;
  stats: CallStats;
  relayStats: Partial<Record<"screen" | "screen_audio", RelayMeasurement>>;
  sampledScreenTrack?: MediaStreamTrack | null;
  screenStatsEpoch: number;
  observations: Map<string, Observation>;
  queue: Promise<void>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  remoteAnswerPending: boolean;
  initialized: boolean;
  starting: boolean;
  pendingIce: (RTCIceCandidateInit | null)[];
  ignoredUfrags: Set<string>;
  restartAttempts: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  error: string;
  failed: boolean;
  receiveHeight: number;
  remoteReceiveHeight: number;
  screenCodec: {
    mode: "fresh" | "h264" | "vp8";
    api: "unknown" | "supported" | "unsupported";
  };
}
function codecFormat(codec: EncodingCodec): Map<string, string> {
  const entries = (codec.sdpFmtpLine || "")
    .split(";")
    .filter((part) => part.trim())
    .map((part) => {
      const [key, ...value] = part.trim().split("=");
      const name = key.trim().toLowerCase();
      const content = value.join("=").trim();
      return [
        name,
        name === "profile-level-id" ? content.toLowerCase() : content,
      ] as const;
    });
  return new Map(entries);
}
function sameCodec(a: EncodingCodec | undefined, b: EncodingCodec): boolean {
  if (
    !a ||
    a.mimeType.toLowerCase() !== b.mimeType.toLowerCase() ||
    a.clockRate !== b.clockRate ||
    a.channels !== b.channels
  )
    return false;
  const left = codecFormat(a),
    right = codecFormat(b);
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
}
function codecValue(codec: RTCRtpCodecParameters): EncodingCodec {
  return {
    mimeType: codec.mimeType,
    clockRate: codec.clockRate,
    ...(codec.channels === undefined ? {} : { channels: codec.channels }),
    ...(codec.sdpFmtpLine === undefined
      ? {}
      : { sdpFmtpLine: codec.sdpFmtpLine }),
  };
}
const emptyMedia = (): CallMedia => ({
  microphone: false,
  camera: false,
  screen: false,
  screen_audio: false,
});
const emptyStats = (): CallStats => ({
  iceRttMs: null,
  route: "unknown",
  sent: {},
  received: {},
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const heightAllowed = (value: unknown): value is number =>
  typeof value === "number" &&
  (value === 0 || resolutions.includes(value as (typeof resolutions)[number]));
function claims(token: string): { sid?: string; exp?: number } {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const value: unknown = JSON.parse(atob(payload));
    return record(value)
      ? {
          sid: typeof value.sid === "string" ? value.sid : undefined,
          exp: typeof value.exp === "number" ? value.exp : undefined,
        }
      : {};
  } catch {
    return {};
  }
}
function members(value: unknown, maximum: number): CallParticipant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum)
    throw new Error("Lista de participantes inválida.");
  const ids = new Set<string>(),
    users = new Set<string>();
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !id(item.peer_id) ||
      !id(item.user_id) ||
      typeof item.display_name !== "string" ||
      item.display_name.length > 100 ||
      typeof item.can_publish !== "boolean" ||
      (item.screen_sfu !== undefined && typeof item.screen_sfu !== "boolean") ||
      !record(item.media) ||
      callSources.some(
        (source) =>
          typeof (item.media as Record<string, unknown>)[source] !== "boolean",
      ) ||
      ids.has(item.peer_id) ||
      users.has(item.user_id)
    )
      throw new Error("Lista de participantes inválida.");
    ids.add(item.peer_id);
    users.add(item.user_id);
    const media = emptyMedia();
    for (const source of callSources)
      media[source] = item.can_publish && item.media[source] === true;
    return {
      peer_id: item.peer_id,
      user_id: item.user_id,
      display_name: item.display_name,
      can_publish: item.can_publish,
      ...(item.screen_sfu === true ? { screen_sfu: true } : {}),
      media,
    };
  });
}
function iceConfiguration(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value) || value.length > 4)
    throw new Error("Configuração de conexão direta inválida.");
  let count = 0;
  return value.map((item: unknown) => {
    if (!record(item)) throw new Error("Servidor de conexão inválido.");
    const urls: unknown[] = Array.isArray(item.urls) ? item.urls : [item.urls];
    if (
      !urls.length ||
      (count += urls.length) > 4 ||
      urls.some(
        (url) =>
          typeof url !== "string" ||
          url.length > 255 ||
          !/^stuns?:[^\s/@?#]+$/i.test(url),
      )
    )
      throw new Error(
        "A chamada direta aceita apenas os servidores STUN configurados.",
      );
    return { urls: urls as string[] };
  });
}
function description(value: unknown): RTCSessionDescriptionInit {
  if (
    !record(value) ||
    !["offer", "answer"].includes(String(value.type)) ||
    typeof value.sdp !== "string" ||
    value.sdp.length > 60_000
  )
    throw new Error("Descrição de mídia inválida.");
  const media = value.sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("m="));
  if (
    media.length !== kinds.length ||
    media.some((line, index) => !line.startsWith("m=" + kinds[index] + " "))
  )
    throw new Error("A chamada recebeu fontes de mídia incompatíveis.");
  return { type: value.type as "offer" | "answer", sdp: value.sdp };
}
function iceCandidate(value: unknown): RTCIceCandidateInit | null {
  if (value === null) return null;
  if (
    !record(value) ||
    typeof value.candidate !== "string" ||
    value.candidate.length > 4096 ||
    (value.sdpMid !== null &&
      value.sdpMid !== undefined &&
      !["0", "1", "2", "3"].includes(String(value.sdpMid))) ||
    (value.sdpMLineIndex !== null &&
      value.sdpMLineIndex !== undefined &&
      (!Number.isInteger(value.sdpMLineIndex) ||
        Number(value.sdpMLineIndex) < 0 ||
        Number(value.sdpMLineIndex) > 3)) ||
    (value.usernameFragment !== undefined &&
      value.usernameFragment !== null &&
      (typeof value.usernameFragment !== "string" ||
        value.usernameFragment.length > 256))
  )
    throw new Error("Candidato de conexão inválido.");
  return {
    candidate: value.candidate,
    sdpMid: value.sdpMid as string | null | undefined,
    sdpMLineIndex: value.sdpMLineIndex as number | null | undefined,
    usernameFragment: value.usernameFragment as string | null | undefined,
  };
}

/** Real media transport. It never captures a microphone, camera or screen itself. */
export class P2PCall {
  private socket: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private listeners = new Set<(snapshot: CallSnapshot) => void>();
  private local: CallTracks = {};
  private pendingTracks = new Set<MediaStreamTrack>();
  private ended = new Map<MediaStreamTrack, () => void>();
  private screenGeometry = new WeakMap<MediaStreamTrack, boolean>();
  private screenTransition?: {
    run: number;
    track: MediaStreamTrack;
    deferred: Set<Peer>;
  };
  private data: CallSnapshot = {
    state: "idle",
    reason: "",
    self: null,
    participants: [],
    localTracks: {},
    maxVideoBitrate: 8_000_000,
    maxParticipants: 12,
    profile: { ...defaultProfile },
    screenUpload: {
      connections: { sfu: 0, p2p: 0 },
      bitrate: null,
      partial: false,
      maxBitrate: 0,
      maxBitratePartial: false,
    },
  };
  private generation = 0;
  private publicationEpoch = 0;
  private origin = "";
  private userId = "";
  private sessionId?: string;
  private token = "";
  private iceServers: RTCIceServer[] = [];
  private unsubscribeSession?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private sampleTimer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private capabilityTimer?: ReturnType<typeof setTimeout>;
  private capabilityAbort?: AbortController;
  private lastPong = 0;
  private mediaQueue: Promise<unknown> = Promise.resolve();
  private samplingRun: number | null = null;
  private flight: Promise<void> | null = null;
  private connected?: () => void;
  private rejected?: (error: Error) => void;
  private screenSfuAdvertised = false;
  private screenSfuEnabled = false;
  private relay?: CallScreenRelay;
  private relayReady = false;
  private relayConnecting?: Promise<void>;
  private relayQueue: Promise<unknown> = Promise.resolve();
  private relayLocalRef?: ScreenRelayRef;
  private relayTrack?: MediaStreamTrack;
  private relayBound?: { max_height: number };
  private relaySentStats: Partial<
    Record<"screen" | "screen_audio", RelayMeasurement>
  > = {};

  constructor(
    private options: { channelId: string },
    private environment: CallEnvironment = browserEnvironment,
  ) {}

  get snapshot(): CallSnapshot {
    return this.data;
  }
  subscribe(listener: (snapshot: CallSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.data);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    this.data = {
      ...this.data,
      localTracks: { ...this.local },
      profile: { ...this.data.profile },
      participants: [...this.peers.values()].map((peer) => {
        this.screenSenderChanged(peer);
        const tracks: CallTracks = {};
        for (const source of callSources) {
          const track = peer.tracks[source];
          const allowed = peer.member.can_publish && peer.member.media[source];
          const enabled = allowed && !peer.failed;
          if (track && track.enabled !== enabled) track.enabled = enabled;
          if (track && allowed && !peer.failed && track.readyState === "live")
            tracks[source] = track;
        }
        const receivingRelay =
          !!peer.receivedRelayRef &&
          sameRelayRef(peer.receivedRelayRef, peer.relayTracksRef) &&
          peer.member.can_publish &&
          peer.member.media.screen &&
          !peer.failed &&
          peer.relayTracks.screen?.readyState === "live";
        for (const source of ["screen", "screen_audio"] as const) {
          const track = peer.relayTracks[source];
          const enabled =
            !!receivingRelay &&
            peer.member.can_publish &&
            peer.member.media[source] &&
            !peer.failed;
          if (track && track.enabled !== enabled) track.enabled = enabled;
          if (enabled && track?.readyState === "live") tracks[source] = track;
        }
        const stats = {
          ...peer.stats,
          sent: { ...peer.stats.sent },
          received: { ...peer.stats.received },
        };
        if (this.usesRelay(peer)) {
          delete stats.sent.screen;
          delete stats.sent.screen_audio;
        }
        if (receivingRelay) {
          // A past P2P sample is not a measurement of the selected SFU track.
          for (const source of ["screen", "screen_audio"] as const) {
            delete stats.received[source];
            if (tracks[source] && peer.relayStats[source])
              stats.received[source] = { ...peer.relayStats[source]! };
          }
        }
        return {
          ...peer.member,
          media: { ...peer.member.media },
          tracks,
          connection: peer.failed ? "failed" : peer.pc.connectionState,
          stats,
          error: peer.error,
          receiveHeight: peer.receiveHeight,
          screenTransport: receivingRelay ? ("sfu" as const) : ("p2p" as const),
          screenIceRttMs: receivingRelay
            ? (peer.relayStats.screen?.iceRttMs ?? null)
            : peer.stats.iceRttMs,
        };
      }),
      screenUpload: this.screenUpload(),
    };
    for (const listener of this.listeners) listener(this.data);
  }
  private screenSenderChanged(peer: Peer) {
    const track = peer.pc.getTransceivers()[2]?.sender.track ?? null;
    if (peer.sampledScreenTrack === track) return;
    peer.sampledScreenTrack = track;
    peer.screenStatsEpoch++;
    delete peer.stats.sent.screen;
    for (const [key, observation] of peer.observations)
      if (observation.outbound && observation.source === "screen")
        peer.observations.delete(key);
  }
  private screenUpload(): CallScreenUpload {
    const measurements: (number | null)[] = [],
      caps: (number | null)[] = [];
    const connections = { sfu: 0, p2p: 0 };
    const track = this.local.screen;
    if (this.mayPublish() && track?.enabled && track.readyState === "live") {
      if (this.relay && this.relayReady && this.relayLocalRef) {
        connections.sfu = 1;
        measurements.push(this.relaySentStats.screen?.bitrate ?? null);
        caps.push(this.relaySentStats.screen?.maxBitrate ?? null);
      }
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getTransceivers()[2]?.sender;
        if (!this.current(peer) || sender?.track !== track) continue;
        connections.p2p++;
        measurements.push(peer.stats.sent.screen?.bitrate ?? null);
        try {
          const encodings = sender.getParameters().encodings;
          const active = encodings.filter(
            (encoding) => encoding.active !== false,
          );
          caps.push(
            !encodings.length ||
              active.some((encoding) => finite(encoding.maxBitrate) === null)
              ? null
              : active.reduce((sum, encoding) => sum + encoding.maxBitrate!, 0),
          );
        } catch {
          caps.push(null);
        }
      }
    }
    const sum = (values: (number | null)[]) => {
      const measured = values.filter(
        (value): value is number => value !== null,
      );
      return measured.length
        ? measured.reduce((total, value) => total + value, 0)
        : null;
    };
    return {
      connections,
      bitrate: sum(measurements),
      partial: measurements.some((value) => value === null),
      maxBitrate: caps.length ? sum(caps) : 0,
      maxBitratePartial: caps.some((value) => value === null),
    };
  }
  private live(run = this.generation) {
    return (
      run === this.generation &&
      ["connecting", "connected"].includes(this.data.state)
    );
  }
  private current(peer: Peer) {
    return (
      this.live() &&
      this.peers.get(peer.member.peer_id) === peer &&
      !peer.failed
    );
  }
  private mayPublish(run = this.generation, epoch = this.publicationEpoch) {
    return (
      this.live(run) &&
      this.data.state === "connected" &&
      epoch === this.publicationEpoch &&
      this.data.self?.can_publish === true
    );
  }

  private relayAuthority(): ScreenRelayAuthority {
    return {
      generation: String(this.generation),
      self: { ...this.data.self!, media: { ...this.data.self!.media } },
      peers: [...this.peers.values()].map(({ member }) => ({
        ...member,
        media: { ...member.media },
      })),
    };
  }
  private usesRelay(peer: Peer): boolean {
    return (
      !!this.relay &&
      this.relayReady &&
      this.screenSfuEnabled &&
      this.data.self?.screen_sfu === true &&
      peer.member.screen_sfu === true &&
      this.mayPublish() &&
      this.local.screen?.enabled === true &&
      this.local.screen === this.relayTrack &&
      sameRelayRef(peer.remoteRelayRef, this.relayLocalRef) &&
      (!peer.remoteReceiveHeight ||
        (!!this.relayBound &&
          this.relayBound.max_height <= peer.remoteReceiveHeight))
    );
  }
  private scheduleRelayRoutes() {
    for (const peer of this.peers.values())
      if (this.current(peer))
        void this.enqueue(peer, () => this.synchronizeRelayRoutes(peer)).catch(
          () => {
            this.failPeer(
              peer,
              "Não foi possível preservar a tela na conexão direta.",
            );
          },
        );
  }
  private relayPublication(ref: ScreenRelayRef | null) {
    if (!sameRelayRef(this.relayLocalRef, ref ?? undefined))
      this.relaySentStats = {};
    this.relayLocalRef = ref ?? undefined;
    for (const peer of this.peers.values())
      if (!sameRelayRef(peer.remoteRelayRef, this.relayLocalRef))
        peer.remoteRelayRef = undefined;
    this.scheduleRelayRoutes();
    this.emit();
  }
  private clearRelayTracks(peer: Peer) {
    for (const track of Object.values(peer.relayTracks)) track.enabled = false;
    peer.relayTracks = {};
    peer.relayTracksRef = undefined;
    peer.relayStats = {};
  }
  private stopRelay(quiet = false) {
    const relay = this.relay;
    this.relay = undefined;
    this.relayReady = false;
    this.relayTrack = undefined;
    this.relayBound = undefined;
    this.relaySentStats = {};
    if (quiet) this.relayLocalRef = undefined;
    else this.relayPublication(null);
    for (const peer of this.peers.values()) {
      this.clearRelayTracks(peer);
      if (peer.receivedRelayRef) {
        peer.receivedRelayRef = undefined;
        if (!quiet) this.sendReceivePreference(peer);
      }
    }
    if (relay) void relay.close().catch(() => {});
  }
  private sendReceivePreference(peer: Peer) {
    this.signal(peer, {
      receive: {
        screen_height: peer.receiveHeight,
        ...(this.screenSfuEnabled && peer.member.screen_sfu === true
          ? { screen_sfu: peer.receivedRelayRef ?? null }
          : {}),
      },
    });
  }
  private startRelay(run: number) {
    if (
      !this.screenSfuEnabled ||
      this.relay ||
      this.relayConnecting ||
      !this.environment.getScreenToken ||
      !this.environment.relayFactory
    )
      return;
    const pending = (async () => {
      const grant = await this.environment.getScreenToken!(
        this.options.channelId,
        this.data.self!.peer_id,
      );
      if (!this.live(run) || !this.screenSfuEnabled) return;
      let relay: CallScreenRelay;
      const current = () =>
        !!relay &&
        this.live(run) &&
        this.relay === relay &&
        this.screenSfuEnabled;
      relay = await this.environment.relayFactory!({
        onStats: ({
          direction,
          source,
          ref,
          peer_id,
          publication_sid,
          stats,
        }) => {
          if (!current()) return;
          if (source === "screen" && publication_sid !== ref.track_sid) return;
          if (direction === "sent") {
            if (
              peer_id ||
              !this.mayPublish() ||
              !sameRelayRef(this.relayLocalRef, ref)
            )
              return;
            const previous = this.relaySentStats[source];
            if (!stats) delete this.relaySentStats[source];
            else if (!previous || stats.timestamp >= previous.timestamp)
              this.relaySentStats[source] = {
                ...stats,
                sourceRef: { ...ref },
                publicationSid: publication_sid,
              };
          } else {
            const peer = peer_id ? this.peers.get(peer_id) : undefined;
            if (
              !peer ||
              !this.current(peer) ||
              !peer.member.can_publish ||
              !peer.member.media[source] ||
              !peer.relayTracks[source] ||
              !sameRelayRef(peer.relayTracksRef, ref)
            )
              return;
            const previous = peer.relayStats[source];
            if (!stats) delete peer.relayStats[source];
            else if (!previous || stats.timestamp >= previous.timestamp)
              peer.relayStats[source] = {
                ...stats,
                sourceRef: { ...ref },
                publicationSid: publication_sid,
              };
          }
          this.emit();
        },
        onLocalPublication: (ref) => {
          if (current()) this.relayPublication(ref);
        },
        onTrack: ({ peer_id, source, track, ref }) => {
          const peer = this.peers.get(peer_id);
          if (!current() || !peer || !this.current(peer)) {
            if (track) track.enabled = false;
            return;
          }
          if (!track) {
            if (sameRelayRef(peer.relayTracksRef, ref)) {
              if (peer.relayTracks[source])
                peer.relayTracks[source]!.enabled = false;
              delete peer.relayTracks[source];
            }
          } else if (
            peer.member.screen_sfu === true &&
            peer.member.can_publish &&
            peer.member.media[source]
          ) {
            if (!sameRelayRef(peer.relayTracksRef, ref))
              this.clearRelayTracks(peer);
            if (peer.relayTracks[source] && peer.relayTracks[source] !== track)
              peer.relayTracks[source]!.enabled = false;
            peer.relayTracksRef = { ...ref };
            peer.relayTracks[source] = track;
          } else track.enabled = false;
          this.emit();
        },
        onAck: ({ peer_id, screen_sfu }) => {
          const peer = this.peers.get(peer_id);
          if (
            !current() ||
            !peer ||
            !this.current(peer) ||
            peer.member.screen_sfu !== true
          )
            return;
          if (
            screen_sfu &&
            (!peer.member.can_publish ||
              !peer.member.media.screen ||
              !sameRelayRef(peer.relayTracksRef, screen_sfu) ||
              peer.relayTracks.screen?.readyState !== "live" ||
              (peer.member.media.screen_audio &&
                peer.relayTracks.screen_audio?.readyState !== "live"))
          )
            return;
          peer.receivedRelayRef = screen_sfu ? { ...screen_sfu } : undefined;
          if (!screen_sfu) this.clearRelayTracks(peer);
          this.sendReceivePreference(peer);
          this.emit();
        },
        onError: () => {
          if (current()) {
            this.stopRelay();
            this.emit();
          }
        },
      });
      if (!this.live(run) || !this.screenSfuEnabled) {
        await relay.close();
        return;
      }
      this.relay = relay;
      await relay.connect(grant, this.relayAuthority());
      if (!current()) {
        await relay.close();
        return;
      }
      this.relayReady = true;
      for (const peer of this.peers.values())
        relay.setReceiveHeight(peer.member.peer_id, peer.receiveHeight);
      await this.syncRelay();
    })().catch(() => {
      if (this.live(run)) {
        this.stopRelay();
        this.emit();
      }
    });
    this.relayConnecting = pending;
    void pending.finally(() => {
      if (this.relayConnecting === pending) this.relayConnecting = undefined;
    });
  }
  /** This queue never waits for the media or peer queues. SDK callbacks only
   * schedule peer work, so capture/profile changes may safely await retirement. */
  private syncRelay(retire = false): Promise<void> {
    const relay = this.relay,
      run = this.generation,
      epoch = this.publicationEpoch;
    if (!relay || !this.relayReady) return Promise.resolve();
    if (retire) {
      this.relayTrack = undefined;
      this.relayBound = undefined;
      this.relayPublication(null);
    }
    const operation = this.relayQueue
      .catch(() => {})
      .then(async () => {
        if (!this.live(run) || this.relay !== relay) return;
        if (!retire && this.screenTransition?.run === run) return;
        const track =
          !retire && this.mayPublish(run, epoch) && this.local.screen?.enabled
            ? this.local.screen
            : null;
        const bound = track ? getCaptureBound(track) : undefined;
        // Audio intent is immutable in the publication generation. A requested
        // source that was not actually captured must not advertise phantom audio.
        const profile = {
          ...this.data.profile,
          audio: !!(
            track &&
            this.data.profile.audio &&
            this.local.screen_audio?.enabled
          ),
        };
        const ref = await relay.setScreen(
          track,
          profile,
          this.data.maxVideoBitrate,
          bound,
        );
        if (!this.live(run) || this.relay !== relay) {
          await relay.close();
          return;
        }
        if (!this.mayPublish(run, epoch)) {
          await relay.setScreen(
            null,
            { ...this.data.profile },
            this.data.maxVideoBitrate,
          );
          return;
        }
        if (!retire && this.local.screen === track) {
          this.relayTrack = track ?? undefined;
          this.relayBound = bound;
          if (!sameRelayRef(this.relayLocalRef, ref ?? undefined))
            this.relayPublication(ref);
          await relay.setScreenAudio(
            track && this.data.profile.audio && this.local.screen_audio?.enabled
              ? this.local.screen_audio
              : null,
          );
          if (this.live(run) && this.relay === relay)
            this.scheduleRelayRoutes();
        }
      })
      .catch(async () => {
        if (this.relay === relay) this.stopRelay();
        await relay.close();
      });
    this.relayQueue = operation;
    return operation;
  }
  private async synchronizeRelayRoutes(peer: Peer) {
    await this.synchronizeScreen(peer);
    if (!this.current(peer)) return;
    const sender = peer.pc.getTransceivers()[3]?.sender;
    if (sender)
      await this.replaceSenderTrack(
        sender,
        this.mayPublish() && !this.usesRelay(peer)
          ? (this.local.screen_audio ?? null)
          : null,
      );
    await this.parameters(peer, "screen_audio");
    if (this.current(peer)) this.emit();
  }

  connect(): Promise<void> {
    if (this.data.state === "connected") return Promise.resolve();
    if (this.data.state === "connecting" && this.flight) return this.flight;
    const session = this.environment.getSession();
    if (!session)
      return Promise.reject(
        new Error("Entre na sua conta para iniciar a chamada."),
      );
    const run = ++this.generation;
    this.screenSfuAdvertised = false;
    this.screenSfuEnabled = false;
    this.origin = this.environment.getServer();
    this.userId = session.user.id;
    this.token = session.access_token;
    this.sessionId = claims(this.token).sid;
    this.data = { ...this.data, state: "connecting", reason: "", self: null };
    const flight = new Promise<void>((resolve, reject) => {
      this.connected = resolve;
      this.rejected = reject;
    });
    this.flight = flight;
    this.emit();
    if (!this.live(run)) return flight;
    this.unsubscribeSession = this.environment.onSession((next) =>
      this.sessionChanged(next),
    );
    if (!this.live(run)) {
      this.unsubscribeSession();
      this.unsubscribeSession = undefined;
      return flight;
    }
    const open = () => {
      if (!this.live(run)) return;
      // The optional HTTP lookup has its own 1.5 s budget. Preserve the full
      // existing 15 s deadline from the WebSocket attempt, even before onopen.
      this.connectTimer = setTimeout(
        () => this.fail("O servidor não confirmou a entrada na chamada."),
        15_000,
      );
      try {
        const url = new URL("/api/calls", this.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = this.environment.socket(url.toString());
        const budget = { frames: 0, bytes: 0 };
        this.socket = socket;
        socket.onopen = () => {
          if (this.live(run))
            this.send({
              type: "auth",
              token: this.token,
              channel_id: this.options.channelId,
              ...(this.screenSfuAdvertised ? { screen_sfu: true } : {}),
            });
        };
        socket.onmessage = (event) => {
          if (!this.live(run)) return;
          const raw = typeof event.data === "string" ? event.data : "";
          if (
            !raw ||
            raw.length > 65_536 ||
            budget.frames >= 128 ||
            budget.bytes + raw.length > 1_048_576
          ) {
            this.fail("A sinalização excedeu o limite seguro da chamada.");
            return;
          }
          budget.frames++;
          budget.bytes += raw.length;
          // Authority changes must interrupt media operations immediately. Peer queues
          // serialize SDP/ICE independently; one slow peer cannot delay revocation.
          let pending: Promise<void>;
          try {
            pending = this.receive(JSON.parse(raw));
          } catch {
            pending = Promise.reject(new Error("Invalid frame"));
          }
          void pending
            .catch(() => {
              if (this.live(run))
                this.fail("Não foi possível negociar a chamada com segurança.");
            })
            .finally(() => {
              budget.frames--;
              budget.bytes -= raw.length;
            });
        };
        socket.onerror = () => {
          if (this.live(run))
            this.fail("Não foi possível manter a conexão com o servidor.");
        };
        socket.onclose = () => {
          if (this.live(run))
            this.fail(
              "A conexão com o servidor terminou. Reconecte para continuar.",
            );
        };
      } catch {
        this.fail("Este navegador não conseguiu abrir a chamada.");
      }
    };
    if (this.environment.getCallConfig) {
      const controller = new AbortController();
      this.capabilityAbort = controller;
      let settled = false;
      const finishDiscovery = (enabled: boolean) => {
        if (settled) return;
        settled = true;
        if (this.capabilityAbort === controller) this.clearCapability();
        if (!this.live(run)) return;
        this.screenSfuAdvertised =
          enabled &&
          !!this.environment.getScreenToken &&
          !!this.environment.relayFactory;
        open();
      };
      this.capabilityTimer = setTimeout(() => finishDiscovery(false), 1500);
      try {
        void this.environment
          .getCallConfig(this.options.channelId, controller.signal)
          .then((config) =>
            finishDiscovery(config?.screen_sfu_enabled === true),
          )
          .catch(() => finishDiscovery(false));
      } catch {
        finishDiscovery(false);
      }
    } else open();
    return flight;
  }
  async reconnect(): Promise<void> {
    const old = this.socket;
    const closed =
      old && old.readyState !== 3
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000);
            old.addEventListener(
              "close",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          })
        : Promise.resolve();
    const session = this.environment.getSession();
    const server = this.environment.getServer();
    this.close("Reconectando à chamada.");
    const run = this.generation;
    await closed;
    const next = this.environment.getSession();
    if (
      run !== this.generation ||
      !session ||
      !next ||
      next.user.id !== session.user.id ||
      claims(next.access_token).sid !== claims(session.access_token).sid ||
      this.environment.getServer() !== server
    )
      throw new Error(
        "A reconexão foi cancelada porque a chamada ou a sessão mudou.",
      );
    return this.connect();
  }
  private sessionChanged(session: Session | null) {
    if (!this.live()) return;
    if (
      !session ||
      this.environment.getServer() !== this.origin ||
      session.user.id !== this.userId ||
      (this.sessionId && claims(session.access_token).sid !== this.sessionId)
    ) {
      this.close("A conta ou a sessão mudou. A chamada foi encerrada.");
      return;
    }
    if (session.access_token === this.token) return;
    this.token = session.access_token;
    if (this.data.state === "connected")
      this.send({ type: "reauth", token: this.token });
    this.scheduleRefresh();
  }
  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    const run = this.generation;
    const expiry = claims(this.token).exp;
    const delay = expiry
      ? Math.max(1000, Math.min(480_000, expiry * 1000 - Date.now() - 60_000))
      : 480_000;
    this.refreshTimer = setTimeout(() => {
      if (this.live(run))
        void this.environment
          .refreshSession()
          .then((session) => {
            if (this.live(run)) {
              this.sessionChanged(session);
              this.scheduleRefresh();
            }
          })
          .catch(() => {
            if (this.live(run))
              this.fail(
                "Não foi possível renovar a sessão da chamada. Entre novamente.",
              );
          });
    }, delay);
  }
  private send(value: unknown) {
    const socket = this.socket;
    if (!this.live() || !socket || socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1_048_576) {
      this.fail("A conexão de sinalização está congestionada.");
      return;
    }
    try {
      socket.send(JSON.stringify(value));
    } catch {
      this.fail("A conexão com o servidor terminou.");
    }
  }
  private signal(peer: Peer, data: unknown) {
    if (this.current(peer))
      this.send({ type: "signal", to: peer.member.peer_id, data });
  }
  private async receive(value: unknown) {
    if (!record(value) || typeof value.type !== "string")
      throw new Error("Invalid frame");
    if (value.type === "closed") {
      this.fail(
        typeof value.reason === "string"
          ? value.reason.slice(0, 300)
          : "A chamada foi encerrada.",
      );
      return;
    }
    if (value.type === "pong") {
      this.lastPong = Date.now();
      return;
    }
    if (value.type === "authenticated") return;
    if (value.type === "ready") {
      if (
        this.data.state !== "connecting" ||
        !id(value.peer_id) ||
        value.channel_id !== this.options.channelId ||
        !Number.isInteger(value.max_participants) ||
        Number(value.max_participants) < 2 ||
        Number(value.max_participants) > 12 ||
        !Number.isFinite(value.max_video_bitrate) ||
        Number(value.max_video_bitrate) < 500_000 ||
        Number(value.max_video_bitrate) > 32_000_000 ||
        (value.screen_sfu_enabled !== undefined &&
          typeof value.screen_sfu_enabled !== "boolean")
      )
        throw new Error("Invalid ready");
      this.iceServers = iceConfiguration(value.ice_servers);
      this.data = {
        ...this.data,
        maxParticipants: Number(value.max_participants),
        maxVideoBitrate: Number(value.max_video_bitrate),
      };
      const roster = members(value.participants, this.data.maxParticipants);
      const self = roster.find((peer) => peer.peer_id === value.peer_id);
      if (!self || self.user_id !== this.userId)
        throw new Error("Identity mismatch");
      this.screenSfuEnabled =
        this.screenSfuAdvertised &&
        value.screen_sfu_enabled === true &&
        self.screen_sfu === true;
      this.data = { ...this.data, self, state: "connected" };
      this.applyRoster(roster);
      clearTimeout(this.connectTimer);
      this.lastPong = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 25_000)
          this.fail("O servidor parou de responder. A chamada foi encerrada.");
        else this.send({ type: "ping" });
      }, 10_000);
      this.sampleTimer = setInterval(() => {
        void this.sample();
      }, 1500);
      this.scheduleRefresh();
      this.connected?.();
      this.connected = undefined;
      this.rejected = undefined;
      this.startRelay(this.generation);
      return;
    }
    if (this.data.state !== "connected") throw new Error("Frame before ready");
    if (value.type === "roster") {
      this.applyRoster(members(value.participants, this.data.maxParticipants));
      return;
    }
    if (value.type === "signal") {
      const peer =
        typeof value.from === "string" ? this.peers.get(value.from) : undefined;
      // A final in-flight signal after an authoritative removal cannot recreate a peer.
      if (!peer || !this.current(peer)) return;
      try {
        if (!record(value.data)) throw new Error("Invalid signal");
        const data = value.data;
        if (record(data.receive)) {
          if (!heightAllowed(data.receive.screen_height))
            throw new Error("Invalid ceiling");
          peer.remoteReceiveHeight = data.receive.screen_height;
          const ack = relayRef(data.receive.screen_sfu);
          peer.remoteRelayRef =
            this.screenSfuEnabled && peer.member.screen_sfu === true
              ? ack
              : undefined;
          await this.enqueue(peer, async () =>
            this.screenSfuEnabled
              ? this.synchronizeRelayRoutes(peer)
              : this.parameters(peer, "screen"),
          ).catch(() => {
            peer.error =
              "O navegador não aplicou o teto de resolução solicitado.";
            this.emit();
          });
        } else if ("description" in data) {
          const next = description(data.description);
          await this.enqueue(peer, () => this.description(peer, next));
        } else if ("candidate" in data) {
          const candidate = iceCandidate(data.candidate);
          await this.enqueue(peer, async () => {
            if (
              candidate?.usernameFragment &&
              peer.ignoredUfrags.has(candidate.usernameFragment)
            )
              return;
            if (!peer.pc.remoteDescription) {
              if (peer.pendingIce.length >= 64)
                throw new Error("ICE queue full");
              peer.pendingIce.push(candidate);
            } else {
              try {
                await peer.pc.addIceCandidate(candidate ?? undefined);
              } catch (error) {
                if (!peer.ignoreOffer) throw error;
              }
            }
          });
        } else throw new Error("Unsupported signal");
      } catch {
        this.failPeer(
          peer,
          "Não foi possível negociar a mídia deste participante. Reconecte para tentar novamente.",
        );
      }
    }
  }
  private applyRoster(roster: CallParticipant[]) {
    const self = roster.find(
      (member) => member.peer_id === this.data.self?.peer_id,
    );
    if (!self || self.user_id !== this.userId) {
      this.close("Você saiu da chamada ou perdeu a permissão de conexão.");
      return;
    }
    if (this.data.self?.can_publish && !self.can_publish) {
      ++this.publicationEpoch;
      this.stopLocal();
      for (const peer of this.peers.values()) {
        for (const transceiver of peer.pc.getTransceivers())
          void this.replaceSenderTrack(transceiver.sender, null).catch(
            () => {},
          );
      }
    }
    this.data = { ...this.data, self };
    for (const [key, peer] of this.peers)
      if (!roster.some((member) => member.peer_id === key)) {
        this.disposePeer(peer);
        this.peers.delete(key);
      }
    for (const member of roster) {
      if (member.peer_id === self.peer_id) continue;
      let peer = this.peers.get(member.peer_id);
      if (peer && peer.member.user_id !== member.user_id)
        throw new Error("Peer identity changed");
      if (!peer) {
        peer = this.createPeer(member);
        this.peers.set(member.peer_id, peer);
        if (self.peer_id < member.peer_id) {
          const next = peer;
          next.starting = true;
          void this.enqueue(next, async () => {
            for (const source of callSources) {
              const index = callSources.indexOf(source);
              const track = this.local[source];
              // Screen codec selection requires negotiated codecs, before its
              // first frame, including when a participant joins an active share.
              next.pc.addTransceiver(
                source === "screen" ? kinds[index] : track || kinds[index],
                {
                  direction: "sendrecv",
                  sendEncodings: [this.encoding(source, next)],
                },
              );
            }
            next.initialized = true;
            await this.negotiate(next);
            next.starting = false;
          }).catch(() =>
            this.failPeer(next, "Não foi possível iniciar a conexão direta."),
          );
        }
      } else {
        peer.member = member;
        if (member.screen_sfu !== true) {
          peer.remoteRelayRef = undefined;
          peer.receivedRelayRef = undefined;
          this.clearRelayTracks(peer);
        }
      }
    }
    if (this.relay) {
      if (self.screen_sfu !== true) this.stopRelay();
      else this.relay.updateAuthority(this.relayAuthority());
    }
    if (this.screenSfuEnabled) this.scheduleRelayRoutes();
    this.emit();
  }
  private createPeer(member: CallParticipant): Peer {
    const pc = this.environment.peer({
      iceServers: this.iceServers,
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    const peer: Peer = {
      member,
      pc,
      tracks: {},
      relayTracks: {},
      stats: emptyStats(),
      relayStats: {},
      screenStatsEpoch: 0,
      observations: new Map(),
      queue: Promise.resolve(),
      makingOffer: false,
      ignoreOffer: false,
      remoteAnswerPending: false,
      initialized: false,
      starting: false,
      pendingIce: [],
      ignoredUfrags: new Set(),
      restartAttempts: 0,
      error: "",
      failed: false,
      receiveHeight: 0,
      remoteReceiveHeight: 0,
      screenCodec: { mode: "fresh", api: "unknown" },
    };
    pc.onicecandidate = ({ candidate }) =>
      this.signal(peer, { candidate: candidate?.toJSON() ?? null });
    pc.onnegotiationneeded = () => {
      if (peer.initialized && !peer.starting)
        void this.enqueue(peer, () => this.negotiate(peer)).catch(() =>
          this.failPeer(peer, "Não foi possível renegociar a conexão direta."),
        );
    };
    pc.ontrack = ({ track, transceiver }) => {
      if (!this.current(peer)) {
        track.stop();
        return;
      }
      const index = pc.getTransceivers().indexOf(transceiver);
      const source = callSources[index];
      if (!source || track.kind !== kinds[index]) {
        track.stop();
        this.failPeer(
          peer,
          "O participante enviou uma fonte de mídia inválida.",
        );
        return;
      }
      peer.tracks[source] = track;
      track.onmute = () => this.emit();
      track.onunmute = () => this.emit();
      track.onended = () => this.emit();
      this.emit();
    };
    pc.ondatachannel = ({ channel }) => channel.close();
    pc.onconnectionstatechange = () => {
      if (!this.current(peer)) return;
      if (pc.connectionState === "connected") {
        clearTimeout(peer.recoveryTimer);
        clearTimeout(peer.deadlineTimer);
        peer.recoveryTimer = undefined;
        peer.deadlineTimer = undefined;
        peer.error = "";
      } else if (["disconnected", "failed"].includes(pc.connectionState)) {
        if (!peer.recoveryTimer)
          peer.recoveryTimer = setTimeout(
            () => {
              peer.recoveryTimer = undefined;
              this.restart(peer);
            },
            pc.connectionState === "failed" ? 100 : 4000,
          );
      }
      this.emit();
    };
    peer.deadlineTimer = setTimeout(() => this.restart(peer), 18_000);
    return peer;
  }
  private restart(peer: Peer) {
    if (!this.current(peer) || peer.pc.connectionState === "connected") return;
    clearTimeout(peer.deadlineTimer);
    if (++peer.restartAttempts > 2) {
      this.failPeer(
        peer,
        "A rede não permitiu uma conexão direta. Tente outra rede ou reconecte à chamada.",
      );
      return;
    }
    peer.error = "Tentando restabelecer a conexão direta…";
    if (peer.initialized) peer.pc.restartIce();
    peer.deadlineTimer = setTimeout(() => this.restart(peer), 18_000);
    this.emit();
  }
  private enqueue(peer: Peer, operation: () => Promise<void>): Promise<void> {
    const result = peer.queue
      .catch(() => {})
      .then(async () => {
        if (this.current(peer)) await operation();
      });
    peer.queue = result;
    return result;
  }
  private async negotiate(peer: Peer) {
    if (!this.current(peer) || peer.pc.signalingState !== "stable") return;
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      if (!this.current(peer)) return;
      this.signal(peer, { description: peer.pc.localDescription?.toJSON() });
      for (const source of callSources) await this.parameters(peer, source);
    } finally {
      peer.makingOffer = false;
    }
  }
  private async description(peer: Peer, incoming: RTCSessionDescriptionInit) {
    const pc = peer.pc;
    const readyForOffer =
      !peer.makingOffer &&
      (pc.signalingState === "stable" || peer.remoteAnswerPending);
    const collision = incoming.type === "offer" && !readyForOffer;
    const polite = this.data.self!.peer_id > peer.member.peer_id;
    peer.ignoreOffer = !polite && collision;
    if (peer.ignoreOffer) {
      for (const line of incoming.sdp!.split(/\r?\n/))
        if (line.startsWith("a=ice-ufrag:"))
          peer.ignoredUfrags.add(line.slice(12));
      if (peer.ignoredUfrags.size > 8)
        peer.ignoredUfrags.delete(peer.ignoredUfrags.values().next().value!);
      return;
    }
    peer.remoteAnswerPending = incoming.type === "answer";
    try {
      await pc.setRemoteDescription(incoming);
    } finally {
      peer.remoteAnswerPending = false;
    }
    if (!this.current(peer)) return;
    const transceivers = pc.getTransceivers();
    if (
      transceivers.length !== 4 ||
      transceivers.some(
        (t, i) =>
          t.receiver.track.kind !== kinds[i] ||
          (t.mid !== null && t.mid !== String(i)),
      )
    )
      throw new Error("Invalid media slots");
    peer.initialized = true;
    for (let i = 0; i < transceivers.length; i++) {
      const source = callSources[i];
      transceivers[i].direction = "sendrecv";
      if (source === "screen") continue;
      await this.replaceSenderTrack(
        transceivers[i].sender,
        this.mayPublish() &&
          !(source === "screen_audio" && this.usesRelay(peer))
          ? (this.local[source] ?? null)
          : null,
      );
    }
    for (const candidate of peer.pendingIce.splice(0)) {
      if (
        candidate?.usernameFragment &&
        peer.ignoredUfrags.has(candidate.usernameFragment)
      )
        continue;
      await pc.addIceCandidate(candidate ?? undefined);
    }
    if (incoming.type === "offer") {
      await pc.setLocalDescription();
      if (!this.current(peer)) return;
      this.signal(peer, { description: pc.localDescription?.toJSON() });
    }
    await this.synchronizeScreen(peer);
    for (const source of callSources) await this.parameters(peer, source);
  }
  private deferScreen(peer: Peer, track: MediaStreamTrack): boolean {
    const transition = this.screenTransition;
    if (transition?.track !== track || transition.run !== this.generation)
      return false;
    transition.deferred.add(peer);
    return true;
  }
  /** Runs on the peer queue; it must never wait for the media queue. */
  private async synchronizeScreen(peer: Peer) {
    const sender = peer.pc.getTransceivers()[2]?.sender;
    if (!sender || !this.current(peer)) return;
    const screen = this.mayPublish() ? this.local.screen : undefined;
    if (screen && this.deferScreen(peer, screen)) return;
    const prepared =
      !screen ||
      (await this.prepareScreenCodec(peer, screen, this.data.profile));
    await this.parameters(peer, "screen");
    if (!prepared || (screen && this.deferScreen(peer, screen))) return;
    await this.replaceSenderTrack(
      sender,
      screen &&
        this.mayPublish() &&
        this.current(peer) &&
        !this.usesRelay(peer) &&
        this.local.screen === screen
        ? screen
        : null,
    );
    if (
      screen &&
      (!this.mayPublish() ||
        !this.current(peer) ||
        this.usesRelay(peer) ||
        this.local.screen !== screen)
    )
      await this.replaceSenderTrack(sender, null);
  }
  private encoding(
    source: CallSource,
    peer: Peer,
    profile = this.data.profile,
  ): RTCRtpEncodingParameters {
    if (source === "screen") {
      const actualHeight =
        (this.local.screen && getCaptureSettings(this.local.screen).height) ||
        profile.height ||
        1080;
      return {
        maxBitrate: Math.min(
          this.data.maxVideoBitrate,
          profile.bitrate ? profile.bitrate * 1_000_000 : 8_000_000,
        ),
        maxFramerate: profile.fps || 30,
        scaleResolutionDownBy: peer.remoteReceiveHeight
          ? Math.max(1, actualHeight / peer.remoteReceiveHeight)
          : 1,
      };
    }
    if (source === "camera")
      return {
        maxBitrate: Math.min(this.data.maxVideoBitrate, 2_000_000),
        maxFramerate: 30,
      };
    return { maxBitrate: source === "microphone" ? 64_000 : 128_000 };
  }
  private screenH264(
    track: MediaStreamTrack,
    profile: StreamProfile,
    desired: RTCRtpEncodingParameters,
    codecs: RTCRtpCodecParameters[],
    projected: boolean,
  ): RTCRtpCodecParameters | undefined {
    const settings = getCaptureSettings(track);
    const width = finite(settings.width),
      height = finite(settings.height);
    if (
      this.screenGeometry.get(track) !== true ||
      !width ||
      !height ||
      width <= 0 ||
      height <= 0 ||
      profile.height <= 0 ||
      profile.height > 720 ||
      !desired.maxFramerate ||
      desired.maxFramerate > 30 ||
      !desired.maxBitrate ||
      desired.maxBitrate > 14_000_000
    )
      return;
    // Use the imposed width envelope, not just the current (possibly smaller)
    // window. A later resize must still fit Constrained Baseline level 3.1.
    const boundWidth = Math.round((profile.height * width) / height);
    if (
      boundWidth < 1 ||
      boundWidth > 1280 ||
      (!projected && (width > boundWidth || height > profile.height))
    )
      return;
    const blocks = Math.ceil(boundWidth / 16) * Math.ceil(profile.height / 16);
    if (blocks > 3600 || blocks * desired.maxFramerate > 108_000) return;
    return codecs.find((codec) => {
      if (
        codec.mimeType.toLowerCase() !== "video/h264" ||
        codec.clockRate !== 90_000
      )
        return false;
      const fmtp = codecFormat(codec);
      if (
        fmtp.get("profile-level-id") !== "42e01f" ||
        fmtp.get("packetization-mode") !== "1" ||
        fmtp.size !==
          (codec.sdpFmtpLine || "").split(";").filter((part) => part.trim())
            .length
      )
        return false;
      const admits = (key: string, value: number) => {
        const limit = fmtp.get(key);
        return (
          limit === undefined ||
          (/^[1-9]\d*$/.test(limit) &&
            Number.isSafeInteger(Number(limit)) &&
            Number(limit) >= value)
        );
      };
      return (
        admits("max-fs", blocks) &&
        admits("max-mbps", blocks * desired.maxFramerate!) &&
        admits("max-br", desired.maxBitrate! / 1000)
      );
    });
  }
  private async prepareScreenCodec(
    peer: Peer,
    track: MediaStreamTrack,
    profile: StreamProfile,
    projected = false,
  ): Promise<boolean> {
    const run = this.generation,
      epoch = this.publicationEpoch;
    const allowed = () =>
      this.current(peer) &&
      this.mayPublish(run, epoch) &&
      this.local.screen === track &&
      track.readyState === "live";
    if (!allowed()) return false;
    // Do not start a screen in the native codec while its initial answer is pending.
    if (peer.pc.signalingState !== "stable" || !peer.pc.remoteDescription)
      return false;
    const sender = peer.pc.getTransceivers()[2]?.sender;
    if (!sender) return false;
    const finish = async () => {
      if (!allowed()) return false;
      const result = await tryScreenVp8L1T1(sender, allowed);
      return result !== "stale" && allowed();
    };
    const state = peer.screenCodec;
    if (state.api === "unsupported") {
      state.mode = "vp8";
      return finish();
    }
    const parameters = sender.getParameters() as CodecParameters;
    const vp8 = parameters.codecs.find(
      (codec) =>
        codec.mimeType.toLowerCase() === "video/vp8" &&
        codec.clockRate === 90_000,
    );
    const h264 =
      state.mode !== "vp8" && vp8
        ? this.screenH264(
            track,
            profile,
            this.encoding("screen", peer, profile),
            parameters.codecs,
            projected,
          )
        : undefined;
    // If SDP reset an active H264 sender, do not attempt a hot switch back from
    // an unknown native codec. VP8 remains latched for this sender's lifetime.
    const resetWhileSending =
      state.mode === "h264" &&
      !!sender.track &&
      h264 &&
      parameters.encodings.some((encoding) => !sameCodec(encoding.codec, h264));
    const selected = h264 && !resetWhileSending ? h264 : vp8;
    if (!selected || !parameters.encodings.length) {
      if (state.mode === "h264")
        throw new Error(
          "Não foi possível preservar a qualidade da tela com VP8.",
        );
      state.mode = "vp8";
      return finish();
    }
    const codec = codecValue(selected);
    const mode = selected === h264 && !resetWhileSending ? "h264" : "vp8";
    if (
      parameters.encodings.every((encoding) => sameCodec(encoding.codec, codec))
    ) {
      state.mode = mode;
      state.api = "supported";
      return finish();
    }
    const leavingH264 = state.mode === "h264" && mode === "vp8";
    for (const encoding of parameters.encodings) encoding.codec = codec;
    try {
      // Codec-only preflight: all current bitrate/FPS/scale caps stay unchanged.
      // Never modify the negotiated, read-only parameters.codecs array.
      await sender.setParameters(parameters);
    } catch (error) {
      if (!allowed()) return false;
      if (leavingH264) throw error;
      state.api = "unsupported";
      state.mode = "vp8";
      return finish(); // Optional codec selection failed; normal cap errors still propagate.
    }
    if (!allowed()) return false;
    const applied = sender.getParameters() as CodecParameters;
    if (
      applied.encodings.length &&
      applied.encodings.every((encoding) => sameCodec(encoding.codec, codec))
    ) {
      state.api = "supported";
      state.mode = mode;
    } else {
      if (leavingH264)
        throw new Error("O navegador não confirmou a troca da tela para VP8.");
      state.api = "unsupported";
      state.mode = "vp8";
    }
    return finish();
  }
  private async parameters(peer: Peer, source: CallSource) {
    if (!this.current(peer)) return;
    const sender =
      peer.pc.getTransceivers()[callSources.indexOf(source)]?.sender;
    if (!sender) return;
    const parameters = sender.getParameters();
    // Answers may not have assigned an encoding yet. Apply again after negotiation.
    if (!parameters.encodings.length) return;
    const desired = this.encoding(source, peer);
    let changed = false;
    for (const encoding of parameters.encodings) {
      if (
        Object.entries(desired).some(
          ([key, value]) =>
            encoding[key as keyof RTCRtpEncodingParameters] !== value,
        )
      ) {
        Object.assign(encoding, desired);
        changed = true;
      }
    }
    if (source === "screen") {
      const preference = screenDegradationPreference(this.data.profile);
      if (parameters.degradationPreference !== preference) {
        parameters.degradationPreference = preference;
        changed = true;
      }
    }
    // Read the browser's current parameters instead of caching: negotiation may
    // reset them, while applying an identical cap needlessly enters native code.
    if (changed) await sender.setParameters(parameters);
  }
  private async replaceSenderTrack(
    sender: RTCRtpSender,
    track: MediaStreamTrack | null,
  ) {
    if (sender.track !== track) await sender.replaceTrack(track);
  }
  private async constrain(track: MediaStreamTrack, profile: StreamProfile) {
    const settings = getCaptureSettings(track);
    const geometryKnown =
      this.screenGeometry.get(track) !== false &&
      typeof settings.width === "number" &&
      Number.isFinite(settings.width) &&
      settings.width > 0 &&
      typeof settings.height === "number" &&
      Number.isFinite(settings.height) &&
      settings.height > 0;
    const ratio =
      settings.width && settings.height
        ? settings.width / settings.height
        : 16 / 9;
    await applyCaptureConstraints(track, {
      height: profile.height ? { max: profile.height } : undefined,
      width: profile.height
        ? { max: Math.round(profile.height * ratio) }
        : undefined,
      frameRate: { max: profile.fps || 30 },
    });
    this.screenGeometry.set(track, geometryKnown);
    track.contentHint = profile.content === "text" ? "detail" : "motion";
  }
  private publishMedia() {
    const media = emptyMedia();
    for (const source of callSources)
      media[source] =
        this.mayPublish() &&
        !!this.local[source]?.enabled &&
        this.local[source]?.readyState === "live";
    if (!media.screen) media.screen_audio = false;
    this.send({ type: "media", ...media });
    this.emit();
  }
  /** Transfers ownership: rejected or superseded tracks are stopped too. */
  setTrack(source: CallSource, track: MediaStreamTrack | null): Promise<void> {
    if (track) this.pendingTracks.add(track);
    const run = this.generation,
      epoch = this.publicationEpoch;
    const operation = this.mediaQueue
      .catch(() => {})
      .then(async () => {
        if (
          track &&
          (!this.mayPublish(run, epoch) ||
            track.kind !== kinds[callSources.indexOf(source)] ||
            track.readyState !== "live")
        ) {
          releaseCaptureTrack(track);
          throw new Error(
            "A publicação de mídia não está autorizada nesta chamada.",
          );
        }
        if (!this.live(run)) {
          releaseCaptureTrack(track);
          return;
        }
        if (source === "screen_audio" && track && !this.local.screen) {
          releaseCaptureTrack(track);
          throw new Error("Compartilhe uma tela antes de publicar seu áudio.");
        }
        if (
          (source === "screen" || source === "screen_audio") &&
          this.local[source] !== track
        )
          await this.syncRelay(true);
        if (source === "screen" && this.local.screen !== track)
          await this.replaceSource("screen_audio", null, run, epoch);
        if (source === "screen" && track) {
          try {
            await this.constrain(track, this.data.profile);
          } catch (error) {
            releaseCaptureTrack(track);
            await this.syncRelay();
            throw error;
          }
        }
        await this.replaceSource(source, track, run, epoch);
        if (source === "screen" || source === "screen_audio")
          await this.syncRelay();
      });
    const owned = operation.finally(() => {
      if (track) this.pendingTracks.delete(track);
    });
    this.mediaQueue = owned;
    return owned;
  }
  private async replaceSource(
    source: CallSource,
    track: MediaStreamTrack | null,
    run: number,
    epoch: number,
  ) {
    if (track && !this.mayPublish(run, epoch)) {
      releaseCaptureTrack(track);
      throw new Error("Sua permissão de transmissão foi removida.");
    }
    if (!this.live(run)) {
      releaseCaptureTrack(track);
      return;
    }
    const old = this.local[source];
    if (old !== track && old) {
      old.removeEventListener("ended", this.ended.get(old)!);
      this.ended.delete(old);
      releaseCaptureTrack(old);
    }
    delete this.local[source];
    if (track) {
      this.local[source] = track;
      if (!this.ended.has(track)) {
        const ended = () => {
          if (this.local[source] === track)
            void this.setTrack(source, null).catch(() => {});
        };
        this.ended.set(track, ended);
        track.addEventListener("ended", ended, { once: true });
      }
    }
    try {
      await Promise.all(
        [...this.peers.values()].map((peer) =>
          this.enqueue(peer, async () => {
            const sender =
              peer.pc.getTransceivers()[callSources.indexOf(source)]?.sender;
            if (!sender) return;
            if (source === "screen" && track) {
              const prepared = await this.prepareScreenCodec(
                peer,
                track,
                this.data.profile,
              );
              await this.parameters(peer, source);
              if (
                !prepared ||
                !this.current(peer) ||
                !this.mayPublish(run, epoch)
              )
                return;
            }
            await this.replaceSenderTrack(
              sender,
              track &&
                this.mayPublish(run, epoch) &&
                !(
                  (source === "screen" || source === "screen_audio") &&
                  this.usesRelay(peer)
                )
                ? track
                : null,
            );
            if (track && !this.mayPublish(run, epoch)) {
              await this.replaceSenderTrack(sender, null);
              return;
            }
            await this.parameters(peer, source);
          }),
        ),
      );
      if (track && !this.mayPublish(run, epoch))
        throw new Error("Sua permissão de transmissão foi removida.");
    } catch (error) {
      if (this.local[source] === track) delete this.local[source];
      releaseCaptureTrack(track);
      if (this.live(run)) {
        for (const peer of this.peers.values()) {
          const sender =
            peer.pc.getTransceivers()[callSources.indexOf(source)]?.sender;
          if (sender)
            void this.replaceSenderTrack(sender, null).catch(() => {});
        }
        this.publishMedia();
      }
      throw error;
    }
    if (this.live(run)) this.publishMedia();
  }
  setTrackEnabled(source: CallSource, enabled: boolean): void {
    const track = this.local[source];
    if (!track || track.readyState !== "live") return;
    if (enabled && !this.mayPublish())
      throw new Error("Sua permissão de transmissão foi removida.");
    track.enabled = enabled;
    if (source === "screen" && !enabled && this.local.screen_audio)
      this.local.screen_audio.enabled = false;
    this.publishMedia();
    if (source === "screen" || source === "screen_audio")
      void this.syncRelay(true).then(() => this.syncRelay());
  }
  setScreenProfile(profile: StreamProfile): Promise<void> {
    const candidate = {
      ...validateProfile(profile, this.data.maxVideoBitrate),
    };
    const run = this.generation,
      epoch = this.publicationEpoch;
    const operation = this.mediaQueue
      .catch(() => {})
      .then(async () => {
        if (!this.mayPublish(run, epoch))
          throw new Error("A transmissão não está autorizada.");
        const track = this.local.screen;
        const transition = track
          ? { run, track, deferred: new Set<Peer>() }
          : undefined;
        if (transition) this.screenTransition = transition;
        try {
          if (track) {
            await this.syncRelay(true);
            // A codec transition must finish before the capture can exceed H264's
            // envelope. This preflight changes no bitrate, FPS or scaling caps;
            // failure therefore leaves the previous capture/profile usable.
            await Promise.all(
              [...this.peers.values()].map((peer) =>
                this.enqueue(peer, async () => {
                  const prepared = await this.prepareScreenCodec(
                    peer,
                    track,
                    candidate,
                    true,
                  );
                  if (
                    !prepared &&
                    this.current(peer) &&
                    peer.screenCodec.mode === "h264" &&
                    peer.pc.getTransceivers()[2]?.sender.track === track
                  )
                    throw new Error(
                      "Aguarde a negociação da chamada antes de mudar a qualidade da tela.",
                    );
                }),
              ),
            );
            if (!this.mayPublish(run, epoch))
              throw new Error("Sua permissão de transmissão foi removida.");
            await this.constrain(track, candidate);
          }
          if (!this.mayPublish(run, epoch))
            throw new Error("Sua permissão de transmissão foi removida.");
          this.data = { ...this.data, profile: candidate };
        } catch (error) {
          if (transition && this.screenTransition === transition) {
            this.screenTransition = undefined;
            if (this.mayPublish(run, epoch) && this.local.screen === track) {
              // A failed capture change keeps its previous profile. Only peers
              // deferred by this operation need to be attached during recovery.
              await Promise.all(
                [...transition.deferred].map((peer) =>
                  this.enqueue(peer, () => this.synchronizeScreen(peer)).catch(
                    () => {
                      this.failPeer(
                        peer,
                        "Não foi possível retomar a tela deste participante.",
                      );
                    },
                  ),
                ),
              );
            }
          }
          throw error;
        } finally {
          // A previous call can finish after reconnect created a new transition.
          if (transition && this.screenTransition === transition)
            this.screenTransition = undefined;
        }
        try {
          await Promise.all(
            [...this.peers.values()].map((peer) =>
              this.enqueue(peer, () => this.synchronizeScreen(peer)),
            ),
          );
        } catch (error) {
          // Never keep sending with a previous, potentially larger cap after failure.
          await this.replaceSource("screen", null, run, epoch);
          await this.replaceSource("screen_audio", null, run, epoch);
          throw error;
        }
        this.emit();
        await this.syncRelay();
      });
    this.mediaQueue = operation;
    return operation;
  }
  setReceiveHeight(peerId: string, height: number): void {
    if (!heightAllowed(height)) throw new Error("Teto de resolução inválido.");
    const peer = this.peers.get(peerId);
    if (!peer || !this.current(peer)) return;
    peer.receiveHeight = height;
    this.relay?.setReceiveHeight(peerId, height);
    this.sendReceivePreference(peer);
    this.emit();
  }
  private async sample() {
    if (this.samplingRun === this.generation || this.data.state !== "connected")
      return;
    const run = this.generation;
    this.samplingRun = run;
    const sampled = [...this.peers.values()];
    try {
      await Promise.all(
        sampled
          .map(async (peer) => {
            if (!this.current(peer)) return;
            this.screenSenderChanged(peer);
            const screenStatsEpoch = peer.screenStatsEpoch;
            const report = await peer.pc.getStats();
            if (!this.live(run) || !this.current(peer)) return;
            const rows = new Map<string, StatsRow>();
            report.forEach((row) => rows.set(row.id, row as StatsRow));
            const values = [...rows.values()];
            const transport = values.find(
              (row) =>
                row.type === "transport" &&
                typeof row.selectedCandidatePairId === "string",
            );
            const pair = transport
              ? rows.get(String(transport.selectedCandidatePairId))
              : values.find(
                  (row) =>
                    row.type === "candidate-pair" &&
                    row.nominated === true &&
                    row.state === "succeeded",
                );
            const local = pair
              ? rows.get(String(pair.localCandidateId))
              : undefined;
            const remote = pair
              ? rows.get(String(pair.remoteCandidateId))
              : undefined;
            const rtt = finite(pair?.currentRoundTripTime);
            const stats = emptyStats();
            const observations = new Map<string, Observation>();
            stats.iceRttMs = rtt === null ? null : rtt * 1000;
            stats.route = classifyRoute(
              typeof local?.candidateType === "string"
                ? local.candidateType
                : null,
              typeof remote?.candidateType === "string"
                ? remote.candidateType
                : null,
            );
            for (const row of values) {
              if (
                !["inbound-rtp", "outbound-rtp"].includes(row.type) ||
                row.isRemote
              )
                continue;
              const codec = rows.get(String(row.codecId));
              if (
                typeof codec?.mimeType === "string" &&
                /\/(rtx|red|ulpfec)$/i.test(codec.mimeType)
              )
                continue;
              let source =
                typeof row.mid === "string"
                  ? callSources[Number(row.mid)]
                  : undefined;
              const outbound = row.type === "outbound-rtp";
              if (!source) {
                const mediaSource = rows.get(String(row.mediaSourceId));
                const trackId =
                  row.trackIdentifier || mediaSource?.trackIdentifier;
                source = callSources.find(
                  (key) =>
                    (outbound ? this.local[key] : peer.tracks[key])?.id ===
                    trackId,
                );
              }
              if (!source) continue;
              if (
                outbound &&
                source === "screen" &&
                (peer.screenStatsEpoch !== screenStatsEpoch ||
                  !peer.pc.getTransceivers()[2]?.sender.track)
              )
                continue;
              const bytes = finite(
                outbound ? row.bytesSent : row.bytesReceived,
              );
              const time = finite(row.timestamp),
                frames = finite(outbound ? row.framesSent : row.framesDecoded);
              const previous = peer.observations.get(row.id);
              const duration =
                time !== null && previous ? time - previous.timestamp : 0;
              const bitrate =
                bytes !== null &&
                previous &&
                duration > 0 &&
                bytes >= previous.bytes
                  ? ((bytes - previous.bytes) * 8000) / duration
                  : null;
              const reportedFps = finite(row.framesPerSecond);
              const fps =
                reportedFps ??
                (frames !== null &&
                previous?.frames !== null &&
                previous?.frames !== undefined &&
                duration > 0 &&
                frames >= previous.frames
                  ? ((frames - previous.frames) * 1000) / duration
                  : null);
              if (bytes !== null && time !== null)
                observations.set(row.id, {
                  bytes,
                  timestamp: time,
                  frames,
                  source,
                  outbound,
                });
              const jitter = finite(row.jitter);
              const level =
                finite(row.audioLevel) ??
                finite(rows.get(String(row.mediaSourceId))?.audioLevel);
              (outbound ? stats.sent : stats.received)[source] = {
                bitrate,
                width: finite(row.frameWidth),
                height: finite(row.frameHeight),
                fps,
                audioLevel: level,
                packetsLost: finite(row.packetsLost),
                jitterMs: jitter === null ? null : jitter * 1000,
              };
            }
            peer.stats = stats;
            peer.observations = observations;
          })
          .map((promise, index) =>
            promise.catch(() => {
              const peer = sampled[index];
              if (this.live(run) && this.current(peer)) {
                peer.stats = emptyStats();
                peer.observations.clear();
              }
            }),
          ),
      );
      if (this.live(run)) this.emit();
    } finally {
      if (this.samplingRun === run) this.samplingRun = null;
    }
  }
  private stopLocal() {
    this.screenTransition = undefined;
    for (const track of this.pendingTracks) {
      track.enabled = false;
      releaseCaptureTrack(track);
    }
    this.pendingTracks.clear();
    for (const track of Object.values(this.local)) {
      const ended = this.ended.get(track);
      if (ended) track.removeEventListener("ended", ended);
      track.enabled = false;
      releaseCaptureTrack(track);
    }
    this.ended.clear();
    this.local = {};
  }
  private disposePeer(peer: Peer) {
    clearTimeout(peer.recoveryTimer);
    clearTimeout(peer.deadlineTimer);
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    for (const receiver of peer.pc.getReceivers()) {
      receiver.track.onmute = null;
      receiver.track.onunmute = null;
      receiver.track.onended = null;
      receiver.track.stop();
    }
    peer.pc.close();
    peer.tracks = {};
    this.clearRelayTracks(peer);
    peer.remoteRelayRef = undefined;
    peer.receivedRelayRef = undefined;
    peer.pendingIce = [];
    peer.stats = emptyStats();
    peer.observations.clear();
  }
  private failPeer(peer: Peer, message: string) {
    if (!this.current(peer)) return;
    peer.failed = true;
    peer.error = message;
    this.disposePeer(peer);
    this.emit();
  }
  private fail(reason: string) {
    this.finish("failed", reason);
  }
  close(reason = "Você saiu da chamada.") {
    this.finish("closed", reason);
  }
  private clearCapability() {
    clearTimeout(this.capabilityTimer);
    this.capabilityTimer = undefined;
    const controller = this.capabilityAbort;
    this.capabilityAbort = undefined;
    controller?.abort();
  }
  private finish(state: "closed" | "failed", reason: string) {
    // Also invalidate an in-flight manual reconnect when the UI unmounts.
    ++this.generation;
    ++this.publicationEpoch;
    this.clearCapability();
    if (!["connecting", "connected"].includes(this.data.state)) return;
    clearTimeout(this.connectTimer);
    clearTimeout(this.refreshTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.sampleTimer);
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.screenSfuEnabled = false;
    this.screenSfuAdvertised = false;
    this.relayConnecting = undefined;
    this.stopRelay(true);
    this.relayQueue = Promise.resolve();
    this.stopLocal();
    this.mediaQueue = Promise.resolve();
    for (const peer of this.peers.values()) this.disposePeer(peer);
    this.peers.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    this.data = { ...this.data, state, reason, self: null };
    this.emit();
    this.rejected?.(new Error(reason));
    this.rejected = undefined;
    this.connected = undefined;
    this.flight = null;
    this.token = "";
  }
}
