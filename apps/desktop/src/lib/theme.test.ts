import { describe, expect, it } from "vitest";
import { defaultTheme } from "./types";
import {
  contrastRatio,
  exportTheme,
  importTheme,
  normalizeTheme,
  themePalette,
} from "./theme";
describe("tema versionado e acessível", () => {
  it("migra preferências antigas e preserva mensagem compacta", () => {
    const theme = normalizeTheme({
      mode: "light",
      compact: true,
      font: "mono",
      fontSize: 16,
      accent: "#123456",
    });
    expect(theme).toMatchObject({
      version: 2,
      density: "compact",
      compact: true,
      font: "mono",
      fontSize: 16,
      sidebarWidth: 240,
      wallpaperId: null,
    });
  });
  it("mantém limites finitos mesmo para NaN, infinito, objetos e arrays", () => {
    const theme = normalizeTheme({
      fontSize: NaN,
      wallpaperOpacity: Infinity,
      sidebarWidth: -100,
      font: "constructor",
      accent: "url(javascript:alert(1))",
      wallpaperId: "blob:injected",
    });
    expect(theme).toMatchObject({
      fontSize: 14,
      wallpaperOpacity: 12,
      sidebarWidth: 200,
      font: "system",
      wallpaperId: null,
      accent: defaultTheme.accent,
    });
    expect(normalizeTheme([])).toEqual(defaultTheme);
  });
  it.each(["__proto__", "constructor", "prototype", "css", "script", "url"])(
    "rejeita propriedade importada %s",
    (key) => {
      expect(() =>
        importTheme(
          `{"format":"harmony-theme","version":2,"theme":{"${key}":"evil"}}`,
        ),
      ).toThrow();
      expect(({} as Record<string, unknown>).evil).toBeUndefined();
    },
  );
  it("rejeita tipos/valores inválidos e payload grande sem normalizá-los silenciosamente", () => {
    for (const value of [
      { fontSize: 99 },
      { fontSize: "14" },
      { baseColor: "red" },
      { font: "url(https://example.com)" },
      { wallpaperId: "../../file" },
    ]) {
      expect(() =>
        importTheme(
          JSON.stringify({ format: "harmony-theme", version: 2, theme: value }),
        ),
      ).toThrow();
    }
    expect(() => importTheme(" ".repeat(16385))).toThrow();
    expect(() =>
      importTheme('{"format":"harmony-theme","version":"2","theme":{}}'),
    ).toThrow();
  });
  it("exporta somente configuração e reimporta sem alteração", () => {
    const theme = normalizeTheme({
      ...defaultTheme,
      density: "spacious",
      membersSide: "left",
      fontAssetId: "7dfe8cb3-ac33-4eaf-a983-7d9341ac94ec",
      font: "imported",
    });
    const json = exportTheme(theme);
    expect(importTheme(json)).toEqual(theme);
    expect(json).not.toMatch(/data:|blob:|https:|@font-face/);
  });
  it.each(["#000000", "#ffffff", "#777777", "#141f42", "#ba6d20", "#115a29"])(
    "preserva contraste textual sobre %s",
    (baseColor) => {
      const palette = themePalette(
        normalizeTheme({ baseColor, accent: baseColor }),
      );
      for (const text of [palette.text, palette.muted, palette.accent])
        for (const background of [palette.bg, palette.panel])
          expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette.accentText, palette.accent),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
  it("alto contraste usa fundo puro independentemente da cor importada", () => {
    expect(
      themePalette(
        normalizeTheme({
          contrast: "high",
          mode: "dark",
          baseColor: "#999999",
        }),
      ).bg,
    ).toBe("#000000");
  });
});
