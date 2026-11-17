import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { audioDiagnostics, playbackSnapshot } from "./audio-diagnostics";

let nativePending = false;
export async function sampleWindowsAudio(
  includeNames = false,
): Promise<unknown> {
  if (!isTauri()) return { supported: false, reason: "browser" };
  if (nativePending) return { supported: true, status: "busy" };
  nativePending = true;
  try {
    return await invoke("audio_diagnostic_snapshot", { includeNames });
  } catch {
    return { supported: true, status: "unavailable" };
  } finally {
    nativePending = false;
  }
}
export function useAudioDiagnostics(
  snapshot: () => unknown,
  engine: "p2p" | "livekit",
) {
  const current = useRef(snapshot);
  current.current = snapshot;
  useEffect(() => {
    let active = true,
      count = 0;
    const sample = () => {
      try {
        audioDiagnostics.add("sample", {
          call: current.current(),
          playback: playbackSnapshot(document.querySelectorAll("audio")),
        });
      } catch {
        /* Diagnostics must not affect media. */
      }
      if (count++ % 2 === 0)
        void sampleWindowsAudio().then((value) => {
          if (active) audioDiagnostics.add("sample", { windows: value });
        });
    };
    const change = () => {
      audioDiagnostics.add("device-change", {});
      sample();
    };
    audioDiagnostics.add("call-start", { engine });
    sample();
    const timer = setInterval(sample, 5000);
    navigator.mediaDevices?.addEventListener("devicechange", change);
    return () => {
      active = false;
      clearInterval(timer);
      navigator.mediaDevices?.removeEventListener("devicechange", change);
      audioDiagnostics.add("call-end", { engine });
    };
  }, [engine]);
}
