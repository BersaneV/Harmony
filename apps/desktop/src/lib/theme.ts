import { defaultTheme } from "./types";
import type { Theme } from "./types";
export const fonts = {
  system:
    "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
  serif: "Georgia, Cambria, serif",
  mono: "Consolas, ui-monospace, monospace",
  arial: "Arial, Helvetica, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  imported: "system-ui, sans-serif",
} as const;
const hex = /^#[0-9a-f]{6}$/i;
const assetId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.round(Math.max(min, Math.min(max, v)))
    : fallback;
const id = (v: unknown) =>
  typeof v === "string" && assetId.test(v) ? v : null;
export function normalizeTheme(value: unknown): Theme {
  const v = (
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
  ) as Partial<Theme>;
  const density = ["comfortable", "compact", "spacious"].includes(
    v.density || "",
  )
    ? v.density!
    : v.compact === true
      ? "compact"
      : "comfortable";
  return {
    version: 2,
    mode: v.mode === "light" ? "light" : "dark",
    accent:
      typeof v.accent === "string" && hex.test(v.accent)
        ? v.accent
        : defaultTheme.accent,
    baseColor:
      typeof v.baseColor === "string" && hex.test(v.baseColor)
        ? v.baseColor
        : null,
    contrast: v.contrast === "high" ? "high" : "normal",
    font: Object.hasOwn(fonts, v.font || "") ? v.font! : "system",
    fontAssetId: id(v.fontAssetId),
    fontSize: bounded(v.fontSize, 14, 12, 18),
    compact: density === "compact",
    density,
    background: ["plain", "aurora", "image"].includes(v.background || "")
      ? v.background!
      : "aurora",
    wallpaperId: id(v.wallpaperId),
    wallpaperOpacity: bounded(v.wallpaperOpacity, 12, 0, 20),
    sidebarWidth: bounded(v.sidebarWidth, 240, 200, 300),
    membersSide: v.membersSide === "left" ? "left" : "right",
  };
}
function rgb(color: string) {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
}
function mix(a: string, b: string, amount: number) {
  const right = rgb(b);
  return (
    "#" +
    rgb(a)
      .map((v, i) =>
        Math.round(v * (1 - amount) + right[i] * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function contrastRatio(a: string, b: string) {
  const lum = (color: string) =>
    rgb(color)
      .map((n) => n / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function themePalette(theme: Theme) {
  const high = theme.contrast === "high";
  const bg = high
    ? theme.mode === "light"
      ? "#ffffff"
      : "#000000"
    : theme.baseColor || (theme.mode === "light" ? "#f7f8fc" : "#171a23");
  const text =
    contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#000000")
      ? "#ffffff"
      : "#000000";
  const panel = high
    ? bg
    : mix(bg, text === "#ffffff" ? "#000000" : "#ffffff", 0.035);
  let accent = theme.accent;
  for (
    let i = 0;
    i <= 20 &&
    (contrastRatio(accent, bg) < 4.5 || contrastRatio(accent, panel) < 4.5);
    i++
  )
    accent = mix(theme.accent, text, i / 20);
  let muted = high ? text : mix(bg, text, 0.7);
  for (
    let i = 14;
    i <= 20 &&
    (contrastRatio(muted, bg) < 4.5 || contrastRatio(muted, panel) < 4.5);
    i++
  )
    muted = mix(bg, text, i / 20);
  return {
    bg,
    text,
    panel,
    accent,
    muted,
    accentText:
      contrastRatio(accent, "#000000") > contrastRatio(accent, "#ffffff")
        ? "#000000"
        : "#ffffff",
    sidebar: high
      ? bg
      : mix(bg, text === "#ffffff" ? "#000000" : "#ffffff", 0.015),
    rail: bg,
    input: bg,
    border: high ? mix(bg, text, 0.65) : mix(bg, text, 0.13),
  };
}
export const themePresets: { name: string; theme: Partial<Theme> }[] = [
  {
    name: "Aurora",
    theme: {
      mode: "dark",
      accent: "#9d8aff",
      baseColor: null,
      contrast: "normal",
      background: "aurora",
    },
  },
  {
    name: "Dia",
    theme: {
      mode: "light",
      accent: "#6550b8",
      baseColor: null,
      contrast: "normal",
      background: "plain",
    },
  },
  {
    name: "Floresta",
    theme: {
      mode: "dark",
      accent: "#81d4ac",
      baseColor: "#14231e",
      contrast: "normal",
      background: "plain",
    },
  },
  {
    name: "Alto contraste",
    theme: {
      mode: "dark",
      accent: "#ffdc73",
      baseColor: null,
      contrast: "high",
      background: "plain",
    },
  },
];
export function applyTheme(value: Theme) {
  const theme = normalizeTheme(value),
    root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.dataset.compact = String(theme.compact);
  root.dataset.density = theme.density;
  root.dataset.contrast = theme.contrast;
  root.dataset.background = theme.background;
  root.dataset.membersSide = theme.membersSide;
  for (const [key, value] of Object.entries(themePalette(theme)))
    root.style.setProperty(
      "--" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
      value,
    );
  root.style.setProperty("--base-font", `${theme.fontSize}px`);
  root.style.setProperty("--sidebar-width", `${theme.sidebarWidth}px`);
  root.style.setProperty(
    "--wallpaper-opacity",
    String(theme.contrast === "high" ? 0 : theme.wallpaperOpacity / 100),
  );
  root.style.setProperty("--app-font", fonts[theme.font]);
}
export function exportTheme(theme: Theme) {
  return JSON.stringify(
    { format: "harmony-theme", version: 2, theme: normalizeTheme(theme) },
    null,
    2,
  );
}
export function importTheme(json: string): Theme {
  if (new TextEncoder().encode(json).length > 16384)
    throw new Error("O tema deve ter no máximo 16 KiB.");
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("O arquivo não contém um JSON válido.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Formato de tema inválido.");
  const envelope = data as Record<string, unknown>;
  if (
    Object.keys(envelope).some(
      (k) => !["format", "version", "theme"].includes(k),
    ) ||
    envelope.format !== "harmony-theme" ||
    ![1, 2].includes(envelope.version as number)
  )
    throw new Error("Formato ou versão de tema não suportados.");
  const raw = envelope.theme;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("As opções do tema são inválidas.");
  const v = raw as Record<string, unknown>;
  const keys = Object.keys(defaultTheme);
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error(
      "O tema contém opções desconhecidas. CSS, scripts e URLs não são aceitos.",
    );
  const normalized = normalizeTheme(v);
  for (const [key, value] of Object.entries(v)) {
    if (key === "version" && envelope.version === 1 && value === 1) continue;
    if (
      key === "compact" &&
      envelope.version === 1 &&
      typeof value === "boolean"
    )
      continue;
    if (normalized[key as keyof Theme] !== value)
      throw new Error(`Opção inválida no tema: ${key}.`);
  }
  return normalized;
}
