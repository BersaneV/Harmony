import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAttachmentBlob,
  previewKind,
  validateDerivative,
} from "./attachments";
afterEach(() => vi.unstubAllGlobals());
describe("mídia autorizada e limitada", () => {
  it("aceita somente JPEG limitado para miniatura e MP4 para faststart", () => {
    expect(
      validateDerivative(
        "thumbnail",
        { content_type: "image/jpeg", size: 1024 },
        8000000,
      ).contentType,
    ).toBe("image/jpeg");
    for (const content_type of ["image/svg+xml", "text/html", "image/png"])
      expect(() =>
        validateDerivative("thumbnail", { content_type, size: 1024 }, 8000000),
      ).toThrow();
    expect(() =>
      validateDerivative(
        "thumbnail",
        { content_type: "image/jpeg", size: 5 * 1024 * 1024 },
        8000000,
      ),
    ).toThrow();
    expect(() =>
      validateDerivative(
        "faststart",
        { content_type: "video/mp4", size: Infinity },
        8000000,
      ),
    ).toThrow();
    expect(() =>
      validateDerivative(
        "faststart",
        { content_type: "video/mp4", size: 2048 },
        1024,
      ),
    ).toThrow();
  });
  it("permite apenas os formatos passivos/reproduzíveis previstos", () => {
    expect(previewKind("image/gif")).toBe("image");
    expect(previewKind("video/webm")).toBe("video");
    expect(previewKind("audio/ogg")).toBe("audio");
    for (const type of [
      "image/svg+xml",
      "text/html",
      "application/pdf",
      "application/octet-stream",
    ])
      expect(previewKind(type)).toBeNull();
  });
  it("lê o corpo exato sem cookies e não segue redirects", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Length": "3" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const blob = await fetchAttachmentBlob(
      "https://storage.example/file",
      3,
      10,
      "image/png",
    );
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("image/png");
    expect(fetcher).toHaveBeenCalledWith(
      "https://storage.example/file",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
  });
  it("bloqueia antes do fetch um tamanho acima do orçamento", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      fetchAttachmentBlob("https://storage.example/file", 11, 10, "image/png"),
    ).rejects.toThrow("limite");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("interrompe um corpo que excede os metadados autorizados mesmo sem Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(5))),
    );
    await expect(
      fetchAttachmentBlob("https://storage.example/file", 4, 10, "image/png"),
    ).rejects.toThrow("maior que o arquivo autorizado");
  });
  it("não mostra como completo um arquivo truncado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(3))),
    );
    await expect(
      fetchAttachmentBlob("https://storage.example/file", 4, 10, "image/png"),
    ).rejects.toThrow("incompleto");
  });
});
