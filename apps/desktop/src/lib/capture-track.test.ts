import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCaptureConstraints,
  getCaptureSettings,
  getCaptureBound,
  registerCaptureTrack,
  releaseCaptureTrack,
  resolveCaptureSettings,
} from "./capture-track";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function browserCapture() {
  class Track extends EventTarget {
    kind = "video";
    readyState = "live";
    enabled = true;
    getSettings = vi.fn(() => ({ width: 960, height: 720 }));
    clone = vi.fn(() => {
      throw new Error("A clone must not keep the source alive");
    });
    stop = vi.fn(() => {
      this.readyState = "ended";
    });
  }
  class Video extends EventTarget {
    muted = false;
    playsInline = false;
    autoplay = false;
    readyState = 0;
    videoWidth = 0;
    videoHeight = 0;
    srcObject: MediaStream | null = null;
    pause = vi.fn();
    play = vi.fn(async () => {});
    frame(width: number, height: number) {
      this.readyState = 2;
      this.videoWidth = width;
      this.videoHeight = height;
      this.dispatchEvent(new Event("loadeddata"));
    }
  }
  const track = new Track(),
    video = new Video();
  const create = vi.fn(() => video);
  vi.stubGlobal("document", { createElement: create });
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
  return { track, video, create, media: track as unknown as MediaStreamTrack };
}

