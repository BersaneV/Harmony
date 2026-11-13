import { lazy, Suspense, useEffect, useState } from "react";
import { api, ApiError, errorMessage } from "../lib/api";
import type { Channel } from "../lib/types";
import { ErrorBanner, Loading } from "./ui";

const DirectCall = lazy(() => import("./P2PCallPanel"));
const ServerCall = lazy(() => import("./LiveKitCallPanel"));
export interface CallPanelProps {
  channel: Channel;
  expanded: boolean;
  onClose: () => void;
  onExpand: () => void;
  canModerate: boolean;
}

export default function CallPanel(props: CallPanelProps) {
  const [transport, setTransport] = useState<"p2p" | "livekit" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setTransport(null);
    setError("");
    void api<{ transport: "p2p" | "livekit" }>(
      `/api/channels/${props.channel.id}/call`,
      { signal: controller.signal },
    )
      .then((config) => {
        if (!active) return;
        if (config.transport !== "p2p" && config.transport !== "livekit")
          throw new Error(
            "Modo de chamada não suportado. Atualize o aplicativo.",
          );
        setTransport(config.transport);
      })
      .catch(async (failure) => {
        // Versions before real calls only exposed LiveKit. Never fall back
        // around a permission denial or an error from a current server.
        if (active && failure instanceof ApiError && failure.status === 404) {
          try {
            const instance = await api<{
              version: string;
              media_transport?: string;
            }>("/api/instance", { signal: controller.signal });
            if (
              active &&
              !instance.media_transport &&
              /^0\.[123]\.\d+$/.test(instance.version)
            ) {
              setTransport("livekit");
              return;
            }
          } catch {
            /* Preserve the original error. */
          }
        }
        if (active) setError(errorMessage(failure));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [props.channel.id]);
  if (!transport)
    return (
      <section className="call-panel">
        {error ? (
          <ErrorBanner message={error} />
        ) : (
          <Loading label="Abrindo chamada…" />
        )}
        <button className="button" onClick={props.onClose}>
          Fechar chamada
        </button>
      </section>
    );
  return (
    <Suspense fallback={<Loading label="Abrindo chamada…" />}>
      {transport === "p2p" ? (
        <DirectCall {...props} />
      ) : (
        <ServerCall {...props} />
      )}
    </Suspense>
  );
}
