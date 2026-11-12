import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  getServer,
  getSession,
  onSession,
} from "../lib/api";
import { P2PProbe, probeLimitations } from "../lib/p2p";
import { useP2PDiscovery } from "../lib/useP2PDiscovery";
import type { AvailableProbe } from "../lib/useP2PDiscovery";
import type { ProbeProfile, ProbeReport, ProbeSnapshot } from "../lib/p2p";
import { frameRates, resolutions } from "../lib/stream";
import { ErrorBanner, Field, Modal } from "./ui";

const metric = (value: number | null | undefined, suffix: string) =>
  value === null || value === undefined
    ? "Indisponível"
    : `${value.toFixed(1)} ${suffix}`;

export default function P2PDiagnostics({
  channelId,
  initialProbe,
  onClose,
}: {
  channelId: string;
  initialProbe?: AvailableProbe | null;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Pronto para testar");
  const [active, setActive] = useState(false);
  const discovery = useP2PDiscovery(channelId, !active);
  const info = discovery.data;
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
    const user = getSession()?.user.id;
    const origin = getServer();
    const unsubscribe = onSession((session) => {
      if (!session || session.user.id !== user || getServer() !== origin)
        probe.current?.stop("A sessão mudou");
    });
    return () => {
      mounted.current = false;
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
          void discovery.refetch();
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
      run(result.probe_id);
    } catch (e) {
      setActive(false);
      setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function join(available: AvailableProbe) {
    try {
      run(available.id);
    } catch (e) {
      setActive(false);
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    if (!initialProbe) return;
    // A committed user click starts the invitation. Cleanup cancels StrictMode's
    // discarded mount before a network connection is made.
    const timer = setTimeout(() => join(initialProbe), 0);
    return () => clearTimeout(timer);
  }, [channelId, initialProbe?.id]);
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
      <ErrorBanner
        message={
          error || (discovery.error ? errorMessage(discovery.error) : "")
        }
      />
      {info && (
        <>
          <p>
            {info.stun_configured
              ? "STUN configurado para tentar conexão entre redes."
              : "Sem STUN configurado: a conexão pode funcionar apenas na mesma rede."}{" "}
            Nenhum serviço TURN pago será acionado.
          </p>
          <p className="muted">
            Ao iniciar ou participar, você abre uma conexão direta com o outro
            participante; os endereços de rede podem ficar visíveis entre vocês.
          </p>
          {!active && !discovery.error && info.available.length > 0 && (
            <div
              className="p2p-invitations"
              aria-label="Testes disponíveis neste canal"
            >
              {info.available.map((available) => (
                <div className="p2p-invitation" key={available.id}>
                  <div>
                    <strong>{available.host_name}</strong>
                    <span> está aguardando você neste canal</span>
                  </div>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => join(available)}
                    aria-label={`Participar do teste de ${available.host_name}`}
                  >
                    Participar
                  </button>
                </div>
              ))}
            </div>
          )}
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
              disabled={active || busy || !!discovery.error}
              onClick={() => void create()}
            >
              Iniciar teste no canal
            </button>
            <button
              className="button"
              disabled={!active}
              onClick={() => probe.current?.stop()}
            >
              Encerrar teste
            </button>
          </div>
          {!active && !discovery.error && info.available.length === 0 && (
            <p className="muted">
              Inicie o teste; a outra pessoa verá o convite automaticamente ao
              abrir este canal.
            </p>
          )}
          {active && !remote && !initialProbe && (
            <p className="muted">
              O convite aparece neste canal para os outros participantes
              autorizados.
            </p>
          )}
        </>
      )}
      <p className="diagnostic-status" role="status">
        {status}
      </p>
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
