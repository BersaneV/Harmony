import { useEffect, useState } from "react";
import {
  defaultCallKeys,
  readCallKeys,
  saveCallKeys,
  shortcutFromEvent,
  shortcutLabel,
} from "../lib/call-shortcuts";
import type { CallKeyAction } from "../lib/call-shortcuts";
import { Field } from "./ui";
const capturing = (value: boolean) =>
  window.dispatchEvent(
    new CustomEvent("harmony-shortcut-capture", { detail: value }),
  );
export function CallKeysSettings() {
  const [keys, setKeys] = useState(readCallKeys),
    [message, setMessage] = useState(""),
    [recording, setRecording] = useState<CallKeyAction | null>(null);
  useEffect(
    () => () => {
      capturing(false);
    },
    [],
  );
  function apply(next: typeof keys) {
    try {
      saveCallKeys(next);
      setKeys(next);
      setMessage("Atalhos salvos neste dispositivo.");
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar.");
      return false;
    }
  }
  return (
    <div>
      <h3>Atalhos da chamada</h3>
      <p className="small-note">
        Clique no campo e pressione a tecla ou combinação desejada, como Scroll
        Lock ou Ctrl + Shift + M. Para letras e números, use Ctrl ou Alt junto.
        No aplicativo, os atalhos funcionam fora da janela enquanto você estiver
        na chamada.
      </p>
      {(["microphone", "deafen", "ptt"] as const).map((action) => (
        <Field
          key={action}
          label={
            action === "microphone"
              ? "Atalho para ligar/desligar microfone"
              : action === "deafen"
                ? "Atalho para parar/voltar a ouvir"
                : "Atalho para segurar e falar"
          }
        >
          <input
            readOnly
            value={
              recording === action
                ? "Pressione uma tecla…"
                : shortcutLabel(keys[action])
            }
            placeholder="Clique para definir"
            onFocus={() => {
              setRecording(action);
              capturing(true);
            }}
            onBlur={() => {
              setRecording(null);
              capturing(false);
            }}
            onKeyDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.code === "Escape") {
                e.currentTarget.blur();
                return;
              }
              if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(e.code)) return;
              const value = shortcutFromEvent(e);
              if (!value) {
                setMessage(
                  "Use uma tecla especial (como Scroll Lock ou F9) ou Ctrl/Alt junto de outra tecla.",
                );
                return;
              }
              if (apply({ ...keys, [action]: value })) e.currentTarget.blur();
            }}
          />
          <button
            type="button"
            className="button subtle"
            onClick={() => apply({ ...keys, [action]: "" })}
          >
            Remover atalho{" "}
            {action === "microphone"
              ? "do microfone"
              : action === "deafen"
                ? "do áudio"
                : "de segurar e falar"}
          </button>
        </Field>
      ))}
      <button className="button" onClick={() => apply({ ...defaultCallKeys })}>
        Restaurar atalhos padrão
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
