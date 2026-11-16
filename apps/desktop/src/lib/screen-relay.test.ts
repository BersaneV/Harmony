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
