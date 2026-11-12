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
