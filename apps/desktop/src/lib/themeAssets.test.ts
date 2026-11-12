import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetLimits,
  deleteThemeAsset,
  getThemeAsset,
  inspectFont,
  inspectImage,
  listThemeAssets,
  putThemeAsset,
  themeScope,
  validateThemeFile,
} from "./themeAssets";
const scopes: string[] = [];
const scope = (origin = "https://harmony.example") => {
  const s = themeScope(origin, crypto.randomUUID());
  scopes.push(s);
  return s;
};
afterEach(async () => {
  for (const s of scopes.splice(0))
    for (const asset of await listThemeAssets(s))
      await deleteThemeAsset(s, asset.id);
  vi.unstubAllGlobals();
});
function png(width = 100, height = 100) {
  const bytes = new Uint8Array(45),
    view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set(new TextEncoder().encode("IEND"), 37);
  return bytes;
}
describe("arquivos locais de aparência", () => {
  it("persiste blobs e isola usuário, servidor e tipo ao reler a base", async () => {
    const first = scope(),
      second = scope();
    const asset = await putThemeAsset(
      first,
      "wallpaper",
      "example.png",
      new Blob(["binary"], { type: "image/png" }),
    );
    const persisted = await getThemeAsset(first, asset.id, "wallpaper");
    expect(await persisted?.blob.text()).toBe("binary");
    expect(await getThemeAsset(second, asset.id, "wallpaper")).toBeUndefined();
    expect(
      await getThemeAsset(
        themeScope("https://other.example", JSON.parse(first)[1]),
        asset.id,
        "wallpaper",
      ),
    ).toBeUndefined();
    expect(await getThemeAsset(first, asset.id, "font")).toBeUndefined();
    await deleteThemeAsset(second, asset.id);
    expect(await getThemeAsset(first, asset.id, "wallpaper")).toBeDefined();
    await deleteThemeAsset(first, asset.id);
    expect(await listThemeAssets(first)).toEqual([]);
  });
  it("impede corrida de importações ultrapassar a quota na transação", async () => {
    const s = scope();
    const results = await Promise.allSettled(
      Array.from({ length: 18 }, (_, i) =>
        putThemeAsset(s, "font", `${i}.woff`, new Blob(["x"])),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
      assetLimits.count,
    );
    expect(await listThemeAssets(s)).toHaveLength(assetLimits.count);
  });
  it("limita tamanho individual antes de gravar", async () => {
    await expect(
      putThemeAsset(
        scope(),
        "font",
        "too-big",
        new Blob([new Uint8Array(assetLimits.font + 1)]),
      ),
    ).rejects.toThrow();
  });
  it("rejeita conteúdo ativo disfarçado pelo MIME e imagem enorme antes do decoder", async () => {
    const decoder = vi.fn();
    vi.stubGlobal("createImageBitmap", decoder);
    await expect(
      validateThemeFile(
        new Blob(["<svg onload='evil()'/>"], { type: "image/png" }),
        "wallpaper",
      ),
    ).rejects.toThrow();
    await expect(
      validateThemeFile(new Blob([png(100000, 100000)]), "wallpaper"),
    ).rejects.toThrow();
    expect(decoder).not.toHaveBeenCalled();
  });
  it("valida dimensões decodificadas e fecha o bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 100, height: 100, close }),
    );
    expect((await validateThemeFile(new Blob([png()]), "wallpaper")).type).toBe(
      "image/png",
    );
    expect(close).toHaveBeenCalled();
  });
  it("bloqueia WebP animado e dimensões VP8L acima do teto", () => {
    const bytes = new Uint8Array(30),
      view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"));
    view.setUint32(4, 22, true);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
    view.setUint32(16, 10, true);
    bytes[20] = 2;
    expect(() => inspectImage(bytes)).toThrow(/estática/);
    bytes.set(new TextEncoder().encode("VP8L"), 12);
    view.setUint32(16, 10, true);
    bytes[20] = 47;
    view.setUint32(21, 8191, true);
    expect(() => inspectImage(bytes)).toThrow(/4096/);
  });
  it("rejeita WebP com canvas pequeno e bitstream que declara quadro enorme antes de decodificar", async () => {
    const decoder = vi.fn();
    vi.stubGlobal("createImageBitmap", decoder);
    const bytes = new Uint8Array(44),
      view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"));
    view.setUint32(4, 36, true);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
    view.setUint32(16, 10, true);
    bytes.set(new TextEncoder().encode("VP8L"), 30);
    view.setUint32(34, 5, true);
    bytes[38] = 47;
    view.setUint32(39, 8191, true);
    await expect(
      validateThemeFile(new Blob([bytes]), "wallpaper"),
    ).rejects.toThrow();
    expect(decoder).not.toHaveBeenCalled();
  });
  it("rejeita fonte falsa, expansão excessiva e tabela fora do arquivo", () => {
    expect(() =>
      inspectFont(
        new TextEncoder().encode(
          "@font-face { src: url(https://example.com/font) }",
        ),
      ),
    ).toThrow();
    const bytes = new Uint8Array(48),
      view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("wOF2"));
    view.setUint32(8, 48);
    view.setUint16(12, 1);
    view.setUint32(16, 50_000_000);
    expect(() => inspectFont(bytes)).toThrow();
    view.setUint32(0, 0x00010000);
    view.setUint16(4, 1);
    view.setUint32(20, 99999);
    expect(() => inspectFont(bytes)).toThrow();
  });
});