describe("geometria de um quadro atual", () => {
  it("ignora settings e loadedmetadata transitórios, observa o mesmo track e limpa o vídeo sem parar a fonte", async () => {
    const f = browserCapture();
    const waiting = resolveCaptureSettings(f.media);
    expect(f.video.muted && f.video.playsInline).toBe(true);
    expect(f.video.srcObject!.getTracks()).toEqual([f.track]);
    f.video.videoWidth = 960;
    f.video.videoHeight = 720;
    f.video.readyState = 1;
    f.video.dispatchEvent(new Event("loadedmetadata"));
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    f.video.frame(1280, 720);
    await expect(waiting).resolves.toEqual({ width: 1280, height: 720 });
    expect(f.track.getSettings).not.toHaveBeenCalled();
    expect(f.track.clone).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.video.pause).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
  });
  it.each(["abort", "ended", "release", "error", "timeout"])(
    "limpa a observação em %s e ignora dados tardios",
    async (cause) => {
      vi.useFakeTimers();
      const f = browserCapture(),
        controller = new AbortController();
      const waiting = resolveCaptureSettings(f.media, {
        signal: controller.signal,
      });
      const rejected = expect(waiting).rejects.toThrow();
      if (cause === "abort") controller.abort();
      else if (cause === "ended") {
        f.track.readyState = "ended";
        f.track.dispatchEvent(new Event("ended"));
      } else if (cause === "release") releaseCaptureTrack(f.media);
      else if (cause === "error") f.video.dispatchEvent(new Event("error"));
      else await vi.advanceTimersByTimeAsync(3000);
      await rejected;
      expect(f.video.srcObject).toBeNull();
      expect(f.video.pause).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      f.video.frame(3840, 2160);
      controller.abort();
      expect(f.video.pause).toHaveBeenCalledOnce();
      expect(f.track.stop).toHaveBeenCalledTimes(cause === "release" ? 1 : 0);
    },
  );
  it("rejeita dimensões inválidas, falha de play e prazos fora do limite", async () => {
    const f = browserCapture();
    const waiting = resolveCaptureSettings(f.media);
    f.video.frame(0, 720);
    await expect(waiting).rejects.toThrow("dimensões");
    f.video.readyState = 0;
    f.video.play.mockRejectedValueOnce(new Error("blocked"));
    await expect(resolveCaptureSettings(f.media)).rejects.toThrow("observar");
    await expect(
      resolveCaptureSettings(f.media, { timeoutMs: 5001 }),
    ).rejects.toThrow("Prazo");
  });
  it("aceita metadados da porta registrada sem criar consumidor do navegador", async () => {
    const f = browserCapture();
    registerCaptureTrack(f.media, {
      settings: () => ({ width: 2560, height: 1440 }),
      applyConstraints: async () => {},
      release: () => {},
    });
    await expect(resolveCaptureSettings(f.media)).resolves.toEqual({
      width: 2560,
      height: 1440,
    });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.track.getSettings).not.toHaveBeenCalled();
  });
  it("não inicia consumidores para um sinal já cancelado ou fonte encerrada", async () => {
    const f = browserCapture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      resolveCaptureSettings(f.media, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    f.track.readyState = "ended";
    await expect(resolveCaptureSettings(f.media)).rejects.toThrow("terminou");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("só atesta largura futura do navegador com max explícito confirmado", () => {
    const f = browserCapture();
    const track = f.media as MediaStreamTrack & {
      getConstraints(): MediaTrackConstraints;
    };
    track.getConstraints = () => ({
      height: { max: 720 },
      width: { max: 1280 },
    });
    expect(getCaptureBound(track)).toEqual({
      max_height: 720,
      max_width: 1280,
    });
    registerCaptureTrack(track, {
      settings: () => ({ width: 960, height: 720 }),
      maxHeight: () => 720,
      applyConstraints: async () => {},
      release: () => {},
    });
    expect(getCaptureBound(track)).toEqual({ max_height: 720 });
  });
});

describe("porta de tracks de captura", () => {
  it("só comprova um teto do navegador com max explícito aplicado e geometria dentro dele", () => {
    let constraints: MediaTrackConstraints = { height: { ideal: 1080 } };
    const track = {
      readyState: "live",
      getSettings: () => ({ height: 1080 }),
      getConstraints: () => constraints,
    } as unknown as MediaStreamTrack;
    expect(getCaptureBound(track)).toBeUndefined();
    constraints = { height: { exact: 1080 } };
    expect(getCaptureBound(track)).toBeUndefined();
    constraints = { height: { max: 720 } };
    expect(getCaptureBound(track)).toBeUndefined();
    constraints = { height: { max: 1080 } };
    expect(getCaptureBound(track)).toEqual({ max_height: 1080 });
    (track as unknown as { readyState: string }).readyState = "ended";
    expect(getCaptureBound(track)).toBeUndefined();
  });

  it("não infere bounds nativos pelas dimensões instantâneas e não devolve o objeto mutável do controle", () => {
    const track = {
      readyState: "live",
      getConstraints: () => ({ height: { max: 720 } }),
      getSettings: () => ({ height: 720 }),
    } as unknown as MediaStreamTrack;
    const control = {
      settings: () => ({ height: 720 }),
      applyConstraints: async () => {},
      release: () => {},
    };
    registerCaptureTrack(track, control);
    expect(getCaptureBound(track)).toBeUndefined();
    registerCaptureTrack(track, { ...control, maxHeight: () => 720 });
    const bound = getCaptureBound(track)!;
    expect(bound).toEqual({ max_height: 720 });
    bound.max_height = 2160;
    expect(getCaptureBound(track)).toEqual({ max_height: 720 });
  });
  it("preserva os métodos do navegador sem um adaptador registrado", async () => {
    const track = {
      getSettings: vi.fn(() => ({ width: 1920 })),
      applyConstraints: vi.fn(async () => {}),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    expect(getCaptureSettings(track)).toEqual({ width: 1920 });
    await applyCaptureConstraints(track, { height: { max: 1080 } });
    expect(track.applyConstraints).toHaveBeenCalledWith({
      height: { max: 1080 },
    });
    releaseCaptureTrack(track);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("usa dimensões reais e libera o adaptador sem substituir métodos da track", async () => {
    const track = {
      getSettings: () => ({}),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const settings = { width: 2560, height: 1440 };
    const adapter = {
      settings: () => settings,
      applyConstraints: vi.fn(async () => {}),
      release: vi.fn(),
    };
    registerCaptureTrack(track, adapter);
    expect(track.getSettings()).toEqual({});
    expect(getCaptureSettings(track)).toEqual(settings);
    getCaptureSettings(track).width = 1;
    expect(settings.width).toBe(2560);
    await applyCaptureConstraints(track, { frameRate: { max: 60 } });
    expect(adapter.applyConstraints).toHaveBeenCalledWith({
      frameRate: { max: 60 },
    });
    releaseCaptureTrack(track);
    releaseCaptureTrack(track);
    expect(adapter.release).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  });
});
