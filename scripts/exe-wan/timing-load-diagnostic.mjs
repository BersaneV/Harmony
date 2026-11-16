// Isolated QA on eight immutable public048 EXEs. Only the existing temporary
// VideoFrame/writer instrumentation changes API dispatch, on the publisher.
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { session } from "./session.mjs";
import { requestedProfile } from "./profiles.mjs";
import { guard, cohort, identity, origin, mask } from "./lab.mjs";
import { rotatingToken } from "./auth.mjs";
import { assertOwnedCapture } from "./capture-ui.mjs";
import { assertCallRoute } from "./fixture-contract.mjs";
import { createClientDiagnostics } from "./client-diagnostics.mjs";
import { summarizeHostCpu } from "./host-cpu.mjs";
import {
  createAckTimingObserver,
  measureTimingPhases,
} from "./timing-diagnostic.mjs";

export const timingLoadPhases = [
  "control_before",
  "instrumented",
  "control_after",
];
const tag = "native-timing-load-v1";
const failure = (code) => Object.assign(new Error(code), { code });
const check = (condition, code) => {
  if (!condition) throw failure(code);
};
const finite = (object, keys) =>
  Object.fromEntries(
    keys.filter((k) => Number.isFinite(object?.[k])).map((k) => [k, object[k]]),
  );

export function assertLoadTimingContext(env, platform, profile, index) {
  check(platform === "win32", "WINDOWS_REQUIRED");
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    HARMONY_TIMING_LOAD_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.8",
  }))
    check(env[key] === value, "CONTEXT_REFUSED");
  check(Number.isInteger(index) && index >= 0 && index < 8, "CLIENT_REFUSED");
  check(
    profile.fps === 60 &&
      ((profile.id === "1080p60" &&
        profile.width === 1920 &&
        profile.height === 1080 &&
        profile.bitrate_mbps === 8) ||
        (profile.id === "1440p60" &&
          profile.width === 2560 &&
          profile.height === 1440 &&
          profile.bitrate_mbps === 16)),
    "PROFILE_REFUSED",
  );
  check(env.HARMONY_ENCODER_PROBE !== "true", "OTHER_PROBE_REFUSED");
}

/** One deadline includes awaits and connection readiness; late results cannot
 * establish readiness. Cleanup/restoration intentionally uses separate bounds. */
export function createBudget({
  now = () => performance.now(),
  duration = 600000,
} = {}) {
  check(duration > 0 && duration <= 600000, "BUDGET_REFUSED");
  const end = now() + duration,
    controller = new AbortController();
  const remaining = () => Math.max(0, end - now());
  const run = async (operation, maximum = remaining()) => {
    const operationEnd = Math.min(end, now() + maximum),
      ms = operationEnd - now();
    check(!controller.signal.aborted && ms >= 1, "DEADLINE");
    let timer, cancel;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          check(
            !controller.signal.aborted && operationEnd - now() >= 1,
            "DEADLINE",
          );
          return operation(operationEnd - now());
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure("DEADLINE")), ms);
          cancel = () => reject(failure("DEADLINE"));
          controller.signal.addEventListener("abort", cancel, { once: true });
        }),
      ]);
      check(!controller.signal.aborted && now() <= operationEnd, "DEADLINE");
      return value;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
    }
  };
  const pause = (ms, signal) =>
    run(
      () =>
        new Promise((resolve) => {
          let timer;
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          if (signal?.aborted) return finish();
          timer = setTimeout(finish, Math.min(ms, remaining()));
          signal?.addEventListener("abort", finish, { once: true });
        }),
      Math.min(ms + 1000, remaining()),
    );
  return { now, remaining, run, pause, close: () => controller.abort() };
}

/** Acquisition can finish after Promise.race times out. Keep ownership until
 * the caller accepts it, or close a late session instead of leaking its EXE. */
export async function acquireSession(budget, open, maximum = 120000) {
  let acquired,
    accepted = false,
    abandoned = false,
    closed = false;
  const close = () => {
    if (!acquired || closed) return;
    closed = true;
    try {
      Promise.resolve(acquired.close()).catch(() => {});
    } catch {}
  };
  try {
    const value = await budget.run(async (ms) => {
      acquired = await open(ms);
      if (abandoned) close();
      return acquired;
    }, maximum);
    accepted = true;
    return value;
  } finally {
    if (!accepted) {
      abandoned = true;
      close();
    }
  }
}

/** Retry only a definite HTTP 429 response. Network errors, parsing failures and
 * other statuses may have ambiguous side effects and are never retried. */
