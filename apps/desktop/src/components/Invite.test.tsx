import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Invite from "./Invite";

const invite = {
  server: "https://community.example.org",
  token: "a1".repeat(32),
};
const noop = () => {};
describe("entrada pelo link", () => {
  it("oferece aplicativo, navegador e instalador sem exibir campo para código", () => {
    const html = renderToStaticMarkup(
      createElement(Invite, {
        invite,
        desktop: false,
        authenticated: false,
        server: invite.server,
        onJoined: noop,
        onDismiss: noop,
      }),
    );
    expect(html).toContain("Abrir no Harmony");
    expect(html).toContain("harmony://invite?");
    expect(html).toContain("Continuar no navegador");
    expect(html).toContain("Baixar para Windows");
    expect(html).not.toContain("Código de convite");
  });
  it("oferece confirmação autenticada de entrada", () => {
    const html = renderToStaticMarkup(
      createElement(Invite, {
        invite,
        desktop: true,
        authenticated: true,
        server: invite.server,
        onJoined: noop,
        onDismiss: noop,
      }),
    );
    expect(html).toContain("Entrar na comunidade");
    expect(html).not.toContain("Continuar no navegador");
  });
  it("exige escolher o servidor correto antes de permitir a entrada", () => {
    const html = renderToStaticMarkup(
      createElement(Invite, {
        invite,
        desktop: true,
        authenticated: true,
        server: "https://other.example.org",
        onJoined: noop,
        onDismiss: noop,
      }),
    );
    expect(html).toContain("outro servidor");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
