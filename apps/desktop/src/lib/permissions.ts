import type { Channel, ChannelOverride } from "./types";
export const permissionDefinitions = [
  {
    bit: 1,
    name: "Ver canal",
    description: "Ver o canal, o histórico e os arquivos disponíveis.",
  },
  {
    bit: 2,
    name: "Enviar mensagens",
    description: "Enviar mensagens e editar as próprias mensagens.",
  },
  {
    bit: 4,
    name: "Anexar arquivos",
    description: "Reservar e enviar arquivos neste canal.",
  },
  {
    bit: 8,
    name: "Adicionar reações",
    description: "Adicionar ou remover suas reações.",
  },
  {
    bit: 16,
    name: "Entrar em chamadas",
    description: "Conectar para ouvir e assistir.",
  },
  {
    bit: 32,
    name: "Transmitir mídia",
    description: "Publicar microfone, câmera e tela.",
  },
] as const;
export const Permission = {
  View: 1,
  Send: 2,
  Attach: 4,
  React: 8,
  Connect: 16,
  Publish: 32,
} as const;
export type PermissionBit = (typeof permissionDefinitions)[number]["bit"];
export type OverrideState = "inherit" | "allow" | "deny";
export function parsePermissions(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return 0n;
  const parsed = BigInt(value);
  return parsed <= 63n ? parsed : 0n;
}
export function hasBit(value: unknown, bit: PermissionBit) {
  return (parsePermissions(value) & BigInt(bit)) === BigInt(bit);
}
export function setPermission(
  value: string,
  bit: PermissionBit,
  enabled: boolean,
) {
  const current = parsePermissions(value),
    mask = BigInt(bit);
  return (enabled ? current | mask : current & ~mask).toString();
}
export function can(
  channel: Pick<Channel, "effective_permissions"> | null | undefined,
  bit: PermissionBit,
) {
  const value = channel?.effective_permissions;
  return hasBit(value, Permission.View) && hasBit(value, bit);
}
export function overrideState(
  override: Pick<ChannelOverride, "allow" | "deny">,
  bit: PermissionBit,
): OverrideState {
  return hasBit(override.allow, bit)
    ? "allow"
    : hasBit(override.deny, bit)
      ? "deny"
      : "inherit";
}
export function setOverride(
  override: ChannelOverride,
  bit: PermissionBit,
  state: OverrideState,
): ChannelOverride {
  return {
    ...override,
    allow: setPermission(override.allow, bit, state === "allow"),
    deny: setPermission(override.deny, bit, state === "deny"),
  };
}

export function canSendMessage(
  channel: Pick<Channel, "effective_permissions"> | null | undefined,
  attachmentCount: number,
) {
  return (
    Number.isSafeInteger(attachmentCount) &&
    attachmentCount >= 0 &&
    can(channel, Permission.Send) &&
    (attachmentCount === 0 || can(channel, Permission.Attach))
  );
}
