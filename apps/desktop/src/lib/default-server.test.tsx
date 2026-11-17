import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => runtime.desktop,
  invoke: vi.fn(),
}));

const online = "https://harmony.go.altare.global";
const storage = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  runtime.desktop = true;
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", {
    location: { protocol: "http:", origin: "http://tauri.localhost" },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("servidor inicial e acesso sem configuração", () => {
  it("abre uma instalação desktop nova no servidor online", async () => {
    expect((await import("./api")).getServer()).toBe(online);
  });

  it.each(["https://outra.example.org", "http://127.0.0.1:8080"])(
    "preserva o servidor já escolhido: %s",
    async (saved) => {
      storage.set("harmony.server", saved);
      expect((await import("./api")).getServer()).toBe(saved);
    },
  );

  it("usa o servidor online se o endereço salvo for inválido", async () => {
    storage.set("harmony.server", "https://credencial@outra.example.org");
    expect((await import("./api")).getServer()).toBe(online);
  });

  it("usa o servidor online mesmo se o armazenamento estiver indisponível", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage unavailable");
      },
    });
    expect((await import("./api")).getServer()).toBe(online);
  });

  it("preserva a origem de uma instalação web HTTPS independente", async () => {
    runtime.desktop = false;
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        origin: "https://comunidade.example.org",
      },
    });
    expect((await import("./api")).getServer()).toBe(
      "https://comunidade.example.org",
    );
  });

  it("preserva o servidor local para desenvolvimento web em HTTP", async () => {
    runtime.desktop = false;
    expect((await import("./api")).getServer()).toBe("http://127.0.0.1:8080");
  });

  it("mostra acesso e cadastro com o servidor preenchido em opção recolhida", async () => {
    const { default: Auth } = await import("../components/Auth");
    const html = renderToStaticMarkup(createElement(Auth));
    expect(html).toContain('value="' + online + '"');
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>Usar outro servidor<\/summary>/,
    );
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Criar uma conta");
  });
});
