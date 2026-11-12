import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronUp,
  File,
  Hash,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  Send,
  Smile,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AttachmentViewer from "./AttachmentViewer";
import { fetchAttachmentBlob, previewKind } from "../lib/attachments";
import { openExternal } from "../lib/desktop";
import { api, errorMessage } from "../lib/api";
import { compareSequences, formatBytes, mergeMessages } from "../lib/messages";
import type {
  Attachment,
  Items,
  Channel,
  Message,
  MessagePage,
  User,
} from "../lib/types";
import {
  Avatar,
  Empty,
  ErrorBanner,
  Field,
  IconButton,
  Loading,
  Modal,
} from "./ui";
function uploadContentType(value: string) {
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/wav",
    "audio/mp4",
    "application/pdf",
    "application/zip",
    "text/plain",
  ].includes(value)
    ? value
    : "application/octet-stream";
}
interface Pending {
  nonce: string;
  content: string;
  attachment_ids: string[];
  status: "sending" | "failed";
  error?: string;
}
export default function Chat({
  channel,
  user,
  canModerate,
  maxUpload,
  onTyping,
  typingCount,
}: {
  channel: Channel;
  user: User;
  canModerate: boolean;
  maxUpload: number;
  onTyping: (channelId: string) => void;
  typingCount: number;
}) {
  const cache = useQueryClient();
  const [older, setOlder] = useState<Message[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<Attachment | null>(
    null,
  );
  const [editing, setEditing] = useState<Message | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleting, setDeleting] = useState<Message | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [reactionFor, setReactionFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const acknowledgedRead = useRef("0");
  const pendingRead = useRef("0");
  const markRead = useCallback(
    (seq: string | undefined) => {
      if (
        !seq ||
        document.visibilityState !== "visible" ||
        !nearBottom.current ||
        compareSequences(seq, acknowledgedRead.current) <= 0 ||
        pendingRead.current === seq
      )
        return;
      pendingRead.current = seq;
      void api(`/api/channels/${channel.id}/read`, {
        method: "POST",
        body: { seq },
      })
        .then(() => {
          if (compareSequences(seq, acknowledgedRead.current) > 0)
            acknowledgedRead.current = seq;
          const update = (current: Items<Channel> | undefined) =>
            current
              ? {
                  ...current,
                  items: current.items.map((item) =>
                    item.id === channel.id
                      ? {
                          ...item,
                          read_seq:
                            compareSequences(item.read_seq || "0", seq) > 0
                              ? item.read_seq
                              : seq,
                        }
                      : item,
                  ),
                }
              : current;
          cache.setQueriesData<Items<Channel>>(
            { queryKey: ["channels"] },
            update,
          );
          cache.setQueriesData<Items<Channel>>(
            { queryKey: ["conversations"] },
            update,
          );
        })
        .catch(() => {})
        .finally(() => {
          if (pendingRead.current === seq) pendingRead.current = "0";
        });
    },
    [cache, channel.id],
  );
  const query = useQuery({
    queryKey: ["messages", channel.id],
    queryFn: async ({ signal }) => {
      const current = cache.getQueryData<MessagePage>(["messages", channel.id]);
      if (!current?.cursor)
        return api<MessagePage>(
          `/api/channels/${channel.id}/messages?limit=50`,
          { signal },
        );
      let result = current;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await api<MessagePage>(
          `/api/channels/${channel.id}/messages?after_seq=${result.cursor}&limit=100`,
          { signal },
        );
        result = {
          items: mergeMessages(result.items, page.items),
          has_more: current.has_more,
          cursor: page.cursor,
        };
        if (!page.has_more || page.cursor === current.cursor) break;
      }
      return result;
    },
    refetchInterval: 30000,
  });
  const messages = mergeMessages(older, query.data?.items || []);
  useEffect(() => {
    setOlder([]);
    setHasOlder(true);
    setContent("");
    setPending([]);
    setAttachments([]);
    setError("");
    setMenu(null);
    nearBottom.current = true;
  }, [channel.id]);
  useEffect(() => {
    if (nearBottom.current)
      bottom.current?.scrollIntoView({ behavior: "instant" });
    markRead(query.data?.cursor);
  }, [query.data, channel.id, pending.length, markRead]);
  useEffect(() => {
    const visible = () => markRead(query.data?.cursor);
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [markRead, query.data?.cursor]);
  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    setError("");
    const oldHeight = list.current?.scrollHeight || 0;
    try {
      const page = await api<MessagePage>(
        `/api/channels/${channel.id}/messages?before_seq=${first.seq}&limit=50`,
      );
      setOlder((current) => mergeMessages(page.items, current));
      setHasOlder(page.has_more);
      requestAnimationFrame(() => {
        if (list.current)
          list.current.scrollTop = list.current.scrollHeight - oldHeight;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingOlder(false);
    }
  }
  async function deliver(item: Pending) {
    setPending((current) =>
      current.map((p) =>
        p.nonce === item.nonce ? { ...p, status: "sending" } : p,
      ),
    );
    try {
      const message = await api<Message>(
        `/api/channels/${channel.id}/messages`,
        {
          method: "POST",
          body: {
            client_nonce: item.nonce,
            content: item.content,
            attachment_ids: item.attachment_ids,
          },
        },
      );
      cache.setQueryData<MessagePage>(["messages", channel.id], (current) => ({
        items: mergeMessages(current?.items || [], [message]),
        has_more: current?.has_more || false,
        cursor: current?.cursor || "0",
      }));
      setPending((current) => current.filter((p) => p.nonce !== item.nonce));
      void cache.invalidateQueries({ queryKey: ["channels"] });
    } catch (e) {
      setPending((current) =>
        current.map((p) =>
          p.nonce === item.nonce
            ? { ...p, status: "failed", error: errorMessage(e) }
            : p,
        ),
      );
    }
  }
  function send() {
    if ((!content.trim() && !attachments.length) || uploading) return;
    const item: Pending = {
      nonce: crypto.randomUUID(),
      content: content.trim(),
      attachment_ids: attachments.map((a) => a.id),
      status: "sending",
    };
    setPending((current) => [...current, item]);
    setContent("");
    setAttachments([]);
    nearBottom.current = true;
    void deliver(item);
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    setUploading(true);
    setError("");
    try {
      if (files.length + attachments.length > 5)
        throw new Error("Envie no máximo cinco arquivos por mensagem.");
      for (const f of Array.from(files)) {
        if (f.size > maxUpload)
          throw new Error(
            `“${f.name}” excede o limite de ${formatBytes(maxUpload)}.`,
          );
        const reservation = await api<{
          id: string;
          url: string;
          headers: Record<string, string>;
        }>(`/api/channels/${channel.id}/uploads`, {
          method: "POST",
          body: {
            name: f.name,
            size: f.size,
            content_type: uploadContentType(f.type),
          },
        });
        const result = await fetch(reservation.url, {
          method: "PUT",
          headers: reservation.headers,
          body: f,
          credentials: "omit",
          signal: AbortSignal.timeout(120000),
        });
        if (!result.ok)
          throw new Error(
            "O armazenamento recusou o arquivo. Tente novamente.",
          );
        const attachment = await api<Attachment>(
          `/api/uploads/${reservation.id}/complete`,
          { method: "POST" },
        );
        setAttachments((current) => [...current, attachment]);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  }
  async function download(attachment: Attachment) {
    setError("");
    try {
      const result = await api<{ url: string }>(
        `/api/uploads/${attachment.id}/download`,
      );
      const blob = await fetchAttachmentBlob(
        result.url,
        attachment.size,
        maxUpload,
        attachment.content_type,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function react(message: Message, emoji: string) {
    setReactionFor(null);
    try {
      const mine = message.reactions?.find((r) => r.emoji === emoji)?.me;
      await api(
        `/api/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`,
        { method: mine ? "DELETE" : "PUT" },
      );
      await cache.invalidateQueries({ queryKey: ["messages", channel.id] });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/api/messages/${editing.id}`, {
        method: "PATCH",
        body: { content: editValue },
      });
      setEditing(null);
      await cache.invalidateQueries({ queryKey: ["messages", channel.id] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteMessage() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/messages/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      setOlder((current) => current.filter((m) => m.id !== deleting.id));
      await cache.invalidateQueries({ queryKey: ["messages", channel.id] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chat">
      <div
        className="messages"
        ref={list}
        onScroll={() => {
          const el = list.current;
          if (el)
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (nearBottom.current) markRead(query.data?.cursor);
        }}
      >
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorBanner message={errorMessage(query.error)} />
        ) : (
          <>
            {messages.length > 0 &&
              (query.data?.has_more || older.length > 0) &&
              hasOlder && (
                <button
                  className="load-older"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                >
                  <ChevronUp size={14} />
                  {loadingOlder
                    ? "Buscando histórico…"
                    : "Mensagens anteriores"}
                </button>
              )}
            <div className="channel-welcome">
              <div className="channel-welcome-icon">
                {channel.guild_id ? (
                  <Hash size={30} />
                ) : (
                  <MessageSquare size={30} />
                )}
              </div>
              <h2>
                {channel.guild_id
                  ? `Bem-vindo a #${channel.name}`
                  : channel.name}
              </h2>
              <p>
                {channel.guild_id
                  ? "Este é o espaço para começar e continuar boas conversas."
                  : "Uma conversa só de vocês. Diga um oi."}
              </p>
            </div>
            {messages
              .filter((m) => !m.deleted)
              .map((message, index) => {
                const previous = messages[index - 1];
                const group =
                  previous?.author.id === message.author.id &&
                  new Date(message.created_at).getTime() -
                    new Date(previous.created_at).getTime() <
                    300000;
                return (
                  <article
                    key={message.id}
                    className={`message ${group ? "grouped" : ""}`}
                  >
                    <div className="message-avatar">
                      {!group && <Avatar name={message.author.display_name} />}
                    </div>
                    <div className="message-body">
                      {!group && (
                        <header>
                          <strong>{message.author.display_name}</strong>
                          <time
                            dateTime={message.created_at}
                            title={new Date(message.created_at).toLocaleString(
                              "pt-BR",
                            )}
                          >
                            {new Date(message.created_at).toLocaleTimeString(
                              "pt-BR",
                              { hour: "2-digit", minute: "2-digit" },
                            )}
                          </time>
                          {message.author.id === user.id && (
                            <span className="you-label">você</span>
                          )}
                        </header>
                      )}
                      <div className="markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          skipHtml
                          components={{
                            a: ({ children, href }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => {
                                  e.preventDefault();
                                  if (href)
                                    void openExternal(href).catch((e) =>
                                      setError(errorMessage(e)),
                                    );
                                }}
                              >
                                {children}
                              </a>
                            ),
                            img: ({ alt }) => (
                              <span className="muted">
                                [imagem externa: {alt || "sem descrição"}]
                              </span>
                            ),
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                        {message.edited_at && (
                          <span className="edited">editada</span>
                        )}
                      </div>
                      {message.attachments?.length > 0 && (
                        <div className="attachments">
                          {message.attachments.map((a) => (
                            <div className="attachment-card" key={a.id}>
                              <button
                                className="attachment"
                                onClick={() => void download(a)}
                              >
                                <File size={24} />
                                <span>
                                  <strong>{a.name}</strong>
                                  <small>
                                    {formatBytes(a.size)} · baixar arquivo
                                  </small>
                                </span>
                              </button>
                              {previewKind(a.content_type) && (
                                <button
                                  className="text-button attachment-preview-button"
                                  aria-label={`${previewKind(a.content_type) === "image" ? "Ver imagem" : "Reproduzir"}: ${a.name}`}
                                  onClick={() => setViewingAttachment(a)}
                                >
                                  {previewKind(a.content_type) === "image"
                                    ? "Ver imagem"
                                    : previewKind(a.content_type) === "video"
                                      ? "Reproduzir vídeo"
                                      : "Reproduzir áudio"}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {message.reactions?.length > 0 && (
                        <div className="reactions">
                          {message.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              className={r.me ? "selected" : ""}
                              onClick={() => void react(message, r.emoji)}
                              aria-label={`${r.emoji}, ${r.count} reações${r.me ? ", sua reação" : ""}`}
                            >
                              {r.emoji}
                              <span>{r.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="message-actions">
                      <IconButton
                        label="Reagir"
                        onClick={() =>
                          setReactionFor(
                            reactionFor === message.id ? null : message.id,
                          )
                        }
                      >
                        <Smile size={16} />
                      </IconButton>
                      {(message.author.id === user.id || canModerate) && (
                        <IconButton
                          label="Opções da mensagem"
                          onClick={() =>
                            setMenu(menu === message.id ? null : message.id)
                          }
                        >
                          <MoreHorizontal size={16} />
                        </IconButton>
                      )}
                      {menu === message.id && (
                        <div className="message-menu">
                          {message.author.id === user.id && (
                            <button
                              onClick={() => {
                                setEditing(message);
                                setEditValue(message.content);
                                setMenu(null);
                              }}
                            >
                              <Pencil size={15} />
                              Editar
                            </button>
                          )}
                          <button
                            className="danger-text"
                            onClick={() => {
                              setDeleting(message);
                              setMenu(null);
                            }}
                          >
                            <Trash2 size={15} />
                            Excluir
                          </button>
                        </div>
                      )}
                      {reactionFor === message.id && (
                        <div className="reaction-picker">
                          {["👍", "❤️", "😂", "🎉", "👀", "✅"].map((emoji) => (
                            <button
                              key={emoji}
                              onClick={() => void react(message, emoji)}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            {pending.map((item) => (
              <article
                key={item.nonce}
                className={`message pending ${item.status}`}
              >
                <Avatar name={user.display_name} />
                <div className="message-body">
                  <strong>{user.display_name}</strong>
                  <p>
                    {item.content || `${item.attachment_ids.length} arquivo(s)`}
                  </p>
                  <small>
                    {item.status === "sending" ? "Enviando…" : item.error}
                  </small>
                  {item.status === "failed" && (
                    <button
                      className="text-button"
                      onClick={() => void deliver(item)}
                    >
                      <RefreshCw size={13} />
                      Tentar novamente
                    </button>
                  )}
                </div>
              </article>
            ))}
            {!messages.length && !pending.length && (
              <Empty title="A primeira mensagem pode ser sua." />
            )}
            <div ref={bottom} />
          </>
        )}
      </div>
      <div className="composer-wrap">
        <ErrorBanner message={error} />
        {attachments.length > 0 && (
          <div className="attachment-drafts">
            {attachments.map((a) => (
              <span key={a.id}>
                <File size={16} />
                {a.name}
                <button
                  aria-label={`Remover ${a.name}`}
                  onClick={() =>
                    setAttachments((v) => v.filter((item) => item.id !== a.id))
                  }
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer">
          <input
            type="file"
            ref={file}
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
          <IconButton
            label="Anexar arquivos"
            disabled={uploading}
            onClick={() => file.current?.click()}
          >
            <Paperclip size={21} />
          </IconButton>
          <textarea
            aria-label="Mensagem"
            placeholder={
              uploading
                ? "Enviando arquivo…"
                : `Conversar em ${channel.guild_id ? "#" : ""}${channel.name}`
            }
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              if (e.target.value.trim()) onTyping(channel.id);
            }}
            maxLength={4000}
            rows={1}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="send-button"
            aria-label="Enviar mensagem"
            disabled={(!content.trim() && !attachments.length) || uploading}
            onClick={send}
          >
            <Send size={19} />
          </button>
        </div>
        <div className="composer-hint">
          <span>
            {typingCount > 0 ? (
              `${typingCount === 1 ? "Alguém está" : `${typingCount} pessoas estão`} digitando…`
            ) : (
              <>
                <strong>Enter</strong> envia · <strong>Shift + Enter</strong>{" "}
                quebra a linha
              </>
            )}
          </span>
          <span>
            {content.length > 3500 ? (
              `${content.length}/4000`
            ) : (
              <>
                <Check size={12} />
                Histórico salvo no servidor
              </>
            )}
          </span>
        </div>
      </div>
      {viewingAttachment && (
        <AttachmentViewer
          attachment={viewingAttachment}
          maxBytes={maxUpload}
          onClose={() => setViewingAttachment(null)}
        />
      )}
      {editing && (
        <Modal title="Editar mensagem" onClose={() => setEditing(null)}>
          <Field label="Mensagem">
            <textarea
              rows={5}
              value={editValue}
              maxLength={4000}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="modal-actions">
            <button className="button" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button
              className="button primary"
              disabled={busy || !editValue.trim()}
              onClick={() => void saveEdit()}
            >
              Salvar alterações
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="Excluir mensagem?" onClose={() => setDeleting(null)}>
          <p>Esta mensagem deixará de aparecer para todos na conversa.</p>
          <blockquote>{deleting.content.slice(0, 200)}</blockquote>
          <div className="modal-actions">
            <button className="button" onClick={() => setDeleting(null)}>
              Cancelar
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void deleteMessage()}
            >
              Excluir mensagem
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
