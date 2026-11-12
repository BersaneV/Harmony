import { useEffect, useRef, useState } from "react";
import { Download, FileUp, RotateCcw, Trash2 } from "lucide-react";
import { defaultTheme } from "../lib/types";
import type { Theme } from "../lib/types";
import {
  exportTheme,
  importTheme,
  themePalette,
  themePresets,
} from "../lib/theme";
import {
  assetLimits,
  deleteThemeAsset,
  listThemeAssets,
  putThemeAsset,
  validateThemeFile,
} from "../lib/themeAssets";
import type { AssetKind, ThemeAsset } from "../lib/themeAssets";
import { errorMessage } from "../lib/api";
import { formatBytes } from "../lib/messages";
import { ErrorBanner, Field } from "./ui";
export default function Appearance({
  theme,
  onChange,
  scope,
}: {
  theme: Theme;
  onChange: (theme: Partial<Theme>) => void;
  scope: string;
}) {
  const [assets, setAssets] = useState<ThemeAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<ThemeAsset | null>(null);
  const mounted = useRef(true);
  const wallpaperInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    setAssetsLoading(true);
    void listThemeAssets(scope)
      .then((items) => {
        if (mounted.current) setAssets(items);
      })
      .catch((e) => {
        if (mounted.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (mounted.current) setAssetsLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [scope]);
  async function importAsset(file: File | undefined, kind: AssetKind) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const blob = await validateThemeFile(file, kind);
      if (!mounted.current) return;
      const asset = await putThemeAsset(scope, kind, file.name, blob);
      if (!mounted.current) return;
      setAssets(await listThemeAssets(scope));
      onChange(
        kind === "wallpaper"
          ? { background: "image", wallpaperId: asset.id }
          : { font: "imported", fontAssetId: asset.id },
      );
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function readTheme(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > 16384)
        throw new Error("O tema deve ter no máximo 16 KiB.");
      const theme = importTheme(await file.text());
      if (mounted.current) onChange(theme);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    }
  }
  function downloadTheme() {
    const url = URL.createObjectURL(
      new Blob([exportTheme(theme)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "harmony-tema.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function removeAsset() {
    if (!remove) return;
    setBusy(true);
    setError("");
    try {
      await deleteThemeAsset(scope, remove.id);
      setAssets(await listThemeAssets(scope));
      if (remove.id === theme.wallpaperId)
        onChange({ wallpaperId: null, background: "plain" });
      if (remove.id === theme.fontAssetId)
        onChange({ fontAssetId: null, font: "system" });
      setRemove(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const palette = themePalette(theme);
  return (
    <div className="appearance-editor">
      <p className="small-note">
        Prévia neste aplicativo. Use Aplicar preferências para salvar na conta;
        Cancelar descarta as alterações de aparência.
      </p>
      <div className="theme-options" aria-label="Temas prontos">
        {themePresets.map((preset) => (
          <button
            key={preset.name}
            className="theme-preset"
            onClick={() => onChange(preset.theme)}
          >
            <span style={{ background: preset.theme.accent }} />
            {preset.name}
          </button>
        ))}
      </div>
      <div className="stream-form">
        <Field label="Modo">
          <select
            value={theme.mode}
            onChange={(e) =>
              onChange({ mode: e.target.value as Theme["mode"] })
            }
          >
            <option value="dark">Escuro</option>
            <option value="light">Claro</option>
          </select>
        </Field>
        <Field label="Contraste">
          <select
            value={theme.contrast}
            onChange={(e) =>
              onChange({ contrast: e.target.value as Theme["contrast"] })
            }
          >
            <option value="normal">Padrão acessível</option>
            <option value="high">Alto contraste</option>
          </select>
        </Field>
        <Field label="Cor de destaque">
          <input
            type="color"
            value={theme.accent}
            onChange={(e) => onChange({ accent: e.target.value })}
          />
        </Field>
        <Field label="Cor de fundo">
          <input
            type="color"
            disabled={theme.contrast === "high"}
            value={theme.baseColor || palette.bg}
            onChange={(e) => onChange({ baseColor: e.target.value })}
          />
        </Field>
        <Field label="Fonte">
          <select
            value={theme.font}
            onChange={(e) =>
              onChange({ font: e.target.value as Theme["font"] })
            }
          >
            <option value="system">Sistema</option>
            <option value="serif">Georgia / Cambria</option>
            <option value="mono">Consolas / monoespaçada</option>
            <option value="arial">Arial / Helvetica</option>
            <option value="verdana">Verdana / Geneva</option>
            <option value="imported">Arquivo local importado</option>
          </select>
        </Field>
        <Field label={`Tamanho do texto · ${theme.fontSize}px`}>
          <input
            type="range"
            min={12}
            max={18}
            step={1}
            value={theme.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
        </Field>
        <Field label="Espaçamento das mensagens">
          <select
            value={theme.density}
            onChange={(e) =>
              onChange({ density: e.target.value as Theme["density"] })
            }
          >
            <option value="comfortable">Confortável</option>
            <option value="compact">Compacto</option>
            <option value="spacious">Amplo</option>
          </select>
        </Field>
        <Field label={`Largura dos canais · ${theme.sidebarWidth}px`}>
          <input
            type="range"
            min={200}
            max={300}
            step={10}
            value={theme.sidebarWidth}
            onChange={(e) => onChange({ sidebarWidth: Number(e.target.value) })}
          />
        </Field>
        <Field label="Posição da lista de membros">
          <select
            value={theme.membersSide}
            onChange={(e) =>
              onChange({ membersSide: e.target.value as Theme["membersSide"] })
            }
          >
            <option value="right">À direita da conversa</option>
            <option value="left">À esquerda da conversa</option>
          </select>
        </Field>
        <Field label="Fundo da conversa">
          <select
            value={theme.background}
            onChange={(e) =>
              onChange({ background: e.target.value as Theme["background"] })
            }
          >
            <option value="aurora">Aurora sutil</option>
            <option value="plain">Cor sólida</option>
            <option value="image">Imagem local</option>
          </select>
        </Field>
        {theme.background === "image" && (
          <>
            <Field label="Imagem neste dispositivo">
              <select
                value={theme.wallpaperId || ""}
                onChange={(e) =>
                  onChange({ wallpaperId: e.target.value || null })
                }
              >
                <option value="">Escolha uma imagem importada</option>
                {assets
                  .filter((a) => a.kind === "wallpaper")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={`Intensidade do fundo · ${theme.wallpaperOpacity}%`}>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={theme.wallpaperOpacity}
                disabled={theme.contrast === "high"}
                onChange={(e) =>
                  onChange({ wallpaperOpacity: Number(e.target.value) })
                }
              />
            </Field>
          </>
        )}
        {theme.font === "imported" && (
          <Field label="Fonte neste dispositivo">
            <select
              value={theme.fontAssetId || ""}
              onChange={(e) =>
                onChange({ fontAssetId: e.target.value || null })
              }
            >
              <option value="">Escolha uma fonte importada</option>
              {assets
                .filter((a) => a.kind === "font")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
      </div>
      <div className="theme-sample" aria-label="Prévia do tema">
        <span className="eyebrow">PRÉVIA</span>
        <strong>Um espaço para conversar.</strong>
        <p>
          Texto, contraste e espaçamento seguem suas escolhas. Aa Bb 0123456789
        </p>
        <button type="button" className="button primary" tabIndex={-1}>
          Cor de destaque
        </button>
      </div>
      <p className="small-note">
        As cores do texto e do destaque se ajustam para preservar a leitura.
        Alto contraste desativa a imagem. Fontes do sistema usam alternativas
        quando não estão instaladas.
      </p>
      <section
        className="local-assets"
        aria-label="Arquivos locais de aparência"
      >
        <h4>Arquivos deste dispositivo</h4>
        <p className="small-note">
          Imagens PNG/JPEG/WebP estáticas até 8 MiB e 4096 px; fontes
          WOFF2/WOFF/TTF/OTF até 2 MiB. Os arquivos ficam somente neste
          navegador ou aplicativo, separados por conta e servidor. Arquivos
          importados permanecem na biblioteca ao cancelar a prévia. Limpar os
          dados do aplicativo remove esses arquivos.
        </p>
        <div className="appearance-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => wallpaperInput.current?.click()}
          >
            <FileUp size={16} />
            Importar imagem
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() => fontInput.current?.click()}
          >
            <FileUp size={16} />
            Importar fonte
          </button>
        </div>
        <input
          ref={wallpaperInput}
          hidden
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          aria-label="Arquivo de imagem de fundo"
          onChange={(e) => {
            void importAsset(e.target.files?.[0], "wallpaper");
            e.target.value = "";
          }}
        />
        <input
          ref={fontInput}
          hidden
          type="file"
          accept=".woff2,.woff,.ttf,.otf"
          aria-label="Arquivo de fonte"
          onChange={(e) => {
            void importAsset(e.target.files?.[0], "font");
            e.target.value = "";
          }}
        />
        {busy && <p role="status">Validando e salvando arquivo local…</p>}
        <ul className="asset-list">
          {assets.map((asset) => (
            <li key={asset.id}>
              <div>
                <strong>{asset.name}</strong>
                <small>
                  {asset.kind === "font" ? "Fonte" : "Imagem"} ·{" "}
                  {formatBytes(asset.blob.size)}
                </small>
              </div>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`Remover ${asset.name}`}
                onClick={() => setRemove(asset)}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
        {assetsLoading ? (
          <p role="status">Carregando arquivos locais…</p>
        ) : (
          <small>
            {assets.length}/{assetLimits.count} arquivos ·{" "}
            {formatBytes(assets.reduce((sum, a) => sum + a.blob.size, 0))} / 40
            MiB
          </small>
        )}
        {remove && (
          <div className="asset-confirm" role="alert">
            <p>
              Remover {remove.name} deste dispositivo? Temas que usam esse
              arquivo voltarão ao fundo ou fonte padrão.
            </p>
            <button className="button" onClick={() => setRemove(null)}>
              Manter arquivo
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void removeAsset()}
            >
              Remover arquivo
            </button>
          </div>
        )}
      </section>
      <div className="appearance-actions">
        <button className="button" onClick={() => onChange(defaultTheme)}>
          <RotateCcw size={16} />
          Restaurar padrão na prévia
        </button>
        <button className="button" onClick={() => jsonInput.current?.click()}>
          <FileUp size={16} />
          Importar tema JSON
        </button>
        <button className="button" onClick={downloadTheme}>
          <Download size={16} />
          Exportar tema JSON
        </button>
      </div>
      <input
        ref={jsonInput}
        type="file"
        hidden
        accept=".json,application/json"
        aria-label="Arquivo de tema JSON"
        onChange={(e) => {
          void readTheme(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <p className="small-note">
        O JSON inclui apenas opções e identificadores locais; imagens e fontes
        não são exportadas nem enviadas ao servidor. Em outro dispositivo,
        importe os arquivos e selecione-os novamente.
      </p>
      <ErrorBanner message={error} />
    </div>
  );
}
