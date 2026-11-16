// Runs the pinned SDK's actual publication and republish contracts. Only the
// Room transport and raw capture wrapper are replaced; no SFU/network is used.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalParticipant,
  LocalTrack,
  LocalTrackPublication,
  TrackPublishOptions,
} from "livekit-client";

interface RoomContract {
  remoteParticipants: Map<string, unknown>;
  emit(name: string, ...args: unknown[]): boolean;
  localParticipant: {
    trackPublications: Map<string, LocalTrackPublication>;
    publishTrack: ReturnType<typeof vi.fn>;
    unpublishTrack: ReturnType<typeof vi.fn>;
  };
  disconnect: ReturnType<typeof vi.fn>;
}
const contract = vi.hoisted(() => ({ rooms: [] as RoomContract[], serial: 0 }));

vi.mock("livekit-client", async (original) => {
  const sdk = await original<typeof import("livekit-client")>();
  const { TrackInfo, TrackType, TrackSource } =
    await import("@livekit/protocol");
  class Events {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    on(name: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return this;
    }
    off(name: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(name)?.delete(listener);
      return this;
    }
    emit(name: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
      return true;
    }
  }
  class ProvidedTrack extends Events {
    mediaStreamTrack: MediaStreamTrack;
    kind: string;
    source: string = sdk.Track.Source.Unknown;
    isMuted = false;
    sender = {
      getStats: vi.fn(async () => new Map() as unknown as RTCStatsReport),
      getParameters: vi.fn(() => ({ encodings: [{ maxBitrate: 2_000_000 }] })),
    };
    getRTCStatsReport() {
      // Exercise the pinned SDK's delegation to this source's sender.getStats.
      return sdk.LocalVideoTrack.prototype.getRTCStatsReport.call(
        this as unknown as LocalTrack,
      );
    }
    constructor(raw: MediaStreamTrack) {
      super();
      this.mediaStreamTrack = raw;
      this.kind = raw.kind;
    }
  }
  class ContractRoom extends Events {
    name = "harmony-fixture";
    state = sdk.ConnectionState.Disconnected;
    remoteParticipants = new Map();
    localParticipant = {
      identity:
        "00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000005",
      metadata: JSON.stringify({
        harmony_peer_id: "00000000-0000-4000-8000-000000000001",
      }),
      trackPublications: new Map<string, LocalTrackPublication>(),
      publishTrack: vi.fn(
        async (track: LocalTrack, options: TrackPublishOptions) => {
          const publication = new sdk.LocalTrackPublication(
            track.kind,
            new TrackInfo({
              sid: `TR_${++contract.serial}`,
              name: options.name,
              type:
                track.kind === sdk.Track.Kind.Video
                  ? TrackType.VIDEO
                  : TrackType.AUDIO,
              source:
                track.kind === sdk.Track.Kind.Video
                  ? TrackSource.SCREEN_SHARE
                  : TrackSource.SCREEN_SHARE_AUDIO,
              width: 2560,
              height: 1440,
            }),
            track,
          );
          publication.options = options;
          this.localParticipant.trackPublications.set(
            publication.trackSid,
            publication,
          );
          this.emit(sdk.RoomEvent.LocalTrackPublished, publication);
          return publication;
        },
      ),
      unpublishTrack: vi.fn(async (track: LocalTrack, _stop: boolean) => {
        const publication = [
          ...this.localParticipant.trackPublications.values(),
        ].find((publication) => publication.track === track);
        if (!publication) return;
        this.localParticipant.trackPublications.delete(publication.trackSid);
        // The real pinned SDK method also clears the original publication.
        publication.setTrack(undefined);
        this.emit(sdk.RoomEvent.LocalTrackUnpublished, publication);
        return publication;
      }),
      publishOrRepublishTrack: (
        track: LocalTrack,
        options: TrackPublishOptions,
      ) => this.localParticipant.publishTrack(track, options),
    };
    constructor() {
      super();
      contract.rooms.push(this);
    }
    connect = vi.fn(async () => {
      this.state = sdk.ConnectionState.Connected;
    });
    disconnect = vi.fn(async (_stop: boolean) => {
      this.state = sdk.ConnectionState.Disconnected;
    });
  }
  return {
    ...sdk,
    Room: ContractRoom,
    LocalVideoTrack: ProvidedTrack,
    LocalAudioTrack: ProvidedTrack,
  };
});

import {
  LocalParticipant as RealParticipant,
  RemoteVideoTrack,
  RoomEvent,
  Track,
} from "livekit-client";
import { ScreenRelay, type ScreenRelayAuthority } from "./screen-relay";

