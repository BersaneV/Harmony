import { describe, expect, it, vi } from "vitest";
import {
  applyCaptureConstraints,
  getCaptureSettings,
  getCaptureBound,
  registerCaptureTrack,
  releaseCaptureTrack,
} from "./capture-track";

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
