import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { AudioDiagnostics } from "./AudioDiagnostics";

interface AudioStatus {
  supported: boolean;
  ducking_preference: number | null;
}

export function AudioHelp() {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<AudioStatus>("windows_audio_status").then(
      (result) => {
        if (active) setStatus(result);
      },
      () => {
        if (active)
          setMessage("Não foi possível consultar o áudio do Windows.");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function disableDucking() {
    setBusy(true);
    setMessage("");
    try {
      const next = await invoke<AudioStatus>("disable_windows_audio_ducking");
      setStatus(next);
      setMessage(
        "Preferência salva. Saia e entre novamente na chamada para testar o som do PC.",
      );
    } catch {
      setMessage(
        "Não foi possível aplicar. No Windows, abra Som → Comunicações → Não fazer nada → Aplicar.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="small-note">
      <strong>O som dos outros aplicativos sumiu?</strong>
      {status?.supported && (
        <>
          <p>
            {status.ducking_preference === 3
              ? "A redução automática de outros sons já está desativada no Windows."
              : "O Windows pode reduzir ou silenciar outros sons ao detectar uma chamada."}
          </p>
          {status.ducking_preference !== 3 && (
            <>
              <p>
                Este botão seleciona “Não fazer nada” em Som → Comunicações. É
                uma preferência permanente do seu usuário Windows e vale para as
                chamadas de todos os aplicativos.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() => void disableDucking()}
              >
                {busy ? "Aplicando…" : "Manter os outros sons no Windows"}
              </button>
            </>
          )}
        </>
      )}
      {!isTauri() && (
        <p>No Windows, confira Som → Comunicações → Não fazer nada.</p>
      )}
      <p>
        Com Bluetooth clássico, o microfone do próprio fone pode mudar o
        dispositivo para o modo de chamada e interromper o áudio estéreo. Para
        manter o estéreo, escolha o microfone do notebook ou um microfone USB e
        deixe o fone como saída. O Harmony lembra essas escolhas neste
        dispositivo.
      </p>
      {message && <p role="status">{message}</p>}
      <AudioDiagnostics />
    </div>
  );
}
