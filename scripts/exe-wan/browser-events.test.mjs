import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createBrowserEvents } from "./browser-events.mjs";
import { observe } from "./observe.mjs";

const origin = "https://harmony.go.altare.global";
const secret = "DO_NOT_RECORD_PRIVATE_VALUE";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ0b2tlbiI6InByaXZhdGUifQ.signature";
const send = (trace, method, params) =>
  trace.onEvent({ method: "Network." + method, params });
function websocket(trace, id = "socket", path = "/api/calls") {
  send(trace, "webSocketCreated", {
    requestId: id,
    url: origin.replace("https:", "wss:") + path + "?access_token=" + secret,
    initiator: { description: secret },
  });
  send(trace, "webSocketWillSendHandshakeRequest", {
    requestId: id,
    timestamp: 10,
    wallTime: 1000,
    request: { headers: { Authorization: secret } },
  });
  send(trace, "webSocketHandshakeResponseReceived", {
    requestId: id,
    timestamp: 10.5,
    response: {
      status: 101,
      statusText: secret,
      headers: { "Set-Cookie": secret },
    },
  });
}
function request(trace, id, path, at = 10) {
  send(trace, "requestWillBeSent", {
    requestId: id,
    timestamp: at,
    wallTime: 1000 + at - 10,
    request: {
      url: origin + path,
      headers: { Authorization: secret },
      postData: secret,
    },
  });
}
function response(trace, id, path, status, at = 11) {
  send(trace, "responseReceived", {
    requestId: id,
    timestamp: at,
    response: {
      url: origin + path,
      status,
      headers: { Cookie: secret },
      statusText: secret,
    },
  });
}
test("records socket lifecycle and clock correlation without query, headers, close text or raw request IDs", () => {
  const trace = createBrowserEvents({ now: () => 900_000 });
  websocket(trace, secret);
  send(trace, "webSocketFrameError", {
    requestId: secret,
    timestamp: 11,
    errorMessage: origin + "?token=" + secret,
  });
  send(trace, "webSocketClosed", { requestId: secret, timestamp: 12 });
  const snapshot = trace.snapshot();
  assert.deepEqual(
    snapshot.events.map((e) => e.event),
    ["ws_created", "ws_handshake", "ws_frame_error", "ws_closed"],
  );
  assert.deepEqual(
    snapshot.events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.equal(snapshot.events[0].at, null);
  assert.equal(snapshot.events[0].wall_utc, 900_000);
  assert.equal(snapshot.events[1].at, 10_500);
  assert.equal(snapshot.events[1].wall_utc, 1_000_500);
  assert.equal(snapshot.events[3].wall_utc, 1_002_000);
  assert.equal(snapshot.events[1].status, 101);
  assert.equal(snapshot.tracked_requests, 0);
  assert.ok(
    snapshot.events.every((e) => e.path === "/api/calls" && e.request === 1),
  );
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});
test("retains only allowlisted scalar frame type/t and code; ignores binary, signals, chat and oversized text", () => {
  const trace = createBrowserEvents();
  websocket(trace);
  for (const value of [
    { type: "auth", token: jwt },
    { type: "ping", data: secret },
    { type: "pong" },
    { type: "closed", code: "call_closed", reason: secret },
    { t: "error", code: "unauthorized", body: secret },
    { type: "session.revoked", token: jwt },
    { type: "auth_expiring" },
    { type: "error", code: secret },
    {
      type: "signal",
      data: { description: { sdp: secret }, candidate: secret },
    },
    { type: "message.new", content: secret },
    { type: secret },
  ])
    send(trace, "webSocketFrameReceived", {
      requestId: "socket",
      timestamp: 11,
      response: { opcode: 1, payloadData: JSON.stringify(value) },
    });
  for (const [opcode, payloadData] of [
    [2, jwt],
    [1, "{invalid"],
    [1, JSON.stringify({ type: "error", body: secret.repeat(2000) })],
  ])
    send(trace, "webSocketFrameSent", {
      requestId: "socket",
      timestamp: 12,
      response: { opcode, payloadData },
    });
  const frames = trace
    .snapshot()
    .events.filter((e) => e.event === "ws_received");
  assert.deepEqual(
    frames.map((e) => e.type ?? e.t),
    [
      "auth",
      "ping",
      "pong",
      "closed",
      "error",
      "session.revoked",
      "auth_expiring",
      "error",
    ],
  );
  assert.equal(frames[3].code, "call_closed");
  assert.equal(frames[4].code, "unauthorized");
  assert.equal(frames.at(-1).code, undefined);
  assert.ok(!trace.snapshot().events.some((e) => e.event === "ws_sent"));
  assert.ok(!JSON.stringify(trace.snapshot()).includes(secret));
  assert.ok(!JSON.stringify(trace.snapshot()).includes(jwt));
});
test("records failing API status and successful refresh, but never bodies or unrelated successful requests", () => {
  const trace = createBrowserEvents();
  const path =
    "/api/channels/01a1e271-d2a1-723e-91ed-86659d69d490/messages?token=" +
    secret;
  request(trace, "failed", path);
  response(trace, "failed", path, 401);
  request(trace, "refresh", "/api/auth/refresh");
  response(trace, "refresh", "/api/auth/refresh", 200, 12);
  request(trace, "good", "/api/guilds");
  response(trace, "good", "/api/guilds", 200);
  request(trace, "timeout", "/api/auth/refresh", 13);
  send(trace, "loadingFailed", {
    requestId: "timeout",
    timestamp: 28,
    errorText: secret,
    canceled: true,
  });
  const events = trace.snapshot().events;
  assert.deepEqual(
    events.map((e) => e.event),
    ["http_response", "http_response", "http_failed"],
  );
  assert.deepEqual(
    events.map((e) => e.path),
    ["/api/channels/:id/messages", "/api/auth/refresh", "/api/auth/refresh"],
  );
  assert.deepEqual(
    events.map((e) => e.status),
    [401, 200, undefined],
  );
  assert.equal(events.at(-1).duration_ms, 15_000);
  assert.equal(events.at(-1).canceled, true);
  assert.ok(!JSON.stringify(events).includes(secret));
});
test("rejects other origins, credentials, misleading subdomains, non-API HTTP and external redirects", () => {
  const trace = createBrowserEvents();
  for (const url of [
    "https://example.com/api/auth/refresh",
    origin + ".evil.test/api/auth/refresh",
    "http://harmony.go.altare.global/api/me",
    "https://user:pass@harmony.go.altare.global/api/me",
    origin + "/assets/app.js",
  ]) {
    send(trace, "requestWillBeSent", {
      requestId: "outside",
      timestamp: 10,
      request: { url },
    });
    send(trace, "responseReceived", {
      requestId: "outside",
      timestamp: 11,
      response: { url, status: 500 },
    });
    send(trace, "webSocketCreated", {
      requestId: "outside",
      url: url.replace("https:", "wss:"),
    });
    send(trace, "webSocketClosed", { requestId: "outside", timestamp: 12 });
  }
  request(trace, "redirect", "/api/me");
  send(trace, "requestWillBeSent", {
    requestId: "redirect",
    timestamp: 10,
    request: { url: "https://example.com/api/me" },
  });
  send(trace, "responseReceived", {
    requestId: "redirect",
    timestamp: 11,
    response: { url: "https://example.com/api/me", status: 500 },
  });
  assert.equal(trace.snapshot().events.length, 0);
  assert.equal(trace.snapshot().tracked_requests, 0);
});
test("bounds both retention and request context, ignores evicted IDs and returns detached snapshots", () => {
  const trace = createBrowserEvents();
  for (let i = 0; i < 300; i++)
    send(trace, "webSocketCreated", {
      requestId: "s" + i,
      url: "wss://harmony.go.altare.global/api/calls",
    });
  let snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 256);
  assert.equal(snapshot.tracked_requests, 256);
  assert.equal(snapshot.dropped_events, 44);
  assert.equal(snapshot.dropped_requests, 44);
  send(trace, "webSocketClosed", { requestId: "s0", timestamp: 12 });
  assert.equal(trace.snapshot().events.at(-1).event, "ws_created");
  snapshot.events[0].path = secret;
  snapshot.events.length = 0;
  assert.equal(trace.snapshot().events.length, 256);
  assert.equal(trace.snapshot().events[0].path, "/api/calls");
});
test("does not retain opaque path segments or free text in frame values", () => {
  const trace = createBrowserEvents();
  request(trace, "path", "/api/invites/" + jwt + "?token=" + secret);
  response(trace, "path", "/api/invites/" + jwt, 403);
  websocket(trace, "rtc", "/rtc");
  send(trace, "webSocketFrameReceived", {
    requestId: "rtc",
    timestamp: 11,
    response: {
      opcode: 1,
      payloadData: JSON.stringify({
        type: "error",
        code: "unauthorized",
        body: secret,
      }),
    },
  });
  assert.equal(trace.snapshot().events[0].path, "/api/invites/:value");
  assert.ok(!trace.snapshot().events.some((e) => e.event === "ws_received"));
  assert.ok(!JSON.stringify(trace.snapshot()).includes(secret));
  assert.ok(!JSON.stringify(trace.snapshot()).includes(jwt));
});
test("cleans completed HTTP contexts and preserves receive order without fabricating missing CDP timestamps", () => {
  const trace = createBrowserEvents({ now: () => 1234 });
  for (let i = 0; i < 300; i++) {
    request(trace, "r" + i, "/api/me");
    send(trace, "loadingFinished", { requestId: "r" + i, timestamp: 11 });
  }
  assert.equal(trace.snapshot().tracked_requests, 0);
  assert.equal(trace.snapshot().dropped_requests, 0);
  websocket(trace);
  send(trace, "webSocketFrameError", {
    requestId: "socket",
    timestamp: Number.NaN,
    errorMessage: secret,
  });
  send(trace, "webSocketClosed", { requestId: "socket", timestamp: 9 });
  const events = trace.snapshot().events;
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.equal(events[2].at, null);
  assert.equal(events[2].clock, "observed");
  assert.equal(events[2].wall_utc, 1234);
  assert.equal(events[3].at, 9000);
  assert.equal(events[3].clock, "cdp");
});

