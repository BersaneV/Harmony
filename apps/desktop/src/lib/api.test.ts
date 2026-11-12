import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) || null,
  setItem: (key: string, value: string) => storage.set(key, value),
});
let client: typeof import("./api");
const user = {
  id: "user",
  username: "example",
  display_name: "Example",
  is_admin: false,
  disabled: false,
  preferences: {},
  created_at: "2026-01-01T00:00:00Z",
};
const session = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  user,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  client = await import("./api");
});
describe("origens e sessão", () => {
  it("aceita HTTPS e loopback, rejeita destinos inseguros/credenciais/caminhos", () => {
    expect(client.normalizeServer("https://chat.example.org/")).toBe(
      "https://chat.example.org",
    );
    expect(client.normalizeServer("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    for (const value of [
      "http://example.org",
      "file:///tmp",
      "https://secret@example.org",
      "https://example.org/api",
      "https://example.org?token=x",
    ])
      expect(() => client.normalizeServer(value)).toThrow();
  });
  it("rotaciona uma única vez para solicitações concorrentes de refresh", async () => {
    await client.saveSession(session);
    const fetcher = vi.fn(async () =>
      json({
        ...session,
        access_token: "rotated",
        refresh_token: "rotated-refresh",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await Promise.all([client.refreshSession(), client.refreshSession()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.getSession()?.access_token).toBe("rotated");
    expect(storage.has("token")).toBe(false);
  });
  it("uma resposta de refresh atrasada não restaura uma sessão encerrada", async () => {
    await client.saveSession(session);
    let resolveRefresh!: (value: Response) => void;
    const fetcher = vi.fn((url: string) =>
      url.endsWith("/refresh")
        ? new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          })
        : Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetcher);
    const pending = client.refreshSession();
    const rejection = expect(pending).rejects.toThrow("A sessão mudou");
    await client.logout();
    resolveRefresh(json({ ...session, access_token: "stale" }));
    await rejection;
    expect(client.getSession()).toBeNull();
  });
  it("não move credenciais de uma instância para outra", async () => {
    await client.saveSession(session);
    let resolveRefresh!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    );
    const pending = client.refreshSession();
    const rejection = expect(pending).rejects.toThrow("A sessão mudou");
    await client.setServer("https://second.example.org");
    resolveRefresh(json({ ...session, access_token: "wrong-origin" }));
    await rejection;
    expect(client.getServer()).toBe("https://second.example.org");
    expect(client.getSession()).toBeNull();
  });
  it("descarta um corpo HTTP que termina depois do logout", async () => {
    await client.saveSession(session);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/logout")
          ? new Response(null, { status: 204 })
          : new Response(stream, {
              headers: { "Content-Type": "application/json" },
            }),
      ),
    );
    const pending = client.api("/api/me");
    const rejection = expect(pending).rejects.toThrow("A sessão mudou");
    await Promise.resolve();
    await Promise.resolve();
    await client.logout();
    controller.enqueue(new TextEncoder().encode(JSON.stringify(user)));
    controller.close();
    await rejection;
    expect(client.getSession()).toBeNull();
  });
  it("informa revogação ou expiração quando o refresh real é recusado", async () => {
    await client.saveSession(session);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          { error: { code: "invalid_session", message: "Sessão inválida" } },
          401,
        ),
      ),
    );
    await expect(client.refreshSession()).rejects.toThrow("Sessão inválida");
    expect(client.getSession()).toBeNull();
    expect(client.getSessionNotice()).toContain("expirou ou foi revogada");
  });
  it("reenvia uma requisição autenticada com o novo access token depois de 401", async () => {
    await client.saveSession(session);
    const requests: string[] = [];
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/refresh"))
          return json({ ...session, access_token: "new-access" });
        requests.push(
          (options.headers as Record<string, string>).Authorization,
        );
        if (first) {
          first = false;
          return json({ error: { code: "expired", message: "expired" } }, 401);
        }
        return json({ ok: true });
      }),
    );
    expect(await client.api("/api/me")).toEqual({ ok: true });
    expect(requests).toEqual(["Bearer synthetic-access", "Bearer new-access"]);
  });
});
