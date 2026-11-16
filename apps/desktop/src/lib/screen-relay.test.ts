import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScreenRelay,
  type RelayRoom,
  type RelayPublication,
  type RelayParticipant,
  type ScreenRelayAuthority,
  type RelayDecodeSample,
  type RelayLocalPublication,
  type RelayAudioSample,
  type RelayRtpSample,
  type RelayPlayoutDelay,
} from "./screen-relay";
import type { StreamProfile } from "./stream";

const uuid = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const peerA = uuid(1),
  peerB = uuid(2),
  userA = uuid(3),
  userB = uuid(4),
  sidA = uuid(5),
  sidB = uuid(6);
const profile: StreamProfile = {
  height: 1440,
  fps: 60,
  bitrate: 8,
  audio: true,
  content: "motion",
};
const authority = (): ScreenRelayAuthority => ({
  generation: "call-1",
  self: {
    peer_id: peerA,
    user_id: userA,
    can_publish: true,
    screen_sfu: true,
    media: { screen: true, screen_audio: true },
  },
  peers: [
    {
      peer_id: peerB,
      user_id: userB,
      can_publish: true,
      screen_sfu: true,
      media: { screen: true, screen_audio: false },
    },
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function media(kind = "video") {
  return {
    kind,
    readyState: "live",
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ width: 2560, height: 1440 }),
  } as unknown as MediaStreamTrack;
}
const decodedAudio = (
  overrides: Partial<RelayAudioSample> = {},
): RelayAudioSample => ({
  bytesReceived: 100,
  totalSamplesReceived: 4800,
  totalSamplesDuration: 0.1,
  concealedSamples: 0,
  ...overrides,
});
function publication(
  source: RelayPublication["source"] = "screen",
  generation = "video-1",
): RelayPublication {
  return {
    sid: `sid-${source}`,
    source,
    name: `harmony-${source === "screen" ? "screen" : "screen-audio"}:${generation}`,
    width: 2560,
    height: 1440,
    muted: false,
    subscribe: vi.fn(),
    track: {
      media: media(source === "screen" ? "video" : "audio"),
      sample: vi.fn(async (): Promise<RelayDecodeSample | null> => ({
        framesDecoded: 0,
        bytesReceived: 0,
        width: 2560,
        height: 1440,
      })),
    },
  };
}
function fixture() {
  let change = () => {};
  let connected = true;
  const remote: RelayParticipant = {
    identity: `${userB}:${sidB}`,
    metadata: JSON.stringify({ harmony_peer_id: peerB }),
    publications: [],
  };
  const room: RelayRoom = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    identity: () => `${userA}:${sidA}`,
    metadata: () => JSON.stringify({ harmony_peer_id: peerA }),
    name: () => "room",
    connected: () => connected,
    participants: () => [
      {
        ...remote,
        publications: remote.publications.map((publication) => ({
          ...publication,
        })),
      },
    ],
    onChange: (listener) => {
      change = listener;
      return () => {
        change = () => {};
      };
    },
    publish: vi.fn(async (track, options): Promise<RelayLocalPublication> => ({
      sid: `local-${options.source}`,
      track,
    })),
    unpublish: vi.fn(async () => {}),
  };
  const callbacks = {
    onStats: vi.fn(),
    onAck: vi.fn(),
    onTrack: vi.fn(),
    onFallback: vi.fn(),
    onError: vi.fn(),
    onLocalPublication: vi.fn(),
  };
  const relay = new ScreenRelay(callbacks, {
    room: () => room,
    nonce: () => "generation-1",
    interval: 100,
  });
  const connect = (roster = authority()) =>
    relay.connect(
      {
        token: "token",
        url: "wss://relay.test",
        room: "room",
        peer_id: peerA,
        max_video_bitrate: 8_000_000,
      },
      roster,
    );
  return {
    relay,
    room,
    remote,
    callbacks,
    connect,
    change: () => change(),
    disconnect: () => {
      connected = false;
      change();
    },
    reconnect: () => {
      connected = true;
      change();
    },
  };
}
afterEach(() => vi.useRealTimers());
async function tick() {
  await vi.advanceTimersByTimeAsync(100);
}
function counters(
  timestamp: number,
  bytes: number,
  frames: number | null = 30,
): RelayRtpSample {
  return {
    rowId: "rtp-source",
    timestamp,
    bytes,
    frames,
    width: frames === null ? null : 2560,
    height: frames === null ? null : 1440,
    audioLevel: frames === null ? 0.2 : null,
    packetsLost: 3,
    jitterMs: 2,
    iceRttMs: 39,
    maxBitrate: 8_000_000,
  };
}

