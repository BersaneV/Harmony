import { describe, expect, it, vi } from "vitest";
import { observeNativeInvites } from "./invites-native";

describe("entrega de links pelo aplicativo", () => {
  it("escuta novas aberturas antes de ler o link inicial e encerra o listener", async () => {
    const order: string[] = [],
      received: string[] = [];
    let emit: (urls: string[]) => void = () => {};
    const stop = vi.fn();
    const cleanup = await observeNativeInvites((url) => received.push(url), {
      onOpenUrl: async (callback) => {
        order.push("listen");
        emit = callback;
        return stop;
      },
      getCurrent: async () => {
        order.push("initial");
        return ["cold-start"];
      },
    });
    emit(["already-running"]);
    expect(order).toEqual(["listen", "initial"]);
    expect(received).toEqual(["cold-start", "already-running"]);
    cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("não duplica a entrega que chegar entre listener e leitura inicial", async () => {
    const received: string[] = [];
    await observeNativeInvites((url) => received.push(url), {
      onOpenUrl: async (callback) => {
        callback(["same-link"]);
        return () => {};
      },
      getCurrent: async () => ["same-link"],
    });
    expect(received).toEqual(["same-link"]);
  });
  it("libera o listener quando a leitura inicial falha", async () => {
    const stop = vi.fn();
    await expect(
      observeNativeInvites(() => {}, {
        onOpenUrl: async () => stop,
        getCurrent: async () => {
          throw new Error("plugin unavailable");
        },
      }),
    ).rejects.toThrow("plugin unavailable");
    expect(stop).toHaveBeenCalledOnce();
  });
});
