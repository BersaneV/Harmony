import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type {
  Channel,
  ChannelOverride,
  Guild,
  GuildRole,
  Items,
  User,
} from "../lib/types";
import {
  hasBit,
  overrideState,
  permissionDefinitions,
  setOverride,
  setPermission,
} from "../lib/permissions";
import { ErrorBanner, Field, Loading, Modal } from "./ui";
export async function refreshGuildAccess(
  cache: ReturnType<typeof useQueryClient>,
  guildId: string,
) {
  await Promise.all([
    cache.invalidateQueries({ queryKey: ["roles", guildId] }),
    cache.invalidateQueries({ queryKey: ["members", guildId] }),
    cache.invalidateQueries({ queryKey: ["channels", guildId] }),
    cache.invalidateQueries({ queryKey: ["channel-permissions"] }),
    cache.invalidateQueries({ queryKey: ["messages"] }),
  ]);
}
export function RolesManager({
  guild,
  onClose,
}: {
  guild: Guild;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const roles = useQuery({
    queryKey: ["roles", guild.id],
    queryFn: () => api<Items<GuildRole>>(`/api/guilds/${guild.id}/roles`),
  });
  const [active, setActive] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  function select(role: GuildRole | null) {
    setActive(role?.id ?? null);
    setName(role?.name ?? "");
    setPermissions(role?.permissions ?? "0");
    setDeleting(false);
    setError("");
    setSaved(false);
  }
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const role = await api<GuildRole>(
        active ? `/api/roles/${active}` : `/api/guilds/${guild.id}/roles`,
        {
          method: active ? "PATCH" : "POST",
          body: { name: name.trim(), permissions },
        },
      );
      await refreshGuildAccess(cache, guild.id);
      setActive(role.id);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!active) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/roles/${active}`, { method: "DELETE" });
      select(null);
      await refreshGuildAccess(cache, guild.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Cargos de ${guild.name}`} onClose={onClose} wide>
      <p className="muted">
        Organize grupos de membros e suas permissões. Responsáveis e moderadores
        mantêm acesso administrativo.
      </p>
      <div className="role-editor">
        <aside className="role-list">
          <button
            className={`role-list-item ${active === null ? "selected" : ""}`}
            onClick={() => select(null)}
          >
            <Plus size={16} />
            Novo cargo
          </button>
          {roles.isPending ? (
            <Loading />
          ) : roles.isError ? (
            <ErrorBanner message={errorMessage(roles.error)} />
          ) : (
            roles.data.items.map((role) => (
              <button
                key={role.id}
                className={`role-list-item ${active === role.id ? "selected" : ""}`}
                onClick={() => select(role)}
              >
                <ShieldCheck size={15} />
                {role.name}
              </button>
            ))
          )}
        </aside>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Nome do cargo">
            <input
              autoFocus
              value={name}
              required
              maxLength={64}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              placeholder="Ex.: Equipe de eventos"
            />
          </Field>
          <h3>Concessões do cargo</h3>
          <div className="permission-list">
            {permissionDefinitions.map((permission) => (
              <label className="permission-row" key={permission.bit}>
                <input
                  type="checkbox"
                  checked={hasBit(permissions, permission.bit)}
                  onChange={(e) => {
                    setPermissions((value) =>
                      setPermission(value, permission.bit, e.target.checked),
                    );
                    setSaved(false);
                  }}
                />
                <span>
                  <strong>{permission.name}</strong>
                  <small>{permission.description}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="small-note">
            Cargos somam concessões; desmarcar uma opção não retira direitos
            herdados. O membro básico tem as seis permissões. Para restringir
            acesso, configure “Negar” nas permissões do canal. Se algum cargo
            permitir uma opção que outro cargo nega no mesmo canal, permitir
            prevalece.
          </p>
          <ErrorBanner message={error} />
          {saved && (
            <p className="success-note" role="status">
              Cargo salvo.
            </p>
          )}
          <div className="modal-actions">
            {active && (
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={15} />
                Excluir
              </button>
            )}
            <button className="button primary" disabled={busy || !name.trim()}>
              {busy ? "Salvando…" : active ? "Salvar cargo" : "Criar cargo"}
            </button>
          </div>
          {deleting && (
            <div className="inline-confirm">
              <p>
                Excluir este cargo remove suas atribuições e exceções de canal.
                Os membros permanecem na comunidade.
              </p>
              <button
                type="button"
                className="button"
                onClick={() => setDeleting(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Confirmar exclusão
              </button>
            </div>
          )}
        </form>
      </div>
    </Modal>
  );
}
export function MemberRoles({
  guild,
  member,
  onClose,
}: {
  guild: Guild;
  member: User;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const roles = useQuery({
    queryKey: ["roles", guild.id],
    queryFn: () => api<Items<GuildRole>>(`/api/guilds/${guild.id}/roles`),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle(role: GuildRole, enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/guilds/${guild.id}/members/${member.id}/roles/${role.id}`,
        { method: enabled ? "PUT" : "DELETE" },
      );
      await refreshGuildAccess(cache, guild.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Cargos de ${member.display_name}`} onClose={onClose}>
      <p className="muted">
        As alterações são salvas imediatamente. O cargo administrativo de
        responsável ou moderador é gerenciado separadamente.
      </p>
      {roles.isPending ? (
        <Loading />
      ) : roles.isError ? (
        <ErrorBanner message={errorMessage(roles.error)} />
      ) : roles.data.items.length === 0 ? (
        <p>Nenhum cargo personalizado foi criado nesta comunidade.</p>
      ) : (
        <div className="permission-list">
          {roles.data.items.map((role) => (
            <label key={role.id} className="permission-row">
              <input
                type="checkbox"
                checked={(member.role_ids || []).includes(role.id)}
                disabled={busy}
                onChange={(e) => void toggle(role, e.target.checked)}
              />
              <span>
                <strong>{role.name}</strong>
                <small>
                  {permissionDefinitions
                    .filter((permission) =>
                      hasBit(role.permissions, permission.bit),
                    )
                    .map((permission) => permission.name)
                    .join(" · ") ||
                    "Sem concessões adicionais; pode receber exceções por canal."}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      <ErrorBanner message={error} />
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Concluído
        </button>
      </div>
    </Modal>
  );
}
export function ChannelPermissions({
  guild,
  channel,
  onClose,
}: {
  guild: Guild;
  channel: Channel;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const roles = useQuery({
    queryKey: ["roles", guild.id],
    queryFn: () => api<Items<GuildRole>>(`/api/guilds/${guild.id}/roles`),
  });
  const overrides = useQuery({
    queryKey: ["channel-permissions", channel.id],
    queryFn: () =>
      api<Items<ChannelOverride>>(`/api/channels/${channel.id}/permissions`),
  });
  const [roleId, setRoleId] = useState("everyone");
  const [draft, setDraft] = useState<ChannelOverride>({
    role_id: null,
    allow: "0",
    deny: "0",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const id = roleId === "everyone" ? null : roleId;
    setDraft(
      overrides.data?.items.find((item) => item.role_id === id) || {
        role_id: id,
        allow: "0",
        deny: "0",
      },
    );
    setSaved(false);
  }, [roleId, overrides.data]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/channels/${channel.id}/permissions`, {
        method: "PUT",
        body: draft,
      });
      await refreshGuildAccess(cache, guild.id);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Permissões de #${channel.name}`} onClose={onClose} wide>
      <p className="muted">
        Defina exceções para todos ou para um cargo. Responsáveis e moderadores
        não são bloqueados por estas regras.
      </p>
      <Field label="Aplicar a">
        <select
          value={roleId}
          disabled={busy}
          onChange={(e) => {
            setRoleId(e.target.value);
            setError("");
          }}
        >
          <option value="everyone">Todos os membros</option>
          {roles.data?.items.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </Field>
      {overrides.isPending ? (
        <Loading />
      ) : overrides.isError ? (
        <ErrorBanner message={errorMessage(overrides.error)} />
      ) : (
        <div className="permission-overrides">
          {permissionDefinitions.map((permission) => (
            <div className="permission-row" key={permission.bit}>
              <span>
                <strong>{permission.name}</strong>
                <small>{permission.description}</small>
              </span>
              <fieldset
                className="tri-state"
                aria-label={permission.name}
                disabled={busy}
              >
                {(["inherit", "allow", "deny"] as const).map((value) => (
                  <label
                    key={value}
                    className={
                      overrideState(draft, permission.bit) === value
                        ? `selected ${value}`
                        : ""
                    }
                  >
                    <input
                      type="radio"
                      name={`permission-${permission.bit}`}
                      value={value}
                      checked={overrideState(draft, permission.bit) === value}
                      onChange={() => {
                        setDraft((current) =>
                          setOverride(current, permission.bit, value),
                        );
                        setSaved(false);
                      }}
                    />
                    {value === "inherit"
                      ? "Herdar"
                      : value === "allow"
                        ? "Permitir"
                        : "Negar"}
                  </label>
                ))}
              </fieldset>
            </div>
          ))}
        </div>
      )}
      <p className="small-note">
        Primeiro são aplicadas as regras de “Todos os membros”; depois, as dos
        cargos. Permitir em um cargo prevalece sobre negar em outro. Negar “Ver
        canal” também impede enviar, reagir, baixar arquivos e entrar em
        chamadas. “Herdar” em todas as opções remove esta exceção.
      </p>
      <ErrorBanner
        message={
          error || (roles.isError ? errorMessage(roles.error) : undefined)
        }
      />
      {saved && (
        <p className="success-note" role="status">
          Permissões salvas e acessos atualizados.
        </p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Fechar
        </button>
        <button
          className="button primary"
          disabled={busy || overrides.isPending || overrides.isError}
          onClick={() => void save()}
        >
          {busy ? "Salvando…" : "Salvar permissões"}
        </button>
      </div>
    </Modal>
  );
}
