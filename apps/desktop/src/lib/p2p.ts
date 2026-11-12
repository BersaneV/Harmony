// Short-lived synthetic probe. No microphone, camera or desktop capture is requested.
export interface ProbeProfile {
  height: number;
  fps: number;
  bitrate: number;
}
export interface ProbeSnapshot {
  elapsedSeconds: number;
  connection: RTCPeerConnectionState | "waiting" | "closed";
  route: "direct" | "relay" | "unknown";
  localCandidate: string | null;
  remoteCandidate: string | null;
  protocol: string | null;
  iceRttMs: number | null;
  p2pMedianMs: number | null;
  p2pP95Ms: number | null;
  signalingMedianMs: number | null;
  pingSent: number;
  pingReceived: number;
  pingTimedOut: number;
  pingPending: number;
  videoBitrate: number | null;
  videoFps: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  jitterMs: number | null;
}
export interface ProbeReport {
  version: 1;
  kind: "harmony-p2p-synthetic";
  startedAt: string;
  scope: "unspecified" | "same-machine" | "different-networks";
  profile: ProbeProfile;
  durationSeconds: number;
  reason: string;
  samples: ProbeSnapshot[];
  limitations: string[];
}
export const probeLimitations = [
  "Vídeo gerado por canvas; não mede captura da tela, áudio ou desempenho do jogo.",
  "RTT é ida e volta; não é atraso de captura até reprodução.",
  "O padrão sintético não mede capacidade máxima de banda nem equivale à transmissão de um jogo.",
  "ICE direct não comprova redes distintas. Dois navegadores no mesmo computador não validam WAN.",
  "O teste não contrata TURN. Se o caminho direto falhar, não há fallback pago.",
];
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[
    Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))
  ];
}
export function validateProbeProfile(profile: ProbeProfile): ProbeProfile {
  if (
    ![144, 240, 360, 480, 720, 1080, 1440, 2160].includes(profile.height) ||
    ![15, 24, 30, 60].includes(profile.fps) ||
    !Number.isFinite(profile.bitrate) ||
    profile.bitrate < 500_000 ||
    profile.bitrate > 32_000_000
  ) {
    throw new Error("Perfil inválido para o teste P2P.");
  }
  return { ...profile };
}
export function classifyRoute(
  local: string | null,
  remote: string | null,
): ProbeSnapshot["route"] {
  if (local === "relay" || remote === "relay") return "relay";
  const types = ["host", "srflx", "prflx"];
  return local && remote && types.includes(local) && types.includes(remote)
    ? "direct"
    : "unknown";
}
type StatsRow = RTCStats & Record<string, unknown>;
const numeric = (row: StatsRow | undefined, key: string): number | null =>
  row && typeof row[key] === "number" && Number.isFinite(row[key])
    ? (row[key] as number)
    : null;
const textual = (row: StatsRow | undefined, key: string): string | null =>
  row && typeof row[key] === "string" ? (row[key] as string) : null;

