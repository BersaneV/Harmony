import { describe, expect, it } from "vitest";
import {
  can,
  canSendMessage,
  hasBit,
  overrideState,
  parsePermissions,
  Permission,
  permissionDefinitions,
  setOverride,
  setPermission,
} from "./permissions";
describe("permissões efetivas recebidas do servidor", () => {
  it("mapeia explicitamente os seis bits do contrato", () => {
    expect(permissionDefinitions.map((value) => value.bit)).toEqual([
      1, 2, 4, 8, 16, 32,
    ]);
    expect(
      permissionDefinitions.every((value) =>
        can({ effective_permissions: "63" }, value.bit),
      ),
    ).toBe(true);
  });
  it("sem VIEW bloqueia todos os controles, mesmo que outros bits estejam presentes", () => {
    for (const definition of permissionDefinitions)
      expect(can({ effective_permissions: "62" }, definition.bit)).toBe(false);
  });
  it("ouvinte pode conectar sem ganhar publicação, envio, anexo ou reação", () => {
    const channel = { effective_permissions: "17" };
    expect(can(channel, Permission.View)).toBe(true);
    expect(can(channel, Permission.Connect)).toBe(true);
    for (const bit of [
      Permission.Send,
      Permission.Attach,
      Permission.React,
      Permission.Publish,
    ])
      expect(can(channel, bit)).toBe(false);
  });
  it("não infere autorização quando campo ausente, inválido ou fora do contrato", () => {
    for (const value of [
      undefined,
      null,
      63,
      "64",
      "-1",
      "3.5",
      "Infinity",
      "1e1",
      " 63",
      "0x3f",
      "999999999999999999999",
    ])
      expect(parsePermissions(value)).toBe(0n);
    expect(can(undefined, Permission.Send)).toBe(false);
    expect(can({ effective_permissions: "0" }, Permission.View)).toBe(false);
  });
  it("mensagem com anexo já preparado exige ATTACH no momento do envio", () => {
    const channel = { effective_permissions: "3" };
    expect(canSendMessage(channel, 0)).toBe(true);
    expect(canSendMessage(channel, 1)).toBe(false);
    expect(canSendMessage({ effective_permissions: "7" }, 1)).toBe(true);
    expect(canSendMessage(channel, -1)).toBe(false);
  });
  it("desmarcar um bit não altera os demais", () => {
    const reduced = setPermission("63", Permission.Attach, false);
    expect(reduced).toBe("59");
    expect(hasBit(reduced, Permission.Send)).toBe(true);
    expect(hasBit(reduced, Permission.Attach)).toBe(false);
    expect(setPermission(reduced, Permission.Attach, true)).toBe("63");
  });
});
describe("exceções triestado de canal", () => {
  it("nunca mantém o mesmo bit simultaneamente em permitir e negar", () => {
    const before = { role_id: "role-id", allow: "3", deny: "4" };
    const denied = setOverride(before, Permission.Send, "deny");
    expect(denied).toEqual({ role_id: "role-id", allow: "1", deny: "6" });
    expect(overrideState(denied, Permission.Send)).toBe("deny");
    const allowed = setOverride(denied, Permission.Send, "allow");
    expect(allowed).toEqual(before);
    expect(overrideState(allowed, Permission.Send)).toBe("allow");
  });
  it("Herdar remove a exceção somente do bit escolhido e preserva o alvo Todos", () => {
    const after = setOverride(
      { role_id: null, allow: "0", deny: "2" },
      Permission.Send,
      "inherit",
    );
    expect(after).toEqual({ role_id: null, allow: "0", deny: "0" });
    expect(overrideState(after, Permission.Send)).toBe("inherit");
  });
});
