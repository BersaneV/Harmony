import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { readCallKeys, matchesCallKey } from "./call-shortcuts";
import type { CallKeys } from "./call-shortcuts";
import { microphoneCheckActive } from "./audio-check";
let lease = 0,
  queue = Promise.resolve();
function bind(keys: CallKeys) {
  const pending = queue.then(() =>
    invoke<void>("set_call_shortcuts", { keys }),
  );
  queue = pending.catch(() => {});
  return pending;
}
export function useCallShortcuts(options: {
  active: boolean;
  ptt: boolean;
  canTalk: boolean;
  onPtt: (held: boolean) => void;
  microphone: () => void;
  deafen: () => void;
  error: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [keys, setKeys] = useState(readCallKeys);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    const changed = () => setKeys(readCallKeys());
    const capture = (e: Event) =>
      setRecording((e as CustomEvent<boolean>).detail === true);
    window.addEventListener("harmony-shortcut-capture", capture);
    window.addEventListener("harmony-call-keys", changed);
    return () => {
      window.removeEventListener("harmony-call-keys", changed);
      window.removeEventListener("harmony-shortcut-capture", capture);
    };
  }, []);
  useEffect(() => {
    if (!options.active || recording) return;
    if (options.ptt && !keys.ptt) {
      latest.current.onPtt(false);
      latest.current.error();
      return;
    }
    const mine = ++lease;
    let disposed = false,
      held = false;
    let unlisten: (() => void) | undefined;
    const ptt = (pressed: boolean) => {
      held = pressed;
      if (!pressed || (!microphoneCheckActive() && latest.current.canTalk))
        latest.current.onPtt(pressed);
    };
    const editing = () => {
      const t = document.activeElement;
      return (
        document.hasFocus() &&
        t instanceof HTMLElement &&
        (t.isContentEditable ||
          t.matches(
            'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,select',
          ))
      );
    };
    const action = (name: string, pressed: boolean) => {
      if (disposed) return;
      if (name === "ptt") {
        if (!latest.current.ptt) return;
        if (!pressed || !editing()) ptt(pressed);
        return;
      }
      if (!pressed || editing() || microphoneCheckActive()) return;
      if (
        name === "microphone" &&
        !latest.current.ptt &&
        latest.current.canTalk
      )
        latest.current.microphone();
      if (name === "deafen") latest.current.deafen();
    };
    const registered = {
      ...keys,
      ptt: options.ptt && options.canTalk ? keys.ptt : "",
    };
    if (options.ptt) ptt(false);
    if (isTauri())
      void (async () => {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<{ action: string; pressed: boolean }>(
          "call-shortcut",
          (e) => action(e.payload.action, e.payload.pressed),
        );
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        try {
          await bind(registered);
        } catch {
          if (!disposed) {
            ptt(false);
            latest.current.error();
          }
        }
      })().catch(() => {
        if (!disposed) {
          ptt(false);
          latest.current.error();
        }
      });
    const down = (e: KeyboardEvent) => {
      if (isTauri() || e.repeat || e.defaultPrevented || editing()) return;
      for (const name of ["ptt", "microphone", "deafen"] as const)
        if (matchesCallKey(e, registered[name])) {
          e.preventDefault();
          action(name, true);
          break;
        }
    };
    const up = () => {
      if (!isTauri() && held) ptt(false);
    };
    const blur = () => {
      if (!isTauri()) ptt(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      disposed = true;
      unlisten?.();
      if (options.ptt) ptt(false);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      if (isTauri() && mine === lease)
        void bind({ ptt: "", microphone: "", deafen: "" }).catch(() => {});
    };
  }, [
    options.active,
    recording,
    options.ptt,
    options.canTalk,
    keys.ptt,
    keys.microphone,
    keys.deafen,
  ]);
  return keys;
}
