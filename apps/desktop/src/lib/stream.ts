import type {
  ScreenShareCaptureOptions,
  TrackPublishOptions,
} from "livekit-client";
export const resolutions = [144, 240, 360, 480, 720, 1080, 1440, 2160] as const;
export const frameRates = [15, 24, 30, 60] as const;
export const bitrates = [0.5, 1, 2, 4, 6, 8, 12, 16, 24, 32] as const;
export interface StreamProfile {
  height: number;
  fps: number;
  bitrate: number;
  content: "text" | "motion";
  audio: boolean;
}
export const defaultProfile: StreamProfile = {
  height: 1080,
  fps: 30,
  bitrate: 0,
  content: "text",
  audio: true,
};
export function validateProfile(
  profile: StreamProfile,
  maxBitrate: number,
): StreamProfile {
  if (
    ![0, ...resolutions].includes(
      profile.height as (typeof resolutions)[number],
    )
  )
    throw new Error("Resolução não suportada.");
  if (![0, ...frameRates].includes(profile.fps as (typeof frameRates)[number]))
    throw new Error("FPS não suportado.");
  if (!Number.isFinite(maxBitrate) || maxBitrate < 500000)
    throw new Error("O servidor não permite novas transmissões.");
  if (
    !Number.isFinite(profile.bitrate) ||
    profile.bitrate < 0 ||
    (profile.bitrate !== 0 && profile.bitrate < 0.5) ||
    profile.bitrate * 1_000_000 > maxBitrate
  )
    throw new Error(
      `O bitrate deve estar entre 0,5 e ${maxBitrate / 1_000_000} Mb/s, ou Automático.`,
    );
  return profile;
}
export function captureOptions(
  profile: StreamProfile,
): ScreenShareCaptureOptions {
  return {
    audio: profile.audio,
    ...(profile.height
      ? {
          resolution: {
            width: Math.round((profile.height * 16) / 9),
            height: profile.height,
            frameRate: profile.fps || 30,
          },
        }
      : {}),
    contentHint: profile.content === "text" ? "detail" : "motion",
    selfBrowserSurface: "exclude",
    systemAudio: "include",
    surfaceSwitching: "include",
  };
}
export function publishOptions(
  profile: StreamProfile,
  maxBitrate: number,
): TrackPublishOptions {
  validateProfile(profile, maxBitrate);
  // Single VP8 encoding makes the chosen cap the aggregate video budget.
  // No hidden simulcast layers or secondary compatibility encoder.
  const target = profile.bitrate
    ? profile.bitrate * 1_000_000
    : Math.min(maxBitrate, 8_000_000);
  return {
    videoCodec: "vp8",
    simulcast: false,
    backupCodec: false,
    screenShareEncoding: {
      maxBitrate: target,
      maxFramerate: profile.fps || 30,
    },
    degradationPreference:
      profile.content === "text" ? "maintain-resolution" : "maintain-framerate",
  };
}
