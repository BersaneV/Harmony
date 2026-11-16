// Isolated instrumentation of the immutable published EXE. Compiled UI owns all
// captures and media. These timings can perturb scheduling and never approve capacity.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { session } from "./session.mjs";
import { requestedProfile } from "./profiles.mjs";
import {
  guard,
  cohort,
  identity,
  origin,
  mask,
  ownedSession,
  api,
} from "./lab.mjs";
import { delay, until } from "./cdp.mjs";
import { assertOwnedCapture, assertCaptureMeasurement } from "./capture-ui.mjs";
import { assertCallRoute } from "./fixture-contract.mjs";
import { collectProbeFailure } from "./probe-native.mjs";

export function assertTimingContext(env, platform, profile) {
  assert.equal(platform, "win32");
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    HARMONY_TIMING_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.6",
  }))
    assert.equal(env[key], value, `Timing context requires ${key}`);
  assert.ok(
    ["1080p60", "1440p60"].includes(profile.id) && profile.fps === 60,
    "Only named performance60 profiles are diagnostic targets",
  );
}

// Self-contained for the owned WebView and VM passivity tests. No pixel reads,
// source/capture calls, close/enqueue calls or modifications to frame arguments.
export function installNativeTimingDiagnostic() {
  if (
    !window.__TAURI_INTERNALS__ ||
    !["http://tauri.localhost", "https://tauri.localhost"].includes(
      location.origin,
    )
  )
    throw Error("Owned compiled page required");
  if (window.__nativeTimingDiagnostic)
    throw Error("Timing diagnostic already installed");
  const frameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "VideoFrame",
  );
  const OriginalFrame = frameDescriptor?.value;
  const writerPrototype = globalThis.WritableStreamDefaultWriter?.prototype;
  const writeDescriptor =
    writerPrototype &&
    Object.getOwnPropertyDescriptor(writerPrototype, "write");
  const originalWrite = writeDescriptor?.value;
  const clock = () => {
    try {
      const n = performance.now();
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const started = clock(),
    samples = { constructor_bgrx: [], write_sync: [], write_settled: [] };
  const interception = {
    video_frame: "NOT_VERIFIED",
    writer_write: "NOT_VERIFIED",
  };
  const restoration = {
    video_frame: "NOT_INSTALLED",
    writer_write: "NOT_INSTALLED",
  };
  const counts = {
    constructor_errors: 0,
    write_errors: 0,
    write_fulfilled: 0,
    write_rejected: 0,
    write_unobservable: 0,
    dropped_observations: 0,
  };
  let active = true,
    pending = 0,
    FrameProxy,
    writeWrapper,
    sealed;
  const record = (key, start, end) => {
    try {
      if (!active || start === null || end === null || end < start) return;
      if (samples[key].length >= 10000) {
        counts.dropped_observations++;
        return;
      }
      samples[key].push(end - start);
    } catch {}
  };
  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b),
      n = sorted.length;
    return {
      status: n ? "OBSERVED" : "NOT_VERIFIED",
      count: n,
      mean_ms: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
      p50_ms: n ? sorted[Math.ceil(n * 0.5) - 1] : null,
      p95_ms: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
      max_ms: n ? sorted[n - 1] : null,
    };
  };
  const snapshot = () => {
    if (sealed) return JSON.parse(JSON.stringify(sealed));
    const ended = clock();
    return {
      interception: { ...interception },
      restore: { ...restoration },
      window_started_ms: started,
      window_elapsed_ms:
        started !== null && ended !== null && ended >= started
          ? ended - started
          : null,
      pending_writes: pending,
      ...counts,
      ...Object.fromEntries(
        Object.entries(samples).map(([k, v]) => [k, summarize(v)]),
      ),
    };
  };
  if (typeof OriginalFrame === "function") {
    try {
      FrameProxy = new Proxy(OriginalFrame, {
        construct(target, args, newTarget) {
          if (!active) return Reflect.construct(target, args, newTarget);
          let observed = false;
          try {
            observed =
              Object.getOwnPropertyDescriptor(args[1] || {}, "format")
                ?.value === "BGRX";
          } catch {}
          const start = observed && active ? clock() : null;
          try {
            return Reflect.construct(target, args, newTarget);
          } catch (error) {
            if (active && observed) counts.constructor_errors++;
            throw error;
          } finally {
            if (observed) record("constructor_bgrx", start, clock());
          }
        },
      });
      Object.defineProperty(globalThis, "VideoFrame", {
        ...frameDescriptor,
        value: FrameProxy,
      });
      interception.video_frame = "INTERCEPTED";
    } catch {
      FrameProxy = undefined;
    }
  }
  if (
    typeof originalWrite === "function" &&
    typeof OriginalFrame === "function"
  ) {
    try {
      const then = Promise.prototype.then;
      writeWrapper = function (...args) {
        let observed = false;
        try {
          observed =
            active &&
            Reflect.apply(
              Function.prototype[Symbol.hasInstance],
              OriginalFrame,
              [args[0]],
            );
        } catch {}
        const start = observed ? clock() : null;
        let result;
        try {
          result = Reflect.apply(originalWrite, this, args);
        } catch (error) {
          if (observed) {
            counts.write_errors++;
            record("write_sync", start, clock());
          }
          throw error;
        }
        if (observed) {
          record("write_sync", start, clock());
          pending++;
          const settled = (failed) => {
            try {
              if (!active) return;
              pending--;
              counts[failed ? "write_rejected" : "write_fulfilled"]++;
              record("write_settled", start, clock());
            } catch {}
          };
          // Return the original Promise verbatim. Both handlers make the additional
          // observation branch fulfilled; no unhandled rejected child is introduced.
          try {
            Reflect.apply(then, result, [
              () => settled(false),
              () => settled(true),
            ]);
          } catch {
            pending--;
            counts.write_unobservable++;
          }
        }
        return result;
      };
      Object.defineProperty(writerPrototype, "write", {
        ...writeDescriptor,
        value: writeWrapper,
      });
      interception.writer_write = "INTERCEPTED";
    } catch {
      writeWrapper = undefined;
    }
  }
  const qa = (window.__nativeTimingDiagnostic = {
    snapshot,
    restore() {
      if (sealed) return snapshot();
      active = false;
      for (const [key, target, name, wrapper, descriptor] of [
        ["video_frame", globalThis, "VideoFrame", FrameProxy, frameDescriptor],
        [
          "writer_write",
          writerPrototype,
          "write",
          writeWrapper,
          writeDescriptor,
        ],
      ]) {
        if (!wrapper) continue;
        try {
          if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper)
            restoration[key] = "NOT_OWNER";
          else {
            Object.defineProperty(target, name, descriptor);
            restoration[key] = "RESTORED";
          }
        } catch {
          restoration[key] = "FAILED";
        }
      }
      sealed = snapshot();
      return snapshot();
    },
  });
  return qa.snapshot();
}

