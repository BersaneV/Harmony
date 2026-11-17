import { useEffect, useRef, useState } from "react";
import { AudioCheck } from "../lib/audio-check";
import type { AudioCheckState } from "../lib/audio-check";
import { readAudioDevices } from "../lib/audio-devices";

export function AudioTests({
  input,
  output,
}: {
  input?: string;
  output?: string;
}) {
  const saved = readAudioDevices(),
    selectedInput = input ?? saved.audioinput,
    selectedOutput = output ?? saved.audiooutput;
  const mounted = useRef(true);
  const [state, setState] = useState<AudioCheckState>({
    mode: null,
    level: 0,
    message: "",
  });
  const [check] = useState(
    () =>
      new AudioCheck((s) => {
        if (mounted.current) setState(s);
      }),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      check.stop();
    };
  }, [check]);
  useEffect(() => {
    check.stop("");
  }, [check, selectedInput, selectedOutput]);
  return (
    <div className="audio-tests">
      <h3>Testar áudio</h3>
      <p className="small-note">
        Usa o microfone e a saída escolhidos para a chamada. O teste do
        microfone é local e silencia seu microfone na chamada; religue-o ao
        terminar. Use fones para evitar eco.
      </p>
      <div className="modal-actions">
        <button
          className="button"
          onClick={() => void check.microphone(selectedInput, selectedOutput)}
          disabled={state.mode !== null}
        >
          Testar microfone
        </button>
        <button
          className="button"
          onClick={() => void check.sound(selectedOutput)}
          disabled={state.mode !== null}
        >
          Testar saída de som
        </button>
        {state.mode && (
          <button className="button" onClick={() => check.stop()}>
            Parar teste de áudio
          </button>
        )}
      </div>
      {state.mode === "microphone" && (
        <label className="field">
          <span>Nível do microfone</span>
          <meter
            aria-label="Nível do microfone"
            min={0}
            max={100}
            value={state.level}
            style={{ width: "100%" }}
          />
        </label>
      )}
      {state.message && <p role="status">{state.message}</p>}
    </div>
  );
}
