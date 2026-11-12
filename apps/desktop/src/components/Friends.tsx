import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageCircle, UserPlus, Users, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { Channel, Friend, Items } from "../lib/types";
import { Avatar, Empty, ErrorBanner, Field, Loading, Modal } from "./ui";
export default function Friends({
  onConversation,
}: {
  onConversation: (channel: Channel) => void;
}) {
  const cache = useQueryClient();
  const [tab, setTab] = useState<"all" | "pending">("all");
  const [add, setAdd] = useState(false);
  const [group, setGroup] = useState(false);
  const [username, setUsername] = useState("");
  const [groupName, setGroupName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["friends"],
    queryFn: () => api<Items<Friend>>("/api/friends"),
    refetchInterval: 30000,
  });
  const friends = query.data?.items || [];
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await cache.invalidateQueries({ queryKey: ["friends"] });
      await cache.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function conversation(userIds: string[], name?: string) {
    const channel = await api<Channel>("/api/conversations", {
      method: "POST",
      body: { user_ids: userIds, ...(name ? { name } : {}) },
    });
    setGroup(false);
    onConversation(channel);
  }
  return (
    <section className="friends-panel">
      <header className="page-header">
        <div>
          <span className="eyebrow">SUAS CONEXÕES</span>
          <h1>Melhor com companhia.</h1>
          <p className="muted">
            Uma boa conversa está a um convite de distância.
          </p>
        </div>
        <button className="button primary" onClick={() => setAdd(true)}>
          <UserPlus size={17} />
          Adicionar amigo
        </button>
      </header>
      <div className="section-heading">
        <nav className="tabs">
          <button
            className={tab === "all" ? "active" : ""}
            onClick={() => setTab("all")}
          >
            Amigos{" "}
            <span>{friends.filter((f) => f.status === "accepted").length}</span>
          </button>
          <button
            className={tab === "pending" ? "active" : ""}
            onClick={() => setTab("pending")}
          >
            Pendentes{" "}
            <span>{friends.filter((f) => f.status === "pending").length}</span>
          </button>
        </nav>
        <button
          className="text-button"
          onClick={() => {
            setSelected([]);
            setGroup(true);
          }}
        >
          <Users size={16} />
          Criar grupo
        </button>
      </div>
      <ErrorBanner message={error} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorBanner message={errorMessage(query.error)} />
      ) : friends.filter((f) =>
          tab === "all" ? f.status === "accepted" : f.status === "pending",
        ).length === 0 ? (
        <Empty
          icon={<MessageCircle size={34} />}
          title={tab === "all" ? "Encontre sua turma." : "Tudo em dia."}
        >
          <p>
            {tab === "all"
              ? "Adicione alguém pelo nome de usuário e comece uma conversa."
              : "Os pedidos de amizade aparecerão aqui."}
          </p>
        </Empty>
      ) : (
        <div className="friend-list">
          {friends
            .filter((f) =>
              tab === "all" ? f.status === "accepted" : f.status === "pending",
            )
            .map((friend) => (
              <div className="friend-card" key={friend.id}>
                <Avatar name={friend.user.display_name} size={44} />
                <div>
                  <strong>{friend.user.display_name}</strong>
                  <small>
                    @{friend.user.username}
                    {friend.status === "pending"
                      ? friend.incoming
                        ? " · convite recebido"
                        : " · convite enviado"
                      : ""}
                  </small>
                </div>
                {friend.status === "accepted" ? (
                  <button
                    className="icon-button"
                    title="Conversar"
                    disabled={busy}
                    onClick={() =>
                      void action(() => conversation([friend.user.id]))
                    }
                  >
                    <MessageCircle size={20} />
                  </button>
                ) : (
                  friend.incoming && (
                    <button
                      className="icon-button"
                      title="Aceitar amizade"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api(`/api/friends/${friend.id}/accept`, {
                            method: "POST",
                          }),
                        )
                      }
                    >
                      <Check size={20} />
                    </button>
                  )
                )}
                <button
                  className="icon-button"
                  title={
                    friend.status === "accepted"
                      ? "Remover amizade"
                      : "Recusar ou cancelar pedido"
                  }
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/api/friends/${friend.id}`, { method: "DELETE" }),
                    )
                  }
                >
                  <X size={18} />
                </button>
              </div>
            ))}
        </div>
      )}
      {add && (
        <Modal title="Adicionar amigo" onClose={() => setAdd(false)}>
          <p className="muted">
            Informe o nome de usuário exato de alguém desta instância.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api("/api/friends", {
                  method: "POST",
                  body: { username },
                });
                setUsername("");
                setAdd(false);
              });
            }}
          >
            <Field label="Nome de usuário">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                maxLength={32}
                placeholder="nome.usuario"
              />
            </Field>
            <ErrorBanner message={error} />
            <button
              className="button primary full"
              disabled={busy || !username.trim()}
            >
              Enviar pedido
            </button>
          </form>
        </Modal>
      )}
      {group && (
        <Modal title="Nova conversa em grupo" onClose={() => setGroup(false)}>
          <Field label="Nome do grupo">
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              maxLength={80}
            />
          </Field>
          <div className="group-members">
            {friends
              .filter((f) => f.status === "accepted")
              .map((friend) => (
                <label className="check-field" key={friend.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(friend.user.id)}
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...current, friend.user.id]
                          : current.filter((id) => id !== friend.user.id),
                      )
                    }
                  />
                  {friend.user.display_name}
                </label>
              ))}
          </div>
          <ErrorBanner message={error} />
          <button
            className="button primary full"
            disabled={busy || selected.length < 2 || !groupName.trim()}
            onClick={() => void action(() => conversation(selected, groupName))}
          >
            Criar grupo
          </button>
          <p className="small-note">Selecione pelo menos dois amigos.</p>
        </Modal>
      )}
    </section>
  );
}
