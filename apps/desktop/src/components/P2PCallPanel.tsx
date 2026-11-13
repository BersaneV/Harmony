import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  ChevronDown,
  Expand,
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  Video,
  VideoOff,
  Volume2,
  Maximize2,
} from "lucide-react";
import { P2PCall } from "../lib/call";
import type { CallSource, CallPeerSnapshot } from "../lib/call";
import { api, errorMessage } from "../lib/api";
import { registerGlobalPtt } from "../lib/desktop";
import { can, Permission } from "../lib/permissions";
import {
  defaultProfile,
  resolutions,
  frameRates,
  validateProfile,
} from "../lib/stream";
import type { StreamProfile } from "../lib/stream";
import type { CallPanelProps } from "./CallPanel";
import {
  Avatar,
  Empty,
  ErrorBanner,
  Field,
  IconButton,
  Loading,
  Modal,
} from "./ui";

function VideoSurface({
  track,
  local = false,
}: {
  track: MediaStreamTrack;
  local?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={local}
      className="video-surface"
    />
  );
}

function AudioSurface({
  track,
  volume,
  output,
  blocked,
}: {
  track: MediaStreamTrack;
  volume: number;
  output: string;
  blocked: () => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const currentVolume = useRef(volume);
  currentVolume.current = volume;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = new MediaStream([track]);
    element.volume = currentVolume.current;
    void element.play().catch(blocked);
    return () => {
      element.srcObject = null;
    };
  }, [track, blocked]);
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    const element = ref.current;
    if (element && "setSinkId" in element)
      void element.setSinkId(output).catch(blocked);
  }, [output, blocked]);
  return <audio ref={ref} autoPlay />;
}

