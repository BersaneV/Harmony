import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P2PCall, type CallEnvironment, type CallParticipant } from "./call";
import type { Session } from "./types";

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
class Track extends EventTarget {
  id = `track_${++sequence}`;
  readyState = "live";
  enabled = true;
  contentHint = "";
  onmute = null;
  onunmute = null;
  onended = null;
  settings: MediaTrackSettings;
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
  parameters: RTCRtpSendParameters = {
    encodings: [{}],
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    transactionId: "test",
  };
  hold?: Promise<void>;
  rejectParameters = false;
  async replaceTrack(track: MediaStreamTrack | null) {
    const hold = track ? this.hold : undefined;
    this.hold = undefined;
    if (hold) await hold;
    this.track = track;
  }
  getParameters() {
    return structuredClone(this.parameters);
  }
  async setParameters(value: RTCRtpSendParameters) {
    if (this.rejectParameters) throw new Error("Parameters unsupported");
    this.parameters = value;
  }
}
class Peer {
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
function setup() {
  let auth: Session | null = session();
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
      const peer = new Peer();
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
        peer_id: "a",
        channel_id: "channel",
        max_participants: 12,
        max_video_bitrate: 8_000_000,
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
