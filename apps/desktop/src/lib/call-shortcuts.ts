export type CallKeyAction = "ptt" | "microphone" | "deafen";
export type CallKeys = Record<CallKeyAction, string>;
export function validShortcut(value: string): boolean {
  if (!value) return true;
  if (value.length > 64 || ["Alt+F4", "Ctrl+Alt+Delete"].includes(value))
    return false;
  const parts = value.split("+"),
    key = parts.pop()!;
  if (
    parts.join("+") !==
    ["Ctrl", "Alt", "Shift"].filter((m) => parts.includes(m)).join("+")
  )
    return false;
  const special =
    /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ||
    [
      "ScrollLock",
      "CapsLock",
      "Pause",
      "Insert",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "PrintScreen",
    ].includes(key);
  const ordinary =
    /^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/.test(key) ||
    [
      "Space",
      "Tab",
      "Enter",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Equal",
      "Minus",
      "Comma",
      "Period",
      "Slash",
      "Backquote",
      "BracketLeft",
      "BracketRight",
      "Backslash",
      "Semicolon",
      "Quote",
    ].includes(key);
  return (
    special || (ordinary && (parts.includes("Ctrl") || parts.includes("Alt")))
  );
}
export function shortcutFromEvent(
  e: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
): string | null {
  if (e.metaKey) return null;
  const value = [
    e.ctrlKey ? "Ctrl" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    e.code,
  ]
    .filter(Boolean)
    .join("+");
  return validShortcut(value) ? value : null;
}
export const shortcutLabel = (value: string) =>
  value
    .replace(/Key([A-Z])/g, "$1")
    .replace(/Digit([0-9])/g, "$1")
    .replace("ScrollLock", "Scroll Lock");
export const defaultCallKeys: CallKeys = {
  ptt: "F9",
  microphone: "",
  deafen: "",
};
const storageKey = "harmony.call-keys.v1";
export function validCallKeys(value: unknown): value is CallKeys {
  if (!value || typeof value !== "object") return false;
  const keys = value as CallKeys;
  const values = [keys.ptt, keys.microphone, keys.deafen];
  return (
    values.every((k) => typeof k === "string" && validShortcut(k)) &&
    new Set(values.filter(Boolean)).size === values.filter(Boolean).length
  );
}
export function readCallKeys(): CallKeys {
  try {
    const v = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (validCallKeys(v))
      return { ptt: v.ptt, microphone: v.microphone, deafen: v.deafen };
  } catch {
    /* Keep usable defaults. */
  }
  return { ...defaultCallKeys };
}
export function saveCallKeys(keys: CallKeys) {
  if (!validCallKeys(keys))
    throw new Error("Escolha atalhos diferentes para cada ação.");
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(keys));
  } catch {
    throw new Error("Não foi possível salvar os atalhos neste dispositivo.");
  }
  window.dispatchEvent(new Event("harmony-call-keys"));
}
export function matchesCallKey(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
  key: string,
) {
  if (!key) return false;
  const pieces = key.split("+"),
    last = pieces.at(-1)!;
  return (
    event.code === last &&
    event.ctrlKey === pieces.includes("Ctrl") &&
    event.altKey === pieces.includes("Alt") &&
    event.shiftKey === pieces.includes("Shift") &&
    !event.metaKey
  );
}
