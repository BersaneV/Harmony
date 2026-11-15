import { describe, expect, it, vi } from "vitest";
import {
  applyCaptureConstraints,
  getCaptureSettings,
  registerCaptureTrack,
  releaseCaptureTrack,
} from "./capture-track";

describe("porta de tracks de captura", () => {
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
