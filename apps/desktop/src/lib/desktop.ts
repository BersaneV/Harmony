import { invoke, isTauri } from "@tauri-apps/api/core";
export async function openExternal(href: string) {
  const url = new URL(href);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Apenas links HTTP e HTTPS são permitidos.");
  if (isTauri()) await invoke("open_external_url", { url: url.href });
  else window.open(url.href, "_blank", "noopener,noreferrer");
}
export async function enableNotifications() {
  if (isTauri()) {
    const { isPermissionGranted, requestPermission } =
      await import("@tauri-apps/plugin-notification");
    return (
      (await isPermissionGranted()) || (await requestPermission()) === "granted"
    );
  }
  return (
    "Notification" in window &&
    (await Notification.requestPermission()) === "granted"
  );
}
export async function notifyMessage(title: string, body: string) {
  if (document.visibilityState === "visible") return;
  if (isTauri()) {
    const { isPermissionGranted, sendNotification } =
      await import("@tauri-apps/plugin-notification");
    if (await isPermissionGranted()) sendNotification({ title, body });
  } else if ("Notification" in window && Notification.permission === "granted")
    new Notification(title, { body, icon: "/harmony.svg" });
}

let pttLease = 0;
export async function registerGlobalPtt(handler: (pressed: boolean) => void) {
  const lease = ++pttLease;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<boolean>("ptt-state", (event) =>
    handler(event.payload === true),
  );
  try {
    await invoke("set_push_to_talk", { enabled: true });
  } catch (error) {
    unlisten();
    throw error;
  }
  return async () => {
    unlisten();
    handler(false);
    if (lease === pttLease)
      await invoke("set_push_to_talk", { enabled: false });
  };
}
