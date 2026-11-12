import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  getServer,
  getSession,
  onSession,
} from "../lib/api";
import { P2PProbe, probeLimitations } from "../lib/p2p";
import type { ProbeProfile, ProbeReport, ProbeSnapshot } from "../lib/p2p";
import { frameRates, resolutions } from "../lib/stream";
import { ErrorBanner, Field, Modal } from "./ui";

interface Info {
  enabled: boolean;
  duration_seconds: number;
  stun_configured: boolean;
  relay_configured: boolean;
}
const metric = (value: number | null | undefined, suffix: string) =>
  value === null || value === undefined
    ? "Indisponível"
    : `${value.toFixed(1)} ${suffix}`;

export default function P2PDiagnostics({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Preparando diagnóstico");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<ProbeSnapshot | null>(null);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [profile, setProfile] = useState<ProbeProfile>({
    height: 720,
    fps: 30,
    bitrate: 2_000_000,
  });
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const probe = useRef<P2PProbe | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<Info>(`/api/channels/${channelId}/p2p-probes`, {
      signal: controller.signal,
    })
      .then((value) => {
        setInfo(value);
        setStatus("Pronto para testar");
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            `Diagnóstico indisponível ou não autorizado. ${errorMessage(e)}`,
          );
      });
    const user = getSession()?.user.id;
    const origin = getServer();
    const unsubscribe = onSession((session) => {
      if (!session || session.user.id !== user || getServer() !== origin)
        probe.current?.stop("A sessão mudou");
    });
    return () => {
      mounted.current = false;
      controller.abort();
      unsubscribe();
      probe.current?.stop();
    };
  }, [channelId]);
  useEffect(() => {
    if (video.current) video.current.srcObject = remote;
  }, [remote]);

  function run(probeId: string) {
    const session = getSession();
    if (!session) throw new Error("Entre novamente para testar.");
    setReport(null);
    setSnapshot(null);
    setError("");
    setActive(true);
    probe.current = new P2PProbe({
      server: getServer(),
      token: session.access_token,
      probeId,
      channelId,
      profile,
      onStatus: (value) => {
        if (mounted.current) setStatus(value);
      },
      onSnapshot: (value) => {
        if (mounted.current) setSnapshot(value);
      },
      onVideo: (value) => {
        if (mounted.current) setRemote(value);
      },
      onClosed: (value) => {
        if (mounted.current) {
          setReport(value);
          setActive(false);
          setRemote(null);
        }
      },
    });
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ probe_id: string }>(
        `/api/channels/${channelId}/p2p-probes`,
        { method: "POST" },
      );
      if (!mounted.current) return;
      setCode(result.probe_id);
      run(result.probe_id);
    } catch (e) {
      setActive(false);
      setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function join() {
    try {
      run(joinCode.trim());
    } catch (e) {
      setActive(false);
      setError(errorMessage(e));
    }
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "harmony-p2p-diagnostico.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Modal title="Teste de conexão P2P" onClose={onClose} wide>
      <p>
        Compare a conexão direta entre dois participantes com a ida e volta até
        o servidor. O teste dura até dois minutos e transmite somente um vídeo
        gerado, sem acessar câmera, microfone ou tela.
      </p>
      <p>
        Os dois participantes precisam estar autorizados neste canal. As
        chamadas normais continuam usando o servidor de mídia.
      </p>
      <ErrorBanner message={error} />
      {info && (
        <>
          <p>
            {info.stun_configured
              ? "STUN configurado para tentar conexão entre redes."
              : "Sem STUN configurado: a conexão pode funcionar apenas na mesma rede."}{" "}
            Nenhum serviço TURN pago será acionado.
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={consent}
              disabled={active}
              onChange={(e) => setConsent(e.target.checked)}
            />
            Aceito testar uma conexão direta; o outro participante pode conhecer
            meu endereço IP.
          </label>
          <div className="stream-form">
            <Field label="Resolução do vídeo de teste">
              <select
                value={profile.height}
                disabled={active}
                onChange={(e) =>
                  setProfile({ ...profile, height: Number(e.target.value) })
                }
              >
                {resolutions.map((height) => (
                  <option key={height} value={height}>
                    {height}p
                  </option>
                ))}
              </select>
            </Field>
            <Field label="FPS solicitado">
              <select
                value={profile.fps}
                disabled={active}
                onChange={(e) =>
                  setProfile({ ...profile, fps: Number(e.target.value) })
                }
              >
                {frameRates.map((fps) => (
                  <option key={fps} value={fps}>
                    {fps}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Teto de bitrate (Mb/s)">
              <input
                type="number"
                min={0.5}
                max={32}
                step={0.5}
                value={profile.bitrate / 1_000_000}
                disabled={active}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    bitrate: Number(e.target.value) * 1_000_000,
                  })
                }
              />
            </Field>
          </div>
          <p>
            Quem cria o teste transmite o vídeo sintético; a outra pessoa
            recebe. Para medir no sentido contrário, encerrem e invertam quem
            cria.
          </p>
          <div className="diagnostic-actions">
            <button
              className="button primary"
              disabled={!consent || active || busy}
              onClick={() => void create()}
            >
              Criar teste
            </button>
            <button className="button" disabled={!active} onClick={() => probe.current?.stop()}>
              Encerrar teste
            </button>
          </div>
          {code && (
            <Field label="Código para o outro participante deste canal">
              <input
                readOnly
                value={code}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
          )}
          <Field label="Entrar com o código recebido">
            <input
              value={joinCode}
              disabled={active}
              maxLength={64}
              autoComplete="off"
              onChange={(e) => setJoinCode(e.target.value)}
            />
          </Field>
          <button
            className="button"
            disabled={
              !consent ||
              active ||
              busy ||
              !/^[a-f0-9]{64}$/.test(joinCode.trim())
            }
            onClick={join}
          >
            Entrar no teste
          </button>
        </>
      )}
      <p className="diagnostic-status" role="status">{status}</p>
      {remote && (
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          className="video-surface"
          style={{ maxHeight: 260 }}
        />
      )}
      {snapshot && (
        <dl className="diagnostic-metrics">
          <dt>Caminho ICE</dt>
          <dd>
            {snapshot.route === "direct"
              ? "Direto entre os participantes"
              : snapshot.route === "relay"
                ? "Retransmitido por relay"
                : "Ainda não identificado"}{" "}
            ({snapshot.protocol || "protocolo indisponível"})
          </dd>
          <dt>RTT P2P mediano / p95</dt>
          <dd>
            {metric(snapshot.p2pMedianMs, "ms")} /{" "}
            {metric(snapshot.p2pP95Ms, "ms")}
          </dd>
          <dt>RTT até o servidor</dt>
          <dd>{metric(snapshot.signalingMedianMs, "ms")}</dd>
          <dt>Ping recebido / enviado / expirado / pendente</dt>
          <dd>
            {snapshot.pingReceived} / {snapshot.pingSent} /{" "}
            {snapshot.pingTimedOut} / {snapshot.pingPending}
          </dd>
          <dt>Vídeo efetivo</dt>
          <dd>
            {snapshot.videoWidth && snapshot.videoHeight
              ? `${snapshot.videoWidth}×${snapshot.videoHeight}`
              : "Indisponível"}{" "}
            · {metric(snapshot.videoFps, "FPS")} ·{" "}
            {metric(
              snapshot.videoBitrate === null
                ? null
                : snapshot.videoBitrate / 1_000_000,
              "Mb/s",
            )}
          </dd>
          <dt>Jitter / pacotes perdidos recebidos</dt>
          <dd>
            {metric(snapshot.jitterMs, "ms")} /{" "}
            {snapshot.packetsLost ?? "Indisponível"}
          </dd>
        </dl>
      )}
      {report && (
        <button className="button" onClick={download}>
          Baixar resultado sem IPs ou credenciais
        </button>
      )}
      <ul>
        {probeLimitations.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </Modal>
  );
}
