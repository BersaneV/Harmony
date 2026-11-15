import { useState } from "react";
import type { NativeSource } from "../lib/native-screen";
import { Field, Modal } from "./ui";

export function NativeSourcePicker({
  sources,
  onSelect,
  onCancel,
}: {
  sources: NativeSource[];
  onSelect: (key: string) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState(sources[0]?.key ?? "");
  return (
    <Modal title="Escolher janela do Windows" onClose={onCancel}>
      <p className="muted">
        Escolha a janela para a prévia. O Windows pedirá sua confirmação antes
        de iniciar a captura. Ela ainda não será publicada na chamada.
      </p>
      <Field label="Janela">
        <select value={key} onChange={(event) => setKey(event.target.value)}>
          {sources.map((source) => (
            <option key={source.key} value={source.key}>
              {source.title}
            </option>
          ))}
        </select>
      </Field>
      {!sources.length && (
        <p role="status">
          Nenhuma janela disponível. Abra a janela e escolha a fonte novamente.
        </p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={onCancel}>
          Cancelar
        </button>
        <button
          className="button primary"
          disabled={!key}
          onClick={() => onSelect(key)}
        >
          Confirmar janela
        </button>
      </div>
    </Modal>
  );
}
