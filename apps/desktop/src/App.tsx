import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Hash,
  Headphones,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Signal,
  Users,
  Volume2,
  WifiOff,
} from "lucide-react";
import {
  api,
  errorMessage,
  getSession,
  getServer,
  onSession,
  refreshSession,
} from "./lib/api";
import { normalizeTheme } from "./lib/theme";
import { activateTheme } from "./lib/themeRuntime";
import { themeScope } from "./lib/themeAssets";
import { useRealtime } from "./lib/useRealtime";
import { initials } from "./lib/messages";
import type {
  Channel,
  Guild,
  GuildRole,
  Instance,
  Items,
  Message,
  Session,
  User,
} from "./lib/types";
import { can, Permission } from "./lib/permissions";
import {
  RolesManager,
  MemberRoles,
  ChannelPermissions,
} from "./components/Roles";
import Auth from "./components/Auth";
import Chat from "./components/Chat";
import Friends from "./components/Friends";
import { Admin, Settings } from "./components/Settings";
import {
  Avatar,
  Empty,
  ErrorBanner,
  Field,
  IconButton,
  Loading,
  Modal,
} from "./components/ui";
const CallPanel = lazy(() => import("./components/CallPanel"));
export default function App() {
  const [session, setSession] = useState(getSession());
  const [restoring, setRestoring] = useState(isTauri());
  const cache = useQueryClient();
  const [appearanceWarning, setAppearanceWarning] = useState("");
  const appearance = JSON.stringify(session?.user.preferences?.theme ?? null);
  const appearanceScope = session
    ? themeScope(getServer(), session.user.id)
    : null;
  useEffect(
    () =>
      onSession((next) => {
        if (!next) cache.clear();
        setSession(next);
      }),
    [cache],
  );
  useEffect(() => {
    if (!isTauri()) return;
    void refreshSession()
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, []);
  useEffect(() => {
    let active = true;
    void activateTheme(normalizeTheme(JSON.parse(appearance)), appearanceScope)
      .then((warnings) => {
        if (active) setAppearanceWarning(warnings.join(" "));
      })
      .catch((error) => {
        if (active) setAppearanceWarning(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [appearance, appearanceScope]);
  if (restoring)
    return (
      <main className="restore-screen">
        <img src="/harmony.svg" alt="Harmony" />
        <Loading label="Abrindo seu espaço…" />
      </main>
    );
  return (
    <>
      {appearanceWarning && session && (
        <div className="appearance-warning" role="status">
          {appearanceWarning}
          <button onClick={() => setAppearanceWarning("")}>Dispensar</button>
        </div>
      )}
      {session ? (
        <Workspace key={appearanceScope} session={session} />
      ) : (
        <Auth />
      )}
    </>
  );
}
function Workspace({ session }: { session: Session }) {
  const user = session.user;
  const cache = useQueryClient();
  const [guildId, setGuildId] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [settings, setSettings] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [roleMemberId, setRoleMemberId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "guild" | "channel" | "join" | "invite" | null
  >(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "voice">("text");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{
    token: string;
    expires_at: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [call, setCall] = useState<Channel | null>(null);
  const [callExpanded, setCallExpanded] = useState(true);
  const [search, setSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const { connection, typing, sendTyping } = useRealtime(user.id);
  const guilds = useQuery({
    queryKey: ["guilds"],
    queryFn: () => api<Items<Guild>>("/api/guilds"),
  });
  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api<Items<Channel>>("/api/conversations"),
  });
  const channels = useQuery({
    queryKey: ["channels", guildId],
    queryFn: () => api<Items<Channel>>(`/api/guilds/${guildId}/channels`),
    enabled: !!guildId,
    refetchInterval: 15000,
  });
  const members = useQuery({
    queryKey: ["members", guildId],
    queryFn: () => api<Items<User>>(`/api/guilds/${guildId}/members`),
    enabled: !!guildId,
  });
  const roles = useQuery({
    queryKey: ["roles", guildId],
    queryFn: () => api<Items<GuildRole>>(`/api/guilds/${guildId}/roles`),
    enabled: !!guildId,
  });
  const callChannels = useQuery({
    queryKey: ["channels", call?.guild_id],
    queryFn: () =>
      api<Items<Channel>>(`/api/guilds/${call?.guild_id}/channels`),
    enabled: !!call?.guild_id,
    refetchInterval: 15000,
  });
  const instance = useQuery({
    queryKey: ["instance"],
    queryFn: () => api<Instance>("/api/instance", { anonymous: true }),
  });
  const searchResults = useQuery({
    queryKey: ["search", searchTerm, channel?.id],
    queryFn: () =>
      api<Items<Message>>(
        `/api/search?q=${encodeURIComponent(searchTerm)}${channel ? `&channel_id=${channel.id}` : ""}`,
      ),
    enabled: search && searchTerm.length >= 2,
  });
  const guild = guilds.data?.items.find((g) => g.id === guildId);
  const member = members.data?.items.find((m) => m.id === user.id);
  const canModerate = guild?.owner_id === user.id || member?.role === "admin";
  const visibleChannels = guildId
    ? channels.data?.items || []
    : conversations.data?.items || [];
  useEffect(() => {
    if (
      guildId &&
      !guilds.isPending &&
      guilds.data &&
      !guilds.data.items.some((g) => g.id === guildId)
    ) {
      setGuildId(null);
      setChannel(null);
    }
  }, [guildId, guilds.data, guilds.isPending]);
  useEffect(() => {
    if (guildId && channels.data) {
      if (channel?.guild_id === guildId) {
        const latest = channels.data.items.find(
          (item) => item.id === channel.id,
        );
        if (!latest || !can(latest, Permission.View)) {
          setChannel(null);
          setError(
            "Seu acesso ao canal foi removido. Escolha outro canal disponível.",
          );
        } else if (latest !== channel) setChannel(latest);
      } else if (!channel || channel.guild_id !== guildId) {
        const first = channels.data.items.find(
          (item) => item.kind === "text" && can(item, Permission.View),
        );
        if (first) setChannel(first);
      }
    }
  }, [guildId, channels.data, channel]);
  useEffect(() => {
    if (!guildId && channel && conversations.data) {
      const latest = conversations.data.items.find(
        (item) => item.id === channel.id,
      );
      if (latest && latest !== channel) setChannel(latest);
    }
  }, [guildId, channel, conversations.data]);
  useEffect(() => {
    if (call?.guild_id && callChannels.data) {
      const latest = callChannels.data.items.find(
        (item) => item.id === call.id,
      );
      if (!latest || !can(latest, Permission.Connect)) {
        setCall(null);
        setError(
          "Sua permissão de chamada foi removida. A conexão foi encerrada.",
        );
      } else if (latest !== call) setCall(latest);
    }
  }, [call, callChannels.data]);
  useEffect(() => {
    if (!canModerate) {
      setRolesOpen(false);
      setPermissionsOpen(false);
      setRoleMemberId(null);
    }
  }, [canModerate]);
  function openGuild(id: string | null) {
    setGuildId(id);
    setChannel(null);
    setMobileNav(false);
    setRolesOpen(false);
    setPermissionsOpen(false);
    setRoleMemberId(null);
  }
  function openChannel(next: Channel) {
    setChannel(next);
    setMobileNav(false);
    if (next.kind === "voice" && can(next, Permission.Connect)) {
      setCall(next);
      setCallExpanded(true);
    }
  }
  function openDialog(next: typeof dialog) {
    setError("");
    setName("");
    setInvite(null);
    setCopied(false);
    setKind("text");
    setDialog(next);
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (dialog === "guild") {
      const result = await api<Guild>("/api/guilds", {
        method: "POST",
        body: { name },
      });
      await cache.invalidateQueries({ queryKey: ["guilds"] });
      openGuild(result.id);
    } else if (dialog === "channel" && guildId) {
      const result = await api<Channel>(`/api/guilds/${guildId}/channels`, {
        method: "POST",
        body: { name, kind },
      });
      await cache.invalidateQueries({ queryKey: ["channels", guildId] });
      setChannel(result);
    } else if (dialog === "join") {
      const result = await api<Guild>("/api/invites/accept", {
        method: "POST",
        body: { token: name },
      });
      await cache.invalidateQueries({ queryKey: ["guilds"] });
      openGuild(result.id);
    }
    setDialog(null);
  }
  async function createInvite() {
    if (!guildId) return;
    setInvite(
      await api(`/api/guilds/${guildId}/invites`, {
        method: "POST",
        body: { expires_hours: 24, max_uses: 1 },
      }),
    );
    setCopied(false);
  }
  async function changeRole(target: User, role: "admin" | "member") {
    await api(`/api/guilds/${guildId}/members/${target.id}`, {
      method: "PATCH",
      body: { role },
    });
    await cache.invalidateQueries({ queryKey: ["members", guildId] });
  }
  async function removeMember(target: User) {
    await api(`/api/guilds/${guildId}/members/${target.id}`, {
      method: "DELETE",
    });
    await cache.invalidateQueries({ queryKey: ["members", guildId] });
  }
  return (
    <div className={`workspace ${mobileNav ? "mobile-nav-open" : ""}`}>
      <nav className="server-rail" aria-label="Comunidades">
        <button
          className={`home-button ${!guildId ? "selected" : ""}`}
          title="Conversas e amigos"
          onClick={() => openGuild(null)}
        >
          <img src="/harmony.svg" alt="Harmony" />
        </button>
        <div className="rail-divider" />
        {guilds.data?.items.map((g) => (
          <button
            key={g.id}
            title={g.name}
            aria-label={`Abrir ${g.name}`}
            className={`server-button ${guildId === g.id ? "selected" : ""}`}
            onClick={() => openGuild(g.id)}
          >
            {initials(g.name)}
          </button>
        ))}
        <button
          className="server-button add-server"
          title="Criar comunidade"
          onClick={() => openDialog("guild")}
        >
          <Plus size={24} />
        </button>
        <button
          className="server-button join-server"
          title="Entrar com convite"
          onClick={() => openDialog("join")}
        >
          <ArrowRight size={21} />
        </button>
        <div className="rail-spacer" />
        <button
          className="rail-settings"
          title="Preferências"
          onClick={() => setSettings(true)}
        >
          <Settings2 size={20} />
        </button>
      </nav>
      <aside className="channel-sidebar">
        <header className="sidebar-header">
          <div>
            <strong>{guild?.name || "Seu espaço"}</strong>
            <small>
              {guild ? "Sua comunidade" : instance.data?.name || "Harmony"}
            </small>
          </div>
          {guild && canModerate && (
            <IconButton
              label="Convidar para a comunidade"
              onClick={() => openDialog("invite")}
            >
              <ChevronDown size={19} />
            </IconButton>
          )}
        </header>
        {guild && canModerate && (
          <div className="guild-tools">
            <button className="text-button" onClick={() => setRolesOpen(true)}>
              <ShieldCheck size={14} />
              Cargos e permissões
            </button>
          </div>
        )}
        {!guildId && (
          <button
            className={`friends-link ${!channel ? "selected" : ""}`}
            onClick={() => setChannel(null)}
          >
            <Users size={20} />
            Amigos<span>Encontre sua turma</span>
          </button>
        )}
        <div className="channel-list">
          <div className="list-heading">
            <span>{guildId ? "CANAIS DE TEXTO" : "MENSAGENS DIRETAS"}</span>
            {guildId && canModerate && (
              <IconButton
                label="Criar canal"
                onClick={() => openDialog("channel")}
              >
                <Plus size={15} />
              </IconButton>
            )}
          </div>
          {(guildId ? channels.isPending : conversations.isPending) ? (
            <Loading />
          ) : (
            visibleChannels
              .filter((c) => c.kind !== "voice")
              .map((c) => (
                <button
                  key={c.id}
                  className={`channel-item ${channel?.id === c.id ? "selected" : ""}`}
                  onClick={() => openChannel(c)}
                >
                  {guildId ? (
                    <Hash size={19} />
                  ) : (
                    <Avatar name={c.name} size={28} />
                  )}
                  <span>{c.name}</span>
                  {c.read_seq !== undefined &&
                    BigInt(c.last_seq) > BigInt(c.read_seq) && (
                      <span
                        className="unread-dot"
                        aria-label="Mensagens não lidas"
                      />
                    )}
                </button>
              ))
          )}
          {!guildId && visibleChannels.length === 0 && (
            <p className="sidebar-empty">
              Suas conversas aparecem aqui. Comece adicionando um amigo.
            </p>
          )}
          {guildId && (
            <>
              <div className="list-heading voice-heading">
                <span>CANAIS DE VOZ</span>
                {canModerate && (
                  <IconButton
                    label="Criar canal de voz"
                    onClick={() => {
                      openDialog("channel");
                      setKind("voice");
                    }}
                  >
                    <Plus size={15} />
                  </IconButton>
                )}
              </div>
              {visibleChannels
                .filter((c) => c.kind === "voice")
                .map((c) => (
                  <button
                    key={c.id}
                    className={`channel-item ${call?.id === c.id ? "in-call" : ""} ${channel?.id === c.id ? "selected" : ""}`}
                    onClick={() => openChannel(c)}
                  >
                    <Volume2 size={19} />
                    <span>{c.name}</span>
                    {call?.id === c.id && <Signal size={14} />}
                  </button>
                ))}
              {visibleChannels.length === 0 && !channels.isPending && (
                <p className="sidebar-empty">
                  Ainda não há canais.
                  {canModerate ? " Crie o primeiro para começar." : ""}
                </p>
              )}
            </>
          )}
        </div>
        <div className="sidebar-bottom">
          <div
            className={`realtime-status ${connection === "connected" ? "online" : ""}`}
          >
            {connection === "connected" ? (
              <Signal size={13} />
            ) : (
              <WifiOff size={13} />
            )}
            <span>
              {connection === "connected"
                ? "Conectado à comunidade"
                : connection === "connecting"
                  ? "Conectando…"
                  : "Reconectando ao servidor…"}
            </span>
          </div>
          <div className="user-panel">
            <Avatar name={user.display_name} />
            <button onClick={() => setSettings(true)}>
              <strong>{user.display_name}</strong>
              <small>@{user.username}</small>
            </button>
            {user.is_admin && (
              <IconButton label="Administração" onClick={() => setAdmin(true)}>
                <ShieldCheck size={19} />
              </IconButton>
            )}
            <IconButton label="Preferências" onClick={() => setSettings(true)}>
              <Settings2 size={18} />
            </IconButton>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="main-header">
          <button
            className="mobile-menu icon-button"
            aria-label="Mostrar canais"
            onClick={() => setMobileNav((v) => !v)}
          >
            <Hash size={22} />
          </button>
          <div className="channel-title">
            {channel ? (
              channel.kind === "voice" ? (
                <Volume2 size={22} />
              ) : channel.guild_id ? (
                <Hash size={22} />
              ) : (
                <MessageCircle size={22} />
              )
            ) : (
              <Users size={22} />
            )}
            <strong>{channel?.name || "Amigos"}</strong>
            {channel?.guild_id && (
              <>
                <span className="header-divider" />
                <small>Um espaço para suas conversas</small>
              </>
            )}
          </div>
          <div className="header-actions">
            {channel?.guild_id && canModerate && (
              <IconButton
                label="Permissões do canal"
                onClick={() => setPermissionsOpen(true)}
              >
                <ShieldCheck size={19} />
              </IconButton>
            )}
            {channel && channel.kind !== "text" && channel.kind !== "voice" && (
              <IconButton
                label={
                  can(channel, Permission.Connect)
                    ? "Entrar na chamada"
                    : "Sem permissão para entrar na chamada"
                }
                disabled={!can(channel, Permission.Connect)}
                onClick={() => {
                  setCall(channel);
                  setCallExpanded(true);
                }}
              >
                <Headphones size={20} />
              </IconButton>
            )}
            <button
              aria-label="Buscar mensagens no canal"
              className="search-trigger"
              onClick={() => {
                setSearch(true);
                setSearchQuery("");
                setSearchTerm("");
              }}
            >
              <Search size={16} />
              <span>Buscar mensagens</span>
            </button>
            {guildId && (
              <IconButton
                label="Mostrar membros"
                active={showMembers}
                onClick={() => setShowMembers((v) => !v)}
              >
                <Users size={20} />
              </IconButton>
            )}
          </div>
        </header>
        <div className="content-layout">
          <div className="conversation-content">
            {!dialog && (
              <ErrorBanner
                message={
                  error ||
                  (guilds.isError
                    ? errorMessage(guilds.error)
                    : channels.isError && guildId
                      ? errorMessage(channels.error)
                      : undefined)
                }
              />
            )}{" "}
            {call && (
              <Suspense fallback={<Loading label="Abrindo chamada…" />}>
                <CallPanel
                  key={call.id}
                  channel={call}
                  expanded={callExpanded}
                  onExpand={() => setCallExpanded((v) => !v)}
                  onClose={() => setCall(null)}
                  canModerate={
                    guilds.data?.items.find((g) => g.id === call.guild_id)
                      ?.owner_id === user.id ||
                    (call.guild_id === guildId && canModerate)
                  }
                />
              </Suspense>
            )}
            {channel ? (
              <Chat
                key={channel.id}
                channel={channel}
                onTyping={sendTyping}
                typingCount={typing[channel.id]?.length || 0}
                user={user}
                canModerate={canModerate}
                maxUpload={instance.data?.max_upload_bytes || 25 * 1024 * 1024}
              />
            ) : guildId ? (
              <Empty
                icon={<Hash size={30} />}
                title={`Seu espaço em ${guild?.name || "comunidade"}`}
              >
                <p>Escolha um canal para conversar.</p>
                {canModerate && (
                  <button
                    className="button primary"
                    onClick={() => openDialog("channel")}
                  >
                    Criar primeiro canal
                  </button>
                )}
              </Empty>
            ) : (
              <Friends
                onConversation={(next) => {
                  setGuildId(null);
                  setChannel(next);
                }}
              />
            )}
          </div>
          {showMembers && guildId && (
            <aside className="members-panel" aria-label="Membros da comunidade">
              <div className="list-heading">
                <span>MEMBROS — {members.data?.items.length || 0}</span>
              </div>
              {members.isPending ? (
                <Loading />
              ) : members.isError ? (
                <ErrorBanner message={errorMessage(members.error)} />
              ) : (
                members.data?.items.map((target) => (
                  <div className="member-entry" key={target.id}>
                    <div className="member-summary">
                      <Avatar name={target.display_name} size={32} />
                      <div>
                        <strong>{target.display_name}</strong>
                        <small>
                          {target.role === "owner"
                            ? "Responsável"
                            : target.role === "admin"
                              ? "Moderador"
                              : "Membro"}
                        </small>
                      </div>
                    </div>
                    {!!target.role_ids?.length && (
                      <div className="member-role-chips">
                        {target.role_ids.map((id) => {
                          const role = roles.data?.items.find(
                            (item) => item.id === id,
                          );
                          return role ? (
                            <span key={id}>{role.name}</span>
                          ) : null;
                        })}
                      </div>
                    )}
                    {canModerate && (
                      <button
                        className="text-button member-roles-button"
                        onClick={() => setRoleMemberId(target.id)}
                      >
                        Gerenciar cargos
                      </button>
                    )}
                    {canModerate &&
                      target.id !== user.id &&
                      target.role !== "owner" && (
                        <div className="member-actions">
                          {guild?.owner_id === user.id && (
                            <select
                              aria-label={`Cargo de ${target.display_name}`}
                              value={target.role || "member"}
                              disabled={busy}
                              onChange={(e) =>
                                void action(() =>
                                  changeRole(
                                    target,
                                    e.target.value as "admin" | "member",
                                  ),
                                )
                              }
                            >
                              <option value="member">Membro</option>
                              <option value="admin">Moderador</option>
                            </select>
                          )}
                          <button
                            className="text-button danger-text"
                            disabled={busy}
                            onClick={() =>
                              void action(() => removeMember(target))
                            }
                          >
                            Remover
                          </button>
                        </div>
                      )}
                  </div>
                ))
              )}
            </aside>
          )}
        </div>
      </main>
      {rolesOpen && guild && canModerate && (
        <RolesManager guild={guild} onClose={() => setRolesOpen(false)} />
      )}
      {permissionsOpen &&
        guild &&
        channel?.guild_id === guild.id &&
        canModerate && (
          <ChannelPermissions
            guild={guild}
            channel={channel}
            onClose={() => setPermissionsOpen(false)}
          />
        )}
      {roleMemberId &&
        guild &&
        canModerate &&
        members.data?.items.some((item) => item.id === roleMemberId) && (
          <MemberRoles
            guild={guild}
            member={members.data.items.find(
              (item) => item.id === roleMemberId,
            )!}
            onClose={() => setRoleMemberId(null)}
          />
        )}
      {settings && <Settings user={user} onClose={() => setSettings(false)} />}{" "}
      {admin && <Admin onClose={() => setAdmin(false)} />}{" "}
      {dialog && (
        <Modal
          title={
            dialog === "guild"
              ? "Crie um novo ponto de encontro"
              : dialog === "channel"
                ? "Criar canal"
                : dialog === "join"
                  ? "Entrar em uma comunidade"
                  : "Convide sua turma"
          }
          onClose={() => setDialog(null)}
        >
          {dialog === "invite" ? (
            <>
              <p className="muted">
                Este convite permite uma entrada e é válido por 24 horas.
              </p>
              {invite ? (
                <div className="secret-result">
                  <code>{invite.token}</code>
                  <small>
                    Expira em{" "}
                    {new Date(invite.expires_at).toLocaleString("pt-BR")}
                  </small>
                  <button
                    className="button primary full"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(invite.token)
                        .then(() => setCopied(true))
                        .catch((e) => setError(errorMessage(e)))
                    }
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
                    {copied ? "Copiado" : "Copiar convite"}
                  </button>
                </div>
              ) : (
                <button
                  className="button primary full"
                  disabled={busy}
                  onClick={() => void action(createInvite)}
                >
                  Gerar convite
                </button>
              )}
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(create);
              }}
            >
              <p className="muted">
                {dialog === "guild"
                  ? "Dê um nome ao lugar onde vocês vão se encontrar."
                  : dialog === "join"
                    ? "Cole o convite recebido de um responsável pela comunidade."
                    : "Separe as conversas por assunto ou reúna todos em voz."}
              </p>
              <Field
                label={
                  dialog === "join"
                    ? "Código de convite"
                    : dialog === "guild"
                      ? "Nome da comunidade"
                      : "Nome do canal"
                }
              >
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={dialog === "join" ? 256 : 80}
                  placeholder={
                    dialog === "guild"
                      ? "Nossa comunidade"
                      : dialog === "channel"
                        ? "geral"
                        : ""
                  }
                />
              </Field>
              {dialog === "channel" && (
                <Field label="Tipo de canal">
                  <select
                    value={kind}
                    onChange={(e) =>
                      setKind(e.target.value as "text" | "voice")
                    }
                  >
                    <option value="text">Texto · mensagens e arquivos</option>
                    <option value="voice">Voz · conversa, câmera e tela</option>
                  </select>
                </Field>
              )}
              <button
                className="button primary full"
                disabled={busy || !name.trim()}
              >
                {busy
                  ? "Salvando…"
                  : dialog === "join"
                    ? "Entrar na comunidade"
                    : "Criar"}
              </button>
            </form>
          )}
          <ErrorBanner message={error} />
        </Modal>
      )}
      {search && (
        <Modal
          title={channel ? `Buscar em ${channel.name}` : "Buscar mensagens"}
          onClose={() => setSearch(false)}
          wide
        >
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              setSearchTerm(searchQuery.trim());
            }}
          >
            <input
              aria-label="Texto da busca"
              autoFocus
              required
              minLength={2}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="O que você procura?"
            />
            <button className="button primary">Buscar</button>
          </form>
          {searchTerm &&
            (searchResults.isPending ? (
              <Loading />
            ) : searchResults.isError ? (
              <ErrorBanner message={errorMessage(searchResults.error)} />
            ) : searchResults.data?.items.length === 0 ? (
              <Empty title="Nenhuma mensagem encontrada." />
            ) : (
              <div className="search-results">
                {searchResults.data?.items.map((message) => (
                  <article key={message.id}>
                    <Avatar name={message.author.display_name} size={30} />
                    <div>
                      <strong>{message.author.display_name}</strong>
                      <time>
                        {new Date(message.created_at).toLocaleString("pt-BR")}
                      </time>
                      <p>{message.content}</p>
                    </div>
                  </article>
                ))}
              </div>
            ))}
        </Modal>
      )}
    </div>
  );
}
