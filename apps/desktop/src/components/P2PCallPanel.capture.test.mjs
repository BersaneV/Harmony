import { readFileSync } from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Execute the actual component handler with media/UI boundaries controlled.
// This covers async ownership; real EXE capture remains a separate QA gate.
const source = readFileSync(
  new URL("./P2PCallPanel.tsx", import.meta.url),
  "utf8",
);
const start = source.indexOf("  async function captureScreen() {");
const end = source.indexOf("  async function stopSharing()", start);
if (start < 0 || end <= start) throw new Error("Capture handler not found");
const handler = stripTypeScriptTypes(source.slice(start, end));

function fixture({
  native = false,
  height = 720,
  fps = 30,
  screenAudio = false,
  method = "auto",
} = {}) {
  class Track extends EventTarget {
    kind = "video";
    readyState = "live";
    getSettings = vi.fn(() => ({ width: 960, height: 720 }));
    stop = vi.fn(() => {
      this.readyState = "ended";
    });
  }
  const video = new Track(),
    audio = new Track();
  audio.kind = "audio";
  const stream = {
    getVideoTracks: () => [video],
    getTracks: () => [video, audio],
  };
  const setPreview = vi.fn();
  const resolveCaptureSettings = vi.fn(async () => ({
    width: 960,
    height: 540,
  }));
  const applyCaptureConstraints = vi.fn(async () => {});
  const getDisplayMedia = vi.fn(async () => stream);
  const context = {
    AbortController,
    DOMException,
    allowed: { current: true },
    mounted: { current: true },
    profile: { height, fps, bitrate: 4, audio: screenAudio, content: "motion" },
    state: { maxVideoBitrate: 32e6 },
    validateProfile: vi.fn(),
    stopPreview: vi.fn(),
    previewGeneration: { current: 1 },
    previewRef: { current: null },
    nativeCaptureAbort: { current: null },
    nativeAvailable: native,
    captureMethod: method,
    nativeSelection: { current: null },
    nativeScreenSources: vi.fn(async () => [{ key: "owned", title: "Window" }]),
    setNativeSources: vi.fn(() => {
      queueMicrotask(() => context.nativeSelection.current?.("owned"));
    }),
    createNativeScreenTrack: vi.fn(async () => video),
    MediaStream: class {
      getVideoTracks = () => [video];
      getTracks = () => [video];
    },
    navigator: { mediaDevices: { getDisplayMedia } },
    resolveCaptureSettings,
    applyCaptureConstraints,
    setPreview,
    releaseCaptureTrack: (track) => track.stop(),
  };
  const runtime = vm.createContext(context);
  vm.runInContext(handler, runtime);
  const run = () => runtime.captureScreen();
  return {
    context,
    video,
    audio,
    stream,
    getDisplayMedia,
    resolveCaptureSettings,
    applyCaptureConstraints,
    setPreview,
    run,
  };
}

describe("compiled screen preview capture handler", () => {
  it("uses current-frame 16:9 geometry instead of provisional 4:3 settings before applying maximums", async () => {
    const f = fixture();
    await f.run();
    expect(f.resolveCaptureSettings).toHaveBeenCalledWith(f.video, {
      signal: f.context.nativeCaptureAbort.current.signal,
    });
    expect(f.video.getSettings).not.toHaveBeenCalled();
    expect(f.resolveCaptureSettings.mock.invocationCallOrder[0]).toBeLessThan(
      f.applyCaptureConstraints.mock.invocationCallOrder[0],
    );
    expect(f.applyCaptureConstraints).toHaveBeenCalledWith(f.video, {
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { max: 30 },
    });
    expect(f.getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: {
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      }),
    );
    expect(f.setPreview).toHaveBeenCalledWith(f.stream);
    expect(f.video.stop).not.toHaveBeenCalled();
  });
  it("keeps automatic height uncapped and the existing default 30 FPS maximum", async () => {
    const f = fixture({ height: 0, fps: 0 });
    await f.run();
    expect(f.applyCaptureConstraints).toHaveBeenCalledWith(f.video, {
      frameRate: { max: 30 },
    });
  });
  it("preserves native profile constraints without browser frame observation or width maximums", async () => {
    const f = fixture({ native: true, height: 1080, fps: 60 });
    await f.run();
    expect(f.resolveCaptureSettings).not.toHaveBeenCalled();
    expect(f.getDisplayMedia).not.toHaveBeenCalled();
    expect(f.applyCaptureConstraints).toHaveBeenCalledWith(f.video, {
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
    });
  });
  it("releases video and audio on frame observation failure, without publishing a preview", async () => {
    const f = fixture();
    f.resolveCaptureSettings.mockRejectedValueOnce(
      new Error("no current frame"),
    );
    await expect(f.run()).rejects.toThrow("no current frame");
    expect(f.video.stop).toHaveBeenCalledOnce();
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.applyCaptureConstraints).not.toHaveBeenCalled();
    expect(f.setPreview).not.toHaveBeenCalled();
  });
  it.each(["abort", "revocation", "unmount", "replacement"])(
    "releases all tracks and ignores late frame geometry after %s",
    async (cause) => {
      const f = fixture();
      let complete;
      f.resolveCaptureSettings.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const pending = f.run();
      await vi.waitFor(() =>
        expect(f.resolveCaptureSettings).toHaveBeenCalledOnce(),
      );
      if (cause === "abort") f.context.nativeCaptureAbort.current.abort();
      else if (cause === "revocation") f.context.allowed.current = false;
      else if (cause === "unmount") f.context.mounted.current = false;
      else f.context.previewGeneration.current++;
      complete({ width: 1280, height: 720 });
      await pending;
      expect(f.video.stop).toHaveBeenCalledOnce();
      expect(f.audio.stop).toHaveBeenCalledOnce();
      expect(f.applyCaptureConstraints).not.toHaveBeenCalled();
      expect(f.setPreview).not.toHaveBeenCalled();
    },
  );
});

