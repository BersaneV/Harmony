export type AudioDeviceKind = "audioinput" | "audiooutput";
export type AudioDevices = Record<AudioDeviceKind, string>;
const key = "harmony.audio-devices.v1";

export function readAudioDevices(): AudioDevices {
  const devices = { audioinput: "", audiooutput: "" };
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) || "null");
    for (const kind of ["audioinput", "audiooutput"] as const) {
      const value = stored?.[kind];
      if (typeof value === "string" && value.length <= 1024)
        devices[kind] = value;
    }
  } catch {
    // Device access still works when browser storage is unavailable.
  }
  return devices;
}

export function saveAudioDevice(kind: AudioDeviceKind, value: string) {
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...readAudioDevices(), [kind]: value }),
    );
  } catch {
    // This choice remains active for the current call.
  }
}
