import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  audioDiagnostics,
  playbackSnapshot,
  browserAudioInventory,
} from "../lib/audio-diagnostics";
import { sampleWindowsAudio } from "../lib/useAudioDiagnostics";

export function AudioDiagnostics() {
  const [busy, setBusy] = useState(false),
    [names, setNames] = useState(false),
    [message, setMessage] = useState("");
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const windows = await sampleWindowsAudio(names);
      audioDiagnostics.add("export", {
        playback: playbackSnapshot(document.querySelectorAll("audio")),
      });
      let browserDevices: ReturnType<typeof browserAudioInventory> = [];
      let microphonePermission = "unavailable";
      try {
        browserDevices = browserAudioInventory(
          await navigator.mediaDevices.enumerateDevices(),
          names,
        );
      } catch {
        /* Do not request access. */
      }
      try {
        microphonePermission = (
          await navigator.permissions.query({
            name: "microphone" as PermissionName,
          })
        ).state;
      } catch {
        /* Unsupported. */
      }
      const report = {
        ...audioDiagnostics.report(await getVersion()),
        windows,
        browserDevices,
        microphonePermission,
        device_names_requested: names,
      };
      const name = await invoke<string>("save_audio_diagnostics", {
        report: JSON.stringify(report),
      });
      setMessage(
        `Salvo em Downloads: ${name}. Envie esse arquivo a quem está investigando o problema.`,
      );
    } catch {
      setMessage(
        "Não foi possível salvar o diagnóstico. Tente novamente e confira o acesso à pasta Downloads.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!isTauri()) return null;
  return (
    <div className="small-note">
      <strong>Diagnóstico de áudio</strong>
      <p>
        Quando o som sumir, salve o relatório antes de sair da chamada. Ele
        inclui os últimos minutos de estados da chamada, reprodução e
        dispositivos do Windows. Não grava áudio nem inclui mensagens, senhas,
        tokens ou endereços de rede. Nada é enviado automaticamente.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={names}
          onChange={(e) => setNames(e.target.checked)}
        />{" "}
        Incluir nomes dos dispositivos (podem conter nomes pessoais)
      </label>
      <button className="button" disabled={busy} onClick={() => void save()}>
        {busy ? "Salvando diagnóstico…" : "Salvar diagnóstico de áudio"}
      </button>
      <button
        className="button subtle"
        disabled={busy}
        onClick={() => {
          audioDiagnostics.clear();
          setMessage("Histórico de diagnóstico limpo neste aplicativo.");
        }}
      >
        Limpar histórico de áudio
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
