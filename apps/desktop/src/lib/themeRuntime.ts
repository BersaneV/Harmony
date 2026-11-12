import { applyTheme, fonts, normalizeTheme } from "./theme";
import { getThemeAsset, validateThemeFile } from "./themeAssets";
import type { Theme } from "./types";
let generation = 0;
let wallpaperUrl = "";
let loadedFont: FontFace | null = null;
export async function activateTheme(
  value: Theme,
  scope: string | null,
): Promise<string[]> {
  const attempt = ++generation;
  const theme = normalizeTheme(value);
  const root = document.documentElement;
  if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
  wallpaperUrl = "";
  root.style.removeProperty("--wallpaper-image");
  if (loadedFont) document.fonts.delete(loadedFont);
  loadedFont = null;
  applyTheme(theme);
  if (!scope) return [];
  const warnings: string[] = [];
  await Promise.all([
    (async () => {
      if (theme.background !== "image" || !theme.wallpaperId) return;
      try {
        const asset = await getThemeAsset(
          scope,
          theme.wallpaperId,
          "wallpaper",
        );
        if (!asset)
          throw new Error(
            "Imagem não disponível neste dispositivo. Importe-a novamente ou escolha outro fundo.",
          );
        const blob = await validateThemeFile(asset.blob, "wallpaper");
        if (attempt !== generation) return;
        wallpaperUrl = URL.createObjectURL(blob);
        root.style.setProperty(
          "--wallpaper-image",
          `url(${JSON.stringify(wallpaperUrl)})`,
        );
      } catch (error) {
        warnings.push(
          error instanceof Error
            ? error.message
            : "Não foi possível abrir o fundo local.",
        );
      }
    })(),
    (async () => {
      if (theme.font !== "imported" || !theme.fontAssetId) return;
      try {
        const asset = await getThemeAsset(scope, theme.fontAssetId, "font");
        if (!asset)
          throw new Error(
            "Fonte não disponível neste dispositivo. Usando a fonte do sistema.",
          );
        const blob = await validateThemeFile(asset.blob, "font");
        const family = "HarmonyLocal" + asset.id.replaceAll("-", "");
        const face = new FontFace(family, await blob.arrayBuffer());
        await face.load();
        if (attempt !== generation) return;
        document.fonts.add(face);
        loadedFont = face;
        root.style.setProperty("--app-font", `${family}, ${fonts.system}`);
      } catch (error) {
        warnings.push(
          error instanceof Error
            ? error.message
            : "Não foi possível abrir a fonte local.",
        );
      }
    })(),
  ]);
  return attempt === generation ? warnings : [];
}
