import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  KeyRound,
  LogOut,
  Palette,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  api,
  errorMessage,
  getServer,
  getSession,
  logout,
  updateSessionUser,
} from "../lib/api";
import { enableNotifications } from "../lib/desktop";
import { normalizeTheme } from "../lib/theme";
import { activateTheme } from "../lib/themeRuntime";
import { themeScope } from "../lib/themeAssets";
import Appearance from "./Appearance";
import { Updates } from "./Updates";
import type { AuditEvent, Items, Theme, User } from "../lib/types";
import { Avatar, ErrorBanner, Field, Loading, Modal } from "./ui";
export function Settings({
  user,
  onClose,
}: {
  user: User;
  onClose: () => void;
}) {
  const [name, setName] = useState(user.display_name);
  const [theme, setTheme] = useState<Theme>(
    normalizeTheme(user.preferences?.theme),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [themeWarning, setThemeWarning] = useState("");
  const origin = getServer();
  const scope = themeScope(origin, user.id);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void activateTheme(theme, scope)
        .then((warnings) => {
          if (active) setThemeWarning(warnings.join(" "));
        })
        .catch((e) => {
          if (active) setThemeWarning(errorMessage(e));
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [theme, scope]);
  function updateTheme(value: Partial<Theme>) {
    setSaved(false);
    const next = normalizeTheme({ ...theme, ...value });
    setTheme(next);
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const updated = await api<User>("/api/me", {
        method: "PATCH",
        body: {
          display_name: name,
          preferences: { ...user.preferences, theme },
        },
      });
      updateSessionUser(updated, origin);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function close() {
    void activateTheme(
      normalizeTheme(getSession()?.user.preferences?.theme),
      scope,
    );
    onClose();
  }
  return (
    <Modal title="Seu espaço, do seu jeito" onClose={close} wide>
      <div className="settings-profile">
        <Avatar name={user.display_name} size={56} />
        <div>
          <strong>{user.display_name}</strong>
          <small>
            @{user.username} · {getServer()}
          </small>
        </div>
      </div>
      <h3>
        <UserRound size={17} />
        Perfil
      </h3>
      <Field label="Nome de exibição">
        <input
          value={name}
          maxLength={64}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      <h3>
        <Palette size={17} />
        Aparência
      </h3>
      <Appearance theme={theme} onChange={updateTheme} scope={scope} />
      {themeWarning && (
        <p className="appearance-note" role="status">
          {themeWarning}
        </p>
      )}
      <button
        className="button"
        onClick={() =>
          void enableNotifications()
            .then((granted) => {
              if (!granted) setError("As notificações não foram autorizadas.");
            })
            .catch((e) => setError(errorMessage(e)))
        }
      >
        Ativar notificações neste dispositivo
      </button>
      <Updates />
      <ErrorBanner message={error} />
      <div className="modal-actions">
        <button
          className="button danger subtle"
          onClick={() => void logout().catch((e) => setError(errorMessage(e)))}
        >
          <LogOut size={16} />
          Sair da conta
        </button>
        <button className="button" onClick={close}>
          Cancelar
        </button>
        <button
          className="button primary"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
        >
          {saved ? (
            <>
              <Check size={16} />
              Salvo
            </>
          ) : busy ? (
            "Salvando…"
          ) : (
            "Aplicar preferências"
          )}
        </button>
      </div>
    </Modal>
  );
}
export function Admin({ onClose }: { onClose: () => void }) {
  const cache = useQueryClient();
  const [tab, setTab] = useState<"users" | "audit" | "stats">("users");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<User | null>(null);
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<{
    token: string;
    expires_at: string;
  } | null>(null);
  const [secretTitle, setSecretTitle] = useState("");
  const [copied, setCopied] = useState(false);
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api<Items<User>>("/api/admin/users"),
  });
  const audit = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: () => api<Items<AuditEvent>>("/api/admin/audit"),
    enabled: tab === "audit",
  });
  const stats = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: () => api<Record<string, unknown>>("/api/admin/stats"),
    enabled: tab === "stats",
  });
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await cache.invalidateQueries({ queryKey: ["admin"] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function invite() {
    setSecret(
      await api("/api/admin/invites", {
        method: "POST",
        body: { expires_hours: 24, max_uses: 1 },
      }),
    );
    setSecretTitle("Convite de cadastro");
    setCopied(false);
  }
  async function confirmReset() {
    if (!reset) return;
    setSecret(
      await api(`/api/admin/users/${reset.id}/reset`, {
        method: "POST",
        body: { password },
      }),
    );
    setSecretTitle(`Recuperação de ${reset.username}`);
    setPassword("");
    setReset(null);
    setCopied(false);
  }
  return (
    <Modal title="Administração da instância" onClose={onClose} wide>
      <p className="muted">Contas, convites e registros do seu servidor.</p>
      <nav className="tabs">
        <button
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          Contas
        </button>
        <button
          className={tab === "audit" ? "active" : ""}
          onClick={() => setTab("audit")}
        >
          Auditoria
        </button>
        <button
          className={tab === "stats" ? "active" : ""}
          onClick={() => setTab("stats")}
        >
          Uso e limites
        </button>
      </nav>
      <ErrorBanner message={error} />
      {tab === "users" && (
        <>
          <div className="section-heading">
            <h3>
              <ShieldCheck size={17} />
              Usuários
            </h3>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void action(invite)}
            >
              Criar convite
            </button>
          </div>
          {users.isPending ? (
            <Loading />
          ) : users.isError ? (
            <ErrorBanner message={errorMessage(users.error)} />
          ) : (
            <div className="admin-users">
              {users.data.items.map((user) => (
                <div key={user.id} className="member-row">
                  <Avatar name={user.display_name} />
                  <div>
                    <strong>{user.display_name}</strong>
                    <small>
                      @{user.username} ·{" "}
                      {user.is_admin
                        ? "Administrador"
                        : user.disabled
                          ? "Desativado"
                          : "Ativo"}
                    </small>
                  </div>
                  <button
                    className="icon-button"
                    title={`Resetar senha de ${user.username}`}
                    onClick={() => {
                      setReset(user);
                      setPassword("");
                    }}
                  >
                    <KeyRound size={17} />
                  </button>
                  <button
                    className="button small"
                    disabled={busy || user.is_admin}
                    onClick={() =>
                      void action(() =>
                        api(`/api/admin/users/${user.id}`, {
                          method: "PATCH",
                          body: { disabled: !user.disabled },
                        }),
                      )
                    }
                  >
                    {user.disabled ? "Reativar" : "Desativar"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {tab === "audit" &&
        (audit.isPending ? (
          <Loading />
        ) : audit.isError ? (
          <ErrorBanner message={errorMessage(audit.error)} />
        ) : (
          <div className="audit-list">
            {audit.data?.items.length === 0 && (
              <p className="muted">Nenhum evento registrado.</p>
            )}
            {audit.data?.items.map((event) => (
              <article key={event.id}>
                <strong>{event.action}</strong>
                <time>
                  {new Date(event.created_at).toLocaleString("pt-BR")}
                </time>
                <small>
                  Autor: {event.actor_id || "sistema"}
                  {event.target_id ? ` · Alvo: ${event.target_id}` : ""}
                </small>
              </article>
            ))}
          </div>
        ))}
      {tab === "stats" &&
        (stats.isPending ? (
          <Loading />
        ) : stats.isError ? (
          <ErrorBanner message={errorMessage(stats.error)} />
        ) : (
          <div className="stats-list">
            {Object.entries(stats.data || {}).map(([key, value]) => (
              <div key={key}>
                <strong>{key.replaceAll("_", " ")}</strong>
                <span>
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value)}
                </span>
              </div>
            ))}
          </div>
        ))}
      {reset && (
        <div className="admin-reset">
          <h3>Recuperar acesso de {reset.display_name}</h3>
          <p>
            Confirme sua senha de administrador. O código será exibido uma vez
            para entrega por um canal de confiança. As sessões do usuário serão
            revogadas.
          </p>
          <Field label="Sua senha de administrador">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="modal-actions">
            <button
              className="button"
              onClick={() => {
                setReset(null);
                setPassword("");
              }}
            >
              Cancelar
            </button>
            <button
              className="button primary"
              disabled={busy || !password}
              onClick={() => void action(confirmReset)}
            >
              Gerar código de recuperação
            </button>
          </div>
        </div>
      )}
      {secret && (
        <div className="secret-result">
          <h3>{secretTitle}</h3>
          <p>
            Copie e entregue apenas à pessoa correta. Expira em{" "}
            {new Date(secret.expires_at).toLocaleString("pt-BR")}.
          </p>
          <code>{secret.token}</code>
          <div className="modal-actions">
            <button className="button" onClick={() => setSecret(null)}>
              Ocultar código
            </button>
            <button
              className="button primary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret.token)
                  .then(() => setCopied(true))
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}Copiar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