describe("automatic Windows capture path without screen audio", () => {
  it.each([15, 24, 30, 60])(
    "uses the normal native source picker and requested constraints at %i explicit FPS",
    async (fps) => {
      const f = fixture({ native: true, height: 720, fps });
      await f.run();
      expect(f.context.nativeScreenSources).toHaveBeenCalledOnce();
      expect(f.context.setNativeSources).toHaveBeenCalledWith([
        { key: "owned", title: "Window" },
      ]);
      expect(f.context.createNativeScreenTrack).toHaveBeenCalledExactlyOnceWith(
        "owned",
        f.context.profile,
        { signal: f.context.nativeCaptureAbort.current.signal },
      );
      expect(f.applyCaptureConstraints).toHaveBeenCalledExactlyOnceWith(
        f.video,
        {
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: fps, max: fps },
        },
      );
      expect(f.getDisplayMedia).not.toHaveBeenCalled();
      expect(f.resolveCaptureSettings).not.toHaveBeenCalled();
      expect(f.setPreview).toHaveBeenCalledOnce();
      expect(f.video.stop).not.toHaveBeenCalled();
    },
  );
  it.each([30, 60])(
    "preserves browser and system audio when screen audio is requested at %i FPS",
    async (fps) => {
      const f = fixture({ native: true, fps, screenAudio: true });
      await f.run();
      expect(f.getDisplayMedia).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          audio: true,
          systemAudio: "include",
          video: {
            height: { ideal: 720, max: 720 },
            frameRate: { ideal: fps, max: fps },
          },
        }),
      );
      expect(f.context.nativeScreenSources).not.toHaveBeenCalled();
      expect(f.context.createNativeScreenTrack).not.toHaveBeenCalled();
      expect(f.setPreview).toHaveBeenCalledWith(f.stream);
      expect(f.audio.stop).not.toHaveBeenCalled();
    },
  );
  it.each([30, 60])(
    "preserves explicit browser capture with native available at %i FPS",
    async (fps) => {
      const f = fixture({ native: true, fps, method: "browser" });
      await f.run();
      expect(f.getDisplayMedia).toHaveBeenCalledOnce();
      expect(f.resolveCaptureSettings).toHaveBeenCalledOnce();
      expect(f.context.nativeScreenSources).not.toHaveBeenCalled();
      expect(f.context.createNativeScreenTrack).not.toHaveBeenCalled();
    },
  );
  it.each([30, 60])(
    "keeps browser capture when native is unavailable at %i FPS",
    async (fps) => {
      const f = fixture({ native: false, fps });
      await f.run();
      expect(f.getDisplayMedia).toHaveBeenCalledOnce();
      expect(f.context.nativeScreenSources).not.toHaveBeenCalled();
      expect(f.context.createNativeScreenTrack).not.toHaveBeenCalled();
    },
  );
  it("keeps automatic FPS on the existing browser path with its effective30 FPS cap", async () => {
    const f = fixture({ native: true, fps: 0 });
    await f.run();
    expect(f.getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: {
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      }),
    );
    expect(f.context.createNativeScreenTrack).not.toHaveBeenCalled();
  });
  it.each([30, 60])(
    "cancels native picker without starting any capture or browser fallback at %i FPS",
    async (fps) => {
      const f = fixture({ native: true, fps });
      f.context.setNativeSources.mockImplementationOnce(() => {
        queueMicrotask(() => f.context.nativeSelection.current?.(null));
      });
      await f.run();
      expect(f.context.nativeScreenSources).toHaveBeenCalledOnce();
      expect(f.context.createNativeScreenTrack).not.toHaveBeenCalled();
      expect(f.getDisplayMedia).not.toHaveBeenCalled();
      expect(f.applyCaptureConstraints).not.toHaveBeenCalled();
      expect(f.setPreview).not.toHaveBeenCalled();
    },
  );
  it.each([30, 60])(
    "native consent rejection at %i FPS never opens a browser capture automatically",
    async (fps) => {
      const f = fixture({ native: true, fps });
      f.context.createNativeScreenTrack.mockRejectedValueOnce(
        new DOMException("cancelled", "NotAllowedError"),
      );
      await expect(f.run()).rejects.toThrow(
        "A seleção foi cancelada ou a captura não foi autorizada.",
      );
      expect(f.getDisplayMedia).not.toHaveBeenCalled();
      expect(f.setPreview).not.toHaveBeenCalled();
    },
  );
  it.each(
    [30, 60].flatMap((fps) =>
      ["abort", "revocation", "unmount", "replacement"].map((cause) => ({
        fps,
        cause,
      })),
    ),
  )(
    "releases a late native track at $fps FPS after $cause without changing the path",
    async ({ fps, cause }) => {
      const f = fixture({ native: true, fps });
      let complete;
      f.context.createNativeScreenTrack.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const pending = f.run();
      await vi.waitFor(() =>
        expect(f.context.createNativeScreenTrack).toHaveBeenCalledOnce(),
      );
      if (cause === "abort") f.context.nativeCaptureAbort.current.abort();
      else if (cause === "revocation") f.context.allowed.current = false;
      else if (cause === "unmount") f.context.mounted.current = false;
      else f.context.previewGeneration.current++;
      complete(f.video);
      await pending;
      expect(f.video.stop).toHaveBeenCalledOnce();
      expect(f.audio.stop).not.toHaveBeenCalled();
      expect(f.setPreview).not.toHaveBeenCalled();
      expect(f.getDisplayMedia).not.toHaveBeenCalled();
    },
  );
});