function milliseconds(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b),
    n = sorted.length;
  return {
    status: n ? "OBSERVED" : "NOT_VERIFIED",
    count: n,
    mean_ms: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    p50_ms: n ? sorted[Math.ceil(n * 0.5) - 1] : null,
    p95_ms: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
    max_ms: n ? sorted[n - 1] : null,
  };
}
export function createAckTimingObserver() {
  const phases = new Map(),
    pending = new Map();
  let active = null,
    closed = false;
  return {
    begin(name) {
      assert.ok(
        ["control_before", "instrumented", "control_after"].includes(name),
      );
      assert.equal(active, null);
      assert.ok(!phases.has(name), "Phase already measured");
      phases.set(name, { rows: [], dropped: 0, pending_at_boundary: null });
      active = name;
    },
    end(name) {
      assert.equal(active, name);
      const phase = phases.get(name);
      phase.pending_at_boundary = phase.rows.filter(
        (r) => r.state === "pending",
      ).length;
      active = null;
    },
    onEvent(event) {
      if (closed) return;
      const p = event.params;
      if (
        event.method === "Network.requestWillBeSent" &&
        active &&
        p?.request?.method === "POST" &&
        /^https?:\/\/ipc\.localhost\/native_capture_ack$/.test(
          p.request.url || "",
        ) &&
        typeof p.requestId === "string" &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(p.requestId) &&
        Number.isFinite(p.timestamp)
      ) {
        if (pending.has(p.requestId)) return;
        const phase = phases.get(active);
        if (phase.rows.length >= 2400) {
          phase.dropped++;
          return;
        }
        const row = {
          request_id: p.requestId,
          started_at_seconds: p.timestamp,
          finished_at_seconds: null,
          state: "pending",
          duration_ms: null,
        };
        phase.rows.push(row);
        pending.set(p.requestId, row);
      }
      if (
        !["Network.loadingFinished", "Network.loadingFailed"].includes(
          event.method,
        )
      )
        return;
      const row = pending.get(p?.requestId);
      if (!row) return;
      pending.delete(p.requestId);
      row.state =
        event.method === "Network.loadingFinished" ? "completed" : "failed";
      if (
        Number.isFinite(p.timestamp) &&
        p.timestamp >= row.started_at_seconds
      ) {
        row.finished_at_seconds = p.timestamp;
        row.duration_ms = (p.timestamp - row.started_at_seconds) * 1000;
      }
    },
    snapshot(name) {
      const phase = phases.get(name);
      assert.ok(phase);
      const rows = phase.rows.map((r) => ({ ...r }));
      return {
        status: rows.length ? "OBSERVED" : "NOT_VERIFIED",
        requests: rows.length,
        completed: rows.filter((r) => r.state === "completed").length,
        failed: rows.filter((r) => r.state === "failed").length,
        pending: rows.filter((r) => r.state === "pending").length,
        pending_at_boundary: phase.pending_at_boundary,
        dropped_requests: phase.dropped,
        completed_ms: milliseconds(
          rows
            .filter((r) => r.state === "completed" && r.duration_ms !== null)
            .map((r) => r.duration_ms),
        ),
        failed_ms: milliseconds(
          rows
            .filter((r) => r.state === "failed" && r.duration_ms !== null)
            .map((r) => r.duration_ms),
        ),
        records: rows,
      };
    },
    close() {
      closed = true;
      active = null;
      pending.clear();
    },
  };
}

