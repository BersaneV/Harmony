import { afterEach, expect, it, vi } from "vitest";
import { readAudioDevices, saveAudioDevice } from "./audio-devices";

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    },
  });
  return values;
}
afterEach(() => vi.unstubAllGlobals());
it("remembers a separate microphone and output across calls without changing Windows defaults", () => {
  storage();
  expect(readAudioDevices()).toEqual({ audioinput: "", audiooutput: "" });
  saveAudioDevice("audioinput", "usb-microphone");
  saveAudioDevice("audiooutput", "bluetooth-stereo");
  expect(readAudioDevices()).toEqual({
    audioinput: "usb-microphone",
    audiooutput: "bluetooth-stereo",
  });
  saveAudioDevice("audioinput", "");
  expect(readAudioDevices()).toEqual({
    audioinput: "",
    audiooutput: "bluetooth-stereo",
  });
});
it("ignores corrupted settings and keeps calls usable when storage is blocked", () => {
  const values = storage();
  values.set(
    "harmony.audio-devices.v1",
    '{"audioinput":42,"audiooutput":"valid"}',
  );
  expect(readAudioDevices()).toEqual({ audioinput: "", audiooutput: "valid" });
  values.set("harmony.audio-devices.v1", "invalid");
  expect(readAudioDevices()).toEqual({ audioinput: "", audiooutput: "" });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => {
        throw Error("denied");
      },
      setItem: () => {
        throw Error("denied");
      },
    },
  });
  expect(() => saveAudioDevice("audioinput", "usb")).not.toThrow();
  expect(readAudioDevices()).toEqual({ audioinput: "", audiooutput: "" });
});
