import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Chat from "./Chat";
import type { Channel, Message, User } from "../lib/types";
vi.mock("../lib/api", () => ({
  api: vi.fn(),
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "erro",
}));
const user: User = {
  id: "test-user",
  username: "fixture",
  display_name: "Fixture",
  is_admin: false,
  disabled: false,
  preferences: {},
  created_at: "2026-01-01T00:00:00Z",
};
const message: Message = {
  id: "test-message",
  channel_id: "test-channel",
  author: user,
  content: "Conteúdo protegido de teste",
  seq: "1",
  event_seq: "1",
  client_nonce: "test-nonce",
  created_at: "2026-01-01T00:00:00Z",
  edited_at: null,
  deleted: false,
  reactions: [{ emoji: "ok", count: 1, me: false }],
  attachments: [],
};
function render(permissions: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["messages", "test-channel"], {
    items: [message],
    has_more: false,
    cursor: "1",
  });
  const channel: Channel = {
    id: "test-channel",
    guild_id: "test-guild",
    name: "teste",
    kind: "text",
    last_seq: "1",
    effective_permissions: permissions,
  };
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Chat
        channel={channel}
        user={user}
        canModerate={false}
        maxUpload={1024}
        onTyping={vi.fn()}
        typingCount={0}
      />
    </QueryClientProvider>,
  );
  queryClient.clear();
  return html;
}
function button(html: string, label: string) {
  return (
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] || ""
  );
}
describe("controles reais de mensagens respeitam ACL", () => {
  it("retira histórico cacheado quando VIEW é negado", () => {
    const html = render("62");
    expect(html).toContain("Acesso ao canal indisponível");
    expect(html).not.toContain(message.content);
    expect(html).not.toContain('aria-label="Mensagem"');
  });
  it("canal somente leitura mostra histórico, mas desabilita escrita, anexo e reação", () => {
    const html = render("1");
    expect(html).toContain(message.content);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(button(html, "Enviar mensagem")).toContain("disabled");
    expect(button(html, "Anexar arquivos")).toContain("disabled");
    expect(button(html, "Sem permissão para reagir")).toContain("disabled");
    expect(html).toContain("Canal somente para leitura");
  });
  it("SEND não concede ATTACH ou REACT e mantém envio utilizável após digitar", () => {
    const html = render("3");
    expect(html).toMatch(/<textarea aria-label="Mensagem" placeholder=/);
    expect(button(html, "Anexar arquivos")).toContain("disabled");
    expect(button(html, "Sem permissão para reagir")).toContain("disabled");
    expect(html).not.toContain("Canal somente para leitura");
  });
  it("permissões completas habilitam anexo e reação, sem depender de papel administrativo", () => {
    const html = render("63");
    expect(button(html, "Anexar arquivos")).not.toContain("disabled");
    expect(button(html, "Reagir")).not.toContain("disabled");
  });
});
