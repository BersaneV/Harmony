import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, RefreshCw } from "lucide-react";
import { ErrorBanner } from "./ui";

type UpdateStatus = { phase: string; version: string | null; downloaded: number; total: number | null };
const initial: UpdateStatus = { phase: "idle", version: null, downloaded: 0, total: null };
export function Updates() {
  const [status, setStatus] = useState<UpdateStatus>(initial);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const native = isTauri();
  useEffect(() => {
    if (!native) return;
    let active = true;
    const unlisten = listen<UpdateStatus>("updater-progress", ({ payload }) => { if (active) setStatus(payload); });
    void invoke<UpdateStatus>("update_status").then((value) => { if (active) setStatus(value); }).catch(() => {});
    return () => { active = false; void unlisten.then((dispose) => dispose()); };
  }, [native]);
  async function run(command: string) {
    setPending(true); setError("");
    try {
      const value = await invoke<UpdateStatus | null>(command);
      if (value) setStatus(value);
    } catch (e) { setError(typeof e === "string" ? e : "Não foi possível concluir a atualização."); }
    finally { setPending(false); }
  }
  const downloading = status.phase === "downloading";
  const busy = pending || downloading || status.phase === "checking" || status.phase === "installing";
  return <section aria-label="Atualizações do aplicativo" className="settings-updates">
    <h3><RefreshCw size={17} /> Atualizações</h3>
    {!native ? <p className="muted">No navegador, as novidades chegam quando o servidor é atualizado. O instalador para Windows possui atualização com assinatura verificada.</p> : <>
      <p className="muted">Os pacotes são verificados antes da instalação. Instalar fecha o Harmony e interrompe chamadas em andamento.</p>
      <div role="status" aria-live="polite">
        {status.phase === "checking" && "Consultando atualizações…"}
        {status.phase === "current" && "Você está na versão mais recente deste canal."}
        {status.version && status.phase === "available" && `Versão ${status.version} disponível.`}
        {downloading && `Baixando ${status.version}: ${(status.downloaded / 1048576).toFixed(1)} MB${status.total ? ` de ${(status.total / 1048576).toFixed(1)} MB` : ""}.`}
        {status.phase === "ready" && `Versão ${status.version}: assinatura e versão verificadas. Pronta para instalar.`}
        {status.phase === "installing" && "Iniciando o instalador…"}
      </div>
      {downloading && <progress aria-label="Progresso da atualização" value={status.total ? status.downloaded : undefined} max={status.total || undefined} />}
      <ErrorBanner message={error} />
      <div className="button-row">
        <button type="button" className="secondary" disabled={busy} onClick={() => void run("check_update")}><RefreshCw size={15} /> Verificar atualizações</button>
        {status.phase === "available" && <button type="button" className="primary" disabled={busy} onClick={() => void run("download_update")}><Download size={15} /> Baixar e verificar</button>}
        {downloading && <button type="button" className="secondary" onClick={() => void invoke("cancel_update").catch(() => setError("Não foi possível cancelar."))}>Cancelar download</button>}
        {status.phase === "ready" && <button type="button" className="primary" disabled={busy} onClick={() => void run("install_update")}>Instalar e reiniciar</button>}
      </div>
    </>}
  </section>;
}
