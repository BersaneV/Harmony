import { normalizeServer } from "./api";

export interface CommunityInvite {
  server: string;
  token: string;
}
const code = /^[a-f0-9]{64}$/;
const storageKey = "harmony.pending-invite";

export function inviteLink(invite: CommunityInvite): string {
  if (!code.test(invite.token)) throw new Error("Convite inválido.");
  return `${normalizeServer(invite.server)}/#/invite/${invite.token}`;
}

export function nativeInviteLink(invite: CommunityInvite): string {
  inviteLink(invite);
  const params = new URLSearchParams({
    server: normalizeServer(invite.server),
    code: invite.token,
  });
  return `harmony://invite?${params}`;
}

export function parseInvite(input: string): CommunityInvite | null {
  if (input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password) return null;
    if (url.protocol === "harmony:") {
      if (
        url.hostname !== "invite" ||
        url.port ||
        !["", "/"].includes(url.pathname) ||
        url.hash
      )
        return null;
      const keys = [...url.searchParams.keys()];
      if (
        keys.length !== 2 ||
        !keys.includes("server") ||
        !keys.includes("code")
      )
        return null;
      const token = url.searchParams.get("code")!;
      if (!code.test(token)) return null;
      return {
        server: normalizeServer(url.searchParams.get("server")!),
        token,
      };
    }
    const token = url.hash.match(/^#\/invite\/([a-f0-9]{64})$/)?.[1];
    if (!token || url.pathname !== "/" || url.search) return null;
    return { server: normalizeServer(url.origin), token };
  } catch {
    return null;
  }
}

export function parseInviteInput(
  input: string,
  server: string,
): CommunityInvite {
  const value = input.trim();
  const invite = code.test(value)
    ? { server: normalizeServer(server), token: value }
    : parseInvite(value);
  if (!invite)
    throw new Error(
      "Convite inválido. Abra o link recebido ou cole um convite válido.",
    );
  if (invite.server !== normalizeServer(server))
    throw new Error(
      "Este convite pertence a outro servidor. Selecione essa instância na tela de acesso antes de continuar.",
    );
  return invite;
}

export function loadInvite(
  storage?: Pick<Storage, "getItem">,
): CommunityInvite | null {
  try {
    const value = JSON.parse(
      (storage ?? sessionStorage).getItem(storageKey) || "null",
    );
    if (
      !value ||
      typeof value.server !== "string" ||
      typeof value.token !== "string"
    )
      return null;
    return parseInvite(inviteLink(value));
  } catch {
    return null;
  }
}

export function storeInvite(
  invite: CommunityInvite | null,
  storage?: Pick<Storage, "setItem" | "removeItem">,
) {
  try {
    const target = storage ?? sessionStorage;
    if (invite)
      target.setItem(
        storageKey,
        JSON.stringify(parseInvite(inviteLink(invite))),
      );
    else target.removeItem(storageKey);
  } catch {
    /* The in-memory invitation still survives authentication. */
  }
}