function observedPage() {
  let settings = {
    width: 1280,
    height: 720,
    frameRate: 30,
    resizeMode: "crop-and-scale",
  };
  const track = {
    id: "owned-source",
    kind: "video",
    readyState: "live",
    getSettings: () => ({ ...settings }),
  };
  const nodes = new Map();
  const context = {
    URL,
    location: { origin: "http://tauri.localhost" },
    performance: { now: () => 10 },
    document: { querySelectorAll: (selector) => nodes.get(selector) ?? [] },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getAudioTracks: () => [] }),
        getDisplayMedia: async () => ({
          getVideoTracks: () => [track],
          getAudioTracks: () => [],
        }),
      },
    },
    window: {
      __TAURI_INTERNALS__: {},
      RTCPeerConnection: class {},
      addEventListener() {},
    },
  };
  vm.runInNewContext(`(${observe.toString()})()`, context);
  return {
    qa: context.window.__exeWan,
    nodes,
    context,
    resize: () => {
      settings = { ...settings, width: 960, height: 540 };
    },
  };
}
test("samples visible header and bounded alerts without reading input values", async () => {
  const f = observedPage(),
    visible = (textContent) => ({ textContent, getClientRects: () => [{}] });
  f.nodes.set(".call-header", [visible("Canal · Em chamada · 8 na chamada")]);
  f.nodes.set(
    '[role="alert"]',
    Array.from({ length: 20 }, () =>
      visible(
        "Sessão encerrada " + jwt + " token=" + secret + " " + "x".repeat(1000),
      ),
    ),
  );
  f.nodes.set('input[autocomplete="username"]', [
    {
      get value() {
        throw Error("Input values must never be read");
      },
      getClientRects: () => [{}],
    },
  ]);
  const sample = await f.qa.sample();
  assert.equal(sample.ui.call_header, "Canal · Em chamada · 8 na chamada");
  assert.equal(sample.ui.login_visible, true);
  assert.equal(sample.ui.alerts.length, 8);
  assert.ok(sample.ui.alerts.every((text) => text.length <= 300));
  assert.ok(!JSON.stringify(sample.ui).includes(secret));
  assert.ok(!JSON.stringify(sample.ui).includes(jwt));
  f.nodes.set(".call-header", []);
  f.nodes.set('[role="alert"]', []);
  f.nodes.set('input[autocomplete="username"]', [
    { hidden: true, getClientRects: () => [] },
  ]);
  const absent = await f.qa.sample();
  assert.equal(absent.ui.call_header, null);
  assert.equal(absent.ui.login_visible, false);
});
test("preserves initial browser settings before the app changes live capture constraints", async () => {
  const f = observedPage();
  await f.context.navigator.mediaDevices.getDisplayMedia();
  f.resize();
  const capture = (await f.qa.sample()).captures[0];
  assert.equal(capture.initial_settings.width, 1280);
  assert.equal(capture.initial_settings.height, 720);
  assert.equal(capture.initial_settings.frameRate, 30);
  assert.equal(capture.initial_settings.resizeMode, "crop-and-scale");
  assert.equal(capture.track_settings.width, 960);
  assert.equal(capture.settings.height, 540);
});
