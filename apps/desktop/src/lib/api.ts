import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Session } from "./types";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function normalizeServer(input: string): string {
  const url = new URL(input.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error(
      "Use o endereço HTTPS do servidor, sem caminho ou credenciais. HTTP é permitido apenas no computador local.",
    );
  return url.origin;
}
function initialServer() {
  try {
    return normalizeServer(
      localStorage.getItem("harmony.server") || "http://127.0.0.1:8080",
    );
  } catch {
    return "http://127.0.0.1:8080";
  }
}
let server = initialServer();
let session: Session | null = null;
let sessionNotice = "";
let epoch = 0;
let refreshing: Promise<Session> | null = null;
let storageQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(value: Session | null) => void>();
export const getServer = () => server;
export const getSession = () => session;
export const getSessionNotice = () => sessionNotice;
export function onSession(callback: (value: Session | null) => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
function changedSession() {
  return new ApiError(
    409,
    "session_changed",
    "A sessão mudou. Tente novamente na conta atual.",
  );
}
function notify(next: Session | null) {
  session = next;
  listeners.forEach((listener) => listener(next));
}
async function persist(origin: string, token: string | null) {
  if (!isTauri()) return;
  const operation = storageQueue
    .catch(() => {})
    .then(() => invoke("store_refresh_token", { server: origin, token }));
  storageQueue = operation;
  await operation;
}
export async function saveSession(next: Session | null) {
  if (next) sessionNotice = "";
  const origin = server;
  const generation = ++epoch;
  refreshing = null;
  if (!next) notify(null);
  await persist(origin, next?.refresh_token ?? null);
  if (generation !== epoch || origin !== server) throw changedSession();
  if (next) notify(next);
}
export async function setServer(value: string) {
  const normalized = normalizeServer(value);
  if (normalized === server) return;
  sessionNotice = "";
  await saveSession(null);
  server = normalized;
  localStorage.setItem("harmony.server", server);
}
async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.code || "request_failed",
      body?.error?.message || `Não foi possível concluir (${response.status}).`,
    );
  return body as T;
}
export async function refreshSession(): Promise<Session> {
  if (refreshing) return refreshing;
  const origin = server;
  const generation = epoch;
  let attemptedRefresh = false;
  const flight = (async () => {
    const token =
      session?.refresh_token ||
      (isTauri()
        ? await invoke<string | null>("load_refresh_token", { server: origin })
        : null);
    if (generation !== epoch || origin !== server) throw changedSession();
    if (!token)
      throw new ApiError(
        401,
        "session_expired",
        "Entre na sua conta para continuar.",
      );
    attemptedRefresh = true;
    const next = await parseResponse<Session>(
      await fetch(origin + "/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }),
    );
    if (generation !== epoch || origin !== server) throw changedSession();
    await persist(origin, next.refresh_token);
    if (generation !== epoch || origin !== server) throw changedSession();
    notify(next);
    return next;
  })().catch(async (error) => {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      generation === epoch &&
      origin === server
    ) {
      sessionNotice = attemptedRefresh
        ? "Sua sessão expirou ou foi revogada. Entre novamente para continuar."
        : "";
      await saveSession(null);
    }
    throw error;
  });
  refreshing = flight;
  try {
    return await flight;
  } finally {
    if (refreshing === flight) refreshing = null;
  }
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    anonymous?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const origin = server;
  const generation = epoch;
  const request = () =>
    fetch(origin + path, {
      method: options.method || "GET",
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(!options.anonymous && session
          ? { Authorization: `Bearer ${session.access_token}` }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: options.signal || AbortSignal.timeout(20000),
    });
  let response = await request();
  if (generation !== epoch || origin !== server) throw changedSession();
  if (response.status === 401 && !options.anonymous && session) {
    await refreshSession();
    if (generation !== epoch || origin !== server) throw changedSession();
    response = await request();
  }
  if (generation !== epoch || origin !== server) throw changedSession();
  const value = await parseResponse<T>(response);
  if (generation !== epoch || origin !== server) throw changedSession();
  return value;
}
export async function logout() {
  sessionNotice = "";
  const origin = server;
  const token = session?.refresh_token;
  await saveSession(null);
  if (token)
    await parseResponse(
      await fetch(origin + "/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      }),
    );
}
export function websocketUrl() {
  return server.replace(/^http/, "ws") + "/api/ws";
}
export function errorMessage(error: unknown) {
  return error instanceof TypeError
    ? "Não foi possível conectar ao servidor. Confira o endereço e a conexão."
    : error instanceof Error
      ? error.message
      : "Ocorreu um erro inesperado.";
}
