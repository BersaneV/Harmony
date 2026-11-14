import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P2PCall, type CallEnvironment, type CallParticipant } from "./call";
import type { Session } from "./types";
import type { StreamProfile } from "./stream";

vi.mock("./api", () => ({
  getServer: vi.fn(),
  getSession: vi.fn(),
  onSession: vi.fn(),
  refreshSession: vi.fn(),
}));

const sdp =
  "v=0\r\na=ice-ufrag:test\r\nm=audio 9 RTP/SAVPF 111\r\nm=video 9 RTP/SAVPF 96\r\nm=video 9 RTP/SAVPF 96\r\nm=audio 9 RTP/SAVPF 111\r\n";
const roster = (peer_id: string, can_publish = true): CallParticipant => ({
  peer_id,
  user_id: `user_${peer_id}`,
  display_name: peer_id,
  can_publish,
  media: {
    microphone: false,
    camera: false,
    screen: false,
    screen_audio: false,
  },
});
const session = (revision = 1): Session => ({
  access_token: `header.${btoa(JSON.stringify({ sid: "session", version: revision, exp: Date.now() / 1000 + 3600 }))}.signature`,
  refresh_token: "test-refresh",
  user: {
    id: "user_a",
    username: "test",
    display_name: "test",
    is_admin: false,
    disabled: false,
    preferences: {},
    created_at: "",
  },
});
let sequence = 0;
type Codec = Pick<
  RTCRtpCodecParameters,
  "mimeType" | "clockRate" | "channels" | "sdpFmtpLine"
>;
type SendParameters = Omit<RTCRtpSendParameters, "encodings"> & {
  encodings: (RTCRtpEncodingParameters & { codec?: Codec })[];
};
const videoCodecs: RTCRtpCodecParameters[] = [
  { mimeType: "video/VP8", clockRate: 90_000, payloadType: 96 },
  {
    mimeType: "video/rtx",
    clockRate: 90_000,
    payloadType: 97,
    sdpFmtpLine: "apt=96",
  },
  {
    mimeType: "video/H264",
    clockRate: 90_000,
    payloadType: 98,
    sdpFmtpLine:
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
  },
  {
    mimeType: "video/H264",
    clockRate: 90_000,
    payloadType: 99,
    sdpFmtpLine:
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  },
];
const screenProfile: StreamProfile = {
  height: 720,
  fps: 30,
  bitrate: 4,
  content: "motion",
  audio: true,
};
class Track extends EventTarget {
  id = `track_${++sequence}`;
  readyState = "live";
  enabled = true;
  contentHint = "";
  onmute = null;
  onunmute = null;
  onended = null;
  settings: MediaTrackSettings;
  onConstraints?: (constraints: MediaTrackConstraints) => void | Promise<void>;
  constructor(public kind: string) {
    super();
    this.settings = kind === "video" ? { width: 1920, height: 1080 } : {};
  }
  stop() {
    this.readyState = "ended";
  }
  end() {
    this.stop();
    this.dispatchEvent(new Event("ended"));
  }
  getSettings() {
    return this.settings;
  }
  async applyConstraints(constraints: MediaTrackConstraints) {
    await this.onConstraints?.(constraints);
    for (const key of ["width", "height", "frameRate"] as const) {
      const value = constraints[key];
      if (value && typeof value === "object" && value.max)
        this.settings[key] = value.max;
    }
  }
  media() {
    return this as unknown as MediaStreamTrack;
  }
}
class Sender {
  track: MediaStreamTrack | null = null;
  parameters: SendParameters = {
    encodings: [{}],
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    transactionId: "test",
  };
  hold?: Promise<void>;
  parameterHold?: Promise<void>;
  codecBehavior: "supported" | "ignored" | "rejected" = "supported";
  rejectParameters = false;
  replacementCalls: (MediaStreamTrack | null)[] = [];
  replacements: {
    track: MediaStreamTrack | null;
    parameters: SendParameters;
  }[] = [];
  parameterHistory: SendParameters[] = [];
  parameterCalls = 0;
  async replaceTrack(track: MediaStreamTrack | null) {
    this.replacementCalls.push(track);
    this.replacements.push({ track, parameters: this.getParameters() });
    const hold = track ? this.hold : undefined;
    this.hold = undefined;
    if (hold) await hold;
    this.track = track;
  }
  getParameters() {
    return structuredClone(this.parameters);
  }
  async setParameters(value: SendParameters) {
    this.parameterCalls++;
    this.parameterHistory.push(structuredClone(value));
    if (this.rejectParameters) throw new Error("Parameters unsupported");
    // A browser must reject edits to its negotiated codec list.
    expect(value.codecs).toEqual(this.parameters.codecs);
    const hold = this.parameterHold;
    this.parameterHold = undefined;
    if (hold) await hold;
    if (
      this.codecBehavior === "rejected" &&
      value.encodings.some(
        (encoding, i) =>
          JSON.stringify(encoding.codec) !==
          JSON.stringify(this.parameters.encodings[i]?.codec),
      )
    )
      throw new Error("Codec selection unsupported");
    const applied = structuredClone(value);
    if (this.codecBehavior === "ignored")
      for (const encoding of applied.encodings) delete encoding.codec;
    this.parameters = applied;
  }
}
class Peer {
  constructor(private codecs: RTCRtpCodecParameters[] = []) {}
  connectionState = "connected";
  signalingState = "stable";
  localDescription: {
    type: string;
    sdp: string;
    toJSON: () => unknown;
  } | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  slots: {
    sender: Sender;
    receiver: { track: Track };
    mid: string;
    direction: string;
  }[] = [];
  onicecandidate: ((event: unknown) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  ondatachannel: ((event: unknown) => void) | null = null;
  report = new Map<string, unknown>();
  statsFailure = false;
  addTransceiver(
    value: string | MediaStreamTrack,
    options?: RTCRtpTransceiverInit,
  ) {
    const sender = new Sender();
    sender.track = typeof value === "string" ? null : value;
    sender.parameters.encodings = options?.sendEncodings ?? [{}];
    if (this.slots.length === 2)
      sender.parameters.codecs = structuredClone(this.codecs);
    const transceiver = {
      sender,
      receiver: {
        track: new Track(typeof value === "string" ? value : value.kind),
      },
      mid: String(this.slots.length),
      direction: "sendrecv",
    };
    this.slots.push(transceiver);
    return transceiver;
  }
  getTransceivers() {
    return this.slots;
  }
  getReceivers() {
    return this.slots.map((slot) => slot.receiver);
  }
  async setLocalDescription() {
    const type =
      this.signalingState === "have-remote-offer" ? "answer" : "offer";
    this.localDescription = { type, sdp, toJSON: () => ({ type, sdp }) };
    this.signalingState = type === "answer" ? "stable" : "have-local-offer";
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit) {
    this.remoteDescription = value;
    if (!this.slots.length)
      for (const kind of ["audio", "video", "video", "audio"])
        this.addTransceiver(kind);
    this.signalingState =
      value.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate() {}
  restartIce() {
    this.onnegotiationneeded?.();
  }
  async getStats() {
    if (this.statsFailure) throw new Error("Stats unavailable");
    return this.report;
  }
  close() {
    this.connectionState = "closed";
    this.signalingState = "closed";
  }
  rtc() {
    return this as unknown as RTCPeerConnection;
  }
}
class Socket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closeImmediately = true;
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = this.closeImmediately ? 3 : 2;
    if (this.closeImmediately) this.dispatchEvent(new Event("close"));
  }
  ws() {
    return this as unknown as WebSocket;
  }
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const active: P2PCall[] = [];
function setup(
  options: {
    self?: string;
    codecs?: RTCRtpCodecParameters[];
    maxBitrate?: number;
  } = {},
) {
  let auth: Session | null = session();
  const self = options.self ?? "a";
  auth.user.id = `user_${self}`;
  const listeners = new Set<(value: Session | null) => void>();
  const peers: Peer[] = [],
    sockets: Socket[] = [];
  const environment: CallEnvironment = {
    getServer: () => "https://harmony.test",
    getSession: () => auth,
    onSession: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshSession: async () => auth!,
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket.ws();
    },
    peer: () => {
      const peer = new Peer(options.codecs);
      peers.push(peer);
      return peer.rtc();
    },
  };
  const call = new P2PCall({ channelId: "channel" }, environment);
  active.push(call);
  return {
    call,
    peers,
    sockets,
    environment,
    auth: (next: Session | null) => {
      auth = next;
      for (const listener of listeners) listener(next);
    },
    async connect(participants = [roster("a"), roster("b")]) {
      const pending = call.connect(),
        socket = sockets.at(-1)!;
      socket.open();
      socket.receive({
        type: "ready",
        peer_id: self,
        channel_id: "channel",
        max_participants: 12,
        max_video_bitrate: options.maxBitrate ?? 8_000_000,
        ice_servers: [],
        participants,
      });
      await pending;
      await flush();
      return socket;
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const call of active.splice(0)) call.close();
  vi.useRealTimers();
});