interface Options {
  server: string;
  token: string;
  probeId: string;
  channelId: string;
  profile: ProbeProfile;
  scope?: ProbeReport["scope"];
  onStatus: (status: string) => void;
  onSnapshot: (snapshot: ProbeSnapshot) => void;
  onVideo: (stream: MediaStream) => void;
  onClosed: (report: ProbeReport) => void;
}
export class P2PProbe {
  private socket: WebSocket;
  private pc: RTCPeerConnection | null = null;
  private data: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private sender: RTCRtpSender | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private pendingPing = new Map<number, number>();
  private pendingServerPing = new Map<number, number>();
  private pings: number[] = [];
  private serverPings: number[] = [];
  private snapshots: ProbeSnapshot[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopTimer: ReturnType<typeof setTimeout>;
  private started = performance.now();
  private startedAt = new Date().toISOString();
  private sequence = 0;
  private sent = 0;
  private received = 0;
  private timedOut = 0;
  private stopped = false;
  private sampling = false;
  private bytes: { id: string; value: number; time: number } | null = null;
  private nonce = crypto.randomUUID();
  private signalQueue: Promise<void> = Promise.resolve();
  readonly profile: ProbeProfile;

  constructor(private options: Options) {
    this.profile = validateProbeProfile(options.profile);
    const url = new URL("/api/p2p/ws", options.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url);
    this.stopTimer = setTimeout(
      () => this.stop("Prazo máximo do teste atingido"),
      120_000,
    );
    this.socket.onopen = () =>
      this.send({
        type: "auth",
        token: options.token,
        probe_id: options.probeId,
        channel_id: options.channelId,
      });
    this.socket.onmessage = (event) => {
      this.signalQueue = this.signalQueue
        .then(async () => {
          if (!this.stopped) await this.signal(JSON.parse(String(event.data)));
        })
        .catch(() => this.stop("Não foi possível negociar o teste P2P"));
    };
    this.socket.onerror = () => this.stop("Falha na conexão de diagnóstico");
    this.socket.onclose = () => this.stop("Sinalização encerrada");
    this.timers.push(
      setInterval(() => {
        void this.sample();
      }, 1000),
    );
    options.onStatus("Entrando no teste");
  }

  private send(value: unknown) {
    if (!this.stopped && this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }
  private async signal(value: Record<string, unknown>) {
    if (value.type === "closed") {
      this.stop(String(value.reason || "Teste encerrado"));
      return;
    }
    if (value.type === "pong") {
      const seq = Number(value.seq),
        time = this.pendingServerPing.get(seq);
      if (time !== undefined) {
        this.serverPings.push(performance.now() - time);
        this.pendingServerPing.delete(seq);
      }
      return;
    }
    if (value.type === "ready") {
      if (this.pc) throw new Error("Duplicate ready");
      const configured = Array.isArray(value.ice_servers)
        ? value.ice_servers
        : [];
      const iceServers: RTCIceServer[] = configured
        .filter(
          (server): server is { urls: string } =>
            typeof server === "object" &&
            server !== null &&
            typeof server.urls === "string" &&
            /^stuns?:[^\s/@]+(?::\d+)?$/i.test(server.urls),
        )
        .map(({ urls }) => ({ urls }));
      this.pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all",
        bundlePolicy: "max-bundle",
      });
      this.pc.onicecandidate = ({ candidate }) => {
        if (candidate)
          this.send({ type: "ice", candidate: candidate.toJSON() });
      };
      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === "connected")
          this.options.onStatus("P2P conectado; medindo");
        if (state === "failed")
          this.stop("Conexão direta falhou. Este teste não usa TURN pago.");
      };
      this.pc.ondatachannel = ({ channel }) => this.bindData(channel);
      this.pc.ontrack = ({ track }) => {
        if (track.kind === "video")
          this.options.onVideo(new MediaStream([track]));
      };
      clearTimeout(this.stopTimer);
      const remaining = Math.min(
        120,
        Math.max(0, Number(value.expires_in) || 0),
      );
      this.stopTimer = setTimeout(
        () => this.stop("Prazo máximo do teste atingido"),
        remaining * 1000,
      );
      this.options.onStatus(
        value.role === "offerer"
          ? "Aguardando o outro participante"
          : "Negociando conexão direta",
      );
      this.timers.push(setInterval(() => this.ping(), 1000));
      return;
    }
    if (!this.pc) throw new Error("Peer not ready");
    if (value.type === "peer-ready") {
      this.bindData(
        this.pc.createDataChannel("harmony-probe", {
          ordered: false,
          maxRetransmits: 0,
        }),
      );
      this.addSyntheticVideo();
      await this.pc.setLocalDescription(await this.pc.createOffer());
      if (this.sender) {
        const parameters = this.sender.getParameters();
        parameters.degradationPreference = "maintain-resolution";
        for (const encoding of parameters.encodings) {
          encoding.maxBitrate = this.profile.bitrate;
          encoding.maxFramerate = this.profile.fps;
        }
        await this.sender.setParameters(parameters);
      }
      this.send({
        type: "description",
        description: this.pc.localDescription?.toJSON(),
      });
      return;
    }
    if (value.type === "description") {
      const description = value.description as RTCSessionDescriptionInit;
      await this.pc.setRemoteDescription(description);
      for (const candidate of this.pendingIce.splice(0))
        await this.pc.addIceCandidate(candidate);
      if (description.type === "offer") {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.send({
          type: "description",
          description: this.pc.localDescription?.toJSON(),
        });
      }
      return;
    }
    if (value.type === "ice") {
      if (this.pc.remoteDescription)
        await this.pc.addIceCandidate(value.candidate as RTCIceCandidateInit);
      else this.pendingIce.push(value.candidate as RTCIceCandidateInit);
    }
  }

  private addSyntheticVideo() {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((this.profile.height * 16) / 9);
    canvas.height = this.profile.height;
    const context = canvas.getContext("2d");
    if (!context || !canvas.captureStream)
      throw new Error("Canvas capture unavailable");
    let frame = 0;
    const paint = () => {
      const { width, height } = canvas;
      context.fillStyle = "#101628";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#689eff";
      context.fillRect(
        (frame * 13) % width,
        height * 0.3,
        width / 5,
        height / 4,
      );
      context.fillStyle = "#ffffff";
      context.font = `${Math.max(14, height / 18)}px sans-serif`;
      context.fillText(
        `Harmony · teste sintético · ${frame++}`,
        width * 0.05,
        height * 0.17,
      );
      context.fillText(
        `${width}×${height} / ${this.profile.fps} FPS`,
        width * 0.05,
        height * 0.85,
      );
    };
    paint();
    this.stream = canvas.captureStream(this.profile.fps);
    const track = this.stream.getVideoTracks()[0];
    track.contentHint = "motion";
    this.sender = this.pc!.addTransceiver(track, {
      direction: "sendonly",
      streams: [this.stream],
      sendEncodings: [
        { maxBitrate: this.profile.bitrate, maxFramerate: this.profile.fps },
      ],
    }).sender;
    this.timers.push(setInterval(paint, 1000 / this.profile.fps));
  }

  private bindData(channel: RTCDataChannel) {
    if (this.data) {
      channel.close();
      return;
    }
    this.data = channel;
    channel.onmessage = ({ data }) => {
      if (this.stopped || typeof data !== "string" || data.length > 256) return;
      try {
        const message = JSON.parse(data);
        if (
          !Number.isSafeInteger(message.seq) ||
          typeof message.nonce !== "string" ||
          message.nonce.length > 64
        )
          return;
        if (
          message.kind === "ping" &&
          channel.readyState === "open" &&
          channel.bufferedAmount < 4096
        ) {
          channel.send(
            JSON.stringify({
              kind: "pong",
              seq: message.seq,
              nonce: message.nonce,
            }),
          );
        } else if (message.kind === "pong" && message.nonce === this.nonce) {
          const time = this.pendingPing.get(message.seq);
          if (time !== undefined) {
            this.pings.push(performance.now() - time);
            this.received++;
            this.pendingPing.delete(message.seq);
          }
        }
      } catch {
        /* Unknown diagnostic payloads are ignored. */
      }
    };
  }

  private ping() {
    const seq = ++this.sequence,
      now = performance.now();
    for (const [id, sent] of this.pendingPing)
      if (now - sent > 2500) {
        this.timedOut++;
        this.pendingPing.delete(id);
      }
    for (const [id, sent] of this.pendingServerPing)
      if (now - sent > 5000) this.pendingServerPing.delete(id);
    if (this.data?.readyState === "open" && this.data.bufferedAmount < 4096) {
      this.pendingPing.set(seq, now);
      this.sent++;
      this.data.send(JSON.stringify({ kind: "ping", seq, nonce: this.nonce }));
    }
    this.pendingServerPing.set(seq, now);
    this.send({ type: "ping", seq });
  }

  private async sample() {
    if (this.stopped || this.sampling) return;
    this.sampling = true;
    try {
      const report = await this.pc?.getStats();
      if (this.stopped) return;
      const rows = new Map<string, StatsRow>();
      report?.forEach((row) => rows.set(row.id, row as StatsRow));
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
      const local = pair ? rows.get(String(pair.localCandidateId)) : undefined;
      const remote = pair
        ? rows.get(String(pair.remoteCandidateId))
        : undefined;
      const video = values.find(
        (row) =>
          ["inbound-rtp", "outbound-rtp"].includes(row.type) &&
          (row.kind === "video" || row.mediaType === "video") &&
          !row.isRemote,
      );
      const count = numeric(
        video,
        video?.type === "inbound-rtp" ? "bytesReceived" : "bytesSent",
      );
      const time = numeric(video, "timestamp");
      let bitrate: number | null = null;
      if (video && count !== null && time !== null) {
        if (
          this.bytes?.id === video.id &&
          time > this.bytes.time &&
          count >= this.bytes.value
        )
          bitrate =
            ((count - this.bytes.value) * 8000) / (time - this.bytes.time);
        this.bytes = { id: video.id, value: count, time };
      }
      const localType = textual(local, "candidateType"),
        remoteType = textual(remote, "candidateType");
      const rtt = numeric(pair, "currentRoundTripTime"),
        jitter = numeric(video, "jitter");
      const snapshot: ProbeSnapshot = {
        elapsedSeconds: (performance.now() - this.started) / 1000,
        connection: this.pc?.connectionState || "waiting",
        route: classifyRoute(localType, remoteType),
        localCandidate: localType,
        remoteCandidate: remoteType,
        protocol: textual(local, "protocol"),
        iceRttMs: rtt === null ? null : rtt * 1000,
        p2pMedianMs: percentile(this.pings, 0.5),
        p2pP95Ms: percentile(this.pings, 0.95),
        signalingMedianMs: percentile(this.serverPings, 0.5),
        pingSent: this.sent,
        pingReceived: this.received,
        pingTimedOut: this.timedOut,
        pingPending: this.pendingPing.size,
        videoBitrate: bitrate,
        videoFps: numeric(video, "framesPerSecond"),
        videoWidth: numeric(video, "frameWidth"),
        videoHeight: numeric(video, "frameHeight"),
        packetsLost: numeric(video, "packetsLost"),
        packetsReceived: numeric(video, "packetsReceived"),
        jitterMs: jitter === null ? null : jitter * 1000,
      };
      this.snapshots.push(snapshot);
      this.options.onSnapshot(snapshot);
    } catch {
      this.options.onStatus("Estatísticas indisponíveis neste navegador");
    } finally {
      this.sampling = false;
    }
  }

  stop(reason = "Teste encerrado pelo participante") {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.stopTimer);
    this.timers.forEach(clearInterval);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.pc?.getReceivers().forEach((receiver) => receiver.track.stop());
    this.data?.close();
    this.pc?.close();
    this.socket.close();
    this.options.onStatus(reason);
    this.options.onClosed({
      version: 1,
      kind: "harmony-p2p-synthetic",
      startedAt: this.startedAt,
      scope: this.options.scope || "unspecified",
      profile: this.profile,
      durationSeconds: (performance.now() - this.started) / 1000,
      reason,
      samples: this.snapshots,
      limitations: probeLimitations,
    });
  }
}
