import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import {
  fetchAttachmentBlob,
  mediaStatusLabel,
  previewKind,
  validateDerivative,
} from "../lib/attachments";
import { formatBytes } from "../lib/messages";
import type { Attachment, AttachmentMedia } from "../lib/types";
import { ErrorBanner, Loading, Modal } from "./ui";
export default function AttachmentViewer({
  attachment,
  maxBytes,
  onClose,
}: {
  attachment: Attachment;
  maxBytes: number;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [poster, setPoster] = useState("");
  const [error, setError] = useState("");
  const [posterError, setPosterError] = useState("");
  const [source, setSource] = useState<"original" | "faststart">("original");
  const kind = previewKind(attachment.content_type);
  const media = useQuery({
    queryKey: ["attachment-media", attachment.id],
    queryFn: () => api<AttachmentMedia>(`/api/uploads/${attachment.id}/media`),
    retry: false,
    refetchInterval: (query) =>
      ["queued", "processing"].includes(query.state.data?.status || "")
        ? 2500
        : false,
    staleTime: 15000,
  });
  const thumb = media.data?.derivatives.find(
    (item) => item.kind === "thumbnail",
  );
  const optimized = media.data?.derivatives.find(
    (item) => item.kind === "faststart",
  );
  useEffect(() => {
    let active = true,
      blobUrl = "";
    const controller = new AbortController();
    setError("");
    setUrl("");
    void (async () => {
      try {
        if (!kind)
          throw new Error(
            "Este tipo de arquivo está disponível apenas para download.",
          );
        const signed = await api<{
          url: string;
          content_type?: string;
          size?: number;
        }>(
          `/api/uploads/${attachment.id}/${source === "original" ? "download" : "derivatives/faststart"}`,
          { signal: controller.signal },
        );
        const validated =
          source === "faststart"
            ? validateDerivative(
                "faststart",
                {
                  content_type: signed.content_type || "",
                  size: signed.size || 0,
                },
                maxBytes,
              )
            : null;
        const blob = await fetchAttachmentBlob(
          signed.url,
          source === "original" ? attachment.size : signed.size!,
          validated?.maxBytes ?? Math.min(maxBytes, 50 * 1024 * 1024),
          validated?.contentType ?? attachment.content_type,
          controller.signal,
        );
        if (!active) return;
        blobUrl = URL.createObjectURL(blob);
        setUrl(blobUrl);
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [attachment, kind, maxBytes, source]);
  useEffect(() => {
    if (!thumb || media.data?.status !== "ready") return;
    let active = true,
      blobUrl = "";
    const controller = new AbortController();
    setPoster("");
    setPosterError("");
    void (async () => {
      try {
        const signed = await api<{
          url: string;
          content_type: string;
          size: number;
        }>(`/api/uploads/${attachment.id}/derivatives/thumbnail`, {
          signal: controller.signal,
        });
        const validated = validateDerivative("thumbnail", signed, maxBytes);
        const blob = await fetchAttachmentBlob(
          signed.url,
          signed.size,
          validated.maxBytes,
          validated.contentType,
          controller.signal,
        );
        if (!active) return;
        blobUrl = URL.createObjectURL(blob);
        setPoster(blobUrl);
      } catch (e) {
        if (active) setPosterError(errorMessage(e));
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [attachment.id, thumb?.size, media.data?.status, maxBytes]);
  const metadata = media.data?.metadata;
  return (
    <Modal title={attachment.name} onClose={onClose} wide>
      <div className="attachment-processing" role="status">
        <span>
          {media.data
            ? mediaStatusLabel[media.data.status]
            : media.isPending
              ? "Consultando processamento…"
              : "Status de processamento indisponível"}
        </span>
        {metadata && (
          <small>
            {metadata.width && metadata.height
              ? `${metadata.width} × ${metadata.height} px`
              : ""}
            {typeof metadata.duration_seconds === "number" &&
            Number.isFinite(metadata.duration_seconds)
              ? ` · ${metadata.duration_seconds.toFixed(1)} s`
              : ""}
            {metadata.has_audio ? " · com áudio" : ""}
          </small>
        )}
        {media.isError && (
          <button className="text-button" onClick={() => void media.refetch()}>
            Consultar novamente
          </button>
        )}
      </div>
      {media.isError && <ErrorBanner message={errorMessage(media.error)} />}
      {posterError && <ErrorBanner message={`Miniatura: ${posterError}`} />}
      {poster && kind === "image" && (
        <details className="processed-thumbnail">
          <summary>Miniatura processada</summary>
          <img src={poster} alt={`Miniatura de ${attachment.name}`} />
        </details>
      )}
      <div className="attachment-viewer">
        {error ? (
          <ErrorBanner message={error} />
        ) : !url ? (
          <Loading label="Carregando arquivo autorizado…" />
        ) : kind === "image" ? (
          <img src={url} alt={attachment.name} />
        ) : kind === "video" ? (
          <video
            src={url}
            poster={poster || undefined}
            controls
            playsInline
            preload="metadata"
            onError={() =>
              setError(
                "O codec deste vídeo não é reproduzido por este dispositivo. Use o download.",
              )
            }
          />
        ) : (
          <audio
            src={url}
            controls
            preload="metadata"
            onError={() =>
              setError(
                "O formato de áudio não é reproduzido por este dispositivo. Use o download.",
              )
            }
          />
        )}
      </div>
      {optimized && kind === "video" && (
        <div className="appearance-actions">
          <button
            className="button"
            onClick={() =>
              setSource(source === "original" ? "faststart" : "original")
            }
          >
            {source === "original"
              ? "Reproduzir versão otimizada"
              : "Voltar ao original"}
          </button>
          <small>
            {source === "faststart"
              ? "Versão MP4 preparada para reprodução. O original foi preservado."
              : "A versão otimizada reorganiza o MP4 sem alterar a qualidade."}
          </small>
        </div>
      )}
      <div className="modal-actions">
        <small>
          {formatBytes(attachment.size)} · {attachment.content_type}
        </small>
        {url && (
          <a
            className="button"
            href={url}
            download={
              source === "original"
                ? attachment.name
                : `otimizado-${attachment.name}`
            }
          >
            <Download size={16} />
            {source === "original"
              ? "Baixar arquivo"
              : "Baixar versão otimizada"}
          </a>
        )}
        <button className="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}
