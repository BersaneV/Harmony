import { describe, expect, it } from "vitest";
import { classifyRoute, percentile, validateProbeProfile } from "./p2p";
describe("P2P diagnostics evidence", () => {
  it("does not call missing metrics zero or direct", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(classifyRoute(null, "host")).toBe("unknown");
    expect(classifyRoute("host", "unknown")).toBe("unknown");
  });
  it("identifies relay at either endpoint and direct ICE types", () => {
    expect(classifyRoute("host", "relay")).toBe("relay");
    expect(classifyRoute("relay", "host")).toBe("relay");
    expect(classifyRoute("host", "srflx")).toBe("direct");
    expect(classifyRoute("prflx", "srflx")).toBe("direct");
  });
  it("uses measured finite samples without changing their order", () => {
    const samples = [138, 134, 140, NaN, 137];
    expect(percentile(samples, 0.5)).toBe(137);
    expect(percentile(samples, 0.95)).toBe(140);
    expect(samples[0]).toBe(138);
  });
  it("caps synthetic traffic and preserves allowed high resolutions", () => {
    expect(
      validateProbeProfile({ height: 1440, fps: 60, bitrate: 8_000_000 })
        .height,
    ).toBe(1440);
    for (const bitrate of [NaN, Infinity, -1, 33_000_000])
      expect(() =>
        validateProbeProfile({ height: 720, fps: 30, bitrate }),
      ).toThrow();
    expect(() =>
      validateProbeProfile({ height: 1080, fps: 1000, bitrate: 2_000_000 }),
    ).toThrow();
  });
});