describe("real call ownership and authority", () => {
  it("returns a rejected promise, and releases its session listener, when socket creation fails", async () => {
    const test = setup();
    test.environment.socket = () => {
      throw new Error("Unavailable");
    };
    await expect(test.call.connect()).rejects.toThrow("abrir a chamada");
    expect(test.call.snapshot.state).toBe("failed");
  });
  it("revokes publication immediately while sender replacement is still pending", async () => {
    const test = setup(),
      socket = await test.connect();
    let release!: () => void;
    test.peers[0].slots[0].sender.hold = new Promise((resolve) => {
      release = resolve;
    });
    const track = new Track("audio"),
      publication = test.call.setTrack("microphone", track.media());
    const rejection = expect(publication).rejects.toThrow("permissão");
    await flush();
    socket.receive({
      type: "roster",
      participants: [roster("a", false), roster("b")],
    });
    expect(track.readyState).toBe("ended");
    expect(test.call.snapshot.self?.can_publish).toBe(false);
    release();
    await rejection;
    expect(test.peers[0].slots[0].sender.track).toBeNull();
    expect(test.call.snapshot.localTracks).toEqual({});
    expect(
      socket.sent
        .filter((frame) => frame.type === "media")
        .every((frame) => frame.microphone === false),
    ).toBe(true);
  });
  it("closes every track and connection on logout and rejects late capture completion", async () => {
    const test = setup();
    await test.connect([roster("a"), roster("b"), roster("c")]);
    const mic = new Track("audio");
    await test.call.setTrack("microphone", mic.media());
    test.auth(null);
    expect(test.call.snapshot.state).toBe("closed");
    expect(mic.readyState).toBe("ended");
    expect(test.peers.every((peer) => peer.connectionState === "closed")).toBe(
      true,
    );
    const late = new Track("video");
    await expect(test.call.setTrack("screen", late.media())).rejects.toThrow(
      "autorizada",
    );
    expect(late.readyState).toBe("ended");
  });
  it("does not resurrect a call when UI cleanup interrupts manual reconnection", async () => {
    const test = setup(),
      socket = await test.connect();
    socket.closeImmediately = false;
    const reconnect = test.call.reconnect();
    const rejection = expect(reconnect).rejects.toThrow("cancelada");
    test.call.close();
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(test.sockets).toHaveLength(1);
    expect(test.call.snapshot.state).toBe("closed");
  });
  it("stops queued captures on close and does not let an old blocked sender hold the next call", async () => {
    const test = setup();
    await test.connect();
    let release!: () => void;
    test.peers[0].slots[0].sender.hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = new Track("audio"),
      queued = new Track("video");
    const firstPublication = test.call.setTrack("microphone", first.media());
    const firstRejection = expect(firstPublication).rejects.toThrow();
    await flush();
    const queuedPublication = test.call.setTrack("camera", queued.media());
    const queuedRejection = expect(queuedPublication).rejects.toThrow();
    test.call.close();
    expect(first.readyState).toBe("ended");
    expect(queued.readyState).toBe("ended");
    await test.connect();
    const next = new Track("audio");
    await test.call.setTrack("microphone", next.media());
    expect(test.peers[1].slots[0].sender.track).toBe(next);
    release();
    await firstRejection;
    await queuedRejection;
    expect(test.peers[1].slots[0].sender.track).toBe(next);
    expect(next.readyState).toBe("live");
  });
  it("preserves push-to-talk muted capture and releases screen audio when screen ends", async () => {
    const test = setup(),
      socket = await test.connect();
    const mic = new Track("audio");
    mic.enabled = false;
    await test.call.setTrack("microphone", mic.media());
    expect(mic.enabled).toBe(false);
    test.call.setTrackEnabled("microphone", true);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "media",
      microphone: true,
    });
    const screen = new Track("video"),
      audio = new Track("audio");
    await test.call.setTrack("screen", screen.media());
    await test.call.setTrack("screen_audio", audio.media());
    screen.end();
    await flush();
    expect(audio.readyState).toBe("ended");
    expect(test.call.snapshot.localTracks.screen_audio).toBeUndefined();
    expect(test.call.snapshot.localTracks.screen).toBeUndefined();
    expect(mic.readyState).toBe("live");
  });
  it("gates received media by server roster and cannot recreate a removed participant from late signaling", async () => {
    const test = setup(),
      socket = await test.connect();
    const peer = test.peers[0],
      track = peer.slots[0].receiver.track;
    peer.ontrack?.({ track, transceiver: peer.slots[0] });
    expect(track.enabled).toBe(false);
    const member = roster("b");
    member.media.microphone = true;
    socket.receive({ type: "roster", participants: [roster("a"), member] });
    expect(test.call.snapshot.participants[0].tracks.microphone).toBe(track);
    socket.receive({
      type: "roster",
      participants: [roster("a"), roster("b", false)],
    });
    expect(track.enabled).toBe(false);
    expect(test.call.snapshot.participants[0].tracks).toEqual({});
    socket.receive({ type: "roster", participants: [roster("a")] });
    socket.receive({
      type: "signal",
      from: "b",
      data: { description: { type: "offer", sdp } },
    });
    await flush();
    expect(peer.connectionState).toBe("closed");
    expect(test.call.snapshot.participants).toHaveLength(0);
    expect(test.peers).toHaveLength(1);
  });
  it("keeps a call past the probe lifetime, reauthenticates the same session, and closes media when signaling stops", async () => {
    const test = setup(),
      socket = await test.connect();
    const mic = new Track("audio");
    await test.call.setTrack("microphone", mic.media());
    for (let elapsed = 0; elapsed < 130_000; elapsed += 10_000) {
      socket.receive({ type: "pong" });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(test.call.snapshot.state).toBe("connected");
    test.auth(session(2));
    expect(socket.sent.at(-1)).toMatchObject({ type: "reauth" });
    expect(mic.readyState).toBe("live");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.call.snapshot.state).toBe("failed");
    expect(mic.readyState).toBe("ended");
  });
});