export async function measureTimingPhases(
  app,
  selection,
  request,
  phases,
  ack,
  wait = delay,
) {
  const capture = selection.captures[0],
    index = capture.index,
    handle = selection.owned_window_handle;
  const same = (value) => {
    assertOwnedCapture(value, handle, request, "native");
    assert.equal(
      value.track_id,
      capture.track_id,
      "All phases require the same owned native track",
    );
    assert.equal(value.index, index);
  };
  await wait(5000);
  for (const name of ["control_before", "instrumented", "control_after"]) {
    if (name !== "control_before") await wait(2000);
    app.cdp.setStage("capture.snapshot");
    const before = await app.cdp.evaluate(
      `__exeWan.captureSnapshots()[${index}]`,
    );
    same(before);
    const phase = { name, capacity_approval: false, before };
    phases.push(phase);
    let measuring = false;
    console.log(
      "HARMONY_EXE_NATIVE_TIMING_STAGE " +
        JSON.stringify({ stage: name, utc: new Date().toISOString() }),
    );
    try {
      if (name === "instrumented")
        await app.cdp.evaluate(
          `(${installNativeTimingDiagnostic.toString()})()`,
        );
      ack.begin(name);
      measuring = true;
      app.cdp.setStage("capture.measure");
      phase.capture = await app.measureCapture(index, 10000);
      same(phase.capture);
      try {
        assertCaptureMeasurement(phase.capture, request, "native");
        phase.original_quality_gate = { status: "PASS" };
      } catch (error) {
        phase.original_quality_gate = {
          status: "FAIL",
          reason: String(error.message).slice(0, 200),
        };
      }
    } finally {
      if (measuring) ack.end(name);
      if (name === "instrumented") {
        phase.timings = await app.cdp.evaluate(
          "window.__nativeTimingDiagnostic?.restore()",
          false,
          2000,
        );
        assert.ok(
          phase.timings,
          "Wrapper installation/restoration not confirmed",
        );
        assert.ok(
          Object.values(phase.timings.restore).every((s) =>
            ["RESTORED", "NOT_INSTALLED"].includes(s),
          ),
          "Diagnostic wrappers must be removed before the final control",
        );
      }
    }
    phase.native_producer_fps = phase.capture.settings?.frameRate ?? null;
    phase.marker_copy_mean_ms =
      phase.capture.marker_copy_calls_delta > 0
        ? phase.capture.marker_copy_total_ms_delta /
          phase.capture.marker_copy_calls_delta
        : null;
  }
}