export function createDiagnosticHttp({ budget, fetch = globalThis.fetch }) {
  const stats = {
    attempts: 0,
    rate_limited_responses: 0,
    rate_limited_requests: 0,
    recovered_requests: 0,
    backoff_count: 0,
    backoff_elapsed_ms: 0,
    exhausted: 0,
    status_counts: {},
    backoffs: [],
  };
  const request = async (
    path,
    token,
    body,
    { maximum = 60000, kind = "bootstrap", signal } = {},
  ) => {
    check(path.startsWith("/") && !path.includes("://"), "HTTP_PATH_REFUSED");
    check(
      ["bootstrap", "auth", "control_read", "control_write"].includes(kind),
      "HTTP_KIND_REFUSED",
    );
    const end = budget.now() + Math.min(maximum, budget.remaining()),
      encoded = body === undefined ? undefined : JSON.stringify(body),
      access =
        typeof token === "function"
          ? await budget.run(() => token(), end - budget.now())
          : token;
    let retry = 0,
      limited = false;
    for (;;) {
      check(!signal?.aborted, "DEADLINE");
      const remaining = end - budget.now();
      check(remaining > 0, "DEADLINE");
      const result = await budget.run(
        async (ms) => {
          stats.attempts++;
          const response = await fetch(origin + "/api" + path, {
            method: encoded === undefined ? "GET" : "POST",
            headers: {
              ...(access ? { Authorization: "Bearer " + access } : {}),
              ...(encoded === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            body: encoded,
            signal: AbortSignal.any([
              AbortSignal.timeout(Math.max(1, Math.floor(ms))),
              ...(signal ? [signal] : []),
            ]),
          });
          const status = response.status;
          check(
            Number.isInteger(status) && status >= 100 && status <= 599,
            "HTTP_STATUS_INVALID",
          );
          stats.status_counts[status] = (stats.status_counts[status] || 0) + 1;
          if (status === 429) {
            stats.rate_limited_responses++;
            if (!limited) {
              limited = true;
              stats.rate_limited_requests++;
            }
            await response.body?.cancel().catch(() => {});
            return { limited: true };
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw failure("HTTP_FAILED");
          }
          return { value: status === 204 ? null : await response.json() };
        },
        Math.min(20000, remaining),
      );
      if (!result.limited) {
        if (limited) stats.recovered_requests++;
        return result.value;
      }
      const delay = Math.min(5000 * 2 ** retry, 20000);
      if (retry >= 5 || end - budget.now() <= delay) {
        stats.exhausted++;
        throw failure("HTTP_RATE_LIMITED");
      }
      retry++;
      stats.backoff_count++;
      const started = budget.now(),
        row = { kind, attempt: retry, requested_ms: delay, elapsed_ms: 0 };
      stats.backoffs.push(row);
      try {
        await budget.pause(delay, signal);
      } finally {
        row.elapsed_ms = budget.now() - started;
        stats.backoff_elapsed_ms += row.elapsed_ms;
      }
      check(budget.now() < end, "HTTP_RATE_LIMITED");
      check(!signal?.aborted, "DEADLINE");
    }
  };
  return {
    request,
    snapshot: () => ({
      ...structuredClone(stats),
      classification:
        stats.exhausted ||
        stats.rate_limited_requests > stats.recovered_requests
          ? "NOT_RUN"
          : stats.rate_limited_responses
            ? "RECOVERED"
            : "NO_RATE_LIMIT",
    }),
  };
}
export function createControlTransport({ http, token, channel, cohortKey }) {
  const endpoint = `/channels/${encodeURIComponent(channel)}/messages`;
  return {
    send: (message, { maximum = 90000 } = {}) => {
      // Allocate once per logical operation, outside the HTTP 429 retry loop.
      const body = {
        client_nonce: randomUUID(),
        content: JSON.stringify({
          lab: "exe-wan",
          cohort: cohortKey,
          ...message,
        }),
      };
      return http.request(endpoint, token, body, {
        maximum,
        kind: "control_write",
      });
    },
    list: async (maximum = 90000, signal) => {
      const value = await http.request(
        endpoint + "?limit=100",
        token,
        undefined,
        { maximum, kind: "control_read", signal },
      );
      return value.items.flatMap((message) => {
        try {
          const parsed = JSON.parse(message.content);
          return parsed.lab === "exe-wan" && parsed.cohort === cohortKey
            ? [{ ...parsed, author_id: message.author.id }]
            : [];
        } catch {
          return [];
        }
      });
    },
  };
}

const actions = new Set([
  "voice-ready",
  "screen-ready",
  "prepare",
  "phase-ready",
  "end",
  "phase-done",
  "finished",
  "abort",
]);
const staged = new Set(["prepare", "phase-ready", "end", "phase-done"]);
function validReceipt(value, index, screen) {
  return (
    value?.voice_in === 7 &&
    value.voice_out === 7 &&
    value.checks >= 2 &&
    (!screen ||
      (value.sfu_out === (index === 0 ? 1 : 0) &&
        value.sfu_in === (index === 0 ? 0 : 1)))
  );
}
export function createCohortProtocol({ index, users, list, send, budget }) {
  check(
    users.length === 8 &&
      new Set(users.map((u) => u.id)).size === 8 &&
      users.every((u, i) => u.index === i && typeof u.id === "string"),
    "COHORT_REFUSED",
  );
  const parse = (rows) =>
    rows.filter((row) => {
      if (
        row.probe !== tag ||
        !actions.has(row.action) ||
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index > 7 ||
        row.author_id !== users[row.index].id
      )
        return false;
      if (
        staged.has(row.action)
          ? !timingLoadPhases.includes(row.stage)
          : row.stage !== undefined
      )
        return false;
      if (["prepare", "end"].includes(row.action) && row.index !== 0)
        return false;
      if (
        ["voice-ready", "screen-ready", "phase-ready", "phase-done"].includes(
          row.action,
        ) &&
        !validReceipt(row.receipt, row.index, row.action !== "voice-ready")
      )
        return false;
      return true;
    });
  let cached,
    cachedAt = -Infinity,
    inFlight,
    readAbort;
  const waits = [];
  const read = (end) => {
    if (inFlight) return inFlight;
    if (cached && budget.now() - cachedAt < 10000)
      return Promise.resolve(cached);
    const controller = new AbortController();
    readAbort = controller;
    inFlight = budget
      .run((ms) => list(ms, controller.signal), end - budget.now())
      .then((rows) => {
        check(!controller.signal.aborted, "DEADLINE");
        cached = rows;
        cachedAt = budget.now();
        return rows;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const readWithMedia = async (end, inspect) => {
    const pending = budget.run(() => read(end), end - budget.now());
    if (!inspect) return pending;
    let settled = false,
      value,
      error;
    const done = pending.then(
      (rows) => {
        value = rows;
        settled = true;
      },
      (reason) => {
        error = reason;
        settled = true;
      },
    );
    while (!settled) {
      const stop = new AbortController();
      try {
        await Promise.race([
          done,
          budget.pause(
            Math.min(3000, Math.max(0, end - budget.now())),
            stop.signal,
          ),
        ]);
      } finally {
        stop.abort();
      }
      if (!settled)
        await budget.run(() => inspect(), Math.min(5000, end - budget.now()));
    }
    if (error) throw error;
    return value;
  };
  const post = (action, { stage, receipt } = {}) => {
    check(
      actions.has(action) &&
        (staged.has(action)
          ? timingLoadPhases.includes(stage)
          : stage === undefined),
      "PROTOCOL_REFUSED",
    );
    check(!["prepare", "end"].includes(action) || index === 0, "ROLE_REFUSED");
    if (
      ["voice-ready", "screen-ready", "phase-ready", "phase-done"].includes(
        action,
      )
    )
      check(
        validReceipt(receipt, index, action !== "voice-ready"),
        "RECEIPT_REFUSED",
      );
    return budget.run(
      (ms) =>
        send(
          {
            probe: tag,
            action,
            index,
            ...(stage ? { stage } : {}),
            ...(receipt ? { receipt } : {}),
          },
          { maximum: ms },
        ),
      90000,
    );
  };
  const wait = async (
    action,
    count,
    { stage, inspect, maximum = 90000 } = {},
  ) => {
    const started = budget.now(),
      end = started + Math.min(maximum, budget.remaining()),
      timing = {
        action,
        ...(stage ? { stage } : {}),
        requested_maximum_ms: maximum,
        elapsed_ms: 0,
        quorum: 0,
        observed_clients: 0,
        expected_clients: count,
        completion: "NOT_RUN",
      };
    waits.push(timing);
    try {
      while (budget.now() < end) {
        const rows = parse(await readWithMedia(end, inspect));
        check(budget.now() < end, "BARRIER_TIMEOUT");
        check(!rows.some((r) => r.action === "abort"), "COHORT_ABORTED");
        const found = [
          ...new Map(
            rows
              .filter((r) => r.action === action && r.stage === stage)
              .map((r) => [r.index, r]),
          ).values(),
        ];
        timing.observed_clients = found.length;
        if (found.length === count) {
          timing.quorum = count;
          timing.completion = "COMPLETE";
          return found;
        }
        if (inspect) await inspect();
        // Media checks retain their 3s cadence. Only the shared HTTP read is
        // throttled/coalesced to at most one per 10s per process.
        await budget.pause(Math.min(3000, Math.max(0, end - budget.now())));
      }
      throw failure("BARRIER_TIMEOUT");
    } catch (error) {
      readAbort?.abort();
      cached = undefined;
      throw error;
    } finally {
      timing.elapsed_ms = budget.now() - started;
    }
  };
  return {
    post,
    wait,
    parse,
    snapshot: () => ({
      poll_interval_ms: 10000,
      inspection_interval_ms: 3000,
      waits: structuredClone(waits),
    }),
  };
}
export function resolveFixtureUsers(members, usernames) {
  check(
    members.length === 8 &&
      usernames.length === 8 &&
      new Set(usernames).size === 8,
    "MEMBERS_REFUSED",
  );
  const users = usernames.map((username, index) => {
    const found = members.filter(
      (m) => m.username === username && m.is_admin === false,
    );
    check(
      found.length === 1 && typeof found[0].id === "string",
      "MEMBERS_REFUSED",
    );
    return { index, id: found[0].id };
  });
  check(new Set(users.map((u) => u.id)).size === 8, "MEMBERS_REFUSED");
  return users;
}

const mediaKey = (pc, row) =>
  JSON.stringify([
    pc,
    row.stats_id,
    row.ssrc,
    row.track_id,
    row.media_source?.stats_id ?? null,
  ]);
function inspectLoad(sample, index, profile, owned, screen) {
  check(
    Number.isFinite(sample.at) &&
      /Em chamada ·\s*8(?:\D|$)/.test(sample.ui?.call_header || ""),
    "CALL_CHANGED",
  );
  check(
    sample.ui?.self_microphones?.filter((m) => m.ready === "live" && m.enabled)
      .length === 1,
    "MICROPHONE_CHANGED",
  );
  const connected = sample.peers.filter((p) => p.state === "connected"),
    mesh = connected.filter((p) => p.route === "p2p"),
    sdk = connected.filter((p) => p.route === "sfu");
  check(mesh.length === 7, "VOICE_SHAPE");
  const takeVoice = (direction) =>
    mesh
      .map((p) => {
        const rows = p.rtp.filter(
          (r) =>
            r.source === "microphone" &&
            r.kind === "audio" &&
            r.direction === direction &&
            r[direction === "inbound" ? "bytesReceived" : "bytesSent"] > 0,
        );
        check(rows.length === 1, "VOICE_SHAPE");
        const row = rows[0];
        check(
          typeof row.stats_id === "string" &&
            Number.isFinite(row.ssrc) &&
            typeof row.track_id === "string",
          "VOICE_IDENTITY_MISSING",
        );
        if (direction === "inbound")
          check(
            row.totalSamplesDuration > 0 && row.totalAudioEnergy > 0,
            "VOICE_NOT_DECODED",
          );
        return { pc: p.pc, key: mediaKey(p.pc, row), row };
      })
      .sort((a, b) => a.pc - b.pc);
  const incoming = takeVoice("inbound"),
    outgoing = takeVoice("outbound");
  check(
    !connected.some((p) =>
      p.rtp.some(
        (r) =>
          (r.source === "camera" ||
            (p.route === "sfu" && r.kind === "audio")) &&
          ((r.bytesSent ?? 0) > 0 || (r.bytesReceived ?? 0) > 0),
      ),
    ),
    "FORBIDDEN_MEDIA",
  );
  if (!screen)
    return { sample, incoming, outgoing, screen: null, capture: null };
  check(
    !mesh.some((p) =>
      p.rtp.some(
        (r) =>
          r.source === "screen" &&
          r.direction === "outbound" &&
          r.sender_active === true,
      ),
    ),
    "MESH_SCREEN_ACTIVE",
  );
  const candidates = sdk.flatMap((p) =>
    p.rtp
      .filter(
        (r) =>
          r.kind === "video" &&
          r.source === "screen" &&
          r.direction === (index === 0 ? "outbound" : "inbound") &&
          (index !== 0 || r.sender_active === true),
      )
      .map((row) => ({ pc: p.pc, peer: p, key: mediaKey(p.pc, row), row })),
  );
  check(candidates.length === 1, "SCREEN_SHAPE");
  const selected = candidates[0],
    row = selected.row;
  check(
    typeof row.stats_id === "string" &&
      Number.isFinite(row.ssrc) &&
      typeof row.track_id === "string",
    "SCREEN_IDENTITY_MISSING",
  );
  check(
    row.codec?.toLowerCase() === "video/vp8" &&
      row.frameWidth === profile.width &&
      row.frameHeight === profile.height,
    "SCREEN_GEOMETRY_OR_CODEC_CHANGED",
  );
  let capture = null;
  if (index === 0) {
    capture = sample.captures?.[owned?.index];
    try {
      assertOwnedCapture(capture, owned?.handle, profile, "native");
    } catch {
      throw failure("CAPTURE_CHANGED");
    }
    check(
      sample.captures.filter((c) => c.ready === "live").length === 1 &&
        capture.track_id === owned.track_id &&
        row.track_id === owned.track_id &&
        row.media_source?.track_id === owned.track_id,
      "CAPTURE_CHANGED",
    );
    check(
      capture.processor_status === "running" &&
        !capture.processor_error &&
        capture.marker_copy_errors === 0,
      "SOURCE_OBSERVER_FAILED",
    );
    const p = row.sender_parameters,
      e = p?.encodings;
    check(
      e?.length === 1 &&
        e[0].active !== false &&
        e[0].maxBitrate === profile.bitrate_mbps * 1e6 &&
        e[0].maxFramerate === 60 &&
        (e[0].scaleResolutionDownBy ?? 1) === 1 &&
        p.degradationPreference === "maintain-resolution" &&
        p.contentHint === "detail",
      "CAPS_OR_HINT_CHANGED",
    );
    check(
      row.framesEncoded > 0 &&
        row.bytesSent > 0 &&
        row.media_source?.frames > 0,
      "SCREEN_NOT_PRODUCED",
    );
  } else {
    check(
      !(sample.captures || []).some((c) => c.ready === "live"),
      "UNEXPECTED_LOCAL_CAPTURE",
    );
    // SDK, tile and focus rows can observe the same track. Require one actual
    // rendered identity, then select its most advanced usable UI observation.
    const videos = selected.peer.tracks.filter(
      (t) =>
        t.source === "screen" &&
        t.ready === "live" &&
        t.video?.width === profile.width &&
        t.video.height === profile.height &&
        t.video.ready_state >= 2 &&
        !t.video.paused &&
        t.video.total_frames > 0,
    );
    check(
      videos.length > 0 &&
        videos.every((t) => t.track_id === row.track_id) &&
        row.framesDecoded > 0 &&
        row.bytesReceived > 0,
      "SCREEN_NOT_DECODED",
    );
    selected.video = videos.reduce(
      (best, t) => (t.video.total_frames > best.total_frames ? t.video : best),
      videos[0].video,
    );
  }
  return { sample, incoming, outgoing, screen: selected, capture };
}
const audioNumbers = [
  "bytesSent",
  "bytesReceived",
  "packetsSent",
  "packetsReceived",
  "packetsLost",
  "jitter",
  "totalAudioEnergy",
  "totalSamplesDuration",
  "totalSamplesReceived",
  "concealedSamples",
];
const screenNumbers = [
  "timestamp",
  "framesEncoded",
  "framesDecoded",
  "bytesSent",
  "bytesReceived",
  "packetsSent",
  "packetsReceived",
  "packetsLost",
  "totalEncodeTime",
  "totalDecodeTime",
  "frameWidth",
  "frameHeight",
  "framesPerSecond",
  "framesDropped",
  "nackCount",
  "pliCount",
];
function captureProjection(capture) {
  if (!capture) return null;
  return {
    ...finite(capture, [
      "processor_frames",
      "distinct_marker_frames",
      "marker_copy_errors",
      "marker_copy_calls",
      "marker_copy_total_ms",
      "marker_copy_max_ms",
      "pixel_width",
      "pixel_height",
      "pixel_samples",
      "light_pixels",
      "colored_pixels",
      "observation_ms",
      "processor_source_fps",
      "distinct_marker_fps",
      "marker_copy_calls_delta",
      "marker_copy_total_ms_delta",
    ]),
    settings: finite(capture.settings, ["width", "height", "frameRate"]),
    processor_sizes: (
      capture.processor_sizes ||
      capture.sampled_sizes ||
      []
    ).filter((s) => /^\d{1,5}x\d{1,5}$/.test(s)),
  };
}
export function createLoadMonitor(
  index,
  profile,
  { owned, screen = true } = {},
) {
  let previous,
    binding,
    checks = 0,
    latest;
  const accept = (sample, hostCpu) => {
    const view = inspectLoad(sample, index, profile, owned, screen);
    const identity = JSON.stringify([
      view.incoming.map((r) => r.key),
      view.outgoing.map((r) => r.key),
      view.screen?.key ?? null,
      view.capture?.track_id ?? null,
    ]);
    if (binding !== undefined) check(identity === binding, "BINDING_CHANGED");
    binding = identity;
    if (previous) {
      const dt = sample.at - previous.sample.at;
      check(dt > 0, "CLOCK_CHANGED");
      const compare = (a, b, required, optional = []) => {
        for (const k of required) {
          check(
            Number.isFinite(a?.[k]) && Number.isFinite(b?.[k]) && b[k] >= a[k],
            "COUNTER_RESET",
          );
          if (dt >= 1000) check(b[k] > a[k], "MEDIA_NOT_ADVANCING");
        }
        for (const k of optional)
          if (Number.isFinite(a?.[k]) && Number.isFinite(b?.[k]))
            check(b[k] >= a[k], "COUNTER_RESET");
      };
      view.incoming.forEach((v, i) =>
        compare(previous.incoming[i].row, v.row, [
          "bytesReceived",
          "totalSamplesDuration",
        ]),
      );
      view.outgoing.forEach((v, i) =>
        compare(previous.outgoing[i].row, v.row, ["bytesSent"]),
      );
      if (view.screen) {
        compare(
          previous.screen.row,
          view.screen.row,
          index === 0
            ? ["bytesSent", "framesEncoded"]
            : ["bytesReceived", "framesDecoded"],
          ["totalEncodeTime", "totalDecodeTime"],
        );
        if (index === 0) {
          compare(previous.capture, view.capture, [
            "processor_frames",
            "distinct_marker_frames",
          ]);
          compare(
            previous.screen.row.media_source,
            view.screen.row.media_source,
            ["frames"],
          );
        } else
          compare(previous.screen.video, view.screen.video, ["total_frames"]);
      }
    }
    previous = view;
    checks++;
    const receipt = {
      voice_in: view.incoming.length,
      voice_out: view.outgoing.length,
      sfu_in: view.screen && index !== 0 ? 1 : 0,
      sfu_out: view.screen && index === 0 ? 1 : 0,
      checks,
    };
    const row = view.screen?.row;
    latest = {
      at: sample.at,
      wall_utc: sample.wall_utc,
      receipt,
      voice_in: view.incoming.map((v) => finite(v.row, audioNumbers)),
      voice_out: view.outgoing.map((v) => finite(v.row, audioNumbers)),
      capture: captureProjection(view.capture),
      screen: row
        ? {
            ...finite(row, screenNumbers),
            codec: "video/VP8",
            ...(index === 0
              ? {
                  content_hint: "detail",
                  max_bitrate: profile.bitrate_mbps * 1e6,
                  max_framerate: 60,
                  scale: 1,
                  degradation_preference: "maintain-resolution",
                }
              : {}),
            ...(typeof row.content_type === "string" &&
            ["screenshare", "unspecified"].includes(row.content_type)
              ? { content_type: row.content_type }
              : {}),
            ...(typeof row.quality_limitation_reason === "string" &&
            ["cpu", "none", "bandwidth", "other"].includes(
              row.quality_limitation_reason,
            )
              ? { quality_limitation_reason: row.quality_limitation_reason }
              : {}),
            quality_limitation_durations: finite(
              row.quality_limitation_durations,
              ["cpu", "none", "bandwidth", "other"],
            ),
            media_source: finite(row.media_source, [
              "timestamp",
              "frames",
              "width",
              "height",
              "framesPerSecond",
            ]),
          }
        : null,
      ...(hostCpu ? { host_cpu: hostCpu } : {}),
    };
    return latest;
  };
  return { accept, receipt: () => ({ ...latest.receipt }) };
}

function statistics(value) {
  return {
    status: value?.count > 0 ? "OBSERVED" : "NOT_VERIFIED",
    ...finite(value, ["count", "mean_ms", "p50_ms", "p95_ms", "max_ms"]),
  };
}
function timingProjection(value) {
  if (!value) return { status: "NOT_VERIFIED" };
  const allowed = new Set([
    "INTERCEPTED",
    "NOT_VERIFIED",
    "RESTORED",
    "NOT_INSTALLED",
    "NOT_OWNER",
    "FAILED",
  ]);
  const states = (object) =>
    Object.fromEntries(
      ["video_frame", "writer_write"]
        .filter((k) => allowed.has(object?.[k]))
        .map((k) => [k, object[k]]),
    );
  return {
    interception: states(value.interception),
    restore: states(value.restore),
    ...finite(value, [
      "window_started_ms",
      "window_elapsed_ms",
      "pending_writes",
      "constructor_errors",
      "write_errors",
      "write_fulfilled",
      "write_rejected",
      "write_unobservable",
      "dropped_observations",
    ]),
    constructor_bgrx: statistics(value.constructor_bgrx),
    write_sync: statistics(value.write_sync),
    write_settled: statistics(value.write_settled),
  };
}
export function projectTimingPhase(phase) {
  return {
    name: phase.name,
    capacity_approval: false,
    before: captureProjection(phase.before),
    capture: captureProjection(phase.capture),
    original_quality_gate: {
      status: ["PASS", "FAIL"].includes(phase.original_quality_gate?.status)
        ? phase.original_quality_gate.status
        : "NOT_RUN",
    },
    ...finite(phase, ["native_producer_fps", "marker_copy_mean_ms"]),
    ...(phase.timings ? { timings: timingProjection(phase.timings) } : {}),
    ack: {
      ...finite(phase.ack, [
        "requests",
        "completed",
        "failed",
        "pending",
        "pending_at_boundary",
        "dropped_requests",
      ]),
      completed_ms: statistics(phase.ack?.completed_ms),
      failed_ms: statistics(phase.ack?.failed_ms),
    },
    load_samples: phase.load_samples || [],
    load_start_receipts: phase.load_start_receipts || null,
    load_end_receipts: phase.load_end_receipts || null,
    preparation_timing: finite(phase.preparation_timing, [
      "requested_gap_ms",
      "observed_gap_ms",
      "total_elapsed_ms",
    ]),
    host_cpu: summarizeHostCpu(phase.load_samples || []),
  };
}

async function sampleFor(budget, sample, emit, name, target) {
  const row = await budget.run((ms) => sample(ms), 5000);
  target?.push(row);
  emit({ phase: name, sample: row });
  return row;
}
async function observeFor(ms, budget, sample, emit, name) {
  const end = budget.now() + ms;
  while (budget.now() < end) {
    await sampleFor(budget, sample, emit, name);
    await budget.pause(Math.min(3000, Math.max(0, end - budget.now())));
  }
}
function receiptSummary(receipts) {
  const result = {
    clients: receipts.length,
    voice_in: receipts.reduce((n, r) => n + r.receipt.voice_in, 0),
    voice_out: receipts.reduce((n, r) => n + r.receipt.voice_out, 0),
    screen_receivers: receipts.reduce((n, r) => n + r.receipt.sfu_in, 0),
    screen_publishers: receipts.reduce((n, r) => n + r.receipt.sfu_out, 0),
  };
  check(
    result.clients === 8 &&
      result.voice_in === 56 &&
      result.voice_out === 56 &&
      result.screen_receivers === 7 &&
      result.screen_publishers === 1,
    "COHORT_LOAD_CHANGED",
  );
  return result;
}
export async function runPublisherTiming({
  app,
  selection,
  profile,
  protocol,
  budget,
  sample,
  phases = [],
  emit = () => {},
  measure = measureTimingPhases,
}) {
  const ack = createAckTimingObserver(),
    previousEvent = app.cdp.onEvent,
    starts = new Map(),
    preparationTimings = new Map();
  const eventWrapper = (event) => {
    try {
      previousEvent?.call(app.cdp, event);
    } finally {
      ack.onEvent(event);
    }
  };
  app.cdp.onEvent = eventWrapper;
  let next = 0,
    pendingPhase,
    active = true;
  const stopWork = new AbortController(),
    restoreExpression = "window.__nativeTimingDiagnostic?.restore()";
  const assertActive = () => check(active, "DEADLINE");
  const restore = async () => {
    const cleanup = createBudget({ duration: 2000 });
    try {
      return await cleanup.run(
        (ms) => app.cdp.evaluate(restoreExpression, false, ms),
        2000,
      );
    } finally {
      cleanup.close();
    }
  };
  const finishPhase = async () => {
    assertActive();
    if (!pendingPhase) return;
    const phase = pendingPhase;
    pendingPhase = null;
    await protocol.post("end", { stage: phase.name });
    const row = await sampleFor(budget, sample, emit, phase.name);
    await protocol.post("phase-done", {
      stage: phase.name,
      receipt: row.receipt,
    });
    const receipts = await protocol.wait("phase-done", 8, {
      stage: phase.name,
      inspect: () => sampleFor(budget, sample, emit, "barrier"),
    });
    phase.load_end_receipts = receiptSummary(receipts);
  };
  const phaseAck = {
    begin: (name) => ack.begin(name),
    end: (name) => {
      ack.end(name);
      pendingPhase = phases.find((p) => p.name === name);
    },
  };
  const wait = async (ms) => {
    assertActive();
    const started = budget.now();
    await finishPhase();
    const gapStarted = budget.now();
    await observeFor(ms, budget, sample, emit, "gap");
    const observedGap = budget.now() - gapStarted;
    const name = timingLoadPhases[next++];
    check(name !== undefined, "PHASE_SEQUENCE_CHANGED");
    await protocol.post("prepare", { stage: name });
    const row = await sampleFor(budget, sample, emit, "barrier");
    await protocol.post("phase-ready", { stage: name, receipt: row.receipt });
    const receipts = await protocol.wait("phase-ready", 8, {
      stage: name,
      inspect: () => sampleFor(budget, sample, emit, "barrier"),
    });
    starts.set(name, receiptSummary(receipts));
    preparationTimings.set(name, {
      requested_gap_ms: ms,
      observed_gap_ms: observedGap,
      total_elapsed_ms: budget.now() - started,
    });
  };
  const measuredApp = {
    ...app,
    // Fence every command issued by the unchanged046 helper. A pending read
    // resolving after cleanup must never issue a subsequent wrapper install.
    cdp: {
      setStage: (...args) => {
        assertActive();
        return app.cdp.setStage(...args);
      },
      evaluate: async (expression, gesture = false, timeout = 30000) => {
        if (expression === restoreExpression) return restore();
        assertActive();
        const value = await budget.run(
          (ms) => {
            assertActive();
            return app.cdp.evaluate(expression, gesture, ms);
          },
          Math.min(timeout, 5000),
        );
        assertActive();
        return value;
      },
    },
    measureCapture: async (index, duration) => {
      assertActive();
      const phase = phases.at(-1),
        rows = (phase.load_samples = []),
        stop = new AbortController();
      const abort = () => stop.abort();
      stopWork.signal.addEventListener("abort", abort, { once: true });
      phase.load_start_receipts = starts.get(phase.name);
      phase.preparation_timing = preparationTimings.get(phase.name);
      await sampleFor(budget, sample, emit, phase.name, rows);
      const watch = (async () => {
        while (!stop.signal.aborted && active) {
          await budget.pause(3000, stop.signal);
          if (!stop.signal.aborted && active)
            await sampleFor(budget, sample, emit, phase.name, rows);
        }
      })();
      try {
        const capture = await Promise.race([
          budget.run((ms) => {
            assertActive();
            return app.measureCapture(index, duration, ms);
          }, duration + 15000),
          watch.then(() => {
            throw failure("SAMPLER_STOPPED");
          }),
        ]);
        assertActive();
        stop.abort();
        await watch;
        await sampleFor(budget, sample, emit, phase.name, rows);
        check(
          capture.pixel_width === profile.width &&
            capture.pixel_height === profile.height &&
            capture.sampled_sizes?.length > 0 &&
            capture.sampled_sizes.every(
              (s) => s === `${profile.width}x${profile.height}`,
            ) &&
            capture.light_pixels > 13680 &&
            capture.colored_pixels > 13680,
          "CAPTURE_GEOMETRY_CHANGED",
        );
        return capture;
      } finally {
        stop.abort();
        await watch.catch(() => {});
        stopWork.signal.removeEventListener("abort", abort);
      }
    },
  };
  let restored;
  try {
    await observeFor(30000, budget, sample, emit, "load_settle");
    await budget.run(
      () => measure(measuredApp, selection, profile, phases, phaseAck, wait),
      240000,
    );
    await finishPhase();
    const timing = phases.find((p) => p.name === "instrumented")?.timings;
    return {
      phases,
      observations_verified:
        timing?.constructor_bgrx?.count > 0 &&
        timing?.write_sync?.count > 0 &&
        timing?.write_settled?.count > 0 &&
        timing?.interception?.video_frame === "INTERCEPTED" &&
        timing?.interception?.writer_write === "INTERCEPTED" &&
        timing?.restore?.video_frame === "RESTORED" &&
        timing?.restore?.writer_write === "RESTORED" &&
        timing?.dropped_observations === 0,
    };
  } finally {
    active = false;
    stopWork.abort();
    try {
      restored = await restore();
    } finally {
      for (const phase of phases) {
        try {
          phase.ack = ack.snapshot(phase.name);
        } catch {
          phase.ack = null;
        }
      }
      ack.close();
      if (app.cdp.onEvent === eventWrapper) app.cdp.onEvent = previousEvent;
    }
    if (phases.some((p) => p.name === "instrumented"))
      check(Boolean(restored), "RESTORE_NOT_CONFIRMED");
    if (restored)
      check(
        Object.values(restored.restore).every((s) =>
          ["RESTORED", "NOT_INSTALLED"].includes(s),
        ),
        "RESTORE_NOT_CONFIRMED",
      );
  }
}
export async function runReceiverTiming({
  index,
  protocol,
  budget,
  sample,
  emit = () => {},
}) {
  const phases = [];
  for (const name of timingLoadPhases) {
    const rows = [],
      inspect = () => sampleFor(budget, sample, emit, name, rows);
    await protocol.wait("prepare", 1, {
      stage: name,
      inspect,
      maximum: 180000,
    });
    const ready = await inspect();
    await protocol.post("phase-ready", { stage: name, receipt: ready.receipt });
    await protocol.wait("end", 1, { stage: name, inspect, maximum: 90000 });
    const final = await inspect();
    await protocol.post("phase-done", { stage: name, receipt: final.receipt });
    phases.push({
      name,
      capacity_approval: false,
      client: index,
      load_samples: rows,
      note: "Receiver load observations span the preparation barrier through phase end, not a 180s capacity measurement.",
    });
  }
  return { phases };
}

async function main() {
  const profile = requestedProfile(),
    index = Number(process.env.HARMONY_CLIENT_INDEX),
    budget = createBudget(),
    hostCpus = cpus(),
    http = createDiagnosticHttp({ budget });
  const report = {
    kind: "exe_native_timing_load_diagnostic",
    status: "DIAGNOSTIC",
    capacity_approval: false,
    completion: "RUNNING",
    release: "0.4.8",
    index,
    requested_profile: profile,
    host_cpu_context: {
      model: String(hostCpus[0]?.model || "NOT_VERIFIED")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 160),
      logical_count: hostCpus.length,
      note: "OS model string and logical processor count; not a physical-core or isolated CPU allocation measurement.",
    },
    scope:
      "Eight independent public Windows EXEs with generated microphones, one real WGC screen and seven SDK receivers. Only publisher timing wrappers; no capacity approval.",
    phases: [],
    limitations: [
      "10s timing windows are not the180s/eight-participant quality gate.",
      "Wrappers add overhead; synchronous constructor wall time is not isolated CPU.",
      "Writer settlement includes downstream backpressure and event-loop scheduling.",
      "ACK timings cover CDP-observed POST completion, not WGC/Map/all Rust stages.",
      "Full-frame pixel inspection and bounded stats reads extend wrapper exposure after the ten-second capture counter window.",
      "Zero/missing interception counts mean NOT_VERIFIED, never zero CPU cost.",
    ],
  };
  const diagnostics = createClientDiagnostics(
    Number.isInteger(index) && index >= 0 && index < 8 ? index : 0,
  );
  const emit = (row) =>
    console.log(
      "HARMONY_EXE_TIMING_LOAD_SAMPLE " +
        JSON.stringify({ index, capacity_approval: false, ...row }),
    );
  let app, token, protocol, controlChannel;
  const publisherPhases = [];
  try {
    guard();
    assertLoadTimingContext(process.env, process.platform, profile, index);
    const manifest = JSON.parse(
      await readFile(new URL("./releases/0.4.8.json", import.meta.url), "utf8"),
    );
    check(
      manifest.version === "0.4.8" &&
        manifest.installer_url ===
          "https://github.com/BersaneV/Harmony/releases/download/v0.4.8/Harmony_0.4.8_x64-setup.exe" &&
        /^[a-f0-9]{64}$/.test(manifest.main_sha256) &&
        /^[a-f0-9]{64}$/.test(manifest.installer_sha256),
      "MANIFEST_REFUSED",
    );
    check(
      createHash("sha256")
        .update(await readFile(process.env.HARMONY_EXE_PATH))
        .digest("hex") === manifest.main_sha256,
      "BINARY_REFUSED",
    );
    report.main_sha256 = manifest.main_sha256;
    const actor = identity(index);
    mask(actor.password);
    const loggedIn = await http.request("/auth/login", null, actor, {
      kind: "auth",
    });
    mask(loggedIn.access_token);
    mask(loggedIn.refresh_token);
    check(
      loggedIn.user.username === actor.username &&
        loggedIn.user.is_admin === false,
      "AUTH_REFUSED",
    );
    token = rotatingToken(loggedIn, async (refresh_token) => {
      const fresh = await http.request(
        "/auth/refresh",
        null,
        { refresh_token },
        { kind: "auth" },
      );
      mask(fresh.access_token);
      mask(fresh.refresh_token);
      return fresh;
    });
    const guildName = "EXE WAN " + cohort(),
      guilds = (await http.request("/guilds", token)).items.filter(
        (g) => g.name === guildName,
      );
    check(guilds.length === 1, "COHORT_REFUSED");
    const guildId = guilds[0].id,
      channels = (await http.request(`/guilds/${guildId}/channels`, token))
        .items;
    const voice = channels.filter(
        (c) => c.kind === "voice" && c.name === "Sala de voz",
      ),
      control = channels.filter((c) => c.kind === "text");
    check(voice.length === 1 && control.length === 1, "COHORT_REFUSED");
    controlChannel = control[0].id;
    const members = (await http.request(`/guilds/${guildId}/members`, token))
      .items;
    const users = resolveFixtureUsers(
      members,
      Array.from({ length: 8 }, (_, i) => identity(i).username),
    );
    const instance = await http.request("/instance"),
      call = await http.request(`/channels/${voice[0].id}/call`, token);
    assertCallRoute(instance, call);
    check(call.screen_sfu_enabled === true, "SFU_REQUIRED");
    const transport = createControlTransport({
      http,
      token,
      channel: control[0].id,
      cohortKey: cohort(),
    });
    protocol = createCohortProtocol({
      index,
      users,
      list: transport.list,
      send: transport.send,
      budget,
    });
    app = await acquireSession(
      budget,
      () => session(index, { onCommandTrace: diagnostics.onCommandTrace }),
      120000,
    );
    check(
      app.captureMode === "native" &&
        app.attestation.main_sha256 === manifest.main_sha256 &&
        app.attestation.flags_verified &&
        app.attestation.debugger_loopback &&
        app.attestation.private_profile,
      "SESSION_REFUSED",
    );
    report.attestation = {
      browser: /^[A-Za-z]+\/[0-9.]{1,64}$/.test(app.attestation.browser.product)
        ? app.attestation.browser.product
        : "NOT_VERIFIED",
      main_sha256: manifest.main_sha256,
      native_capture: true,
      flags_verified: true,
      debugger_loopback: true,
      private_profile: true,
      generated_audio: [
        "windows_synthesized_speech",
        "generated_tone_fallback",
      ].includes(app.attestation.audio_source),
    };
    check(report.attestation.generated_audio, "GENERATED_MIC_REQUIRED");
    const who = identity(index);
    mask(who.password);
    for (const [selector, value] of [
      ['input[type="url"]', origin],
      ['input[autocomplete="username"]', who.username],
      ['input[type="password"]', who.password],
    ])
      await budget.run(() => app.fill(selector, value), 30000);
    await budget.run(() => app.click("Entrar no Harmony"), 60000);
    await budget.run(() => app.labelled("Abrir " + guildName), 30000);
    await budget.run(() => app.click("Sala de voz"), 30000);
    await budget.run(() => app.labelled("Ligar microfone"), 60000);
    let monitor = createLoadMonitor(index, profile, { screen: false });
    const read = async (timeout = 5000) => {
      app.cdp.setStage("capture.snapshot");
      const snapshot = await app.sample(Math.min(timeout, 5000));
      return monitor.accept(snapshot, {
        platform: "win32",
        at_ms: performance.now(),
        cores: cpus().map((c) => ({ ...c.times })),
      });
    };
    const ready = async () => {
      const end = budget.now() + Math.min(180000, budget.remaining());
      while (budget.now() < end) {
        try {
          await budget.run((ms) => read(ms), 5000);
          if (monitor.receipt().checks >= 2) return;
        } catch (error) {
          if (
            ![
              "CALL_CHANGED",
              "VOICE_SHAPE",
              "VOICE_NOT_DECODED",
              "MICROPHONE_CHANGED",
              "SCREEN_SHAPE",
              "SCREEN_NOT_DECODED",
              "SCREEN_NOT_PRODUCED",
              "SCREEN_GEOMETRY_OR_CODEC_CHANGED",
              "CAPS_OR_HINT_CHANGED",
            ].includes(error.code)
          )
            throw error;
        }
        await budget.pause(3000);
      }
      throw failure("READY_TIMEOUT");
    };
    await ready();
    await protocol.post("voice-ready", { receipt: monitor.receipt() });
    await protocol.wait("voice-ready", 8, {
      maximum: 180000,
      inspect: () => sampleFor(budget, read, emit, "voice_ready"),
    });
    let selection, owned;
    if (index === 0) {
      await budget.run(() => app.click("Compartilhar tela"), 30000);
      for (const [label, value] of [
        ["Resolução", profile.height],
        ["Quadros por segundo", profile.fps],
        ["Bitrate por", "manual"],
        ["Conteúdo", "motion"],
      ])
        await budget.run(() => app.select(label, value), 5000);
      await budget.run(
        () =>
          app.fill(
            'input[aria-label="Bitrate em megabits por segundo"]',
            String(profile.bitrate_mbps),
          ),
        5000,
      );
      await budget.run(
        () =>
          app.cdp.evaluate(
            `(()=>{const c=document.querySelector('.check-field input[type="checkbox"]');if(c?.checked)c.click();return true})()`,
            true,
            2000,
          ),
        3000,
      );
      selection = await budget.run(() => app.chooseScreen(), 90000);
      check(selection.mode === "native", "NATIVE_REQUIRED");
      const capture = selection.captures[0];
      owned = {
        index: capture.index,
        track_id: capture.track_id,
        handle: selection.owned_window_handle,
      };
      await budget.run(() => app.click("Iniciar transmissão"), 30000);
    }
    monitor = createLoadMonitor(index, profile, { owned });
    await ready();
    if (index !== 0)
      await budget.run(
        () =>
          app.cdp.evaluate(
            `(()=>{const v=[...document.querySelectorAll('video')].find(v=>v.srcObject?.getVideoTracks?.().length);const b=v?.closest('.video-tile')?.querySelector('[aria-label="Focar transmissão"]');if(!b)throw Error('Owned screen focus missing');b.click();return true})()`,
            true,
            2000,
          ),
        3000,
      );
    await protocol.post("screen-ready", { receipt: monitor.receipt() });
    await protocol.wait("screen-ready", 8, {
      maximum: 180000,
      inspect: () => sampleFor(budget, read, emit, "screen_ready"),
    });
    const result =
      index === 0
        ? await runPublisherTiming({
            app,
            selection,
            profile,
            protocol,
            budget,
            sample: read,
            phases: publisherPhases,
            emit,
          })
        : await runReceiverTiming({
            index,
            protocol,
            budget,
            sample: read,
            emit,
          });
    report.phases =
      index === 0 ? result.phases.map(projectTimingPhase) : result.phases;
    report.completion =
      index === 0 &&
      (!result.observations_verified ||
        result.phases.some((p) => !(p.ack?.completed_ms?.count > 0)))
        ? "NOT_VERIFIED"
        : "COMPLETE";
    // The owner posts finished only after restoring. Once that final quorum
    // exists peers may leave; do not turn their expected departure into a load
    // failure while another client is reading the same final barrier.
    await protocol.post("finished");
    await protocol.wait("finished", 8, { maximum: 60000 });
  } catch (error) {
    report.completion =
      error.code === "HTTP_RATE_LIMITED" ||
      (error.code === "DEADLINE" &&
        http.snapshot().classification === "NOT_RUN")
        ? "NOT_RUN"
        : "FAILED";
    report.error_code = /^[A-Z_]{1,64}$/.test(error?.code)
      ? error.code
      : "DIAGNOSTIC_FAILED";
    diagnostics.noteFailure(report, app);
    if (token && controlChannel) {
      const cleanup = createBudget({ duration: 5000 });
      const cleanupHttp = createDiagnosticHttp({ budget: cleanup });
      try {
        // Use a separate, short cleanup bound, including after global expiry;
        // never repeat an ambiguous write or restart fixture preparation.
        await createControlTransport({
          http: cleanupHttp,
          token,
          channel: controlChannel,
          cohortKey: cohort(),
        }).send({ probe: tag, action: "abort", index }, { maximum: 5000 });
      } catch {
      } finally {
        report.cleanup_http = cleanupHttp.snapshot();
        cleanup.close();
      }
    }
  } finally {
    report.http = http.snapshot();
    report.control = protocol?.snapshot();
    if (index === 0 && publisherPhases.length)
      report.phases = publisherPhases.map(projectTimingPhase);
    if (app) {
      if (index === 0) {
        try {
          const restored = await app.cdp.evaluate(
            "window.__nativeTimingDiagnostic?.restore()",
            false,
            2000,
          );
          report.final_restore = timingProjection(restored);
          if (
            publisherPhases.some((p) => p.name === "instrumented") &&
            !restored
          )
            report.completion = "FAILED";
          if (
            restored &&
            Object.values(restored.restore).some(
              (s) => !["RESTORED", "NOT_INSTALLED"].includes(s),
            )
          )
            report.completion = "FAILED";
        } catch {
          report.final_restore = { status: "NOT_VERIFIED" };
          report.completion = "FAILED";
        }
      }
      for (const expression of [
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Parar tela'&&!b.disabled);if(b)b.click();return!!b})()`,
        `(()=>{const b=document.querySelector('button[aria-label="Sair da chamada"]:not(:disabled)');if(b)b.click();return!!b})()`,
      ]) {
        try {
          await app.cdp.evaluate(expression, true, 2000);
        } catch {}
      }
      try {
        app.close();
      } catch {
        report.cleanup_status = "FAILED";
        report.completion = "FAILED";
      }
      budget.close();
      diagnostics.finish(report);
      try {
        await writeFile(
          join(app.root, "timing-load-diagnostic.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
      } catch {
        report.write_status = "FAILED";
        report.completion = "FAILED";
      }
    }
    budget.close();
    if (!app) diagnostics.finish(report);
    console.log("HARMONY_EXE_TIMING_LOAD_REPORT " + JSON.stringify(report));
  }
  if (report.completion !== "COMPLETE") process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href)
  await main();
