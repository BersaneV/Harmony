import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioCheck,
  microphoneCheckActive,
  registerAudioCheckMute,
  stopAudioChecks,
  testTone,
} from "./audio-check";
const input = () => {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
};
let media = vi.fn(),
  audios: FakeAudio[] = [],
  contexts: FakeContext[] = [];
class FakeAudio {
  volume = 1;
  srcObject: unknown;
  src = "";
  onended?: () => void;
  setSinkId = vi.fn(async () => {});
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor() {
    audios.push(this);
  }
}
class FakeContext {
  monitor = input();
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 1024,
    connect: vi.fn(),
    getFloatTimeDomainData: (v: Float32Array) => v.fill(0.1),
  }));
  createMediaStreamDestination = vi.fn(() => ({ stream: this.monitor }));
  constructor() {
    contexts.push(this);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  audios = [];
  contexts = [];
  media = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: media } });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:temporary");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  stopAudioChecks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("local audio tests", () => {
  it("plays a bounded WAV on the selected output without requesting a microphone", async () => {
    const changed = vi.fn(),
      check = new AudioCheck(changed);
    expect(media).not.toHaveBeenCalled();
    const blob = testTone(),
      view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(48000);
    expect(blob.size).toBe(96044);
    expect(view.getInt16(24000, true)).not.toBe(0);
    await check.sound("chosen-output");
    expect(audios[0].setSinkId).toHaveBeenCalledWith("chosen-output");
    expect(audios[0].play).toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    check.stop();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:temporary");
  });
  it("mutes the call before capture, measures locally and releases input and monitor tracks", async () => {
    const stream = input(),
      order: string[] = [];
    media.mockImplementation(async () => {
      order.push("capture");
      return stream;
    });
    const unregister = registerAudioCheckMute(async () => {
        order.push("mute-call");
      }),
      changed = vi.fn(),
      check = new AudioCheck(changed);
    await check.microphone("chosen-input", "chosen-output");
    expect(order).toEqual(["mute-call", "capture"]);
    expect(media.mock.calls[0][0].audio.deviceId).toEqual({
      exact: "chosen-input",
    });
    expect(microphoneCheckActive()).toBe(true);
    expect(changed.mock.lastCall?.[0].level).toBe(40);
    check.stop();
    expect(stream.track.stop).toHaveBeenCalled();
    expect(contexts[0].monitor.track.stop).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
    expect(microphoneCheckActive()).toBe(false);
    unregister();
  });
  it("stops late permission results after closing instead of leaving the microphone open", async () => {
    let resolve!: (s: unknown) => void;
    media.mockReturnValue(new Promise((r) => (resolve = r)));
    const stream = input(),
      check = new AudioCheck(vi.fn());
    const pending = check.microphone("", "");
    await Promise.resolve();
    check.stop();
    resolve(stream);
    await pending;
    expect(stream.track.stop).toHaveBeenCalled();
    expect(contexts).toHaveLength(0);
    expect(microphoneCheckActive()).toBe(false);
  });
  it("times out after twenty seconds and reports permission denial without raw error text", async () => {
    const changed = vi.fn(),
      check = new AudioCheck(changed),
      stream = input();
    media.mockResolvedValue(stream);
    await check.microphone("", "");
    await vi.advanceTimersByTimeAsync(20000);
    expect(stream.track.stop).toHaveBeenCalled();
    expect(check.mode).toBe(null);
    media.mockRejectedValue({
      name: "NotAllowedError",
      message: "sensitive raw error",
    });
    await check.microphone("", "");
    expect(changed.mock.lastCall?.[0].message).toContain("Permita");
    expect(changed.mock.lastCall?.[0].message).not.toContain("sensitive");
  });
  it("cleans the microphone if the requested output fails and stops a previous local test", async () => {
    const first = input(),
      second = input();
    media.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const a = new AudioCheck(vi.fn()),
      b = new AudioCheck(vi.fn());
    await a.microphone("", "");
    await b.microphone("", "");
    expect(first.track.stop).toHaveBeenCalled();
    expect(a.mode).toBe(null);
    b.stop();
    expect(second.track.stop).toHaveBeenCalled();
  });
});