describe("real call negotiation and measured controls", () => {
  it("preserves live senders through SDP without redundant native mutations and reapplies reset caps", async () => {
    const test = setup(),
      socket = await test.connect();
    const peer = test.peers[0],
      mic = new Track("audio");
    await test.call.setTrack("microphone", mic.media());
    const before = peer.slots.map(({ sender }) => ({
      replace: sender.replacementCalls.length,
      parameters: sender.parameterCalls,
    }));
    socket.receive({
      type: "signal",
      from: "b",
      data: { description: { type: "answer", sdp } },
    });
    await flush();
    expect(
      peer.slots.map(({ sender }) => ({
        replace: sender.replacementCalls.length,
        parameters: sender.parameterCalls,
      })),
    ).toEqual(before);
    expect(peer.slots[0].sender.track).toBe(mic);
    expect(peer.slots[0].sender.parameters.encodings[0].maxBitrate).toBe(
      64_000,
    );
    expect(peer.slots[2].sender.parameters.encodings[0].maxBitrate).toBe(
      8_000_000,
    );
    expect(mic.readyState).toBe("live");
    // A subsequent negotiation may reset native parameters: do not trust a cache.
    delete peer.slots[2].sender.parameters.encodings[0].maxBitrate;
    socket.receive({
      type: "signal",
      from: "b",
      data: { description: { type: "offer", sdp } },
    });
    await flush();
    expect(peer.slots[2].sender.parameters.encodings[0].maxBitrate).toBe(
      8_000_000,
    );
    expect(peer.slots[2].sender.parameterCalls).toBe(before[2].parameters + 1);
    expect(peer.slots[0].sender.replacementCalls.length).toBe(
      before[0].replace,
    );
    expect(peer.signalingState).toBe("stable");
  });
  it("does not replace an identical muted microphone but still switches devices and revokes publication", async () => {
    const test = setup(),
      socket = await test.connect();
    const sender = test.peers[0].slots[0].sender,
      first = new Track("audio");
    first.enabled = false;
    await test.call.setTrack("microphone", first.media());
    await test.call.setTrack("microphone", first.media());
    expect(sender.replacementCalls).toEqual([first]);
    expect(first.enabled).toBe(false);
    const second = new Track("audio");
    await test.call.setTrack("microphone", second.media());
    expect(first.readyState).toBe("ended");
    expect(sender.track).toBe(second);
    socket.receive({
      type: "roster",
      participants: [roster("a", false), roster("b")],
    });
    await flush();
    expect(second.readyState).toBe("ended");
    expect(sender.track).toBeNull();
    expect(sender.replacementCalls).toEqual([first, second, null]);
    expect(test.call.snapshot.localTracks).toEqual({});
  });
  it("applies changed screen controls once and preserves each recipient's independent resolution cap", async () => {
    const test = setup(),
      socket = await test.connect([roster("a"), roster("b"), roster("c")]);
    const screen = new Track("video");
    await test.call.setTrack("screen", screen.media());
    const profile = {
      height: 720,
      fps: 60,
      bitrate: 3,
      content: "motion" as const,
      audio: true,
    };
    await test.call.setScreenProfile(profile);
    const [first, second] = test.peers.map((peer) => peer.slots[2].sender);
    const counts = [first.parameterCalls, second.parameterCalls];
    await test.call.setScreenProfile(profile);
    expect([first.parameterCalls, second.parameterCalls]).toEqual(counts);
    socket.receive({
      type: "signal",
      from: "b",
      data: { receive: { screen_height: 240 } },
    });
    socket.receive({
      type: "signal",
      from: "b",
      data: { receive: { screen_height: 240 } },
    });
    await flush();
    expect(first.parameterCalls).toBe(counts[0] + 1);
    expect(second.parameterCalls).toBe(counts[1]);
    expect(first.parameters.encodings[0]).toMatchObject({
      maxBitrate: 3_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 3,
    });
    expect(second.parameters.encodings[0].scaleResolutionDownBy).toBe(1);
    await test.call.setScreenProfile({
      ...profile,
      fps: 24,
      bitrate: 4,
      content: "text",
    });
    expect([first.parameterCalls, second.parameterCalls]).toEqual([
      counts[0] + 2,
      counts[1] + 1,
    ]);
    expect(first.parameters.encodings[0]).toMatchObject({
      maxBitrate: 4_000_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 3,
    });
    expect(first.parameters.degradationPreference).toBe("maintain-resolution");
    expect(screen.readyState).toBe("live");
  });
  it("isolates invalid peer SDP without closing other participants or captured media", async () => {
    const test = setup(),
      socket = await test.connect([roster("a"), roster("b"), roster("c")]);
    const mic = new Track("audio");
    await test.call.setTrack("microphone", mic.media());
    socket.receive({
      type: "signal",
      from: "b",
      data: { description: { type: "offer", sdp: "invalid" } },
    });
    await flush();
    expect(test.call.snapshot.state).toBe("connected");
    expect(test.call.snapshot.participants[0].connection).toBe("failed");
    expect(test.call.snapshot.participants[1].connection).toBe("connected");
    expect(test.peers[1].slots[0].sender.track).toBe(mic);
    expect(mic.readyState).toBe("live");
  });
  it("creates exactly four slots and ignores an impolite glare offer without duplicating transceivers", async () => {
    const test = setup(),
      socket = await test.connect();
    expect(test.peers[0].slots).toHaveLength(4);
    socket.receive({
      type: "signal",
      from: "b",
      data: { description: { type: "offer", sdp } },
    });
    await flush();
    expect(test.peers[0].remoteDescription).toBeNull();
    socket.receive({
      type: "signal",
      from: "b",
      data: { description: { type: "answer", sdp } },
    });
    await flush();
    expect(test.peers[0].signalingState).toBe("stable");
    expect(test.peers[0].slots).toHaveLength(4);
  });
  it("applies bitrate, fps and receive ceiling per recipient without changing other senders", async () => {
    const test = setup(),
      socket = await test.connect([roster("a"), roster("b"), roster("c")]);
    await test.call.setScreenProfile({
      height: 720,
      fps: 60,
      bitrate: 3,
      content: "motion",
      audio: true,
    });
    const screen = new Track("video");
    await test.call.setTrack("screen", screen.media());
    socket.receive({
      type: "signal",
      from: "b",
      data: { receive: { screen_height: 240 } },
    });
    await flush();
    expect(test.peers[0].slots[2].sender.parameters.encodings[0]).toMatchObject(
      { maxBitrate: 3_000_000, maxFramerate: 60, scaleResolutionDownBy: 3 },
    );
    expect(
      test.peers[1].slots[2].sender.parameters.encodings[0]
        .scaleResolutionDownBy,
    ).toBe(1);
    expect(
      test.peers[0].slots[0].sender.parameters.encodings[0].maxBitrate,
    ).toBe(64_000);
    expect(
      test.peers[0].slots[1].sender.parameters.encodings[0].maxBitrate,
    ).toBe(2_000_000);
    expect(test.call.snapshot.profile.height).toBe(720);
    test.peers[0].slots[2].sender.rejectParameters = true;
    await expect(
      test.call.setScreenProfile({
        height: 480,
        fps: 30,
        bitrate: 1,
        content: "text",
        audio: false,
      }),
    ).rejects.toThrow();
    expect(screen.readyState).toBe("ended");
    expect(test.call.snapshot.localTracks.screen).toBeUndefined();
  });
  it("reports measured byte deltas and clears unavailable stats instead of inventing or retaining measurements", async () => {
    const test = setup();
    await test.connect();
    const peer = test.peers[0];
    peer.report.set("in", {
      id: "in",
      type: "inbound-rtp",
      mid: "2",
      timestamp: 1000,
      bytesReceived: 1000,
      framesDecoded: 30,
      frameHeight: 720,
      frameWidth: 1280,
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(
      test.call.snapshot.participants[0].stats.received.screen?.bitrate,
    ).toBeNull();
    expect(test.call.snapshot.participants[0].stats.iceRttMs).toBeNull();
    peer.report.set("in", {
      id: "in",
      type: "inbound-rtp",
      mid: "2",
      timestamp: 2500,
      bytesReceived: 151000,
      framesDecoded: 75,
      frameHeight: 720,
      frameWidth: 1280,
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(
      test.call.snapshot.participants[0].stats.received.screen,
    ).toMatchObject({ bitrate: 800_000, fps: 30, height: 720 });
    peer.statsFailure = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.call.snapshot.participants[0].stats.received).toEqual({});
  });
});

const description = async (
  socket: Socket,
  from = "b",
  type: "answer" | "offer" = "answer",
) => {
  socket.receive({
    type: "signal",
    from,
    data: { description: { type, sdp } },
  });
  await flush();
};
const codecOf = (sender: Sender) => sender.parameters.encodings[0]?.codec;

describe("screen codec selection per negotiated sender", () => {
  it("selects only Constrained Baseline before the first screen frame and preserves negotiated codecs", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await test.call.setScreenProfile(screenProfile);
    const track = new Track("video");
    track.enabled = false;
    await test.call.setTrack("screen", track.media());
    const peer = test.peers[0],
      sender = peer.slots[2].sender;
    expect(sender.track).toBeNull(); // The initial answer has not arrived.
    await description(socket);
    expect(sender.track).toBe(track);
    expect(track.enabled).toBe(false);
    const first = sender.replacements.find((entry) => entry.track);
    expect(first?.parameters.encodings[0]).toMatchObject({
      codec: {
        mimeType: "video/H264",
        sdpFmtpLine: videoCodecs[3].sdpFmtpLine,
      },
      maxBitrate: 4_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    });
    expect(codecOf(sender)).not.toHaveProperty("payloadType");
    expect(sender.parameters.codecs).toEqual(videoCodecs);
    expect(
      peer.slots
        .filter((_, i) => i !== 2)
        .every(({ sender: other }) => !codecOf(other)),
    ).toBe(true);
    const calls = sender.parameterCalls;
    await test.call.setTrack("screen", track.media());
    await test.call.setScreenProfile(screenProfile);
    expect(sender.parameterCalls).toBe(calls);
    expect(sender.replacementCalls).toEqual([track]);
  });

  it("chooses independently for opposite directions and a participant joining after publication", async () => {
    const left = setup({ codecs: videoCodecs }),
      right = setup({ self: "b", codecs: videoCodecs });
    const leftSocket = await left.connect(),
      rightSocket = await right.connect();
    await left.call.setScreenProfile(screenProfile);
    await right.call.setScreenProfile({ ...screenProfile, height: 1440 });
    const low = new Track("video"),
      high = new Track("video");
    await left.call.setTrack("screen", low.media());
    await right.call.setTrack("screen", high.media());
    await description(rightSocket, "a", "offer");
    await description(leftSocket);
    expect(codecOf(left.peers[0].slots[2].sender)?.mimeType).toBe("video/H264");
    expect(codecOf(right.peers[0].slots[2].sender)?.mimeType).toBe("video/VP8");
    expect(high.getSettings()).toMatchObject({ width: 2560, height: 1440 });
    leftSocket.receive({
      type: "roster",
      participants: [roster("a"), roster("b"), roster("c")],
    });
    await flush();
    const late = left.peers[1].slots[2].sender;
    expect(late.track).toBeNull();
    await description(leftSocket, "c");
    expect(late.replacements[0].parameters.encodings[0].codec?.mimeType).toBe(
      "video/H264",
    );
    expect(late.track).toBe(low);
    expect(left.peers.every((peer) => peer.slots.length === 4)).toBe(true);
  });

  it.each([
    {
      name: "automatic height",
      profile: { height: 0 },
      geometry: { width: 1280, height: 720 },
      expected: "video/VP8",
    },
    {
      name: "1440p",
      profile: { height: 1440 },
      geometry: { width: 1920, height: 1080 },
      expected: "video/VP8",
    },
    {
      name: "60 FPS",
      profile: { fps: 60 },
      geometry: { width: 1280, height: 720 },
      expected: "video/VP8",
    },
    {
      name: "16 Mb/s",
      profile: { bitrate: 16 },
      geometry: { width: 1280, height: 720 },
      expected: "video/VP8",
    },
    {
      name: "unknown width",
      profile: {},
      geometry: { height: 720 },
      expected: "video/VP8",
    },
    {
      name: "ultrawide 720p",
      profile: {},
      geometry: { width: 3440, height: 1440 },
      expected: "video/VP8",
    },
    {
      name: "ultrawide 360p within the imposed envelope",
      profile: { height: 360 },
      geometry: { width: 3440, height: 1440 },
      expected: "video/H264",
    },
    {
      name: "automatic bitrate and FPS with effective caps",
      profile: { bitrate: 0, fps: 0 },
      geometry: { width: 1920, height: 1080 },
      expected: "video/H264",
    },
  ])(
    "honors the bounded envelope: $name",
    async ({ profile, geometry, expected }) => {
      const test = setup({ codecs: videoCodecs, maxBitrate: 32_000_000 });
      const socket = await test.connect();
      await description(socket);
      await test.call.setScreenProfile({ ...screenProfile, ...profile });
      const track = new Track("video");
      track.settings = geometry;
      await test.call.setTrack("screen", track.media());
      const sender = test.peers[0].slots[2].sender;
      expect(codecOf(sender)?.mimeType).toBe(expected);
      expect(sender.parameters.encodings[0]).toMatchObject({
        maxBitrate:
          profile.bitrate === 0
            ? 8_000_000
            : (profile.bitrate ?? 4) * 1_000_000,
        maxFramerate: profile.fps || 30,
      });
    },
  );

  it.each([
    "packetization-mode=1;profile-level-id=42001f",
    "packetization-mode=0;profile-level-id=42e01f",
    "packetization-mode=1;profile-level-id=42e01f;max-fs=3599",
    "packetization-mode=1;profile-level-id=42e01f;max-mbps=107999",
    "packetization-mode=1;profile-level-id=42e01f;max-br=3999",
    "packetization-mode=1;profile-level-id=42e01f;profile-level-id=42e01f",
  ])(
    "does not opt into an incompatible negotiated H264 format: %s",
    async (fmtp) => {
      const test = setup({
        codecs: [videoCodecs[0], { ...videoCodecs[3], sdpFmtpLine: fmtp }],
      });
      const socket = await test.connect();
      await description(socket);
      await test.call.setScreenProfile(screenProfile);
      await test.call.setTrack("screen", new Track("video").media());
      expect(codecOf(test.peers[0].slots[2].sender)?.mimeType).toBe(
        "video/VP8",
      );
    },
  );

  it("switches to VP8 before raising capture and leaves all previous caps unchanged until then", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await description(socket);
    await test.call.setScreenProfile(screenProfile);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media());
    const sender = test.peers[0].slots[2].sender;
    socket.receive({
      type: "signal",
      from: "b",
      data: { receive: { screen_height: 360 } },
    });
    await flush();
    const previous = structuredClone(sender.parameters.encodings[0]);
    const signalCount = socket.sent.filter(
      (message) => message.type === "signal",
    ).length;
    track.onConstraints = () => {
      expect(codecOf(sender)?.mimeType).toBe("video/VP8");
      expect(sender.parameters.encodings[0]).toEqual({
        ...previous,
        codec: codecOf(sender),
      });
      expect(track.getSettings().height).toBe(720);
    };
    await test.call.setScreenProfile({
      ...screenProfile,
      height: 1440,
      fps: 60,
      bitrate: 8,
    });
    expect(track.getSettings()).toMatchObject({ width: 2560, height: 1440 });
    expect(sender.parameters.encodings[0]).toMatchObject({
      maxBitrate: 8_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 4,
    });
    expect(
      socket.sent.filter((message) => message.type === "signal"),
    ).toHaveLength(signalCount);
    track.onConstraints = undefined;
    await test.call.setScreenProfile(screenProfile);
    expect(codecOf(sender)?.mimeType).toBe("video/VP8");
    await test.call.setTrack("screen", null);
    await test.call.setTrack("screen", new Track("video").media());
    expect(codecOf(sender)?.mimeType).toBe("video/VP8");
  });

  it("never hot-switches a sender that began with VP8 to H264", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await description(socket);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media()); // Default 1080p.
    const sender = test.peers[0].slots[2].sender;
    expect(codecOf(sender)?.mimeType).toBe("video/VP8");
    await test.call.setScreenProfile(screenProfile);
    expect(codecOf(sender)?.mimeType).toBe("video/VP8");
    expect(
      sender.parameterHistory.some((parameters) =>
        parameters.encodings.some(
          (encoding) => encoding.codec?.mimeType === "video/H264",
        ),
      ),
    ).toBe(false);
  });

  it.each(["ignored", "rejected"] as const)(
    "falls back when codec selection is %s without masking subsequent cap errors",
    async (behavior) => {
      const test = setup({ codecs: videoCodecs });
      const socket = await test.connect();
      await description(socket);
      await test.call.setScreenProfile(screenProfile);
      const sender = test.peers[0].slots[2].sender;
      sender.codecBehavior = behavior;
      const track = new Track("video");
      await test.call.setTrack("screen", track.media());
      expect(sender.track).toBe(track);
      expect(codecOf(sender)).toBeUndefined();
      const calls = sender.parameterCalls;
      await test.call.setScreenProfile(screenProfile);
      expect(sender.parameterCalls).toBe(calls);
      sender.rejectParameters = true;
      await expect(
        test.call.setScreenProfile({ ...screenProfile, bitrate: 2 }),
      ).rejects.toThrow("Parameters unsupported");
      expect(track.readyState).toBe("ended");
      expect(sender.track).toBeNull();
    },
  );

  it.each(["ignored", "rejected"] as const)(
    "preserves the old capture when an H264 to VP8 transition is %s",
    async (behavior) => {
      const test = setup({ codecs: videoCodecs });
      const socket = await test.connect();
      await description(socket);
      await test.call.setScreenProfile(screenProfile);
      const track = new Track("video");
      await test.call.setTrack("screen", track.media());
      const sender = test.peers[0].slots[2].sender;
      sender.codecBehavior = behavior;
      track.onConstraints = () => {
        throw new Error(
          "Must not raise capture before a confirmed VP8 transition",
        );
      };
      await expect(
        test.call.setScreenProfile({ ...screenProfile, height: 1440 }),
      ).rejects.toThrow();
      expect(test.call.snapshot.profile).toEqual(screenProfile);
      expect(track.getSettings()).toMatchObject({ width: 1280, height: 720 });
      expect(sender.track).toBe(track);
      expect(track.readyState).toBe("live");
    },
  );

  it("compares codec dictionaries structurally, preserves case-sensitive fmtp, and latches VP8 after an SDP reset", async () => {
    const fmtp = `${videoCodecs[3].sdpFmtpLine};sprop-parameter-sets=Z0IAH5WoFAFuQA==`;
    const test = setup({
      codecs: [videoCodecs[0], { ...videoCodecs[3], sdpFmtpLine: fmtp }],
    });
    const socket = await test.connect();
    await description(socket);
    await test.call.setScreenProfile(screenProfile);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media());
    const sender = test.peers[0].slots[2].sender;
    sender.parameters.encodings[0].codec!.sdpFmtpLine =
      " SPROP-PARAMETER-SETS=Z0IAH5WoFAFuQA==;PROFILE-LEVEL-ID=42E01F;packetization-mode=1;level-asymmetry-allowed=1 ";
    const calls = sender.parameterCalls;
    await test.call.setScreenProfile(screenProfile);
    expect(sender.parameterCalls).toBe(calls);
    // Base64 values are case-sensitive; this is not the negotiated codec.
    sender.parameters.encodings[0].codec!.sdpFmtpLine = fmtp.toLowerCase();
    delete sender.parameters.encodings[0].maxBitrate;
    await description(socket, "b", "offer");
    expect(codecOf(sender)?.mimeType).toBe("video/VP8");
    expect(sender.parameters.encodings[0].maxBitrate).toBe(4_000_000);
    expect(sender.track).toBe(track);
    expect(sender.replacementCalls).toEqual([track]);
  });

  it("does not grow H264 capture while renegotiation is pending", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await description(socket);
    await test.call.setScreenProfile(screenProfile);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media());
    test.peers[0].onnegotiationneeded?.();
    await flush();
    expect(test.peers[0].signalingState).toBe("have-local-offer");
    await expect(
      test.call.setScreenProfile({ ...screenProfile, height: 1440 }),
    ).rejects.toThrow("negociação");
    expect(track.getSettings().height).toBe(720);
    expect(test.call.snapshot.profile).toEqual(screenProfile);
    await description(socket);
    await test.call.setScreenProfile({ ...screenProfile, height: 1440 });
    expect(track.getSettings().height).toBe(1440);
  });

  it("retains mute and publication ownership while codec selection is pending", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await description(socket);
    await test.call.setScreenProfile(screenProfile);
    const sender = test.peers[0].slots[2].sender;
    let release!: () => void;
    sender.parameterHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const track = new Track("video");
    const pending = test.call.setTrack("screen", track.media());
    const rejected = expect(pending).rejects.toThrow("permissão");
    await flush();
    test.call.setTrackEnabled("screen", false);
    expect(track.enabled).toBe(false);
    expect(sender.track).toBeNull();
    socket.receive({
      type: "roster",
      participants: [roster("a", false), roster("b")],
    });
    expect(track.readyState).toBe("ended");
    expect(test.call.snapshot.localTracks).toEqual({});
    release();
    await rejected;
    expect(sender.track).toBeNull();
    expect(sender.replacementCalls).not.toContain(track);
  });

  it("defers a late participant until the pending 720p to 1440p capture change is committed", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await description(socket);
    await test.call.setScreenProfile(screenProfile);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media());
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    track.onConstraints = () => hold;
    const changing = test.call.setScreenProfile({
      ...screenProfile,
      height: 1440,
    });
    await flush();
    const first = test.peers[0].slots[2].sender;
    expect(codecOf(first)?.mimeType).toBe("video/VP8");
    socket.receive({
      type: "roster",
      participants: [roster("a"), roster("b"), roster("c")],
    });
    await flush();
    await description(socket, "c");
    const late = test.peers[1].slots[2].sender;
    expect(late.track).toBeNull();
    expect(codecOf(late)).toBeUndefined();
    expect(test.call.snapshot.profile.height).toBe(720);
    expect(track.getSettings().height).toBe(720);
    release();
    await changing;
    expect(track.getSettings()).toMatchObject({ width: 2560, height: 1440 });
    for (const sender of [first, late]) {
      expect(codecOf(sender)?.mimeType).toBe("video/VP8");
      expect(sender.track).toBe(track);
    }
    expect(late.replacements[0].parameters.encodings[0].codec?.mimeType).toBe(
      "video/VP8",
    );
    expect(
      late.parameterHistory.some((parameters) =>
        parameters.encodings.some(
          (encoding) => encoding.codec?.mimeType === "video/H264",
        ),
      ),
    ).toBe(false);
  });

  it("resumes deferred participants at the previous profile if the capture change fails", async () => {
    const test = setup({ codecs: videoCodecs });
    const socket = await test.connect();
    await description(socket);
    await test.call.setScreenProfile(screenProfile);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media());
    let reject!: (error: Error) => void;
    const hold = new Promise<void>((_, fail) => {
      reject = fail;
    });
    track.onConstraints = () => hold;
    const changing = test.call.setScreenProfile({
      ...screenProfile,
      height: 1440,
    });
    const rejected = expect(changing).rejects.toThrow("Capture failed");
    await flush();
    socket.receive({
      type: "roster",
      participants: [roster("a"), roster("b"), roster("c")],
    });
    await flush();
    await description(socket, "c");
    const late = test.peers[1].slots[2].sender;
    expect(late.track).toBeNull();
    reject(new Error("Capture failed"));
    await rejected;
    expect(test.call.snapshot.profile).toEqual(screenProfile);
    expect(track.getSettings()).toMatchObject({ width: 1280, height: 720 });
    expect(track.readyState).toBe("live");
    expect(late.track).toBe(track);
    expect(codecOf(late)?.mimeType).toBe("video/H264");
    expect(late.parameters.encodings[0]).toMatchObject({
      maxBitrate: 4_000_000,
      maxFramerate: 30,
    });
    expect(test.peers[0].slots[2].sender.track).toBe(track);
    expect(codecOf(test.peers[0].slots[2].sender)?.mimeType).toBe("video/VP8");
  });

  it.each(["revocation", "close"] as const)(
    "cannot attach deferred media after %s during a capture change",
    async (action) => {
      const test = setup({ codecs: videoCodecs });
      const socket = await test.connect();
      await description(socket);
      await test.call.setScreenProfile(screenProfile);
      const track = new Track("video");
      await test.call.setTrack("screen", track.media());
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      track.onConstraints = () => hold;
      const changing = test.call.setScreenProfile({
        ...screenProfile,
        height: 1440,
      });
      const rejected = expect(changing).rejects.toThrow("permissão");
      await flush();
      socket.receive({
        type: "roster",
        participants: [roster("a"), roster("b"), roster("c")],
      });
      await flush();
      await description(socket, "c");
      const late = test.peers[1].slots[2].sender;
      expect(late.track).toBeNull();
      if (action === "close") test.call.close();
      else
        socket.receive({
          type: "roster",
          participants: [roster("a", false), roster("b"), roster("c")],
        });
      expect(track.readyState).toBe("ended");
      expect(test.call.snapshot.localTracks).toEqual({});
      release();
      await rejected;
      expect(late.track).toBeNull();
      expect(late.replacementCalls).not.toContain(track);
    },
  );

  it("does not release a new call's capture barrier when an older call finally settles", async () => {
    const test = setup({ codecs: videoCodecs });
    const oldSocket = await test.connect();
    await description(oldSocket);
    await test.call.setScreenProfile(screenProfile);
    const oldTrack = new Track("video");
    await test.call.setTrack("screen", oldTrack.media());
    let releaseOld!: () => void;
    const oldHold = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    oldTrack.onConstraints = () => oldHold;
    const oldChange = test.call.setScreenProfile({
      ...screenProfile,
      height: 1440,
    });
    const oldRejection = expect(oldChange).rejects.toThrow("permissão");
    await flush();
    test.call.close();
    const socket = await test.connect();
    await description(socket);
    const track = new Track("video");
    await test.call.setTrack("screen", track.media());
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    track.onConstraints = () => hold;
    const changing = test.call.setScreenProfile({
      ...screenProfile,
      height: 1440,
    });
    await flush();
    socket.receive({
      type: "roster",
      participants: [roster("a"), roster("b"), roster("c")],
    });
    await flush();
    await description(socket, "c");
    expect(test.peers[2].slots[2].sender.track).toBeNull();
    releaseOld();
    await oldRejection;
    // This negotiation starts after the obsolete finally ran. Its screen must
    // still be deferred by the newer operation's barrier.
    socket.receive({
      type: "roster",
      participants: [roster("a"), roster("b"), roster("c"), roster("d")],
    });
    await flush();
    await description(socket, "d");
    expect(test.peers[3].slots[2].sender.track).toBeNull();
    expect(codecOf(test.peers[3].slots[2].sender)).toBeUndefined();
    release();
    await changing;
    for (const peer of test.peers.slice(1)) {
      expect(peer.slots[2].sender.track).toBe(track);
      expect(codecOf(peer.slots[2].sender)?.mimeType).toBe("video/VP8");
    }
    expect(oldTrack.readyState).toBe("ended");
  });
});
