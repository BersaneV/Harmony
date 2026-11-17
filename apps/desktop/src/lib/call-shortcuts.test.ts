import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validShortcut,
  validCallKeys,
  shortcutFromEvent,
  matchesCallKey,
  readCallKeys,
  saveCallKeys,
} from "./call-shortcuts";
beforeEach(() => {
  const storage = new Map<string, string>();
  const window = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
  });
  vi.stubGlobal("window", window);
});
afterEach(() => vi.unstubAllGlobals());
describe("custom call keybinds", () => {
  it("preserves reserved system combinations",()=>{expect(validShortcut("Alt+F4")).toBe(false);expect(validShortcut("Ctrl+Alt+Delete")).toBe(false);});
  it.each([
    "ScrollLock",
    "F9",
    "F24",
    "Ctrl+Shift+KeyM",
    "Ctrl+Alt+Digit1",
    "Shift+ScrollLock",
  ])("accepts supported key %s", (key) =>
    expect(validShortcut(key)).toBe(true),
  );
  it.each([
    "KeyM",
    "Shift+KeyM",
    "Digit1",
    "Ctrl+Ctrl+KeyM",
    "Shift+Ctrl+KeyM",
    "F25",
    "Meta+KeyM",
    "anything",
    "Alt+F4",
    "Ctrl+Alt+Delete",
  ])("rejects unsupported or typing conflicts %s", (key) =>
    expect(validShortcut(key)).toBe(false),
  );
  it("captures Scroll Lock and modifiers, persists choices and rejects duplicate actions", () => {
    const e = {
      code: "ScrollLock",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };
    expect(shortcutFromEvent(e)).toBe("ScrollLock");
    expect(matchesCallKey(e, "ScrollLock")).toBe(true);
    expect(matchesCallKey({ ...e, shiftKey: true }, "ScrollLock")).toBe(false);
    const keys = {
      ptt: "F9",
      microphone: "ScrollLock",
      deafen: "Ctrl+Shift+KeyD",
    };
    saveCallKeys(keys);
    expect(readCallKeys()).toEqual(keys);
    expect(validCallKeys({ ...keys, ptt: "ScrollLock" })).toBe(false);
    expect(() => saveCallKeys({ ...keys, ptt: "ScrollLock" })).toThrow();
    expect(readCallKeys()).toEqual(keys);
  });
});