const uuid = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const relays = new Set<ScreenRelay>();
afterEach(async () => {
  for (const relay of relays) await relay.close();
  relays.clear();
  contract.rooms.length = 0;
  vi.useRealTimers();
});
async function connected() {
  const onLocalPublication = vi.fn();
  const onStats = vi.fn();
  const onAck = vi.fn();
  const relay = new ScreenRelay({
    onAck,
    onStats,
    onTrack: vi.fn(),
    onLocalPublication,
  });
  relays.add(relay);
  const authority: ScreenRelayAuthority = {
    generation: "call-1",
    self: {
      peer_id: uuid(1),
      user_id: uuid(3),
      screen_sfu: true,
      can_publish: true,
      media: { screen: true, screen_audio: false },
    },
    peers: [],
  };
  await relay.connect(
    {
      peer_id: uuid(1),
      room: "harmony-fixture",
      url: "wss://fixture.test",
      token: "fixture",
      max_video_bitrate: 8_000_000,
    },
    authority,
  );
  const raw = {
    id: "raw-screen",
    kind: "video",
    readyState: "live",
    getSettings: () => ({ width: 2560, height: 1440 }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const profile = {
    height: 1440,
    fps: 60,
    bitrate: 8,
    content: "motion" as const,
    audio: false,
  };
  const before = await relay.setScreen(raw, profile, 8_000_000, {
    max_height: 1440,
  });
  return {
    relay,
    room: contract.rooms[0],
    raw,
    profile,
    before: before!,
    onLocalPublication,
    onStats,
    onAck,
    authority,
  };
}

describe("ScreenRelay: contrato real de republicação do SDK fixado", () => {
  it("mede apenas RTP da fonte e RTT ICE do transporte vinculado, lendo o teto ativo do sender SDK", async () => {
    vi.useFakeTimers();
    const f = await connected();
    const wrapped = [...f.room.localParticipant.trackPublications.values()][0]
      .track!;
    const sender = wrapped.sender!;
    const getStats = vi.mocked(sender.getStats);
    vi.mocked(sender.getParameters).mockReturnValue({
      encodings: [
        { maxBitrate: 2_000_000 },
        { active: false, maxBitrate: 50_000_000 },
      ],
    } as RTCRtpSendParameters);
    const report = (
      timestamp: number,
      bytesSent: number,
      framesEncoded: number,
    ) =>
      new Map([
        [
          "voice",
          {
            id: "voice",
            type: "outbound-rtp",
            kind: "audio",
            timestamp,
            bytesSent: 9e9,
          },
        ],
        [
          "other-video",
          {
            id: "other-video",
            type: "outbound-rtp",
            kind: "video",
            trackIdentifier: "other-source",
            timestamp,
            bytesSent: 8e9,
            framesEncoded: 800,
          },
        ],
        [
          "video",
          {
            id: "video",
            type: "outbound-rtp",
            kind: "video",
            mediaSourceId: "source",
            timestamp,
            bytesSent,
            framesEncoded,
            frameWidth: 2560,
            frameHeight: 1440,
            transportId: "video-transport",
            remoteId: "remote",
          },
        ],
        [
          "source",
          { id: "source", type: "media-source", trackIdentifier: f.raw.id },
        ],
        [
          "remote",
          {
            id: "remote",
            type: "remote-inbound-rtp",
            localId: "video",
            packetsLost: 4,
            jitter: 0.006,
            roundTripTime: 9,
          },
        ],
        [
          "video-transport",
          {
            id: "video-transport",
            type: "transport",
            selectedCandidatePairId: "video-pair",
          },
        ],
        [
          "video-pair",
          {
            id: "video-pair",
            type: "candidate-pair",
            currentRoundTripTime: 0.042,
          },
        ],
        [
          "voice-pair",
          { id: "voice-pair", type: "candidate-pair", currentRoundTripTime: 8 },
        ],
      ]) as unknown as RTCStatsReport;
    getStats.mockResolvedValue(report(1000, 1000, 30));
    await vi.advanceTimersByTimeAsync(500);
    getStats.mockResolvedValue(report(2000, 201000, 90));
    await vi.advanceTimersByTimeAsync(500);
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(f.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        direction: "sent",
        source: "screen",
        ref: f.before,
        stats: expect.objectContaining({
          bitrate: 1_600_000,
          fps: 60,
          width: 2560,
          height: 1440,
          maxBitrate: 2_000_000,
          iceRttMs: 42,
          packetsLost: 4,
          jitterMs: 6,
          timestamp: 2000,
        }),
      }),
    );
    getStats.mockResolvedValue(new Map() as unknown as RTCStatsReport);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.onStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ stats: null }),
    );
    expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it("usa receiver.getStats da tela, descarta await de track substituída e não mistura a voz", async () => {
    vi.useFakeTimers();
    const f = await connected();
    const raw = {
      id: "received-screen",
      kind: "video",
      readyState: "live",
    } as MediaStreamTrack;
    const report = (
      timestamp: number,
      bytesReceived: number,
      framesDecoded: number,
    ) =>
      new Map([
        [
          "voice",
          {
            id: "voice",
            type: "inbound-rtp",
            kind: "audio",
            timestamp,
            bytesReceived: 9e9,
          },
        ],
        [
          "screen",
          {
            id: "screen",
            type: "inbound-rtp",
            kind: "video",
            trackIdentifier: raw.id,
            timestamp,
            bytesReceived,
            framesDecoded,
            frameWidth: 1920,
            frameHeight: 1080,
            packetsLost: 2,
            jitter: 0.003,
            transportId: "transport",
          },
        ],
        [
          "transport",
          {
            id: "transport",
            type: "transport",
            selectedCandidatePairId: "pair",
          },
        ],
        [
          "pair",
          { id: "pair", type: "candidate-pair", currentRoundTripTime: 0.057 },
        ],
      ]) as unknown as RTCStatsReport;
    const receiver = { getStats: vi.fn(async () => report(1000, 1000, 30)) };
    const track = {
      mediaStreamTrack: raw,
      receiver,
      getRTCStatsReport() {
        return RemoteVideoTrack.prototype.getRTCStatsReport.call(
          this as unknown as RemoteVideoTrack,
        );
      },
    };
    const publication = {
      trackSid: "TR_remote",
      trackName: "harmony-screen:capture_h1440_a0",
      source: Track.Source.ScreenShare,
      dimensions: { width: 1920, height: 1080 },
      isMuted: false,
      track,
      setSubscribed: vi.fn(),
    };
    f.room.remoteParticipants.set("remote", {
      identity: `${uuid(4)}:${uuid(6)}`,
      metadata: JSON.stringify({ harmony_peer_id: uuid(2) }),
      trackPublications: new Map([[publication.trackSid, publication]]),
    });
    f.authority.peers = [
      {
        peer_id: uuid(2),
        user_id: uuid(4),
        screen_sfu: true,
        can_publish: true,
        media: { screen: true, screen_audio: false },
      },
    ];
    f.relay.updateAuthority(f.authority);
    await vi.advanceTimersByTimeAsync(500);
    receiver.getStats.mockResolvedValue(report(2000, 101000, 90));
    await vi.advanceTimersByTimeAsync(500);
    expect(receiver.getStats).toHaveBeenCalledTimes(2);
    expect(f.onStats).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "received",
        peer_id: uuid(2),
        publication_sid: "TR_remote",
        stats: expect.objectContaining({
          bitrate: 800_000,
          fps: 60,
          width: 1920,
          height: 1080,
          iceRttMs: 57,
          packetsLost: 2,
          jitterMs: 3,
        }),
      }),
    );
    let resolve!: (value: RTCStatsReport) => void;
    receiver.getStats.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    publication.track = {
      ...track,
      mediaStreamTrack: { ...raw, id: "new-screen" } as MediaStreamTrack,
    };
    f.room.emit(RoomEvent.TrackSubscribed);
    f.onStats.mockClear();
    resolve(report(3000, 301000, 150));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onStats).not.toHaveBeenCalled();
  });

  it("acompanha o novo SID após o SDK limpar a publicação antiga e republicar a mesma track", async () => {
    const f = await connected();
    const original = [...f.room.localParticipant.trackPublications.values()][0];
    const wrapped = original.track;
    await RealParticipant.prototype.republishAllTracks.call(
      f.room.localParticipant as unknown as LocalParticipant,
      undefined,
      false,
    );
    const current = [...f.room.localParticipant.trackPublications.values()][0];
    expect(original.track).toBeUndefined();
    expect(current.track).toBe(wrapped);
    expect(current.trackSid).not.toBe(f.before.track_sid);
    expect(f.onLocalPublication).toHaveBeenLastCalledWith({
      track_sid: current.trackSid,
      generation: f.before.generation,
    });
    expect(
      await f.relay.setScreen(f.raw, f.profile, 8_000_000, {
        max_height: 1440,
      }),
    ).toEqual({ track_sid: current.trackSid, generation: f.before.generation });
  });

  it("despublica a wrapper estável após republicação, preservando a captura do P2P", async () => {
    const f = await connected();
    const wrapped = [...f.room.localParticipant.trackPublications.values()][0]
      .track;
    await RealParticipant.prototype.republishAllTracks.call(
      f.room.localParticipant as unknown as LocalParticipant,
      undefined,
      false,
    );
    f.room.localParticipant.unpublishTrack.mockClear();
    await f.relay.setScreen(null, f.profile, 8_000_000);
    expect(f.room.localParticipant.unpublishTrack).toHaveBeenCalledWith(
      wrapped,
      false,
    );
    expect(f.room.localParticipant.trackPublications.size).toBe(0);
    expect(f.raw.stop).not.toHaveBeenCalled();
    await f.relay.close();
    expect(f.room.disconnect).toHaveBeenCalledWith(false);
  });
});
