import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

export async function observeNativeInvites(
  receive: (url: string) => void,
  plugin: {
    getCurrent: () => Promise<string[] | null>;
    onOpenUrl: (callback: (urls: string[]) => void) => Promise<() => void>;
  } = { getCurrent, onOpenUrl },
): Promise<() => void> {
  const duringStartup = new Set<string>();
  let starting = true;
  const stop = await plugin.onOpenUrl((urls) => {
    for (const url of urls) {
      if (starting) duringStartup.add(url);
      receive(url);
    }
  });
  try {
    for (const url of (await plugin.getCurrent()) ?? [])
      if (!duringStartup.has(url)) receive(url);
    starting = false;
    duringStartup.clear();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
