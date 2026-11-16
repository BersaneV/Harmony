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

import { LocalParticipant as RealParticipant } from "livekit-client";
import { ScreenRelay, type ScreenRelayAuthority } from "./screen-relay";

const uuid = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const relays = new Set<ScreenRelay>();
afterEach(async () => {
  for (const relay of relays) await relay.close();
  relays.clear();
  contract.rooms.length = 0;
});
async function connected() {
  const onLocalPublication = vi.fn();
  const relay = new ScreenRelay({
    onAck: vi.fn(),
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
  };
}

describe("ScreenRelay: contrato real de republicação do SDK fixado", () => {
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
