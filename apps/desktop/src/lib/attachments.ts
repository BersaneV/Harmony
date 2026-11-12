export function previewKind(
  contentType: string,
): "image" | "video" | "audio" | null {
  if (
    [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ].includes(contentType)
  )
    return "image";
  if (["video/mp4", "video/webm"].includes(contentType)) return "video";
  if (
    ["audio/ogg", "audio/mpeg", "audio/wav", "audio/mp4"].includes(contentType)
  )
    return "audio";
  return null;
}
export async function fetchAttachmentBlob(
  url: string,
  expectedSize: number,
  maxBytes: number,
  contentType: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > maxBytes
  )
    throw new Error(
      "O arquivo excede o limite de visualização neste dispositivo. Use o download.",
    );
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    signal: signal || AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body)
    throw new Error("Não foi possível obter o arquivo autorizado.");
  const stated = response.headers.get("Content-Length");
  if (stated && Number(stated) > maxBytes) {
    await response.body.cancel();
    throw new Error("O arquivo excedeu o tamanho permitido.");
  }
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes || size > expectedSize) {
        await reader.cancel();
        throw new Error("O tamanho recebido é maior que o arquivo autorizado.");
      }
      parts.push(new Uint8Array(item.value).buffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedSize)
    throw new Error("O arquivo recebido está incompleto. Tente novamente.");
  return new Blob(parts, { type: contentType });
}
export const mediaStatusLabel = {
  queued: "Na fila de processamento",
  processing: "Preparando prévia",
  ready: "Prévia processada",
  unsupported: "Original disponível; sem prévia processada",
  failed: "Falha na prévia; original disponível",
} as const;
export function validateDerivative(
  kind: "thumbnail" | "faststart",
  value: { content_type: string; size: number },
  maxBytes: number,
) {
  const type = kind === "thumbnail" ? "image/jpeg" : "video/mp4";
  const limit =
    kind === "thumbnail"
      ? Math.min(maxBytes, 4 * 1024 * 1024)
      : Math.min(maxBytes, 50 * 1024 * 1024);
  if (
    value.content_type !== type ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > limit
  )
    throw new Error("O derivado recebido tem formato ou tamanho inválido.");
  return { contentType: type, maxBytes: limit };
}