describe("ScreenRelay: medições por fonte SDK", () => {
  it("mede um único upload por SID/geração e limpa a amostra ao encerrar", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    const sampleStats = vi.fn(async () => counters(1000, 1000));
    vi.mocked(f.room.publish).mockImplementationOnce(async (track) => ({
      sid: "TR_local",
      track,
      sampleStats,
    }));
    const ref = await f.relay.setScreen(
      media(),
      { ...profile, audio: false },
      8_000_000,
    );
    await tick();
    sampleStats.mockResolvedValue(counters(2000, 201000, 90));
    await tick();
    expect(sampleStats).toHaveBeenCalledTimes(2);
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith({
      direction: "sent",
      source: "screen",
      ref,
      publication_sid: "TR_local",
      stats: expect.objectContaining({
        bitrate: 1_600_000,
        fps: 60,
        width: 2560,
        height: 1440,
        iceRttMs: 39,
        maxBitrate: 8_000_000,
        timestamp: 2000,
      }),
    });
    await f.relay.close();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: "sent", stats: null }),
    );
  });

  it("reutiliza a coleta de ACK para vídeo e áudio, sem misturar SIDs ou duplicar leituras", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication(),
      audio = publication("screen_audio"),
      roster = authority();
    roster.peers[0].media.screen_audio = true;
    const videoSample = (timestamp: number, bytes: number, frames: number) => ({
      framesDecoded: frames,
      bytesReceived: bytes,
      width: 2560,
      height: 1440,
      stats: counters(timestamp, bytes, frames),
    });
    vi.mocked(video.track!.sample).mockResolvedValue(
      videoSample(1000, 1000, 30),
    );
    vi.mocked(audio.track!.sample).mockResolvedValue({
      ...decodedAudio(),
      stats: counters(1000, 1000, null),
    });
    f.remote.publications = [video, audio];
    await f.connect(roster);
    await tick();
    vi.mocked(video.track!.sample).mockResolvedValue(
      videoSample(2000, 201000, 90),
    );
    vi.mocked(audio.track!.sample).mockResolvedValue({
      ...decodedAudio(),
      stats: counters(2000, 17000, null),
    });
    await tick();
    expect(video.track!.sample).toHaveBeenCalledTimes(2);
    expect(audio.track!.sample).toHaveBeenCalledTimes(2);
    expect(f.callbacks.onStats).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "received",
        peer_id: peerB,
        source: "screen",
        publication_sid: video.sid,
        stats: expect.objectContaining({ bitrate: 1_600_000, fps: 60 }),
      }),
    );
    expect(f.callbacks.onStats).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "received",
        peer_id: peerB,
        source: "screen_audio",
        publication_sid: audio.sid,
        ref: { track_sid: video.sid, generation: "video-1" },
        stats: expect.objectContaining({
          bitrate: 128_000,
          fps: null,
          audioLevel: 0.2,
        }),
      }),
    );
    await f.relay.close();
  });

  it("não publica uma leitura que termina depois do fechamento", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      held = deferred<RelayRtpSample | null>();
    await f.connect();
    vi.mocked(f.room.publish).mockImplementationOnce(async (track) => ({
      sid: "TR_local",
      track,
      sampleStats: () => held.promise,
    }));
    await f.relay.setScreen(media(), profile, 8_000_000);
    await tick();
    await f.relay.close();
    held.resolve(counters(2000, 1000));
    await tick();
    expect(
      f.callbacks.onStats.mock.calls.filter(([event]) => event.stats !== null),
    ).toHaveLength(0);
  });

  it("reinicia deltas quando counters ou relógio voltam, sem bitrate/FPS negativos", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    const sampleStats = vi.fn(async () => counters(1000, 1000));
    vi.mocked(f.room.publish).mockImplementationOnce(async (track) => ({
      sid: "TR_local",
      track,
      sampleStats,
    }));
    await f.relay.setScreen(media(), profile, 8_000_000);
    await tick();
    sampleStats.mockResolvedValue(counters(2000, 500, 1));
    await tick();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({ bitrate: null, fps: null }),
      }),
    );
    sampleStats.mockResolvedValue(counters(2000, 600, 2));
    await tick();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({ bitrate: null, fps: null }),
      }),
    );
    await f.relay.close();
  });

  it("descarta a coleta do receiver antigo sem apagar métricas da fonte substituta", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      old = publication();
    const held = deferred<RelayDecodeSample | null>();
    vi.mocked(old.track!.sample).mockReturnValueOnce(held.promise);
    f.remote.publications = [old];
    await f.connect();
    await tick();
    const next = publication("screen", "new_h1440_a0");
    next.sid = "new-screen";
    vi.mocked(next.track!.sample).mockResolvedValue({
      framesDecoded: 30,
      bytesReceived: 1000,
      width: 2560,
      height: 1440,
      stats: counters(1000, 1000),
    });
    f.remote.publications = [next];
    f.change();
    await tick();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ref: { track_sid: next.sid, generation: "new_h1440_a0" },
        stats: expect.any(Object),
      }),
    );
    f.callbacks.onStats.mockClear();
    held.resolve({
      framesDecoded: 200,
      bytesReceived: 500000,
      width: 2560,
      height: 1440,
      stats: counters(4000, 500000, 200),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.callbacks.onStats).not.toHaveBeenCalled();
    await f.relay.close();
  });

  it("reinicia deltas por SSRC/row, ausência de stats e SID novo após reconexão", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connect();
    const sampleStats = vi.fn<() => Promise<RelayRtpSample | null>>(async () =>
      counters(1000, 1000),
    );
    const owned = { sid: "before", track: media(), sampleStats };
    vi.mocked(f.room.publish).mockResolvedValueOnce(owned);
    await f.relay.setScreen(owned.track, profile, 8_000_000);
    await tick();
    sampleStats.mockResolvedValue({
      ...counters(2000, 200000, 60),
      rowId: "new-ssrc",
    });
    await tick();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({ bitrate: null, fps: null }),
      }),
    );
    sampleStats.mockResolvedValue(null);
    await tick();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ stats: null }),
    );
    f.disconnect();
    owned.sid = "after";
    f.reconnect();
    sampleStats.mockResolvedValue(counters(3000, 400000, 120));
    await tick();
    expect(f.callbacks.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        publication_sid: "after",
        ref: expect.objectContaining({ track_sid: "after" }),
        stats: expect.objectContaining({ bitrate: null, fps: null }),
      }),
    );
    await f.relay.close();
  });

  it("isola falhas do observador das provas de mídia e do ACK existente", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication();
    f.callbacks.onStats.mockImplementation(() => {
      throw new Error("observer only");
    });
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 30,
      bytesReceived: 1000,
      width: 2560,
      height: 1440,
      stats: counters(1000, 1000),
    });
    f.remote.publications = [video];
    await f.connect();
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: video.sid, generation: "video-1" },
    });
    expect(f.callbacks.onError).not.toHaveBeenCalled();
    await f.relay.close();
  });
});

