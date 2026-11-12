import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { fetchAttachmentBlob, previewKind } from "../lib/attachments";
import { formatBytes } from "../lib/messages";
import type { Attachment } from "../lib/types";
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
  const [error, setError] = useState("");
  const kind = previewKind(attachment.content_type);
  useEffect(() => {
    let active = true;
    let blobUrl = "";
    const controller = new AbortController();
    void (async () => {
      try {
        if (!kind)
          throw new Error(
            "Este tipo de arquivo está disponível apenas para download.",
          );
        const signed = await api<{ url: string }>(
          `/api/uploads/${attachment.id}/download`,
          { signal: controller.signal },
        );
        const blob = await fetchAttachmentBlob(
          signed.url,
          attachment.size,
          Math.min(maxBytes, 50 * 1024 * 1024),
          attachment.content_type,
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
  }, [attachment, kind, maxBytes]);
  return (
    <Modal title={attachment.name} onClose={onClose} wide>
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
      <div className="modal-actions">
        <small>
          {formatBytes(attachment.size)} · {attachment.content_type}
        </small>
        {url && (
          <a className="button" href={url} download={attachment.name}>
            <Download size={16} />
            Baixar arquivo
          </a>
        )}
        <button className="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}
