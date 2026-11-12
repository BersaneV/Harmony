// Independent regression review; imports the production implementation.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateTheme } from "../apps/desktop/src/lib/themeRuntime";
import { assetLimits, deleteThemeAsset, listThemeAssets, putThemeAsset, themeScope } from "../apps/desktop/src/lib/themeAssets";
import { normalizeTheme } from "../apps/desktop/src/lib/theme";

const scopes: string[] = [];
function scope() {
  const value = themeScope("https://review.example", crypto.randomUUID());
  scopes.push(value);
  return value;
}
function png() {
  const bytes = new Uint8Array(45);
  const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, 100);
  view.setUint32(20, 100);
  bytes.set(new TextEncoder().encode("IEND"), 37);
  return new Blob([bytes]);
}
function dom() {
  const properties = new Map<string, string>();
  const fonts = { add: vi.fn(), delete: vi.fn() };
  vi.stubGlobal("document", { fonts, documentElement: {
    dataset: {}, style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    },
  } });
  return { properties, fonts };
}
afterEach(async () => {
  if (typeof document !== "undefined") await activateTheme(normalizeTheme({}), null);
  for (const value of scopes.splice(0)) for (const asset of await listThemeAssets(value)) await deleteThemeAsset(value, asset.id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("independent appearance boundary review", () => {
  it("aggregate byte quota survives concurrent imports below item-count cap", async () => {
    const value = scope();
    const blob = new Blob([new Uint8Array(assetLimits.wallpaper)]);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => putThemeAsset(value, "wallpaper", "size-only fixture", blob)));
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(5);
    expect((await listThemeAssets(value)).reduce((sum, row) => sum + row.blob.size, 0)).toBe(assetLimits.total);
  });
  it("logout during an in-flight image decode cannot install a late blob URL", async () => {
    const { properties } = dom();
    const value = scope();
    const asset = await putThemeAsset(value, "wallpaper", "fixture", png());
    let resolve!: (value: { width: number; height: number; close: () => void }) => void;
    const decoder = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("createImageBitmap", decoder);
    const create = vi.spyOn(URL, "createObjectURL");
    const pending = activateTheme(normalizeTheme({ background: "image", wallpaperId: asset.id }), value);
    await vi.waitFor(() => expect(decoder).toHaveBeenCalledOnce());
    await activateTheme(normalizeTheme({}), null);
    const close = vi.fn();
    resolve({ width: 100, height: 100, close });
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(properties.has("--wallpaper-image")).toBe(false);
  });
  it("switching account while decode is pending preserves the new account theme", async () => {
    const { properties } = dom();
    const first = scope(), second = scope();
    const asset = await putThemeAsset(first, "wallpaper", "first account", png());
    let resolve!: (value: { width: number; height: number; close: () => void }) => void;
    const decoder = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("createImageBitmap", decoder);
    const pending = activateTheme(normalizeTheme({ background: "image", wallpaperId: asset.id }), first);
    await vi.waitFor(() => expect(decoder).toHaveBeenCalledOnce());
    const warnings = await activateTheme(normalizeTheme({ background: "image", wallpaperId: asset.id }), second);
    expect(warnings).toHaveLength(1);
    resolve({ width: 100, height: 100, close: vi.fn() });
    await pending;
    expect(properties.has("--wallpaper-image")).toBe(false);
  });
  it("deactivating a wallpaper revokes the object URL and clears CSS", async () => {
    const { properties } = dom();
    const value = scope();
    const asset = await putThemeAsset(value, "wallpaper", "fixture", png());
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 100, height: 100, close: vi.fn() }));
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    expect(await activateTheme(normalizeTheme({ background: "image", wallpaperId: asset.id }), value)).toEqual([]);
    expect(properties.get("--wallpaper-image")).toContain("blob:");
    await activateTheme(normalizeTheme({}), null);
    expect(revoke).toHaveBeenCalledOnce();
    expect(properties.has("--wallpaper-image")).toBe(false);
  });
});
