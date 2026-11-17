import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { nativeInviteLink, parseInviteInput } from "../lib/invites";
import type { CommunityInvite } from "../lib/invites";
import type { Guild } from "../lib/types";
import { ErrorBanner, Modal } from "./ui";

export default function Invite({
  invite,
  desktop,
  authenticated,
  server,
  onJoined,
  onDismiss,
}: {
  invite: CommunityInvite;
  desktop: boolean;
  authenticated: boolean;
  server: string;
  onJoined: (guild: Guild) => void;
  onDismiss: () => void;
}) {
  const [continueHere, setContinueHere] = useState(desktop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accepting = useRef(false);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const differentServer = invite.server !== server;
  async function join() {
    if (accepting.current || differentServer) return;
    accepting.current = true;
    setBusy(true);
    setError("");
    controller.current = new AbortController();
    try {
      const parsed = parseInviteInput(nativeInviteLink(invite), server);
      const guild = await api<Guild>("/api/invites/accept", {
        method: "POST",
        body: { token: parsed.token },
        signal: controller.current.signal,
      });
      if (active.current) onJoined(guild);
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      accepting.current = false;
      if (active.current) setBusy(false);
    }
  }
  if (continueHere && !authenticated)
    return (
      <aside className="invite-banner" role="status">
        <span>
          {differentServer
            ? "Este convite pertence a outro servidor. Selecione essa instância em Usar outro servidor."
            : "Convite guardado. Entre ou crie sua conta para entrar na comunidade."}
        </span>
        <button onClick={onDismiss}>Cancelar convite</button>
      </aside>
    );
  return (
    <Modal title="Convite para a comunidade" onClose={onDismiss}>
      <p>Você recebeu um convite para conversar no Harmony.</p>
      <p className="muted">Servidor: {invite.server}</p>
      {differentServer && (
        <ErrorBanner message="Este convite pertence a outro servidor. Volte à tela de acesso e selecione essa instância em Usar outro servidor." />
      )}
      <ErrorBanner message={error} />
      <div className="invite-actions">
        {authenticated ? (
          <button
            className="button primary full"
            disabled={busy || differentServer}
            onClick={() => void join()}
          >
            {busy ? "Entrando…" : "Entrar na comunidade"}
          </button>
        ) : (
          <>
            <a className="button primary full" href={nativeInviteLink(invite)}>
              Abrir no Harmony
            </a>
            <button
              className="button full"
              onClick={() => setContinueHere(true)}
            >
              Continuar no navegador
            </button>
            <a
              className="button full"
              href="https://github.com/BersaneV/Harmony/releases/download/v0.4.12/Harmony_0.4.12_x64-setup.exe"
              rel="noreferrer"
            >
              Baixar para Windows
            </a>
            <p className="muted">
              Se o aplicativo ainda não abrir pelo link, instale a versão atual
              e clique em Abrir no Harmony novamente.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
