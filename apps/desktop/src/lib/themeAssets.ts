export type AssetKind = "wallpaper" | "font";
export interface ThemeAsset {
  key: string;
  scope: string;
  id: string;
  kind: AssetKind;
  name: string;
  blob: Blob;
  createdAt: number;
}
export const assetLimits = {
  wallpaper: 8 * 1024 * 1024,
  font: 2 * 1024 * 1024,
  total: 40 * 1024 * 1024,
  count: 16,
};
export function themeScope(origin: string, userId: string) {
  return JSON.stringify([new URL(origin).origin, userId]);
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "O armazenamento local não está disponível neste dispositivo.",
        ),
      );
      return;
    }
    const request = indexedDB.open("harmony-local-appearance", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("assets", {
        keyPath: "key",
      });
      store.createIndex("scope", "scope");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Não foi possível abrir seus arquivos locais."));
    request.onblocked = () =>
      reject(new Error("Feche outras janelas do Harmony e tente novamente."));
  });
}
export async function listThemeAssets(scope: string): Promise<ThemeAsset[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("assets", "readonly"),
        request = tx.objectStore("assets").index("scope").getAll(scope);
      request.onsuccess = () => resolve(request.result as ThemeAsset[]);
      request.onerror = () =>
        reject(new Error("Não foi possível ler os arquivos locais."));
    });
  } finally {
    db.close();
  }
}
export async function getThemeAsset(
  scope: string,
  id: string,
  kind: AssetKind,
) {
  const items = await listThemeAssets(scope);
  return items.find((asset) => asset.id === id && asset.kind === kind);
}
export async function putThemeAsset(
  scope: string,
  kind: AssetKind,
  name: string,
  blob: Blob,
): Promise<ThemeAsset> {
  if (!blob.size || blob.size > assetLimits[kind])
    throw new Error("O arquivo excede o tamanho permitido.");
  const id = crypto.randomUUID();
  const asset: ThemeAsset = {
    key: JSON.stringify([scope, id]),
    scope,
    id,
    kind,
    name: name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80),
    blob,
    createdAt: Date.now(),
  };
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite"),
        store = tx.objectStore("assets");
      let reason =
        "Não foi possível salvar. Verifique o espaço disponível neste dispositivo.";
      const request = store.index("scope").getAll(scope);
      request.onsuccess = () => {
        const items = request.result as ThemeAsset[];
        if (
          items.length >= assetLimits.count ||
          items.reduce((sum, row) => sum + row.blob.size, 0) + blob.size >
            assetLimits.total
        ) {
          reason =
            "Limite local atingido: 16 arquivos e 40 MiB por conta/servidor. Remova um arquivo antes de importar outro.";
          tx.abort();
          return;
        }
        store.add(asset);
      };
      tx.oncomplete = () => resolve(asset);
      tx.onabort = tx.onerror = () => reject(new Error(reason));
    });
  } finally {
    db.close();
  }
}
export async function deleteThemeAsset(scope: string, id: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite");
      tx.objectStore("assets").delete(JSON.stringify([scope, id]));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(new Error("Não foi possível remover o arquivo local."));
    });
  } finally {
    db.close();
  }
}
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.slice(offset, offset + length));
export function inspectImage(bytes: Uint8Array): {
  type: string;
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let type = "",
    width = 0,
    height = 0;
  if (
    bytes.length >= 24 &&
    bytes
      .slice(0, 8)
      .every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]) &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    type = "image/png";
    width = view.getUint32(16);
    height = view.getUint32(20);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset),
        chunk = ascii(bytes, offset + 4, 4);
      if (chunk === "acTL")
        throw new Error("Use uma imagem estática, sem animação.");
      if (length > bytes.length - offset - 12)
        throw new Error("Imagem PNG incompleta.");
      offset += length + 12;
    }
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    type = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      if (marker === 255) {
        offset++;
        continue;
      }
      if (marker === 217 || marker === 218) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(offset + 5);
        width = view.getUint16(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else if (
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    type = "image/webp";
    if (view.getUint32(4, true) + 8 !== bytes.length)
      throw new Error("Imagem WebP incompleta.");
    let offset = 12,
      canvasWidth = 0,
      canvasHeight = 0,
      foundFrame = false;
    while (offset + 8 <= bytes.length) {
      const format = ascii(bytes, offset, 4),
        length = view.getUint32(offset + 4, true),
        payload = offset + 8;
      if (length > bytes.length - payload)
        throw new Error("Chunk WebP incompleto.");
      if (format === "ANIM" || format === "ANMF")
        throw new Error("Use uma imagem estática, sem animação.");
      if (format === "VP8X") {
        if (offset !== 12 || length !== 10 || bytes[payload] & 2)
          throw new Error("Use uma imagem WebP estática válida.");
        canvasWidth =
          1 +
          bytes[payload + 4] +
          bytes[payload + 5] * 256 +
          bytes[payload + 6] * 65536;
        canvasHeight =
          1 +
          bytes[payload + 7] +
          bytes[payload + 8] * 256 +
          bytes[payload + 9] * 65536;
        if (
          canvasWidth > 4096 ||
          canvasHeight > 4096 ||
          canvasWidth * canvasHeight > 16_000_000
        )
          throw new Error(
            "A imagem deve ter até 4096 pixels por lado e 16 megapixels.",
          );
      } else if (format === "VP8 " || format === "VP8L") {
        if (foundFrame)
          throw new Error("A imagem WebP deve conter um único quadro.");
        foundFrame = true;
        if (
          format === "VP8 " &&
          length >= 10 &&
          bytes[payload + 3] === 157 &&
          bytes[payload + 4] === 1 &&
          bytes[payload + 5] === 42
        ) {
          width = view.getUint16(payload + 6, true) & 0x3fff;
          height = view.getUint16(payload + 8, true) & 0x3fff;
        } else if (format === "VP8L" && length >= 5 && bytes[payload] === 47) {
          const bits = view.getUint32(payload + 1, true);
          width = 1 + (bits & 0x3fff);
          height = 1 + ((bits >>> 14) & 0x3fff);
        }
      }
      offset = payload + length + (length % 2);
    }
    if (
      offset !== bytes.length ||
      !foundFrame ||
      (canvasWidth && (canvasWidth !== width || canvasHeight !== height))
    )
      throw new Error("Dimensões ou estrutura WebP inconsistentes.");
  }
  if (!type || !width || !height)
    throw new Error(
      "Use uma imagem PNG, JPEG ou WebP estática válida. SVG e HTML não são aceitos.",
    );
  if (width > 4096 || height > 4096 || width * height > 16_000_000)
    throw new Error(
      "A imagem deve ter até 4096 pixels por lado e 16 megapixels.",
    );
  return { type, width, height };
}
export function inspectFont(bytes: Uint8Array) {
  if (bytes.length < 32) throw new Error("Fonte incompleta.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tag = ascii(bytes, 0, 4);
  if (tag === "wOFF" || tag === "wOF2") {
    const header = tag === "wOFF" ? 44 : 48;
    if (
      bytes.length < header ||
      view.getUint32(8) !== bytes.length ||
      view.getUint16(12) < 1 ||
      view.getUint16(12) > 256 ||
      view.getUint32(16) > 20 * 1024 * 1024
    )
      throw new Error("Fonte compactada inválida ou grande demais.");
    return tag === "wOFF" ? "font/woff" : "font/woff2";
  }
  if (tag === "OTTO" || view.getUint32(0) === 0x00010000) {
    const tables = view.getUint16(4);
    if (tables < 1 || tables > 256 || 12 + tables * 16 > bytes.length)
      throw new Error("Tabela de fonte inválida.");
    for (let i = 0; i < tables; i++) {
      const offset = view.getUint32(12 + i * 16 + 8),
        length = view.getUint32(12 + i * 16 + 12);
      if (offset > bytes.length || length > bytes.length - offset)
        throw new Error("Tabela de fonte incompleta.");
    }
    return tag === "OTTO" ? "font/otf" : "font/ttf";
  }
  throw new Error(
    "Use uma fonte WOFF2, WOFF, TTF ou OTF. CSS e coleções de fontes não são aceitos.",
  );
}
export async function validateThemeFile(
  file: Blob,
  kind: AssetKind,
): Promise<Blob> {
  if (!file.size || file.size > assetLimits[kind])
    throw new Error(
      kind === "font"
        ? "A fonte deve ter até 2 MiB."
        : "A imagem deve ter até 8 MiB.",
    );
  const buffer = await file.arrayBuffer(),
    bytes = new Uint8Array(buffer);
  if (kind === "wallpaper") {
    const image = inspectImage(bytes);
    const blob = new Blob([buffer], { type: image.type });
    const decoded = await createImageBitmap(blob);
    try {
      if (
        (decoded.width !== image.width || decoded.height !== image.height) &&
        (decoded.width !== image.height || decoded.height !== image.width)
      )
        throw new Error("As dimensões da imagem são inconsistentes.");
    } finally {
      decoded.close();
    }
    return blob;
  }
  const type = inspectFont(bytes);
  const font = new FontFace("HarmonyValidation", buffer);
  await font.load();
  return new Blob([buffer], { type });
}
