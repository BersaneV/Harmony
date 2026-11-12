import { isTauri } from "@tauri-apps/api/core";
import { registerGlobalPtt } from "../lib/desktop";
import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  ConnectionState,
  VideoQuality,
} from "livekit-client";
import type { LocalTrack, TrackPublication } from "livekit-client";
import {
  ChevronDown,
  Expand,
  Headphones,
  HeadphoneOff,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Radio,
  Settings2,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { can, Permission } from "../lib/permissions";
import { api, errorMessage } from "../lib/api";
import type { Channel, MediaToken } from "../lib/types";
import {
  bitrates,
  captureOptions,
  defaultProfile,
  frameRates,
  publishOptions,
  resolutions,
  validateProfile,
} from "../lib/stream";
import type { StreamProfile } from "../lib/stream";
import {
  Avatar,
  Empty,
  ErrorBanner,
  Field,
  IconButton,
  Loading,
  Modal,
} from "./ui";
interface Measured {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}
function VideoSurface({
  track,
  local = false,
}: {
  track: Track;
  local?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) {
      track.attach(element);
      return () => {
        track.detach(element);
      };
    }
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
function AudioSurface({ track, muted }: { track: Track; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) {
      track.attach(element);
      return () => {
        track.detach(element);
      };
    }
  }, [track]);
  return <audio ref={ref} autoPlay muted={muted} />;
}
function useStats(track: Track | undefined) {
  const [stats, setStats] = useState<Measured | null>(null);
  useEffect(() => {
    let active = true;
    let previous: { bytes: number; time: number } | null = null;
    setStats(null);
    async function sample() {
      try {
        const report = await track?.getRTCStatsReport();
        if (!report) return;
        let bytes = 0,
          width = 0,
          height = 0,
          fps = 0,
          time = 0;
        report.forEach((item) => {
          if (
            (item.type === "outbound-rtp" || item.type === "inbound-rtp") &&
            (item.kind === "video" || item.mediaType === "video") &&
            !item.isRemote
          ) {
            bytes += item.bytesSent ?? item.bytesReceived ?? 0;
            time = Math.max(time, item.timestamp || 0);
            width = Math.max(width, item.frameWidth || 0);
            height = Math.max(height, item.frameHeight || 0);
            fps = Math.max(fps, item.framesPerSecond || 0);
          }
        });
        const bitrate =
          previous && time > previous.time
            ? Math.max(
                0,
                ((bytes - previous.bytes) * 8000) / (time - previous.time),
              )
            : 0;
        previous = { bytes, time };
        if (active) setStats({ width, height, fps, bitrate });
      } catch {
        /* Unsupported WebRTC stats remain unavailable. */
      }
    }
    const timer = setInterval(() => void sample(), 1500);
    void sample();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [track]);
  return stats;
}
function RemoteTile({
  participant,
  publication,
  focused,
  onFocus,
  deafened,
  voiceVolume,
  screenVolume,
  onVolume,
}: {
  participant: RemoteParticipant;
  publication?: TrackPublication;
  focused: boolean;
  onFocus: () => void;
  deafened: boolean;
  voiceVolume: number;
  screenVolume: number;
  onVolume: (source: "voice" | "screen", value: number) => void;
}) {
  const [ceiling, setCeiling] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const stats = useStats(publication?.track);
  const tooLarge =
    ceiling > 0 &&
    (publication?.dimensions?.height || 0) > ceiling &&
    !publication?.simulcasted;
  useEffect(() => {
    participant.setVolume(deafened ? 0 : voiceVolume, Track.Source.Microphone);
    participant.setVolume(
      deafened ? 0 : screenVolume,
      Track.Source.ScreenShareAudio,
    );
  }, [participant, voiceVolume, screenVolume, deafened]);
  useEffect(() => {
    if (publication instanceof RemoteTrackPublication) {
      publication.setSubscribed(!tooLarge);
      if (!tooLarge) {
        if (ceiling)
          publication.setVideoDimensions({
            width: Math.round((ceiling * 16) / 9),
            height: ceiling,
          });
        else publication.setVideoQuality(VideoQuality.HIGH);
      }
    }
  }, [publication, ceiling, tooLarge]);
  return (
    <div
      ref={ref}
      className={`video-tile ${focused ? "focused" : ""} ${participant.isSpeaking ? "speaking" : ""}`}
    >
      {publication?.track && !publication.isMuted && !tooLarge ? (
        <VideoSurface track={publication.track} />
      ) : (
        <div className="video-placeholder">
          <Avatar name={participant.name || participant.identity} size={72} />
          {tooLarge && (
            <small>
              Não há camada dentro de {ceiling}p. Aumente o teto ou peça ao
              emissor uma qualidade menor.
            </small>
          )}
        </div>
      )}
      <div className="video-label">
        <span>
          {publication?.source === Track.Source.ScreenShare ? (
            <MonitorUp size={14} />
          ) : participant.isMicrophoneEnabled ? (
            <Mic size={14} />
          ) : (
            <MicOff size={14} />
          )}{" "}
          {participant.name || participant.identity}
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
            onClick={() => void ref.current?.requestFullscreen()}
          >
            <Expand size={15} />
          </IconButton>
        </div>
      </div>
      <div className="video-options">
        <label title="Volume do microfone deste participante">
          <Volume2 size={14} />
          <input
            aria-label={`Volume de voz de ${participant.name}`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={voiceVolume}
            onChange={(e) => onVolume("voice", Number(e.target.value))}
          />
        </label>
        {participant.getTrackPublication(Track.Source.ScreenShareAudio) && (
          <label title="Volume do áudio da tela">
            <MonitorUp size={14} />
            <input
              aria-label={`Volume da tela de ${participant.name}`}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={screenVolume}
              onChange={(e) => onVolume("screen", Number(e.target.value))}
            />
          </label>
        )}
        {publication && (
          <select
            aria-label="Teto de resolução de recepção"
            value={ceiling}
            onChange={(e) => setCeiling(Number(e.target.value))}
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
            ? `${stats.width}×${stats.height} · ${Math.round(stats.fps)} FPS · ${(stats.bitrate / 1e6).toFixed(2)} Mb/s`
            : "Aguardando mídia"}
        </small>
      </div>
    </div>
  );
}
export default function CallPanel({
  channel,
  expanded,
  onClose,
  onExpand,
  canModerate,
}: {
  channel: Channel;
  expanded: boolean;
  onClose: () => void;
  onExpand: () => void;
  canModerate: boolean;
}) {
  const canConnect = can(channel, Permission.Connect);
  const channelAllowsPublishing =
    canConnect && can(channel, Permission.Publish);
  const channelPublishAllowed = useRef(channelAllowsPublishing);
  channelPublishAllowed.current = channelAllowsPublishing;
  const [mediaAllowsPublishing, setMediaAllowsPublishing] = useState(false);
  const canPublish = channelAllowsPublishing && mediaAllowsPublishing;
  const publishAllowed = useRef(canPublish);
  publishAllowed.current = canPublish;
  const [room, setRoom] = useState<Room | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [settings, setSettings] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState<LocalTrack[]>([]);
  const previewRef = useRef<LocalTrack[]>([]);
  const [profile, setProfile] = useState<StreamProfile>(defaultProfile);
  const [applied, setApplied] = useState<StreamProfile | null>(null);
  const [maxBitrate, setMaxBitrate] = useState(8000000);
  const [focus, setFocus] = useState<string | null>(null);
  const captureGeneration = useRef(0);
  const [participantVolumes, setParticipantVolumes] = useState<
    Record<string, { voice: number; screen: number }>
  >({});
  const [status, setStatus] = useState("Conectando");
  useEffect(() => {
    if (!can(channel, Permission.Connect)) {
      setError("Você não tem permissão para entrar nesta chamada.");
      setConnecting(false);
      return;
    }
    const next = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      publishDefaults: {
        videoCodec: "vp8",
        simulcast: false,
        backupCodec: false,
      },
    });
    let stopped = false;
    const update = () => setTick((v) => v + 1);
    const syncPublishingPermission = () => {
      if (stopped) return;
      const allowed = next.localParticipant.permissions?.canPublish === true;
      // In-flight capture must see revocation before React renders again.
      publishAllowed.current = allowed && channelPublishAllowed.current;
      setMediaAllowsPublishing(allowed);
    };
    const listen = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.ActiveSpeakersChanged,
    ] as const;
    for (const event of listen) next.on(event, update);
    next.on(
      RoomEvent.ParticipantPermissionsChanged,
      (_previous, participant) => {
        if (participant === next.localParticipant) syncPublishingPermission();
      },
    );
    next.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (!publishAllowed.current && publication.track)
        void next.localParticipant
          .unpublishTrack(publication.track, true)
          .catch(() => {});
    });
    next.on(RoomEvent.ConnectionStateChanged, (value) => {
      if (value === ConnectionState.Connected) syncPublishingPermission();
      setStatus(
        value === ConnectionState.Connected
          ? "Conectado"
          : value === ConnectionState.Reconnecting
            ? "Reconectando"
            : "Desconectado",
      );
    });
    next.on(RoomEvent.Disconnected, () => {
      if (!stopped) {
        publishAllowed.current = false;
        setMediaAllowsPublishing(false);
        setError(
          "Você foi desconectado da chamada. Entre novamente no canal para continuar.",
        );
        update();
      }
    });
    setConnecting(true);
    setMediaAllowsPublishing(false);
    setError("");
    void (async () => {
      try {
        const media = await api<MediaToken>(
          `/api/channels/${channel.id}/media-token`,
          { method: "POST" },
        );
        if (stopped) return;
        setMaxBitrate(media.max_video_bitrate);
        await next.connect(media.url, media.token);
        if (stopped) {
          await next.disconnect();
          return;
        }
        syncPublishingPermission();
        setRoom(next);
        setStatus("Conectado");
        await next.startAudio();
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      } finally {
        if (!stopped) setConnecting(false);
      }
    })();
    return () => {
      stopped = true;
      captureGeneration.current++;
      previewRef.current.forEach((track) => track.stop());
      void next.disconnect(true);
      next.removeAllListeners();
      setRoom(null);
    };
  }, [channel.id]);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  useEffect(() => {
    if (!room || !ptt || deafened || !canPublish) return;
    let held = false;
    let stopped = false;
    let cleanupGlobal: (() => Promise<void>) | undefined;
    const mute = () => {
      held = false;
      void room.localParticipant.setMicrophoneEnabled(false);
    };
    const press = () => {
      if (held || !publishAllowed.current) return;
      held = true;
      void room.localParticipant
        .setMicrophoneEnabled(true)
        .then(() => {
          if (!held || stopped || !publishAllowed.current)
            void room.localParticipant.setMicrophoneEnabled(false);
        })
        .catch((e) => setError(errorMessage(e)));
    };
    mute();
    if (isTauri()) {
      void registerGlobalPtt((pressed) => (pressed ? press() : mute()))
        .then((cleanup) => {
          if (stopped) void cleanup();
          else cleanupGlobal = cleanup;
        })
        .catch((e) => {
          setError(errorMessage(e));
          setPtt(false);
        });
      return () => {
        stopped = true;
        mute();
        void cleanupGlobal?.();
      };
    }
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.code === "Space" &&
        !event.repeat &&
        !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) &&
        !target.isContentEditable
      ) {
        event.preventDefault();
        press();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") mute();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", mute);
    return () => {
      stopped = true;
      mute();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", mute);
    };
  }, [room, ptt, deafened, canPublish]);
  useEffect(() => {
    if (!room || canPublish) return;
    setPtt(false);
    setSharing(false);
    captureGeneration.current++;
    previewRef.current.forEach((track) => track.stop());
    setPreview([]);
    const tracks = [
      ...room.localParticipant.trackPublications.values(),
    ].flatMap((publication) => (publication.track ? [publication.track] : []));
    if (tracks.length) {
      void Promise.allSettled(
        tracks.map((track) =>
          room.localParticipant.unpublishTrack(track, true),
        ),
      ).then(() => {
        setApplied(null);
        setTick((value) => value + 1);
      });
      setError(
        "Sua permissão para transmitir foi removida. Você pode continuar ouvindo e assistindo.",
      );
    }
  }, [room, canPublish]);
  useEffect(() => {
    if (room && !canConnect) {
      void room.disconnect(true);
      setError(
        "Sua permissão de conexão foi removida. A chamada foi encerrada.",
      );
    }
  }, [room, canConnect]);
  const local = room?.localParticipant;
  const screenPublication = local?.getTrackPublication(
    Track.Source.ScreenShare,
  );
  const screenTrack = screenPublication?.track;
  const sharedAudio = local?.getTrackPublication(
    Track.Source.ScreenShareAudio,
  )?.track;
  const stats = useStats(screenTrack);
  const participants = room ? [...room.remoteParticipants.values()] : [];
  const videoPublications = participants.flatMap<{
    participant: RemoteParticipant;
    publication: TrackPublication | undefined;
    key: string;
  }>((p) => {
    const videos = [...p.videoTrackPublications.values()];
    return videos.length
      ? videos.map((publication) => ({
          participant: p,
          publication,
          key: publication.trackSid,
        }))
      : [{ participant: p, publication: undefined, key: p.identity }];
  });
  void tick;
  async function action(work: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await work();
      setTick((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function stopSharing() {
    if (!local) return;
    for (const publication of [...local.trackPublications.values()])
      if (
        (publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio) &&
        publication.track
      )
        await local.unpublishTrack(publication.track, true);
    setApplied(null);
    setTick((v) => v + 1);
  }
  async function capture() {
    if (!local || !publishAllowed.current) return;
    const attempt = ++captureGeneration.current;
    setError("");
    try {
      validateProfile(profile, maxBitrate);
      preview.forEach((track) => track.stop());
      setPreview([]);
      const tracks = await local.createScreenTracks(captureOptions(profile));
      if (attempt !== captureGeneration.current || !publishAllowed.current) {
        tracks.forEach((track) => track.stop());
        return;
      }
      setPreview(tracks);
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "A seleção foi cancelada ou a captura não foi autorizada."
          : errorMessage(e),
      );
    }
  }
  async function publish() {
    if (!local || !preview.length || !publishAllowed.current) return;
    await stopSharing();
    const options = publishOptions(profile, maxBitrate);
    const published: LocalTrack[] = [];
    try {
      for (const track of preview) {
        if (!publishAllowed.current)
          throw new Error("Sua permissão para transmitir foi removida.");
        if (track.mediaStreamTrack.readyState !== "live")
          throw new Error("A captura terminou. Escolha a tela novamente.");
        await local.publishTrack(track, {
          ...options,
          source:
            track.kind === Track.Kind.Video
              ? Track.Source.ScreenShare
              : Track.Source.ScreenShareAudio,
        });
        published.push(track);
        if (!publishAllowed.current)
          throw new Error("Sua permissão para transmitir foi removida.");
        if (track.kind === Track.Kind.Video)
          track.mediaStreamTrack.addEventListener(
            "ended",
            () => void stopSharing(),
            { once: true },
          );
      }
    } catch (error) {
      await Promise.allSettled(
        published.map((track) => local.unpublishTrack(track, true)),
      );
      preview.forEach((track) => track.stop());
      setPreview([]);
      throw error;
    }
    setApplied({ ...profile });
    setPreview([]);
    setSharing(false);
    setTick((v) => v + 1);
  }
  async function changeProfile() {
    if (
      !local ||
      !(screenTrack instanceof LocalVideoTrack) ||
      !publishAllowed.current
    )
      return;
    validateProfile(profile, maxBitrate);
    const original = screenTrack.mediaStreamTrack.getSettings();
    const ratio = (original.width || 16) / (original.height || 9);
    await screenTrack.mediaStreamTrack.applyConstraints({
      height: profile.height ? { max: profile.height } : undefined,
      width: profile.height
        ? { max: Math.round(profile.height * ratio) }
        : undefined,
      frameRate: { max: profile.fps || 30 },
    });
    await local.unpublishTrack(screenTrack, false);
    try {
      await local.publishTrack(screenTrack, {
        ...publishOptions(profile, maxBitrate),
        source: Track.Source.ScreenShare,
      });
      if (!publishAllowed.current)
        throw new Error("Sua permissão para transmitir foi removida.");
    } catch (error) {
      screenTrack.stop();
      await stopSharing();
      throw error;
    }
    setApplied({ ...profile });
    setSharing(false);
    setTick((v) => v + 1);
  }
  function closeShare() {
    captureGeneration.current++;
    preview.forEach((track) => track.stop());
    setPreview([]);
    setSharing(false);
  }
  async function configure() {
    setSettings(true);
    try {
      setDevices(await Room.getLocalDevices(undefined, false));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <section className={`call-panel ${expanded ? "expanded" : "collapsed"}`}>
      <header className="call-header">
        <span className="connection-dot" />
        <div>
          <strong>{channel.name}</strong>
          <small>
            {status} · {participants.length + 1} na chamada
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
          {connecting ? (
            <Loading label="Conectando à chamada…" />
          ) : (
            <div className={`video-grid ${focus ? "has-focus" : ""}`}>
              <div
                className={`video-tile local ${focus === "local" ? "focused" : ""}`}
              >
                {screenTrack ? (
                  <VideoSurface track={screenTrack} local />
                ) : local?.getTrackPublication(Track.Source.Camera)?.track ? (
                  <VideoSurface
                    track={
                      local.getTrackPublication(Track.Source.Camera)!.track!
                    }
                    local
                  />
                ) : (
                  <div className="video-placeholder">
                    <Avatar name={local?.name || "Você"} size={72} />
                    <small>
                      {local?.isMicrophoneEnabled
                        ? "Microfone ligado"
                        : "Seu microfone está desligado"}
                    </small>
                  </div>
                )}
                <div className="video-label">
                  <span>
                    {screenTrack ? (
                      <MonitorUp size={14} />
                    ) : (
                      <MicOff size={14} />
                    )}
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
                      Solicitado: {applied?.height || "Auto"}p /{" "}
                      {applied?.fps || "Auto"} FPS /{" "}
                      {applied?.bitrate || "Auto"} Mb/s
                    </small>
                    <small>
                      Efetivo:{" "}
                      {stats?.height
                        ? `${stats.width}×${stats.height} · ${Math.round(stats.fps)} FPS · ${(stats.bitrate / 1e6).toFixed(2)} Mb/s`
                        : "aguardando medição"}
                    </small>
                  </div>
                )}
              </div>
              {videoPublications.map((item) => (
                <RemoteTile
                  key={item.key}
                  participant={item.participant}
                  publication={item.publication}
                  deafened={deafened}
                  voiceVolume={
                    participantVolumes[item.participant.identity]?.voice ?? 1
                  }
                  screenVolume={
                    participantVolumes[item.participant.identity]?.screen ?? 1
                  }
                  onVolume={(source, value) =>
                    setParticipantVolumes((current) => ({
                      ...current,
                      [item.participant.identity]: {
                        voice: current[item.participant.identity]?.voice ?? 1,
                        screen: current[item.participant.identity]?.screen ?? 1,
                        [source]: value,
                      },
                    }))
                  }
                  focused={focus === item.key}
                  onFocus={() => setFocus(focus === item.key ? null : item.key)}
                />
              ))}
              {participants.length === 0 && (
                <Empty
                  icon={<Headphones size={28} />}
                  title="A conversa fica melhor junto."
                >
                  <p>
                    Convide alguém para este canal.
                    <br />
                    Seu microfone começa desligado.
                  </p>
                </Empty>
              )}
            </div>
          )}
          {!canPublish && room && (
            <p className="call-permission-note" role="status">
              Você pode ouvir e assistir. A transmissão de microfone, câmera e
              tela não está autorizada.
            </p>
          )}
          <ErrorBanner message={error} />
          {room && (
            <div className="call-controls">
              <button
                className={`call-button ${local?.isMicrophoneEnabled ? "" : "muted-control"}`}
                title={
                  ptt
                    ? "Push-to-talk ativo"
                    : local?.isMicrophoneEnabled
                      ? "Desligar microfone"
                      : "Ligar microfone"
                }
                disabled={busy || ptt || !canPublish}
                onClick={() =>
                  void action(() =>
                    local!.setMicrophoneEnabled(!local!.isMicrophoneEnabled),
                  )
                }
              >
                {local?.isMicrophoneEnabled ? (
                  <Mic size={20} />
                ) : (
                  <MicOff size={20} />
                )}
              </button>
              <button
                className={`call-button ${deafened ? "muted-control" : ""}`}
                title={deafened ? "Ativar áudio" : "Silenciar áudio"}
                onClick={() => {
                  setDeafened((v) => !v);
                  if (!deafened)
                    void action(() => local!.setMicrophoneEnabled(false));
                }}
              >
                {deafened ? (
                  <HeadphoneOff size={20} />
                ) : (
                  <Headphones size={20} />
                )}
              </button>
              <button
                className="call-button"
                title={
                  local?.isCameraEnabled ? "Desligar câmera" : "Ligar câmera"
                }
                disabled={busy || !canPublish}
                onClick={() =>
                  void action(() =>
                    local!.setCameraEnabled(
                      !local!.isCameraEnabled,
                      undefined,
                      {
                        simulcast: false,
                        videoCodec: "vp8",
                        backupCodec: false,
                        videoEncoding: {
                          maxBitrate: Math.min(maxBitrate, 2000000),
                          maxFramerate: 30,
                        },
                      },
                    ),
                  )
                }
              >
                {local?.isCameraEnabled ? (
                  <Video size={20} />
                ) : (
                  <VideoOff size={20} />
                )}
              </button>
              <button
                className={`button ${screenTrack ? "live-button" : "primary"}`}
                disabled={busy || !canPublish}
                onClick={() => setSharing(true)}
              >
                <MonitorUp size={18} />
                {screenTrack ? "Ajustar transmissão" : "Compartilhar tela"}
              </button>
              {sharedAudio && (
                <button
                  className="button"
                  disabled={busy || (!canPublish && sharedAudio.isMuted)}
                  onClick={() =>
                    void action(() =>
                      sharedAudio.isMuted
                        ? sharedAudio.unmute()
                        : sharedAudio.mute(),
                    )
                  }
                >
                  {sharedAudio.isMuted
                    ? "Ativar som da tela"
                    : "Silenciar tela"}
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
                onClick={() => void configure()}
              >
                <Settings2 size={20} />
              </IconButton>
              <button
                className="call-button hangup"
                title="Sair da chamada"
                onClick={onClose}
              >
                <PhoneOff size={20} />
              </button>
            </div>
          )}
        </>
      )}
      {participants.flatMap((p) =>
        [...p.audioTrackPublications.values()]
          .filter((pub) => pub.track)
          .map((pub) => (
            <AudioSurface
              key={pub.trackSid}
              track={pub.track!}
              muted={deafened}
            />
          )),
      )}
      {sharing && (
        <Modal
          title={screenTrack ? "Ajustar transmissão" : "Compartilhar sua tela"}
          onClose={closeShare}
          wide
        >
          <p className="muted">
            Escolha a tela ou janela. Você verá uma prévia antes de publicar.
          </p>
          <div className="stream-form">
            <Field label="Resolução">
              <select
                value={profile.height}
                onChange={(e) =>
                  setProfile((v) => ({ ...v, height: Number(e.target.value) }))
                }
              >
                <option value={0}>Automática</option>
                {resolutions.map((value) => (
                  <option key={value} value={value}>
                    {value}p{value >= 1440 ? " · depende da captura" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quadros por segundo">
              <select
                value={profile.fps}
                onChange={(e) =>
                  setProfile((v) => ({ ...v, fps: Number(e.target.value) }))
                }
              >
                <option value={0}>Automático</option>
                {frameRates.map((value) => (
                  <option key={value} value={value}>
                    {value} FPS
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Bitrate de vídeo (até ${maxBitrate / 1e6} Mb/s)`}>
              <select
                value={profile.bitrate === 0 ? "auto" : "manual"}
                onChange={(e) =>
                  setProfile((v) => ({
                    ...v,
                    bitrate:
                      e.target.value === "auto"
                        ? 0
                        : Math.min(8, maxBitrate / 1e6),
                  }))
                }
              >
                <option value="auto">Automático</option>
                <option value="manual">Manual</option>
              </select>
              {profile.bitrate > 0 && (
                <>
                  <input
                    aria-label="Bitrate em megabits por segundo"
                    type="number"
                    min={0.5}
                    max={maxBitrate / 1e6}
                    step={0.5}
                    list="bitrates"
                    value={profile.bitrate}
                    onChange={(e) =>
                      setProfile((v) => ({
                        ...v,
                        bitrate: Number(e.target.value),
                      }))
                    }
                  />
                  <datalist id="bitrates">
                    {bitrates
                      .filter((b) => b * 1e6 <= maxBitrate)
                      .map((value) => (
                        <option key={value} value={value} />
                      ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Conteúdo">
              <select
                value={profile.content}
                onChange={(e) =>
                  setProfile((v) => ({
                    ...v,
                    content: e.target.value as "text" | "motion",
                  }))
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
              disabled={!!screenTrack && !preview.length}
              onChange={(e) =>
                setProfile((v) => ({ ...v, audio: e.target.checked }))
              }
            />
            Incluir áudio da tela, quando disponível
          </label>
          {!!screenTrack && !preview.length && (
            <small>
              Para mudar a captura de áudio, escolha uma nova fonte. Use
              “Silenciar tela” para pausar o áudio atual.
            </small>
          )}
          <p className="small-note">
            O áudio depende da opção oferecida pelo Windows. Evite compartilhar
            o som da própria chamada. O bitrate é um teto; a rede pode reduzir a
            qualidade. Áudio e tráfego de protocolo são adicionais.
          </p>
          {preview.find((t) => t.kind === Track.Kind.Video) && (
            <div className="share-preview">
              <VideoSurface
                track={preview.find((t) => t.kind === Track.Kind.Video)!}
                local
              />
              <span>PRÉVIA · AINDA NÃO PUBLICADA</span>
            </div>
          )}
          <ErrorBanner message={error} />
          <div className="modal-actions">
            <button className="button" onClick={closeShare}>
              Cancelar
            </button>
            <button
              className="button"
              onClick={() => void capture()}
              disabled={busy || !canPublish}
            >
              Escolher {screenTrack ? "nova fonte" : "tela ou janela"}
            </button>
            {screenTrack && !preview.length && (
              <button
                className="button primary"
                disabled={busy || !canPublish}
                onClick={() => void action(changeProfile)}
              >
                Aplicar à transmissão
              </button>
            )}
            {preview.length > 0 && (
              <button
                className="button primary"
                disabled={busy || !canPublish}
                onClick={() => void action(publish)}
              >
                <Radio size={17} />
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
              disabled={!canPublish}
              onChange={(e) => setPtt(e.target.checked)}
            />
            Push-to-talk: segure{" "}
            {isTauri() ? "F9 (global)" : "Espaço (janela em foco)"}
          </label>
          <p className="small-note">
            {isTauri()
              ? "F9 funciona fora da janela. O atalho é liberado ao desativar ou sair da chamada."
              : "No navegador, ao mudar de janela o microfone fecha. O aplicativo oferece F9 global."}
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
                  defaultValue=""
                  onChange={(e) =>
                    void action(() =>
                      room!.switchActiveDevice(kind, e.target.value),
                    )
                  }
                >
                  <option value="" disabled>
                    Escolha um dispositivo
                  </option>
                  {devices
                    .filter((d) => d.kind === kind)
                    .map((d, index) => (
                      <option key={d.deviceId || index} value={d.deviceId}>
                        {d.label || `Dispositivo ${index + 1}`}
                      </option>
                    ))}
                </select>
              </Field>
            ),
          )}
          <button
            className="button"
            onClick={() =>
              void action(async () => {
                await room?.startAudio();
                setDevices(await Room.getLocalDevices(undefined, true));
              })
            }
          >
            Autorizar e atualizar dispositivos
          </button>
          {canModerate && participants.length > 0 && (
            <div className="moderation-list">
              <h3>Moderação da chamada</h3>
              {participants.map((p) => (
                <div key={p.identity}>
                  <span>{p.name || p.identity}</span>
                  <button
                    className="button"
                    onClick={() =>
                      void action(() =>
                        api(`/api/channels/${channel.id}/moderate`, {
                          method: "POST",
                          body: {
                            user_id: p.identity.split(":")[0],
                            action: "mute",
                          },
                        }),
                      )
                    }
                  >
                    Silenciar
                  </button>
                  <button
                    className="button"
                    onClick={() =>
                      void action(() =>
                        api(`/api/channels/${channel.id}/moderate`, {
                          method: "POST",
                          body: {
                            user_id: p.identity.split(":")[0],
                            action: "unmute",
                          },
                        }),
                      )
                    }
                  >
                    Liberar
                  </button>
                  <button
                    className="button danger"
                    onClick={() =>
                      void action(() =>
                        api(`/api/channels/${channel.id}/moderate`, {
                          method: "POST",
                          body: {
                            user_id: p.identity.split(":")[0],
                            action: "remove",
                          },
                        }),
                      )
                    }
                  >
                    Remover
                  </button>
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
