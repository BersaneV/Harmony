// Passive CDP metadata for the owned EXE fixture. Never retain CDP payloads.
// Network timestamps are monotonic seconds, distinct from page performance.now.
const limit = 256;
const words = new Set(
  "api auth login logout register refresh reset me instance guilds members channels invites accept roles permissions users search friends conversations messages reactions read ws p2p p2p-probes call calls media-token screen-token moderate uploads files complete download media derivatives admin audit stats internal media-admit rtc v1 validate original thumbnail preview waveform".split(
    " ",
  ),
);
const framePaths = new Set(["/api/calls", "/api/ws", "/api/p2p/ws"]);
const types = new Set([
  "auth",
  "reauth",
  "authenticated",
  "ready",
  "ping",
  "pong",
  "closed",
  "error",
  "revoked",
  "session",
  "session.revoked",
  "session.expired",
  "logout",
  "auth_expiring",
  "auth.expiring",
]);
const codes = new Set([
  "call_closed",
  "unauthorized",
  "forbidden",
  "invalid_input",
  "invalid_request",
  "not_found",
  "conflict",
  "unavailable",
  "rate_limited",
  "internal",
  "session_revoked",
  "session_expired",
  "auth_expired",
  "token_expired",
  "reauth_required",
  "auth_timeout",
  "slow_consumer",
]);
const seconds = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER / 1000
    ? value * 1000
    : null;
const status = (value) =>
  Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
function pathFor(value, websocket = false) {
  if (typeof value !== "string" || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== (websocket ? "wss:" : "https:") ||
      url.host !== "harmony.go.altare.global" ||
      url.username ||
      url.password
    )
      return;
    if (
      !/^\/api(?:\/|$)/.test(url.pathname) &&
      !(websocket && /^\/rtc(?:\/|$)/.test(url.pathname))
    )
      return;
    const segments = url.pathname.split("/");
    if (segments.length > 16 || url.pathname.length > 1024) return;
    // Route words are fixed; resource IDs and arbitrary path values are never
    // copied. This also prevents credentials embedded in a URL path leaking.
    return segments
      .map((segment) =>
        !segment || words.has(segment)
          ? segment
          : /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(segment)
            ? ":id"
            : ":value",
      )
      .join("/");
  } catch {
    return;
  }
}
export function createBrowserEvents({ now = Date.now } = {}) {
  const events = [],
    requests = new Map();
  let serial = 0,
    requestSerial = 0,
    droppedEvents = 0,
    droppedRequests = 0,
    wallOffset = null;
  function timing(params) {
    const at = seconds(params.timestamp),
      wall = seconds(params.wallTime);
    if (at !== null && wall !== null) wallOffset = wall - at;
    return {
      at,
      wall_utc:
        wall ?? (at !== null && wallOffset !== null ? at + wallOffset : now()),
      clock:
        wall !== null || (at !== null && wallOffset !== null)
          ? "cdp"
          : "observed",
    };
  }
  function push(event, row, params, extra = {}) {
    events.push({
      seq: ++serial,
      event,
      request: row.id,
      path: row.path,
      ...timing(params),
      ...extra,
    });
    if (events.length > limit) {
      events.shift();
      droppedEvents++;
    }
  }
  function remember(key, path, params) {
    requests.delete(key);
    if (!path) return;
    const row = { id: ++requestSerial, path, at: seconds(params.timestamp) };
    requests.set(key, row);
    if (requests.size > limit) {
      requests.delete(requests.keys().next().value);
      droppedRequests++;
    }
    return row;
  }
  function onEvent(event) {
    const p = event?.params;
    if (!p || typeof p.requestId !== "string" || p.requestId.length > 256)
      return;
    const wsKey = "ws:" + p.requestId,
      httpKey = "http:" + p.requestId;
    if (event.method === "Network.webSocketCreated") {
      const row = remember(wsKey, pathFor(p.url, true), p);
      if (row) push("ws_created", row, p);
      return;
    }
    if (event.method === "Network.requestWillBeSent") {
      const path = pathFor(p.request?.url);
      remember(httpKey, path, p);
      if (path) timing(p);
      return;
    }
    const socket = requests.get(wsKey),
      http = requests.get(httpKey);
    if (event.method === "Network.webSocketWillSendHandshakeRequest") {
      if (socket) timing(p);
    } else if (event.method === "Network.webSocketHandshakeResponseReceived") {
      const code = status(p.response?.status);
      if (socket && code !== null)
        push("ws_handshake", socket, p, { status: code });
    } else if (event.method === "Network.webSocketClosed") {
      if (socket) push("ws_closed", socket, p);
      requests.delete(wsKey);
    } else if (event.method === "Network.webSocketFrameError") {
      if (socket) push("ws_frame_error", socket, p);
    } else if (
      event.method === "Network.webSocketFrameReceived" ||
      event.method === "Network.webSocketFrameSent"
    ) {
      if (
        !socket ||
        !framePaths.has(socket.path) ||
        p.response?.opcode !== 1 ||
        typeof p.response.payloadData !== "string" ||
        p.response.payloadData.length > 16_384
      )
        return;
      let value;
      try {
        value = JSON.parse(p.response.payloadData);
      } catch {
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const fields = {};
      if (types.has(value.type)) fields.type = value.type;
      if (types.has(value.t)) fields.t = value.t;
      if (!fields.type && !fields.t) return;
      if (codes.has(value.code)) fields.code = value.code;
      push(
        event.method === "Network.webSocketFrameSent"
          ? "ws_sent"
          : "ws_received",
        socket,
        p,
        fields,
      );
    } else if (event.method === "Network.responseReceived") {
      const code = status(p.response?.status);
      if (
        http &&
        code !== null &&
        pathFor(p.response?.url) === http.path &&
        (code >= 400 ||
          (http.path === "/api/auth/refresh" && code >= 200 && code < 300))
      )
        push("http_response", http, p, {
          status: code,
          ...(http.at !== null &&
          seconds(p.timestamp) !== null &&
          seconds(p.timestamp) >= http.at
            ? { duration_ms: seconds(p.timestamp) - http.at }
            : {}),
        });
    } else if (event.method === "Network.loadingFailed") {
      if (http)
        push("http_failed", http, p, {
          ...(typeof p.canceled === "boolean" ? { canceled: p.canceled } : {}),
          ...(http.at !== null &&
          seconds(p.timestamp) !== null &&
          seconds(p.timestamp) >= http.at
            ? { duration_ms: seconds(p.timestamp) - http.at }
            : {}),
        });
      requests.delete(httpKey);
    } else if (event.method === "Network.loadingFinished")
      requests.delete(httpKey);
  }
  return {
    onEvent,
    snapshot: () => ({
      events: events.map((event) => ({ ...event })),
      tracked_requests: requests.size,
      dropped_events: droppedEvents,
      dropped_requests: droppedRequests,
    }),
  };
}
