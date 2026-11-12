import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { notifyMessage } from "./desktop";
import { getSession, refreshSession, websocketUrl } from "./api";
export function useRealtime(userId: string) {
  const client = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const typingSent = useRef<Record<string, number>>({});
  const [typing, setTyping] = useState<Record<string, string[]>>({});
  const sendTyping = useCallback((channelId: string) => {
    if (!readyRef.current || socketRef.current?.readyState !== WebSocket.OPEN)
      return;
    const now = Date.now();
    if (now - (typingSent.current[channelId] || 0) < 2500) return;
    typingSent.current[channelId] = now;
    socketRef.current.send(
      JSON.stringify({ type: "typing", channel_id: channelId }),
    );
  }, []);
  const [state, setState] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    let refreshing = false;
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const invalidate = () => {
      void client.invalidateQueries({ queryKey: ["messages"] });
      void client.invalidateQueries({ queryKey: ["channels"] });
      void client.invalidateQueries({ queryKey: ["conversations"] });
      void client.invalidateQueries({ queryKey: ["guilds"] });
      void client.invalidateQueries({ queryKey: ["friends"] });
      void client.invalidateQueries({ queryKey: ["members"] });
      void client.invalidateQueries({ queryKey: ["roles"] });
      void client.invalidateQueries({ queryKey: ["channel-permissions"] });
      void client.invalidateQueries({ queryKey: ["search"] });
    };
    async function connect() {
      if (stopped) return;
      try {
        if (attempts > 0 && !refreshing) {
          refreshing = true;
          await refreshSession();
          refreshing = false;
        }
        if (stopped) return;
        socket = new WebSocket(websocketUrl());
        socketRef.current = socket;
        socket.onopen = () =>
          socket?.send(
            JSON.stringify({ type: "auth", token: getSession()?.access_token }),
          );
        socket.onmessage = (e) => {
          try {
            const event = JSON.parse(e.data);
            if (event.type === "ready") {
              attempts = 0;
              readyRef.current = true;
              setState("connected");
              invalidate();
            } else if (event.type === "typing") {
              if (
                typeof event.channel_id === "string" &&
                typeof event.user_id === "string" &&
                event.user_id !== userId
              ) {
                const cid = event.channel_id,
                  uid = event.user_id,
                  key = cid + ":" + uid;
                setTyping((current) => ({
                  ...current,
                  [cid]: [...new Set([...(current[cid] || []), uid])],
                }));
                const previous = typingTimers.get(key);
                if (previous) clearTimeout(previous);
                typingTimers.set(
                  key,
                  setTimeout(() => {
                    setTyping((current) => ({
                      ...current,
                      [cid]: (current[cid] || []).filter(
                        (value) => value !== uid,
                      ),
                    }));
                    typingTimers.delete(key);
                  }, 5000),
                );
              }
            } else if (
              event.channel_id ||
              event.type === "resync" ||
              event.type === "permissions.updated" ||
              event.type === "membership.updated" ||
              event.type === "friend.updated"
            ) {
              invalidate();
              if (
                event.type === "message.created" &&
                event.message?.author?.id !== userId
              )
                void notifyMessage(
                  "Harmony",
                  "Há uma nova mensagem nas suas conversas.",
                ).catch(() => {});
            }
          } catch {
            /* Malformed unsolicited events do not mutate state. */
          }
        };
        socket.onclose = () => {
          if (stopped) return;
          readyRef.current = false;
          setState("reconnecting");
          attempts++;
          timer = setTimeout(
            connect,
            Math.min(15000, 1000 * 2 ** Math.min(attempts, 4)) +
              Math.random() * 500,
          );
        };
        socket.onerror = () => socket?.close();
      } catch {
        refreshing = false;
        if (!stopped) {
          setState("reconnecting");
          attempts++;
          timer = setTimeout(connect, 15000);
        }
      }
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      typingTimers.forEach(clearTimeout);
      socketRef.current = null;
      readyRef.current = false;
      socket?.close();
    };
  }, [client, userId]);
  return { connection: state, typing, sendTyping };
}
