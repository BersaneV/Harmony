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