function RemoteTile({
  peer,
  source,
  focused,
  onFocus,
  volume,
  onVolume,
  height,
  onHeight,
}: {
  peer: CallPeerSnapshot;
  source: "camera" | "screen";
  focused: boolean;
  onFocus: () => void;
  volume: { voice: number; screen: number };
  onVolume: (source: "voice" | "screen", value: number) => void;
  height: number;
  onHeight: (height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const track =
    peer.can_publish && peer.media[source] ? peer.tracks[source] : undefined;
  const stats = peer.stats.received[source];
  const overCeiling =
    source === "screen" &&
    height > 0 &&
    (stats?.height || track?.getSettings().height || 0) > height;
  const speaking =
    peer.media.microphone &&
    (peer.stats.received.microphone?.audioLevel ?? 0) > 0.015;
  return (
    <div
      ref={ref}
      className={`video-tile ${focused ? "focused" : ""} ${speaking ? "speaking" : ""}`}
    >
      {track && !overCeiling ? (
        <VideoSurface track={track} />
      ) : (
        <div className="video-placeholder">
          <Avatar name={peer.display_name} size={72} />
          <small>
            {overCeiling
              ? `Aguardando vídeo dentro do teto de ${height}p. Aumente o teto se o emissor não conseguir adaptar.`
              : peer.connection === "connected"
                ? peer.media.microphone
                  ? "Microfone ligado"
                  : "Microfone desligado"
                : peer.connection === "failed"
                  ? "A rede não permitiu a conexão direta"
                  : "Conectando diretamente…"}
          </small>
        </div>
      )}
      <div className="video-label">
        <span>
          {source === "screen" ? (
            <MonitorUp size={14} />
          ) : peer.media.microphone ? (
            <Mic size={14} />
          ) : (
            <MicOff size={14} />
          )}{" "}
          {peer.display_name}
          {source === "screen" ? " · tela" : ""}
        </span>
        <div>
          <IconButton
            label={focused ? "Voltar para grade" : "Focar transmissão"}
            onClick={onFocus}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            label="Tela cheia"
            onClick={() =>
              void ref.current?.requestFullscreen().catch(() => {})
            }
          >
            <Expand size={15} />
          </IconButton>
        </div>
      </div>
      <div className="video-options">
        <label title="Volume do microfone">
          <Volume2 size={14} />
          <input
            aria-label={`Volume de voz de ${peer.display_name}`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume.voice}
            onChange={(e) => onVolume("voice", Number(e.target.value))}
          />
        </label>
        {peer.media.screen_audio && (
          <label title="Volume do áudio da tela">
            <MonitorUp size={14} />
            <input
              aria-label={`Volume da tela de ${peer.display_name}`}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume.screen}
              onChange={(e) => onVolume("screen", Number(e.target.value))}
            />
          </label>
        )}
        {source === "screen" && (
          <select
            aria-label={`Teto de resolução de ${peer.display_name}`}
            value={height}
            onChange={(e) => onHeight(Number(e.target.value))}
          >
            <option value={0}>Qualidade automática</option>
            {resolutions.map((h) => (
              <option key={h} value={h}>
                Até {h}p
              </option>
            ))}
          </select>
        )}
        <small>
          {stats?.height
            ? `${stats.width ?? "?"}×${stats.height} · ${stats.fps == null ? "FPS indisponível" : `${Math.round(stats.fps)} FPS`} · ${stats.bitrate == null ? "bitrate indisponível" : `${(stats.bitrate / 1e6).toFixed(2)} Mb/s`}`
            : "Aguardando mídia"}
          {peer.stats.iceRttMs != null
            ? ` · ${Math.round(peer.stats.iceRttMs)} ms`
            : ""}
        </small>
        {peer.error && <small role="status">{peer.error}</small>}
      </div>
    </div>
  );
}

export default function P2PCallPanel({
  channel,
  expanded,
  onClose,
  onExpand,
  canModerate,
}: CallPanelProps) {
  const [engine] = useState(() => new P2PCall({ channelId: channel.id }));
  const [state, setState] = useState(engine.snapshot);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const deafenedRef = useRef(false);
  const pendingMicrophones = useRef(new Set<MediaStreamTrack>());
  const [ptt, setPtt] = useState(false);
  const [settings, setSettings] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevices, setSelectedDevices] = useState({
    audioinput: "",
    audiooutput: "",
    videoinput: "",
  });
  const [profile, setProfile] = useState<StreamProfile>({ ...defaultProfile });
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const previewRef = useRef<MediaStream | null>(null);
  const previewGeneration = useRef(0);
  const generations = useRef<Record<CallSource, number>>({
    microphone: 0,
    camera: 0,
    screen: 0,
    screen_audio: 0,
  });
  const mounted = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const onAudioBlocked = useRef(() => setAudioBlocked(true)).current;
  const [focus, setFocus] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<
    Record<string, { voice: number; screen: number }>
  >({});
  const [receiveHeights, setReceiveHeights] = useState<Record<string, number>>(
    {},
  );
  const canConnect = can(channel, Permission.Connect);
  const canPublish =
    canConnect &&
    can(channel, Permission.Publish) &&
    state.self?.can_publish === true &&
    state.state === "connected";
  const allowed = useRef(canPublish);
  allowed.current = canPublish;
  const screenTrack = state.localTracks.screen;
  const microphone = state.localTracks.microphone;
  const camera = state.localTracks.camera;
  useEffect(() => {
    if (!focus || focus === "local") return;
    const exists = state.participants.some((peer) =>
      focus === `${peer.peer_id}:screen`
        ? peer.media.screen
        : focus === `${peer.peer_id}:camera` &&
          (!peer.media.screen || peer.media.camera),
    );
    if (!exists) setFocus(null);
  }, [focus, state.participants]);

  const stopPreview = () => {
    previewGeneration.current++;
    previewRef.current?.getTracks().forEach((t) => t.stop());
    previewRef.current = null;
    setPreview(null);
  };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = engine.subscribe((next) => {
      // Capture completion sees revocation before the next React paint.
      if (!next.self?.can_publish || next.state !== "connected")
        allowed.current = false;
      setState(next);
    });
    // A cancelled StrictMode effect must not allocate a socket.
    const timer = setTimeout(
      () =>
        void engine.connect().catch((e) => {
          if (mounted.current) setError(errorMessage(e));
        }),
      0,
    );
    return () => {
      mounted.current = false;
      clearTimeout(timer);
      unsubscribe();
      previewGeneration.current++;
      previewRef.current?.getTracks().forEach((t) => t.stop());
      previewRef.current = null;
      for (const source of Object.keys(generations.current) as CallSource[])
        generations.current[source]++;
      engine.close();
    };
  }, [engine]);
  useEffect(() => {
    if (!canConnect) engine.close("Sua permissão de conexão foi removida.");
  }, [engine, canConnect]);
  useEffect(() => {
    if (canPublish) return;
    stopPreview();
    setSharing(false);
    setPtt(false);
    for (const source of Object.keys(generations.current) as CallSource[]) {
      generations.current[source]++;
      if (engine.snapshot.localTracks[source])
        void engine.setTrack(source, null).catch(() => {});
    }
  }, [canPublish, engine]);

  async function action(work: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function captureDevice(
    source: "microphone" | "camera",
    device = selectedDevices[
      source === "microphone" ? "audioinput" : "videoinput"
    ],
    enabled = true,
  ) {
    if (!allowed.current)
      throw new Error("Você não tem permissão para publicar nesta chamada.");
    const attempt = ++generations.current[source];
    const stream = await navigator.mediaDevices.getUserMedia(
      source === "microphone"
        ? {
            video: false,
            audio: {
              ...(device ? { deviceId: { exact: device } } : {}),
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }
        : {
            audio: false,
            video: {
              ...(device ? { deviceId: { exact: device } } : {}),
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { max: 30 },
            },
          },
    );
    if (
      !mounted.current ||
      !allowed.current ||
      attempt !== generations.current[source]
    ) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const track =
      source === "microphone"
        ? stream.getAudioTracks()[0]
        : stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("O dispositivo não forneceu mídia.");
    }
    track.enabled =
      enabled && (source !== "microphone" || !deafenedRef.current);
    if (source === "microphone") pendingMicrophones.current.add(track);
    try {
      await engine.setTrack(source, track);
    } catch (failure) {
      stream.getTracks().forEach((t) => t.stop());
      throw failure;
    } finally {
      pendingMicrophones.current.delete(track);
    }
    if (source === "microphone" && deafenedRef.current) track.enabled = false;
    if (
      !mounted.current ||
      !allowed.current ||
      attempt !== generations.current[source]
    ) {
      if (engine.snapshot.localTracks[source] === track)
        await engine.setTrack(source, null);
      else track.stop();
    }
    setDevices(await navigator.mediaDevices.enumerateDevices());
  }
  async function stopDevice(source: CallSource) {
    generations.current[source]++;
    await engine.setTrack(source, null);
  }
  async function setPushToTalk(enabled: boolean) {
    if (enabled) {
      await captureDevice("microphone", selectedDevices.audioinput, false);
      if (allowed.current) setPtt(true);
    } else {
      setPtt(false);
      await stopDevice("microphone");
    }
  }
  useEffect(() => {
    if (!ptt || !canPublish || deafened) return;
    let stopped = false;
    let cleanupGlobal: (() => Promise<void>) | undefined;
    const mute = () => engine.setTrackEnabled("microphone", false);
    const press = () => {
      if (!stopped && allowed.current && !deafenedRef.current)
        engine.setTrackEnabled("microphone", true);
    };
    mute();
    if (isTauri()) {
      void registerGlobalPtt((pressed) => (pressed ? press() : mute()))
        .then((cleanup) => {
          if (stopped) void cleanup();
          else cleanupGlobal = cleanup;
        })
        .catch((e) => {
          if (!stopped) {
            setError(errorMessage(e));
            setPtt(false);
            mute();
          }
        });
    }
    const down = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        !isTauri() &&
        event.code === "Space" &&
        !event.repeat &&
        !(
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
        )
      ) {
        event.preventDefault();
        press();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (!isTauri() && event.code === "Space") mute();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", mute);
    return () => {
      stopped = true;
      mute();
      void cleanupGlobal?.();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", mute);
    };
  }, [engine, ptt, canPublish, deafened]);

  async function captureScreen() {
    if (!allowed.current) return;
    validateProfile(profile, state.maxVideoBitrate);
    stopPreview();
    const attempt = previewGeneration.current;
    let stream: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices.getDisplayMedia)
        throw new Error(
          "Este navegador não permite compartilhar a tela. Use o aplicativo Windows ou um navegador desktop compatível.",
        );
      const options: DisplayMediaStreamOptions & {
        selfBrowserSurface: string;
        systemAudio: string;
        surfaceSwitching: string;
      } = {
        video: {
          ...(profile.height ? { height: { ideal: profile.height } } : {}),
          frameRate: { ideal: profile.fps || 30 },
        },
        audio: profile.audio,
        selfBrowserSurface: "exclude",
        systemAudio: "include",
        surfaceSwitching: "include",
      };
      // Called directly from the button gesture; never on mount or reconnection.
      stream = await navigator.mediaDevices.getDisplayMedia(options);
      const video = stream.getVideoTracks()[0];
      if (!video) throw new Error("A captura não forneceu vídeo.");
      const settings = video.getSettings();
      const ratio = (settings.width || 16) / (settings.height || 9);
      await video.applyConstraints({
        ...(profile.height
          ? {
              height: { max: profile.height },
              width: { max: Math.round(profile.height * ratio) },
            }
          : {}),
        frameRate: { max: profile.fps || 30 },
      });
      video.contentHint = profile.content === "text" ? "detail" : "motion";
      if (
        !mounted.current ||
        !allowed.current ||
        attempt !== previewGeneration.current
      ) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      previewRef.current = stream;
      setPreview(stream);
      video.addEventListener(
        "ended",
        () => {
          if (previewRef.current === stream) stopPreview();
        },
        { once: true },
      );
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      throw e instanceof DOMException && e.name === "NotAllowedError"
        ? new Error("A seleção foi cancelada ou a captura não foi autorizada.")
        : e;
    }
  }
  async function stopSharing() {
    await engine.setTrack("screen_audio", null);
    await engine.setTrack("screen", null);
  }
  async function publishScreen() {
    const stream = previewRef.current;
    if (!stream || !allowed.current) return;
    const video = stream.getVideoTracks()[0];
    if (!video || video.readyState !== "live")
      throw new Error("A captura terminou. Escolha a tela novamente.");
    const attempt = previewGeneration.current;
    try {
      await engine.setScreenProfile(profile);
      if (!allowed.current || attempt !== previewGeneration.current)
        throw new Error("A publicação foi cancelada.");
      await engine.setTrack("screen", video);
      if (!allowed.current || attempt !== previewGeneration.current)
        throw new Error("A publicação foi cancelada.");
      const audio = stream.getAudioTracks()[0];
      if (!profile.audio) audio?.stop();
      await engine.setTrack(
        "screen_audio",
        profile.audio ? audio || null : null,
      );
      if (!allowed.current || attempt !== previewGeneration.current)
        throw new Error("A publicação foi cancelada.");
      previewRef.current = null;
      setPreview(null);
      setSharing(false);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      if (engine.snapshot.localTracks.screen === video) await stopSharing();
      stopPreview();
      throw e;
    }
  }
  async function configure() {
    setSettings(true);
    setDevices(await navigator.mediaDevices.enumerateDevices());
  }
  async function changeDevice(
    kind: "audioinput" | "audiooutput" | "videoinput",
    value: string,
  ) {
    setSelectedDevices((previous) => ({ ...previous, [kind]: value }));
    if (kind === "audioinput" && microphone)
      await captureDevice("microphone", value, microphone.enabled);
    if (kind === "videoinput" && camera) await captureDevice("camera", value);
  }
  async function unlockAudio() {
    setAudioBlocked(false);
    await Promise.all(
      Array.from(panel.current?.querySelectorAll("audio") || []).map((audio) =>
        audio.play(),
      ),
    );
  }
  const peerVolume = (id: string) => volumes[id] || { voice: 1, screen: 1 };
  const requestedBitrate = state.profile.bitrate
    ? state.profile.bitrate * 1e6
    : Math.min(state.maxVideoBitrate, 8e6);
  const outgoing = state.participants
    .map((p) => p.stats.sent.screen)
    .filter((s) => s?.bitrate != null);
  const measuredUpload = outgoing.length
    ? `${(outgoing.reduce((total, s) => total + s!.bitrate!, 0) / 1e6).toFixed(2)} Mb/s${outgoing.length < state.participants.length ? " (parcial)" : ""}`
    : "aguardando medição";
  const screenSettings = screenTrack?.getSettings();
  const status =
    state.state === "connected"
      ? "Chamada direta"
      : state.state === "connecting"
        ? "Conectando"
        : "Desconectado";
  return (
    <section
      ref={panel}
      className={`call-panel ${expanded ? "expanded" : "collapsed"}`}
    >
      <header className="call-header">
        <span className="connection-dot" />
        <div>
          <strong>{channel.name}</strong>
          <small>
            {status} · {state.participants.length + (state.self ? 1 : 0)} na
            chamada
            {ptt ? ` · segure ${isTauri() ? "F9" : "Espaço"} para falar` : ""}
          </small>
        </div>
        <div className="call-heading-actions">
          <button className="text-button" onClick={onExpand}>
            <ChevronDown size={16} />
            {expanded ? "Recolher" : "Mostrar chamada"}
          </button>
          <IconButton label="Sair da chamada" onClick={onClose}>
            <PhoneOff size={18} />
          </IconButton>
        </div>
      </header>
      {expanded && (
        <>
          <p className="call-permission-note">
            Voz e tela vão diretamente entre os participantes. Os endereços de
            rede podem ficar visíveis entre vocês. Microfone e câmera começam
            desligados.
          </p>
          {state.state === "connecting" ? (
            <Loading label="Entrando na chamada…" />
          ) : (
            <div className={`video-grid ${focus ? "has-focus" : ""}`}>
              <div
                className={`video-tile local ${focus === "local" ? "focused" : ""}`}
              >
                {screenTrack || camera ? (
                  <VideoSurface track={(screenTrack || camera)!} local />
                ) : (
                  <div className="video-placeholder">
                    <Avatar
                      name={state.self?.display_name || "Você"}
                      size={72}
                    />
                    <small>
                      {microphone?.enabled
                        ? "Microfone ligado"
                        : "Seu microfone está desligado"}
                    </small>
                  </div>
                )}
                <div className="video-label">
                  <span>
                    {screenTrack ? (
                      <MonitorUp size={14} />
                    ) : microphone?.enabled ? (
                      <Mic size={14} />
                    ) : (
                      <MicOff size={14} />
                    )}{" "}
                    Você{screenTrack ? " · compartilhando tela" : ""}
                  </span>
                  <IconButton
                    label="Focar sua transmissão"
                    onClick={() => setFocus(focus === "local" ? null : "local")}
                  >
                    <Maximize2 size={15} />
                  </IconButton>
                </div>
                {screenTrack && (
                  <div className="video-options">
                    <small>
                      Solicitado: {state.profile.height || "Auto"}p /{" "}
                      {state.profile.fps || "Auto"} FPS /{" "}
                      {state.profile.bitrate || "Auto"} Mb/s por espectador
                    </small>
                    <small>
                      Captura: {screenSettings?.width ?? "?"}×
                      {screenSettings?.height ?? "?"} ·{" "}
                      {screenSettings?.frameRate == null
                        ? "FPS indisponível"
                        : `${Math.round(screenSettings.frameRate)} FPS`}
                    </small>
                    <small>
                      Upload de vídeo medido: {measuredUpload} · teto estimado:{" "}
                      {(
                        (requestedBitrate * state.participants.length) /
                        1e6
                      ).toFixed(1)}{" "}
                      Mb/s
                    </small>
                  </div>
                )}
              </div>
              {state.participants.flatMap((peer) =>
                (peer.media.screen
                  ? ["screen", ...(peer.media.camera ? ["camera"] : [])]
                  : ["camera"]
                ).map((source) => (
                  <RemoteTile
                    key={`${peer.peer_id}:${source}`}
                    peer={peer}
                    source={source as "screen" | "camera"}
                    focused={focus === `${peer.peer_id}:${source}`}
                    onFocus={() =>
                      setFocus(
                        focus === `${peer.peer_id}:${source}`
                          ? null
                          : `${peer.peer_id}:${source}`,
                      )
                    }
                    volume={peerVolume(peer.peer_id)}
                    onVolume={(kind, value) =>
                      setVolumes((previous) => ({
                        ...previous,
                        [peer.peer_id]: {
                          ...peerVolume(peer.peer_id),
                          [kind]: value,
                        },
                      }))
                    }
                    height={receiveHeights[peer.peer_id] || 0}
                    onHeight={(height) => {
                      setReceiveHeights((previous) => ({
                        ...previous,
                        [peer.peer_id]: height,
                      }));
                      void action(async () => {
                        engine.setReceiveHeight(peer.peer_id, height);
                      });
                    }}
                  />
                )),
              )}
              {state.state === "connected" && !state.participants.length && (
                <Empty
                  icon={<Headphones size={28} />}
                  title="A conversa fica melhor junto."
                >
                  <p>
                    Quem entrar neste canal aparecerá aqui.
                    <br />
                    Ligue seu microfone quando quiser conversar.
                  </p>
                </Empty>
              )}
            </div>
          )}
          {state.state === "connected" && !canPublish && (
            <p className="call-permission-note" role="status">
              Você pode ouvir e assistir. Microfone, câmera e tela não estão
              autorizados.
            </p>
          )}
          <ErrorBanner message={error || state.reason} />
          {audioBlocked && (
            <button
              className="button primary"
              onClick={() => void action(unlockAudio)}
            >
              Ativar reprodução de áudio
            </button>
          )}
          {(state.state === "failed" || state.state === "closed") &&
            canConnect && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void action(() => engine.reconnect())}
              >
                Reconectar à chamada
              </button>
            )}
          {state.state === "connected" && (
            <div className="call-controls">
              <IconButton
                label={
                  microphone?.enabled ? "Desligar microfone" : "Ligar microfone"
                }
                disabled={busy || ptt || deafened || !canPublish}
                onClick={() =>
                  void action(async () => {
                    if (microphone?.enabled) await stopDevice("microphone");
                    else if (microphone)
                      engine.setTrackEnabled("microphone", true);
                    else await captureDevice("microphone");
                  })
                }
              >
                {microphone?.enabled ? <Mic size={20} /> : <MicOff size={20} />}
              </IconButton>
              <IconButton
                label={deafened ? "Ativar áudio" : "Silenciar áudio"}
                onClick={() => {
                  deafenedRef.current = !deafenedRef.current;
                  setDeafened(deafenedRef.current);
                  if (deafenedRef.current) {
                    for (const track of pendingMicrophones.current)
                      track.enabled = false;
                    engine.setTrackEnabled("microphone", false);
                  }
                }}
              >
                {deafened ? (
                  <HeadphoneOff size={20} />
                ) : (
                  <Headphones size={20} />
                )}
              </IconButton>
              <IconButton
                label={camera ? "Desligar câmera" : "Ligar câmera"}
                disabled={busy || !canPublish}
                onClick={() =>
                  void action(() =>
                    camera ? stopDevice("camera") : captureDevice("camera"),
                  )
                }
              >
                {camera ? <Video size={20} /> : <VideoOff size={20} />}
              </IconButton>
              <button
                className={`button ${screenTrack ? "live-button" : "primary"}`}
                disabled={busy || !canPublish}
                onClick={() => {
                  setProfile({ ...engine.snapshot.profile });
                  setSharing(true);
                }}
              >
                <MonitorUp size={18} />
                {screenTrack ? "Ajustar transmissão" : "Compartilhar tela"}
              </button>
              {state.localTracks.screen_audio && (
                <button
                  className="button"
                  onClick={() =>
                    engine.setTrackEnabled(
                      "screen_audio",
                      !state.localTracks.screen_audio?.enabled,
                    )
                  }
                >
                  {state.localTracks.screen_audio.enabled
                    ? "Silenciar tela"
                    : "Ativar som da tela"}
                </button>
              )}
              {screenTrack && (
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() => void action(stopSharing)}
                >
                  Parar tela
                </button>
              )}
              <IconButton
                label="Dispositivos e voz"
                onClick={() => void action(configure)}
              >
                <Settings2 size={20} />
              </IconButton>
              <IconButton label="Sair da chamada" onClick={onClose}>
                <PhoneOff size={20} />
              </IconButton>
            </div>
          )}
        </>
      )}
      {state.participants
        .filter((p) => p.can_publish)
        .flatMap((peer) =>
          (["microphone", "screen_audio"] as const).flatMap((source) =>
            peer.tracks[source] && peer.media[source]
              ? [
                  <AudioSurface
                    key={`${peer.peer_id}:${source}`}
                    track={peer.tracks[source]!}
                    volume={
                      deafened
                        ? 0
                        : peerVolume(peer.peer_id)[
                            source === "microphone" ? "voice" : "screen"
                          ]
                    }
                    output={selectedDevices.audiooutput}
                    blocked={onAudioBlocked}
                  />,
                ]
              : [],
          ),
        )}
      {sharing && (
        <Modal
          title={screenTrack ? "Ajustar transmissão" : "Compartilhar sua tela"}
          onClose={() => {
            stopPreview();
            setSharing(false);
          }}
          wide
        >
          <p className="muted">
            Escolha a tela, janela ou aba. Você verá uma prévia antes de
            publicar.
          </p>
          <div className="stream-form">
            <Field label="Resolução">
              <select
                disabled={busy}
                value={profile.height}
                onChange={(e) =>
                  setProfile({ ...profile, height: Number(e.target.value) })
                }
              >
                <option value={0}>Automática</option>
                {resolutions.map((h) => (
                  <option key={h} value={h}>
                    {h}p
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quadros por segundo">
              <select
                disabled={busy}
                value={profile.fps}
                onChange={(e) =>
                  setProfile({ ...profile, fps: Number(e.target.value) })
                }
              >
                <option value={0}>Automático</option>
                {frameRates.map((fps) => (
                  <option key={fps} value={fps}>
                    {fps} FPS
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={`Bitrate por espectador (até ${state.maxVideoBitrate / 1e6} Mb/s)`}
            >
              <select
                disabled={busy}
                value={profile.bitrate ? "manual" : "auto"}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    bitrate:
                      e.target.value === "auto"
                        ? 0
                        : Math.min(8, state.maxVideoBitrate / 1e6),
                  })
                }
              >
                <option value="auto">Automático</option>
                <option value="manual">Manual</option>
              </select>
              {profile.bitrate > 0 && (
                <input
                  aria-label="Bitrate em megabits por segundo"
                  type="number"
                  disabled={busy}
                  min={0.5}
                  max={state.maxVideoBitrate / 1e6}
                  step={0.5}
                  value={profile.bitrate}
                  onChange={(e) =>
                    setProfile({ ...profile, bitrate: Number(e.target.value) })
                  }
                />
              )}
            </Field>
            <Field label="Conteúdo">
              <select
                disabled={busy}
                value={profile.content}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    content: e.target.value as StreamProfile["content"],
                  })
                }
              >
                <option value="text">Texto e nitidez</option>
                <option value="motion">Movimento e jogos</option>
              </select>
            </Field>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={profile.audio}
              disabled={busy || (!!screenTrack && !preview)}
              onChange={(e) =>
                setProfile({ ...profile, audio: e.target.checked })
              }
            />
            Incluir áudio da tela, quando disponível
          </label>
          <p className="small-note">
            O áudio depende da fonte e do suporte do navegador/Windows. Evite
            compartilhar o som da própria chamada. Cada espectador recebe uma
            conexão: o upload total aumenta com a quantidade de pessoas. O
            bitrate é um teto, com áudio e protocolo adicionais.
          </p>
          {preview?.getVideoTracks()[0] && (
            <div className="share-preview">
              <VideoSurface track={preview.getVideoTracks()[0]} local />
              <span>PRÉVIA · AINDA NÃO PUBLICADA</span>
              {profile.audio && !preview.getAudioTracks().length && (
                <p role="status">
                  A fonte escolhida não forneceu áudio. A transmissão terá
                  somente imagem.
                </p>
              )}
            </div>
          )}
          <ErrorBanner message={error} />
          <div className="modal-actions">
            <button
              className="button"
              onClick={() => {
                stopPreview();
                setSharing(false);
              }}
            >
              Cancelar
            </button>
            <button
              className="button"
              disabled={busy || !canPublish}
              onClick={() => void action(captureScreen)}
            >
              Escolher {screenTrack ? "nova fonte" : "tela ou janela"}
            </button>
            {screenTrack && !preview && (
              <button
                className="button primary"
                disabled={busy || !canPublish}
                onClick={() =>
                  void action(async () => {
                    await engine.setScreenProfile(profile);
                    setSharing(false);
                  })
                }
              >
                Aplicar à transmissão
              </button>
            )}
            {preview && (
              <button
                className="button primary"
                disabled={busy || !canPublish}
                onClick={() => void action(publishScreen)}
              >
                Iniciar transmissão
              </button>
            )}
          </div>
        </Modal>
      )}
      {settings && (
        <Modal title="Dispositivos e voz" onClose={() => setSettings(false)}>
          <label className="check-field">
            <input
              type="checkbox"
              checked={ptt}
              disabled={busy || !canPublish}
              onChange={(e) =>
                void action(() => setPushToTalk(e.target.checked))
              }
            />
            Push-to-talk: segure{" "}
            {isTauri() ? "F9 (global)" : "Espaço (janela em foco)"}
          </label>
          <p className="small-note">
            O microfone só transmite enquanto a tecla está pressionada. Ao sair
            da chamada, todos os dispositivos são liberados.
          </p>
          {(["audioinput", "audiooutput", "videoinput"] as const).map(
            (kind) => (
              <Field
                key={kind}
                label={
                  kind === "audioinput"
                    ? "Microfone"
                    : kind === "audiooutput"
                      ? "Saída de áudio"
                      : "Câmera"
                }
              >
                <select
                  value={selectedDevices[kind]}
                  disabled={
                    busy ||
                    (kind === "audiooutput" &&
                      !("setSinkId" in HTMLMediaElement.prototype))
                  }
                  onChange={(e) =>
                    void action(() => changeDevice(kind, e.target.value))
                  }
                >
                  <option value="">Padrão do sistema</option>
                  {devices
                    .filter((d) => d.kind === kind)
                    .map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `Dispositivo ${i + 1}`}
                      </option>
                    ))}
                </select>
              </Field>
            ),
          )}
          {!("setSinkId" in HTMLMediaElement.prototype) && (
            <p className="small-note">
              Este navegador usa a saída de áudio escolhida no sistema.
            </p>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await unlockAudio();
                const stream = await navigator.mediaDevices.getUserMedia({
                  audio: true,
                });
                stream.getTracks().forEach((t) => t.stop());
                setDevices(await navigator.mediaDevices.enumerateDevices());
              })
            }
          >
            Autorizar e atualizar dispositivos
          </button>
          {canModerate && state.participants.length > 0 && (
            <div className="moderation-list">
              <h3>Moderação da chamada</h3>
              {state.participants.map((peer) => (
                <div key={peer.peer_id}>
                  <span>{peer.display_name}</span>
                  {(["mute", "unmute", "remove"] as const).map((command) => (
                    <button
                      key={command}
                      className={`button ${command === "remove" ? "danger" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api(`/api/channels/${channel.id}/moderate`, {
                            method: "POST",
                            body: { user_id: peer.user_id, action: command },
                          }),
                        )
                      }
                    >
                      {command === "mute"
                        ? "Silenciar"
                        : command === "unmute"
                          ? "Liberar"
                          : "Remover"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <ErrorBanner message={error} />
        </Modal>
      )}
    </section>
  );
}