describe("ScreenRelay: tela opcional sobre SFU", () => {
  it("aguarda intenção de áudio da geração mesmo quando o roster ainda não anunciou a nova fonte", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication("screen", "capture_h1440_a1"),
      audio = publication("screen_audio", "capture_h1440_a1");
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 100,
      width: 2560,
      height: 1440,
    });
    vi.mocked(audio.track!.sample).mockResolvedValue(decodedAudio());
    f.remote.publications = [video, audio];
    const roster = authority();
    await f.connect(roster);
    await tick();
    expect(f.callbacks.onAck).not.toHaveBeenCalled();
    expect(audio.subscribe).not.toHaveBeenCalledWith(true);
    roster.peers[0].media.screen_audio = true;
    f.relay.updateAuthority(roster);
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: video.sid, generation: "capture_h1440_a1" },
    });
    await f.relay.close();
  });
  it.each([
    { bytesReceived: 100 },
    decodedAudio({ totalSamplesReceived: 0, totalSamplesDuration: 0 }),
    decodedAudio({ concealedSamples: 4800 }),
    decodedAudio({ totalSamplesDuration: NaN }),
  ])(
    "mantém P2P quando bytes de áudio não comprovam amostras decodificadas: %j",
    async (sample) => {
      vi.useFakeTimers();
      const f = fixture(),
        video = publication(),
        audio = publication("screen_audio"),
        roster = authority();
      roster.peers[0].media.screen_audio = true;
      vi.mocked(video.track!.sample).mockResolvedValue({
        framesDecoded: 1,
        bytesReceived: 100,
        width: 2560,
        height: 1440,
      });
      vi.mocked(audio.track!.sample).mockResolvedValue(
        sample as RelayAudioSample,
      );
      f.remote.publications = [video, audio];
      await f.connect(roster);
      await tick();
      expect(f.callbacks.onAck).not.toHaveBeenCalled();
      expect(f.callbacks.onTrack).not.toHaveBeenCalled();
      await f.relay.close();
    },
  );

  it("retira também vídeo quando a retirada do áudio rejeita, sem parar capturas", async () => {
    const f = fixture();
    await f.connect();
    const screen = media(),
      audio = media("audio");
    await f.relay.setScreen(screen, profile, 8_000_000);
    await f.relay.setScreenAudio(audio);
    vi.mocked(f.room.unpublish).mockRejectedValueOnce(
      new Error("Audio negotiation failed"),
    );
    await expect(f.relay.setScreen(null, profile, 8_000_000)).rejects.toThrow(
      "Audio negotiation failed",
    );
    expect(f.room.unpublish).toHaveBeenCalledWith(
      expect.objectContaining({ track: screen }),
    );
    expect(f.room.disconnect).toHaveBeenCalledWith(false);
    expect(f.callbacks.onLocalPublication).toHaveBeenLastCalledWith(null);
    expect(screen.stop).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
    await f.relay.close();
  });

  it("usa P2P com teto explícito quando só existem dimensões instantâneas", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication();
    video.height = 720;
    video.width = 1280;
    f.remote.publications = [video];
    f.relay.setReceiveHeight(peerB, 720);
    await f.connect();
    expect(video.subscribe).not.toHaveBeenCalledWith(true);
    expect(f.callbacks.onFallback).toHaveBeenCalled();
    await tick();
    expect(f.callbacks.onAck).not.toHaveBeenCalled();
    await f.relay.close();
  });

  it("captura o limite comprovado antes dos awaits e o fixa na geração publicada", async () => {
    const f = fixture();
    await f.connect();
    const raw = media(),
      bound = { max_height: 1440 };
    const pending = f.relay.setScreen(raw, profile, 8_000_000, bound);
    bound.max_height = 2160;
    expect(await pending).toMatchObject({
      generation: "generation-1_h1440_a1",
    });
    expect(f.room.publish).toHaveBeenCalledWith(
      raw,
      expect.objectContaining({ name: "harmony-screen:generation-1_h1440_a1" }),
    );
    await expect(
      f.relay.setScreen(raw, profile, 8_000_000, { max_height: 720 }),
    ).rejects.toThrow("limite máximo");
    expect(f.room.publish).toHaveBeenCalledOnce();
    await f.relay.close();
  });

  it("só assina uma geração cujo limite máximo comprovado cabe no teto", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication("screen", "capture_h1440");
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 100,
      width: 2560,
      height: 1440,
    });
    f.remote.publications = [video];
    f.relay.setReceiveHeight(peerB, 1440);
    await f.connect();
    expect(video.subscribe).toHaveBeenLastCalledWith(true);
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: video.sid, generation: "capture_h1440" },
    });
    video.height = 2160;
    f.change();
    expect(video.subscribe).toHaveBeenLastCalledWith(false);
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
    await f.relay.close();
  });

  it("publica uma tela VP8 sem simulcast ou backup e preserva as capturas do engine", async () => {
    const f = fixture();
    await f.connect();
    const screen = media(),
      audio = media("audio");
    const ref = await f.relay.setScreen(screen, profile, 8_000_000);
    await f.relay.setScreenAudio(audio);
    expect(f.room.connect).toHaveBeenCalledWith("wss://relay.test", "token", {
      autoSubscribe: false,
    });
    expect(f.room.publish).toHaveBeenNthCalledWith(
      1,
      screen,
      expect.objectContaining({
        source: "screen",
        videoCodec: "vp8",
        simulcast: false,
        backupCodec: false,
        screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      }),
    );
    expect(f.room.publish).toHaveBeenNthCalledWith(
      2,
      audio,
      expect.objectContaining({ source: "screen_audio" }),
    );
    expect(ref).toMatchObject({ generation: "generation-1_u_a1" });
    await expect(
      f.relay.setScreen(media("audio"), profile, 8_000_000),
    ).rejects.toThrow();
    await expect(f.relay.setScreenAudio(media())).rejects.toThrow();
    await f.relay.close();
    expect(f.room.unpublish).toHaveBeenCalledTimes(2);
    expect(f.room.disconnect).toHaveBeenCalledWith(false);
    expect(screen.stop).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("aguarda vídeo decodificado antes de confirmar SID e geração e expor as tracks", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication(),
      audio = publication("screen_audio");
    const roster = authority();
    roster.peers[0].media.screen_audio = true;
    vi.mocked(audio.track!.sample).mockResolvedValue(decodedAudio());
    f.remote.publications = [video, audio];
    await f.connect(roster);
    expect(video.subscribe).toHaveBeenCalledWith(true);
    expect(audio.subscribe).toHaveBeenCalledWith(true);
    await tick();
    expect(f.callbacks.onAck).not.toHaveBeenCalled();
    expect(f.callbacks.onTrack).not.toHaveBeenCalled();
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 2,
      bytesReceived: 200,
      width: 2560,
      height: 1440,
    });
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: video.sid, generation: "video-1" },
    });
    expect(f.callbacks.onTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: peerB,
        source: "screen",
        track: video.track!.media,
      }),
    );
    expect(f.callbacks.onTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: peerB,
        source: "screen_audio",
        track: audio.track!.media,
      }),
    );
    await f.relay.close();
  });

  it("usa P2P e retira ACK quando o limite é menor que o vídeo publicado", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication();
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 200,
      width: 2560,
      height: 1440,
    });
    f.remote.publications = [video];
    await f.connect();
    await tick();
    f.relay.setReceiveHeight(peerB, 720);
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
    expect(video.subscribe).toHaveBeenLastCalledWith(false);
    expect(f.callbacks.onTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: peerB,
        source: "screen",
        track: null,
      }),
    );
    await f.relay.close();
  });

  it.each([
    "peer",
    "user",
    "session",
    "capability",
    "source",
    "permission",
    "malformed",
  ])("recusa identidade ou permissão inválida: %s", async (invalid) => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication();
    f.remote.publications = [video];
    const roster = authority();
    if (invalid === "peer")
      f.remote.metadata = JSON.stringify({ harmony_peer_id: uuid(99) });
    if (invalid === "user") f.remote.identity = `${uuid(99)}:${sidB}`;
    if (invalid === "session") f.remote.identity = `${userB}:not-a-session`;
    if (invalid === "malformed") f.remote.metadata = "not-json";
    if (invalid === "capability") roster.peers[0].screen_sfu = false;
    if (invalid === "permission") roster.peers[0].can_publish = false;
    if (invalid === "source") video.source = "other";
    await f.connect();
    f.relay.updateAuthority(roster);
    await tick();
    expect(f.callbacks.onAck).not.toHaveBeenCalledWith(
      expect.objectContaining({ screen_sfu: expect.any(Object) }),
    );
    expect(f.callbacks.onTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ track: expect.any(Object) }),
    );
    expect(video.subscribe).toHaveBeenLastCalledWith(false);
    await f.relay.close();
  });

  it("retira ACK quando a conexão ou a fonte muda e ignora provas antigas", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication();
    f.remote.publications = [video];
    const held = deferred<RelayDecodeSample | null>();
    vi.mocked(video.track!.sample).mockReturnValueOnce(held.promise);
    await f.connect();
    await tick();
    f.remote.publications = [publication("screen", "video-2")];
    f.change();
    held.resolve({
      framesDecoded: 2,
      bytesReceived: 200,
      width: 2560,
      height: 1440,
    });
    await tick();
    expect(f.callbacks.onAck).not.toHaveBeenCalled();
    const current = f.remote.publications[0];
    vi.mocked(current.track!.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 100,
      width: 2560,
      height: 1440,
    });
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: current.sid, generation: "video-2" },
    });
    f.disconnect();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
    await f.relay.close();
  });

  it("libera publicação tardia após close sem parar ou reanexar a captura", async () => {
    const f = fixture();
    await f.connect();
    const held = deferred<RelayLocalPublication>(),
      track = media();
    vi.mocked(f.room.publish).mockReturnValueOnce(held.promise);
    const publishing = f.relay.setScreen(track, profile, 8_000_000);
    const rejection = expect(publishing).rejects.toThrow();
    await vi.waitFor(() => expect(f.room.publish).toHaveBeenCalledOnce());
    const closing = f.relay.close();
    held.resolve({ sid: "late", track });
    await rejection;
    await closing;
    expect(f.room.unpublish).toHaveBeenCalledWith(
      expect.objectContaining({ sid: "late" }),
    );
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("assina a nova fonte quando TrackSubscribed sucede uma publicação sem track", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication(),
      track = video.track!;
    delete video.track;
    f.remote.publications = [video];
    await f.connect();
    expect(video.subscribe).toHaveBeenLastCalledWith(true);
    video.track = track;
    f.change();
    expect(video.subscribe).toHaveBeenLastCalledWith(true);
    vi.mocked(track.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 100,
      width: 2560,
      height: 1440,
    });
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: video.sid, generation: "video-1" },
    });
    await f.relay.close();
  });

  it("confirma uma tela com áudio após receber o áudio e revoga ACK ao perdê-lo", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication(),
      audio = publication("screen_audio"),
      roster = authority();
    roster.peers[0].media.screen_audio = true;
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 100,
      width: 2560,
      height: 1440,
    });
    f.remote.publications = [video, audio];
    await f.connect(roster);
    await tick();
    expect(f.callbacks.onAck).not.toHaveBeenCalled();
    vi.mocked(audio.track!.sample).mockResolvedValue(decodedAudio());
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: { track_sid: video.sid, generation: "video-1" },
    });
    delete audio.track;
    f.change();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
    await tick();
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
    await f.relay.close();
  });

  it("retira mídias e ACK quando o roster revoga permissão ou a geração muda", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      video = publication();
    vi.mocked(video.track!.sample).mockResolvedValue({
      framesDecoded: 1,
      bytesReceived: 100,
      width: 2560,
      height: 1440,
    });
    f.remote.publications = [video];
    await f.connect();
    await tick();
    const roster = authority();
    roster.peers[0].can_publish = false;
    f.relay.updateAuthority(roster);
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
    expect(video.subscribe).toHaveBeenLastCalledWith(false);
    f.relay.updateAuthority({ ...authority(), generation: "call-2" });
    await tick();
    expect(f.room.disconnect).toHaveBeenCalledWith(false);
    expect(f.callbacks.onAck).toHaveBeenLastCalledWith({
      peer_id: peerB,
      screen_sfu: null,
    });
  });

  it("cancela conexões anteriores sem criar uma Room órfã", async () => {
    const f = fixture();
    const first = f.connect(),
      rejection = expect(first).rejects.toThrow("cancelada");
    const second = f.connect();
    await rejection;
    await second;
    expect(f.room.connect).toHaveBeenCalledOnce();
    await f.relay.close();
  });

  it("atualiza SID local após reconexão e anuncia indisponibilidade durante a perda", async () => {
    const f = fixture();
    await f.connect();
    const raw = media(),
      publication = { sid: "local-before", track: raw };
    vi.mocked(f.room.publish).mockResolvedValueOnce(publication);
    await f.relay.setScreen(raw, profile, 8_000_000);
    expect(f.callbacks.onLocalPublication).toHaveBeenLastCalledWith({
      track_sid: "local-before",
      generation: "generation-1_u_a1",
    });
    f.disconnect();
    expect(f.callbacks.onLocalPublication).toHaveBeenLastCalledWith(null);
    publication.sid = "local-after";
    f.reconnect();
    expect(f.callbacks.onLocalPublication).toHaveBeenLastCalledWith({
      track_sid: "local-after",
      generation: "generation-1_u_a1",
    });
    expect(await f.relay.setScreen(raw, profile, 8_000_000)).toEqual({
      track_sid: "local-after",
      generation: "generation-1_u_a1",
    });
    await f.relay.close();
  });
});