async function runDiagnostic() {
  const request = requestedProfile(),
    result = {
      kind: "exe_native_timing_diagnostic",
      status: "DIAGNOSTIC",
      completion: "RUNNING",
      capacity_approval: false,
      release: "0.4.6",
      requested_profile: request,
      scope:
        "One immutable public EXE046 on one public hosted Windows VM; own compiled UI call/microphone/native preview only, no screen publication or eight-peer capacity approval",
      phases: [],
      limitations: [
        "Diagnostic wrappers add measurement overhead and can change scheduling.",
        "VideoFrame constructor timing is synchronous elapsed wall time, not isolated CPU attribution.",
        "Writer settlement includes downstream backpressure and event-loop scheduling, not just writer CPU.",
        "ACK timings cover observed CDP POST request to loadingFinished/loadingFailed, not every Rust producer stage.",
        "Constructor/write measurement remains NOT_VERIFIED if the compiled app cached an original method or the API is not interceptable.",
        "Each normal capture measurement uses the existing permanent marker reader and inspects one complete frame after its ten-second counter window. Wrapper exposure includes that final inspection.",
      ],
    };
  let app, ack, previousEvent, eventWrapper;
  try {
    guard();
    assertTimingContext(process.env, process.platform, request);
    for (const key of [
      "HARMONY_GUILD_ID",
      "HARMONY_GUILD_NAME",
      "HARMONY_VOICE_ID",
      "HARMONY_COHORT_USERS",
    ])
      assert.ok(
        process.env[key],
        `Ordinary compiled UI fixture requires ${key}`,
      );
    assert.equal(process.env.HARMONY_GUILD_NAME, "EXE WAN " + cohort());
    const users = JSON.parse(process.env.HARMONY_COHORT_USERS);
    assert.equal(users.length, 8);
    const release = JSON.parse(
      await readFile(new URL("./releases/0.4.6.json", import.meta.url), "utf8"),
    );
    assert.equal(release.version, "0.4.6");
    assert.equal(
      release.installer_url,
      "https://github.com/BersaneV/Harmony/releases/download/v0.4.6/Harmony_0.4.6_x64-setup.exe",
    );
    assert.match(release.main_sha256, /^[a-f0-9]{64}$/);
    assert.match(release.installer_sha256, /^[a-f0-9]{64}$/);
    const hash = createHash("sha256")
      .update(await readFile(process.env.HARMONY_EXE_PATH))
      .digest("hex");
    assert.equal(
      hash,
      release.main_sha256,
      "Only immutable public046 EXE is authorized",
    );
    result.installed_sha256 = hash;
    const token = await ownedSession(0),
      members = (
        await api(`/guilds/${process.env.HARMONY_GUILD_ID}/members`, token)
      ).items;
    assert.equal(members.length, 8);
    assert.ok(members.every((m) => users.some((u) => u.id === m.id)));
    const instance = await api("/instance"),
      info = await api(`/channels/${process.env.HARMONY_VOICE_ID}/call`, token);
    assertCallRoute(instance, info);
    result.server = {
      version: instance.version,
      media_transport: instance.media_transport,
      screen_sfu_enabled: info.screen_sfu_enabled === true,
    };
    app = await session(0);
    result.attestation = app.attestation;
    assert.equal(app.captureMode, "native");
    ack = createAckTimingObserver();
    previousEvent = app.cdp.onEvent;
    eventWrapper = (event) => {
      try {
        previousEvent?.call(app.cdp, event);
      } finally {
        ack.onEvent(event);
      }
    };
    app.cdp.onEvent = eventWrapper;
    const who = identity(0);
    mask(who.password);
    await app.fill('input[type="url"]', origin);
    await app.fill('input[autocomplete="username"]', who.username);
    await app.fill('input[type="password"]', who.password);
    await app.click("Entrar no Harmony");
    await app.labelled("Abrir " + process.env.HARMONY_GUILD_NAME);
    await app.click("Sala de voz");
    app.cdp.setStage("call.ready");
    await until(
      () =>
        app.cdp.evaluate(
          `document.querySelector('.call-header small')?.textContent.trim().startsWith('Em chamada ·')`,
        ),
      "compiled normal call joined",
      60000,
    );
    await app.labelled("Ligar microfone");
    app.cdp.setStage("call.microphone.ready");
    await until(
      () =>
        app.cdp.evaluate(`__exeWan.microphones.some(t=>t.readyState==='live')`),
      "compiled generated microphone",
    );
    app.cdp.setStage("call.microphone.observe");
    result.generated_audio = await app.cdp.evaluate(
      "__exeWan.measureMicrophone()",
    );
    assert.ok(result.generated_audio.rms > 0.03);
    await app.click("Compartilhar tela");
    await app.select("Resolução", request.height);
    await app.select("Quadros por segundo", request.fps);
    await app.select("Bitrate por", "manual");
    await app.fill(
      'input[aria-label="Bitrate em megabits por segundo"]',
      String(request.bitrate_mbps),
    );
    await app.select("Conteúdo", "motion");
    app.cdp.setStage("share.configure.audio");
    await app.cdp.evaluate(
      `(()=>{const c=document.querySelector('.check-field input[type="checkbox"]');if(c?.checked)c.click();return true})()`,
      true,
    );
    result.capture_selection = await app.chooseScreen();
    assert.equal(result.capture_selection.mode, "native");
    await measureTimingPhases(
      app,
      result.capture_selection,
      request,
      result.phases,
      ack,
    );
    result.completion = "COMPLETE";
  } catch (error) {
    result.completion = "FAILED";
    result.error = String(error.message).slice(0, 500);
    if (app) {
      const diagnostics = await collectProbeFailure(app);
      delete diagnostics.stats;
      delete diagnostics.stats_error;
      result.failure_diagnostics = diagnostics;
    }
  } finally {
    if (app) {
      try {
        result.final_restore = await app.cdp.evaluate(
          "window.__nativeTimingDiagnostic?.restore()",
          false,
          2000,
        );
      } catch {
        result.final_restore = { status: "NOT_VERIFIED" };
      }
    }
    if (ack) {
      for (const phase of result.phases) {
        try {
          phase.ack = ack.snapshot(phase.name);
        } catch {
          phase.ack = { status: "NOT_VERIFIED" };
        }
      }
      ack.close();
    }
    if (app) {
      if (app.cdp.onEvent === eventWrapper) app.cdp.onEvent = previousEvent;
      result.fixture_diagnostic = app.fixtureDiagnostic();
      try {
        app.close();
      } catch {
        result.completion = "FAILED";
        result.cleanup_policy = "FAILED";
      }
      await writeFile(
        join(app.root, "timing-diagnostic.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
    }
    console.log("HARMONY_EXE_NATIVE_TIMING " + JSON.stringify(result));
  }
  if (result.completion !== "COMPLETE") process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href)
  await runDiagnostic();
