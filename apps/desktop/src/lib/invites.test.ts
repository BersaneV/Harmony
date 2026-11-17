import { describe, expect, it } from "vitest";
import {
  inviteLink,
  nativeInviteLink,
  parseInvite,
  parseInviteInput,
  loadInvite,
  storeInvite,
} from "./invites";

const server = "https://community.example.org";
const token = "a1".repeat(32);
const invite = { server, token };

describe("convites clicáveis", () => {
  it("gera link HTTPS com o código no fragmento, sem enviar na requisição", () => {
    const link = inviteLink(invite);
    expect(link).toBe(`${server}/#/invite/${token}`);
    expect(new URL(link).search).toBe("");
    expect(parseInvite(link)).toEqual(invite);
  });
  it("entrega o mesmo convite pelo protocolo desktop", () => {
    expect(parseInvite(nativeInviteLink(invite))).toEqual(invite);
  });
  it("continua aceitando o código e também aceita o link colado", () => {
    expect(parseInviteInput(token, server)).toEqual(invite);
    expect(parseInviteInput(inviteLink(invite), server)).toEqual(invite);
  });
  it.each([
    `https://secret@community.example.org/#/invite/${token}`,
    `http://community.example.org/#/invite/${token}`,
    `${server}/another/#/invite/${token}`,
    `${server}/?tracking=1#/invite/${token}`,
    `${server}/#/invite/${token.slice(1)}`,
    `harmony://other?server=${server}&code=${token}`,
    `harmony://invite?server=${server}&code=${token}&code=${token}`,
    `harmony://invite?server=${server}&code=${token}&redirect=https://evil.invalid`,
    `harmony://invite?server=http://evil.invalid&code=${token}`,
  ])("recusa convite malformado: %s", (input) => {
    expect(parseInvite(input)).toBeNull();
  });
  it("não usa a sessão atual em servidor indicado por outro convite", () => {
    expect(() =>
      parseInviteInput(inviteLink(invite), "https://other.example.org"),
    ).toThrow(/outro servidor/);
  });
  it("mantém o convite durante login, cadastro e recarregamento e permite cancelar", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    storeInvite(invite, storage);
    expect(loadInvite(storage)).toEqual(invite);
    storeInvite(null, storage);
    expect(loadInvite(storage)).toBeNull();
  });
  it("ignora storage indisponível ou conteúdo adulterado", () => {
    expect(
      loadInvite({
        getItem: () => '{"server":"https://evil@host","token":"x"}',
      }),
    ).toBeNull();
    expect(
      loadInvite({
        getItem: () => {
          throw new Error("disabled");
        },
      }),
    ).toBeNull();
    expect(() =>
      storeInvite(invite, {
        setItem: () => {
          throw new Error("disabled");
        },
        removeItem() {},
      }),
    ).not.toThrow();
  });
});