describe("ScreenRelay: atraso opcional apenas para epoch explícito sem áudio", () => {
  const decoded = () => ({
    framesDecoded: 1,
    bytesReceived: 100,
    width: 2560,
    height: 1440,
  });
  function silent() {
    const f = fixture(),
      video = publication("screen", "capture_h1440_a0");
    const cleanup = vi.fn();
    const apply = vi.fn<RelayPlayoutDelay["apply"]>(
      (_seconds, _ref, current, retain) => {
        expect(current()).toBe(true);
        retain(cleanup);
        return cleanup;
      },
    );
    video.track!.playoutDelay = { apply };
    vi.mocked(video.track!.sample).mockResolvedValue(decoded());
    f.remote.publications = [video];
    return { ...f, video, apply, cleanup };
  }
  it("aplica 0.24 uma vez após decode e antes de entregar vídeo/ACK; restaura antes de unsubscribe", async () => {
    vi.useFakeTimers();
    const f = silent(),
      order: string[] = [];
    f.apply.mockImplementation((_seconds, _ref, current, retain) => {
      expect(current()).toBe(true);
      order.push("delay");
      retain(f.cleanup);
      return f.cleanup;
    });
    f.callbacks.onTrack.mockImplementation(() => order.push("track"));
    f.callbacks.onAck.mockImplementation(() => order.push("ack"));
    vi.mocked(f.video.track!.sample).mockResolvedValueOnce(null);
    await f.connect();
    await tick();
    expect(f.apply).not.toHaveBeenCalled();
    await tick();
    await tick();
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.apply.mock.calls[0].slice(0, 2)).toEqual([
      0.24,
      { track_sid: f.video.sid, generation: "capture_h1440_a0" },
    ]);
    expect(order).toEqual(["delay", "track", "ack"]);
    f.cleanup.mockImplementation(() => order.push("restore"));
    vi.mocked(f.video.subscribe).mockImplementation((enabled) => {
      if (!enabled) order.push("unsubscribe");
    });
    await f.relay.close();
    expect(order.indexOf("restore")).toBeLessThan(order.indexOf("unsubscribe"));
  });
  it.each(["capture_h1440_a1", "legacy_h1440", "legacy"])(
    "não aplica na geração %s",
    async (generation) => {
      vi.useFakeTimers();
      const f = silent();
      f.video.name = `harmony-screen:${generation}`;
      await f.connect();
      await tick();
      expect(f.apply).not.toHaveBeenCalled();
      if (!generation.endsWith("_a1"))
        expect(f.callbacks.onAck).toHaveBeenCalled();
    },
  );
  it.each(["unsupported", "throw"])(
    "falha opcional %s não interrompe mídia nem ACK e não repete",
    async (mode) => {
      vi.useFakeTimers();
      const f = silent();
      f.apply.mockImplementation(() => {
        if (mode === "throw") throw new Error("unsupported");
        return undefined;
      });
      await f.connect();
      await tick();
      await tick();
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect(f.callbacks.onTrack).toHaveBeenCalledWith(
        expect.objectContaining({ track: f.video.track!.media }),
      );
      expect(f.callbacks.onAck).toHaveBeenCalledWith(
        expect.objectContaining({ screen_sfu: expect.any(Object) }),
      );
      expect(f.callbacks.onError).not.toHaveBeenCalled();
    },
  );
  it.each(["authority", "cap", "generation", "media", "close"])(
    "descarta reentrância %s sem ACK/track antigo",
    async (change) => {
      vi.useFakeTimers();
      const f = silent();
      f.apply.mockImplementation((_seconds, _ref, current, retain) => {
        retain(f.cleanup);
        if (change === "authority") {
          const a = authority();
          a.peers[0].can_publish = false;
          f.relay.updateAuthority(a);
        }
        if (change === "cap") f.relay.setReceiveHeight(peerB, 720);
        if (change === "generation") {
          f.video.name = "harmony-screen:new_h1440_a0";
          f.change();
        }
        if (change === "media") {
          f.video.track = { ...f.video.track!, media: media() };
          f.change();
        }
        if (change === "close") void f.relay.close();
        expect(current()).toBe(false);
        return f.cleanup;
      });
      await f.connect();
      await tick();
      expect(f.cleanup).toHaveBeenCalled();
      expect(f.callbacks.onTrack).not.toHaveBeenCalled();
      expect(f.callbacks.onAck).not.toHaveBeenCalled();
    },
  );
  it("retira sincronicamente o hint antes de assinar áudio e entregar epoch a1", async () => {
    vi.useFakeTimers();
    const f = silent(),
      order: string[] = [];
    await f.connect();
    await tick();
    f.cleanup.mockImplementation(() => order.push("restore"));
    const audio = publication("screen_audio", "new_h1440_a1");
    vi.mocked(audio.subscribe).mockImplementation((enabled) => {
      if (enabled) order.push("audio");
    });
    vi.mocked(audio.track!.sample).mockResolvedValue(decodedAudio());
    f.video.name = "harmony-screen:new_h1440_a1";
    f.remote.publications = [f.video, audio];
    const next = authority();
    next.peers[0].media.screen_audio = true;
    f.relay.updateAuthority(next);
    expect(order).toEqual(["restore", "audio"]);
    await tick();
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "screen_audio",
        track: audio.track!.media,
      }),
    );
  });
});
