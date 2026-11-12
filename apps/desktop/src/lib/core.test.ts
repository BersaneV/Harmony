import { describe, expect, it } from "vitest";
import {
  captureOptions,
  defaultProfile,
  publishOptions,
  validateProfile,
} from "./stream";
import { compareSequences, mergeMessages } from "./messages";
import { normalizeTheme } from "./theme";
import type { Message } from "./types";
describe("orçamento de transmissão", () => {
  it("converte Mb/s para bits/s e impede codecs/camadas ocultos", () => {
    const options = publishOptions(
      { ...defaultProfile, bitrate: 4 },
      32_000_000,
    );
    expect(options.screenShareEncoding?.maxBitrate).toBe(4_000_000);
    expect(options.simulcast).toBe(false);
    expect(options.backupCodec).toBe(false);
    expect(options.videoCodec).toBe("vp8");
  });
  it("respeita a cota da instância no modo automático", () => {
    expect(
      publishOptions({ ...defaultProfile, bitrate: 0 }, 2_000_000)
        .screenShareEncoding?.maxBitrate,
    ).toBe(2_000_000);
  });
  it.each([NaN, Infinity, -1, 0.1, 33])(
    "rejeita bitrate inválido %s",
    (bitrate) =>
      expect(() =>
        validateProfile({ ...defaultProfile, bitrate }, 32_000_000),
      ).toThrow(),
  );
  it("não aceita cota zero nem resolução ou FPS fora do catálogo", () => {
    expect(() => publishOptions(defaultProfile, 0)).toThrow();
    expect(() =>
      validateProfile({ ...defaultProfile, height: 999 }, 32_000_000),
    ).toThrow();
    expect(() =>
      validateProfile({ ...defaultProfile, fps: 120 }, 32_000_000),
    ).toThrow();
  });
  it("aceita 1440p60 e 2160p sem afirmar resultado efetivo", () => {
    expect(
      captureOptions({ ...defaultProfile, height: 1440, fps: 60 }).resolution,
    ).toEqual({ width: 2560, height: 1440, frameRate: 60 });
    expect(
      validateProfile({ ...defaultProfile, height: 2160 }, 32_000_000).height,
    ).toBe(2160);
  });
  it("limita a republicação ao mesmo orçamento de vídeo", () => {
    const a = publishOptions({ ...defaultProfile, bitrate: 12 }, 16_000_000);
    const b = publishOptions(
      { ...defaultProfile, bitrate: 2, fps: 15 },
      16_000_000,
    );
    expect(a.screenShareEncoding?.maxBitrate).toBe(12_000_000);
    expect(b.screenShareEncoding).toEqual({
      maxBitrate: 2_000_000,
      maxFramerate: 15,
    });
  });
});
describe("histórico persistente", () => {
  const row = (id: string, seq: string, content: string, deleted = false) =>
    ({ id, seq, content, deleted }) as Message;
  it("não perde precisão em sequências maiores que Number.MAX_SAFE_INTEGER", () => {
    expect(compareSequences("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareSequences("9223372036854775807", "9223372036854775806")).toBe(
      1,
    );
  });
  it("mescla edição/replay/tombstone por identidade sem duplicar", () => {
    const original = [row("a", "1", "antes"), row("b", "2", "preservada")];
    const merged = mergeMessages(original, [
      row("a", "1", "", true),
      row("c", "3", "nova"),
      row("b", "2", "editada"),
    ]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[0].deleted).toBe(true);
    expect(merged[1].content).toBe("editada");
  });
});
describe("personalização como dados", () => {
  it("rejeita CSS arbitrário e mantém limites de fonte", () => {
    const result = normalizeTheme({
      accent: "url(https://evil.example/track)",
      font: "x;display:none",
      fontSize: 999,
      mode: "unknown",
    });
    expect(result.accent).toBe("#9d8aff");
    expect(result.font).toBe("system");
    expect(result.fontSize).toBe(18);
    expect(result.mode).toBe("dark");
  });
});
