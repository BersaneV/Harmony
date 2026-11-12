import { defaultTheme } from "./types";
import type { Theme } from "./types";
export function normalizeTheme(value: unknown): Theme {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Theme>;
  return {
    mode: v.mode === "light" ? "light" : "dark",
    accent:
      typeof v.accent === "string" && /^#[0-9a-f]{6}$/i.test(v.accent)
        ? v.accent
        : defaultTheme.accent,
    font: ["system", "serif", "mono"].includes(v.font || "")
      ? v.font!
      : defaultTheme.font,
    fontSize:
      typeof v.fontSize === "number"
        ? Math.max(12, Math.min(18, v.fontSize))
        : 14,
    compact: v.compact === true,
    background: v.background === "plain" ? "plain" : "aurora",
  };
}
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.dataset.compact = String(theme.compact);
  root.dataset.background = theme.background;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--base-font", `${theme.fontSize}px`);
  root.style.setProperty(
    "--app-font",
    theme.font === "mono"
      ? "ui-monospace, monospace"
      : theme.font === "serif"
        ? "Georgia, serif"
        : "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
  );
}
