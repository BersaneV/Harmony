import { getServer, getSession, onSession, refreshSession } from "./api";
import type { Session } from "./types";
import { defaultProfile, resolutions, validateProfile } from "./stream";
import type { StreamProfile } from "./stream";
import { classifyRoute } from "./p2p";

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
}
export interface CallStats {
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
}
/** The injected boundary is also used by tests; production uses api.ts and browsers. */
export interface CallEnvironment {
  getServer: () => string;
  getSession: () => Session | null;
  onSession: (listener: (session: Session | null) => void) => () => void;
  refreshSession: () => Promise<Session>;
  socket: (url: string) => WebSocket;
  peer: (configuration: RTCConfiguration) => RTCPeerConnection;
}
const browserEnvironment: CallEnvironment = {
  getServer,
  getSession,
  onSession,
  refreshSession,
  socket: (url) => new WebSocket(url),
  peer: (configuration) => new RTCPeerConnection(configuration),
};
type StatsRow = RTCStats & Record<string, unknown>;
type Observation = { bytes: number; timestamp: number; frames: number | null };
interface Peer {
  member: CallParticipant;
  pc: RTCPeerConnection;
  tracks: CallTracks;
  stats: CallStats;
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
  private data: CallSnapshot = {
    state: "idle",
    reason: "",
    self: null,
    participants: [],
    localTracks: {},
    maxVideoBitrate: 8_000_000,
    maxParticipants: 12,
    profile: { ...defaultProfile },
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
  private lastPong = 0;
  private mediaQueue: Promise<unknown> = Promise.resolve();
  private samplingRun: number | null = null;
  private flight: Promise<void> | null = null;
  private connected?: () => void;
  private rejected?: (error: Error) => void;

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
        const tracks: CallTracks = {};
        for (const source of callSources) {
          const track = peer.tracks[source];
          const allowed = peer.member.can_publish && peer.member.media[source];
          const enabled = allowed && !peer.failed;
          if (track && track.enabled !== enabled) track.enabled = enabled;
          if (track && allowed && !peer.failed && track.readyState === "live")
            tracks[source] = track;
        }
        return {
          ...peer.member,
          media: { ...peer.member.media },
          tracks,
          connection: peer.failed ? "failed" : peer.pc.connectionState,
          stats: peer.stats,
          error: peer.error,
          receiveHeight: peer.receiveHeight,
        };
      }),
    };
    for (const listener of this.listeners) listener(this.data);
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

  connect(): Promise<void> {
    if (this.data.state === "connected") return Promise.resolve();
    if (this.data.state === "connecting" && this.flight) return this.flight;
    const session = this.environment.getSession();
    if (!session)
      return Promise.reject(
        new Error("Entre na sua conta para iniciar a chamada."),
      );
    const run = ++this.generation;
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
        Number(value.max_video_bitrate) > 32_000_000
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
          await this.enqueue(peer, async () =>
            this.parameters(peer, "screen"),
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
              next.pc.addTransceiver(track || kinds[index], {
                direction: "sendrecv",
                sendEncodings: [this.encoding(source, next)],
              });
            }
            next.initialized = true;
            await this.negotiate(next);
            next.starting = false;
          }).catch(() =>
            this.failPeer(next, "Não foi possível iniciar a conexão direta."),
          );
        }
      } else peer.member = member;
    }
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
      stats: emptyStats(),
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
      await this.replaceSenderTrack(
        transceivers[i].sender,
        this.mayPublish() ? (this.local[source] ?? null) : null,
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
    for (const source of callSources) await this.parameters(peer, source);
  }
  private encoding(source: CallSource, peer: Peer): RTCRtpEncodingParameters {
    const profile = this.data.profile;
    if (source === "screen") {
      const actualHeight =
        this.local.screen?.getSettings().height || profile.height || 1080;
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
      const preference =
        this.data.profile.content === "text"
          ? "maintain-resolution"
          : "maintain-framerate";
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
    const settings = track.getSettings();
    const ratio =
      settings.width && settings.height
        ? settings.width / settings.height
        : 16 / 9;
    await track.applyConstraints({
      height: profile.height ? { max: profile.height } : undefined,
      width: profile.height
        ? { max: Math.round(profile.height * ratio) }
        : undefined,
      frameRate: { max: profile.fps || 30 },
    });
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
          track.stop();
          throw new Error(
            "A publicação de mídia não está autorizada nesta chamada.",
          );
        }
        if (!this.live(run)) {
          track?.stop();
          return;
        }
        if (source === "screen_audio" && track && !this.local.screen) {
          track.stop();
          throw new Error("Compartilhe uma tela antes de publicar seu áudio.");
        }
        if (source === "screen" && this.local.screen !== track)
          await this.replaceSource("screen_audio", null, run, epoch);
        if (source === "screen" && track) {
          try {
            await this.constrain(track, this.data.profile);
          } catch (error) {
            track.stop();
            throw error;
          }
        }
        await this.replaceSource(source, track, run, epoch);
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
      track.stop();
      throw new Error("Sua permissão de transmissão foi removida.");
    }
    if (!this.live(run)) {
      track?.stop();
      return;
    }
    const old = this.local[source];
    if (old !== track && old) {
      old.removeEventListener("ended", this.ended.get(old)!);
      this.ended.delete(old);
      old.stop();
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
            await this.replaceSenderTrack(
              sender,
              track && this.mayPublish(run, epoch) ? track : null,
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
      track?.stop();
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
        if (track) await this.constrain(track, candidate);
        if (!this.mayPublish(run, epoch))
          throw new Error("Sua permissão de transmissão foi removida.");
        this.data = { ...this.data, profile: candidate };
        try {
          await Promise.all(
            [...this.peers.values()].map((peer) =>
              this.enqueue(peer, () => this.parameters(peer, "screen")),
            ),
          );
        } catch (error) {
          // Never keep sending with a previous, potentially larger cap after failure.
          await this.replaceSource("screen", null, run, epoch);
          await this.replaceSource("screen_audio", null, run, epoch);
          throw error;
        }
        this.emit();
      });
    this.mediaQueue = operation;
    return operation;
  }
  setReceiveHeight(peerId: string, height: number): void {
    if (!heightAllowed(height)) throw new Error("Teto de resolução inválido.");
    const peer = this.peers.get(peerId);
    if (!peer || !this.current(peer)) return;
    peer.receiveHeight = height;
    this.signal(peer, { receive: { screen_height: height } });
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
                observations.set(row.id, { bytes, timestamp: time, frames });
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
    for (const track of this.pendingTracks) {
      track.enabled = false;
      track.stop();
    }
    this.pendingTracks.clear();
    for (const track of Object.values(this.local)) {
      const ended = this.ended.get(track);
      if (ended) track.removeEventListener("ended", ended);
      track.enabled = false;
      track.stop();
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
  private finish(state: "closed" | "failed", reason: string) {
    // Also invalidate an in-flight manual reconnect when the UI unmounts.
    ++this.generation;
    ++this.publicationEpoch;
    if (!["connecting", "connected"].includes(this.data.state)) return;
    clearTimeout(this.connectTimer);
    clearTimeout(this.refreshTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.sampleTimer);
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
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
