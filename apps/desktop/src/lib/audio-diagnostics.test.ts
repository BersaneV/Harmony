import { describe, it, expect } from "vitest";
import {
  AudioDiagnosticLog,
  audioDeviceReference,
  browserAudioInventory,
  audioErrorCode,
  audioTrack,
  p2pAudioSnapshot,
  playbackSnapshot,
} from "./audio-diagnostics";
import type { CallSnapshot } from "./call";

const secret = "DO_NOT_EXPORT_token_password_192.0.2.88";
const track = {
  kind: "audio",
  id: secret,
  label: secret,
  enabled: true,
  muted: false,
  readyState: "live",
  getSettings: () => ({
    deviceId: secret,
    groupId: secret,
    sampleRate: 48000,
    channelCount: 2,
    echoCancellation: false,
    suppressLocalAudioPlayback: false,
  }),
} as unknown as MediaStreamTrack;

describe("audio report privacy and bounds", () => {
  it("projects call fields, omitting identity, raw errors, URLs, network candidates and device IDs", () => {
    const metric = {
      bitrate: 48000,
      audioLevel: 0.1,
      packetsLost: 0,
      jitterMs: 4,
      sourceRef: secret,
      publicationSid: secret,
    };
    const state = {
      state: "connected",
      reason: secret,
      self: { user_id: secret },
      localTracks: { microphone: track, screen_audio: track },
      participants: [
        {
          peer_id: secret,
          user_id: secret,
          display_name: secret,
          error: secret,
          connection: "connected",
          tracks: { microphone: track },
          stats: {
            route: "direct",
            received: { microphone: metric },
            sent: { microphone: metric },
          },
        },
      ],
    } as unknown as CallSnapshot;
    const snapshot = p2pAudioSnapshot(state, false, secret, secret);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.input).toBe("custom");
    expect(snapshot.peers[0].receivedVoice?.audioLevel).toBe(0.1);
    expect(snapshot.screenAudio?.suppressLocalAudioPlayback).toBe(false);
  });
  it("never serializes raw playback errors or sources", () => {
    const element = {
      paused: false,
      muted: false,
      volume: 0.5,
      readyState: 4,
      error: { code: 3, message: secret },
      sinkId: secret,
      src: secret,
      srcObject: { secret },
    };
    const snapshot = playbackSnapshot([element as unknown as HTMLMediaElement]);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot[0]).toMatchObject({
      volume: 0.5,
      errorCode: 3,
      output: "custom",
    });
    expect(audioErrorCode({ name: "NotAllowedError", message: secret })).toBe(
      "NotAllowedError",
    );
    expect(audioErrorCode({ name: secret, message: secret })).toBe("unknown");
  });
  it("expires old data, caps memory, clones snapshots, and clears history", () => {
    let now = 1_000_000;
    const log = new AudioDiagnosticLog(() => now);
    const value = { enabled: true };
    log.add("sample", value);
    value.enabled = false;
    expect(log.report("test").entries[0].data).toEqual({ enabled: true });
    for (let i = 0; i < 250; i++) log.add("sample", { n: i });
    expect(log.report("test").entries).toHaveLength(180);
    log.add("sample", { padding: "x".repeat(650_000) });
    expect(
      new TextEncoder().encode(JSON.stringify(log.report("test"))).length,
    ).toBeLessThan(601_000);
    now += 600_001;
    expect(log.report("test").entries).toHaveLength(0);
    log.add("call-end", {});
    log.clear();
    expect(log.report("test").entries).toHaveLength(0);
  });
  it("correlates custom selections to browser inventory without persistent IDs or names by default", () => {
    const devices = [
      {
        deviceId: secret,
        groupId: secret,
        kind: "audiooutput",
        label: "Fone de teste",
      },
    ] as MediaDeviceInfo[];
    const ref = audioDeviceReference(secret);
    const inventory = browserAudioInventory(devices, false);
    expect(inventory[0]).toEqual({
      device: ref,
      kind: "audiooutput",
      name: null,
    });
    expect(JSON.stringify(inventory)).not.toContain(secret);
    expect(browserAudioInventory(devices, true)[0].name).toBe("Fone de teste");
    for (let i = 0; i < 140; i++) audioDeviceReference(`unique-${i}`);
    expect(audioDeviceReference("beyond-bound")).toBe("browser-other");
  });
  it("handles missing/ended tracks without opening a microphone", () => {
    expect(audioTrack(undefined)).toBe(null);
    const ended = {
      ...track,
      readyState: "ended",
      getSettings: () => {
        throw new Error(secret);
      },
    } as unknown as MediaStreamTrack;
    expect(audioTrack(ended)).toMatchObject({
      state: "ended",
      sampleRate: null,
    });
  });
});
