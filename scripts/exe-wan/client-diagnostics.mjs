// Optional publisher trace and failure-only evidence. No capture/media actions.
import assert from "node:assert/strict";
import { collectProbeFailure } from "./probe-native.mjs";

const methods = new Set([
  "Runtime.evaluate",
  "Runtime.enable",
  "Network.enable",
  "Network.getResponseBody",
  "Browser.getVersion",
  "Browser.getBrowserCommandLine",
  "Browser.grantPermissions",
  "Emulation.setFocusEmulationEnabled",
]);
const stages = new Set(
  "session.start session.setup session.login_ready session.observe ui.fill ui.button.enabled ui.button.click ui.labelled.enabled ui.labelled.click ui.select login.enabled login.click call.open.enabled call.open.click share.open.enabled share.open.click capture.choose.enabled capture.choose.click capture.native.confirm.enabled capture.native.confirm.click share.configure.resolution share.configure.fps share.configure.bitrate_mode share.configure.bitrate share.configure.content share.configure.audio call.ready call.microphone.ready call.microphone.observe capture.fixture capture.method.detect capture.method.select capture.native_picker.wait capture.native_picker.select capture.native_consent capture.preview.wait capture.snapshot capture.owner capture.measure failure.dom failure.captures failure.http failure.browser failure.renderer failure.windows failure.stats".split(
    " ",
  ),
);
const states = new Set([
  "waiting",
  "sent",
  "completed",
  "rejected",
  "timeout",
  "closed",
  "connection_error",
  "send_error",
]);
const sockets = new Set(["connecting", "open", "closing", "closed"]);
const nativeCommands = new Set([
  "native_capture_start",
  "native_capture_sources",
  "native_capture_available",
  "native_capture_profile",
  "native_capture_stop",
  "native_capture_ack",
]);
const blocked = new Set(
  "body headers postdata expression params payload payloaddata accesstoken refreshtoken token authorization cookie password apikey apisecret url uri websocketdebuggerurl commandline arguments".split(
    " ",
  ),
);
function safe(value) {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !blocked.has(key.replace(/[_-]/g, "").toLowerCase()))
        .map(([key, v]) => [key, safe(v)]),
    );
  return value;
}
function sampleMetadata(sample) {
  const out = safe(
    Object.fromEntries(
      ["at", "wall_utc", "peers", "events", "captures", "ui", "browser_events"]
        .filter((key) => sample[key] !== undefined)
        .map((key) => [key, sample[key]]),
    ),
  );
  if (Array.isArray(sample.native_requests))
    out.native_requests = sample.native_requests
      .filter((row) => nativeCommands.has(row.command))
      .map((row) =>
        Object.fromEntries(
          ["command", "state", "at", "http_status"]
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
        ),
      );
  return out;
}
export function createClientDiagnostics(index, { limit = 512, onTrace } = {}) {
  assert.ok(
    Number.isInteger(index) && index >= 0 && index < 8,
    "Only ordinary fixture clients",
  );
  assert.ok(
    Number.isInteger(limit) && limit > 0 && limit <= 512,
    "Bounded trace required",
  );
  assert.ok(onTrace === undefined || typeof onTrace === "function");
  const enabled = index === 0,
    rows = [];
  let dropped = 0,
    emitted = 0;
  const onCommandTrace = enabled
    ? (value) => {
        if (
          !methods.has(value?.method) ||
          !stages.has(value?.stage) ||
          !states.has(value?.state) ||
          !sockets.has(value?.socket_state) ||
          !Number.isSafeInteger(value?.id) ||
          value.id < 1 ||
          typeof value.utc !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.utc) ||
          !Number.isFinite(value.elapsed_ms) ||
          value.elapsed_ms < 0 ||
          !Number.isFinite(value.timeout_ms) ||
          value.timeout_ms < 1
        )
          return;
        const row = Object.fromEntries(
          [
            "method",
            "id",
            "stage",
            "utc",
            "socket_state",
            "state",
            "elapsed_ms",
            "timeout_ms",
          ].map((key) => [key, value[key]]),
        );
        rows.push(row);
        if (rows.length > limit) {
          rows.shift();
          dropped++;
        }
        // Live output is bounded separately; the final report retains recent rows.
        if (onTrace && emitted < limit) {
          emitted++;
          try {
            onTrace({ ...row });
          } catch {}
        }
      }
    : undefined;
  return {
    onCommandTrace,
    noteFailure(report, app) {
      const last = rows.at(-1);
      report.failure_stage = stages.has(app?.cdp?.stage)
        ? app.cdp.stage
        : (last?.stage ?? null);
      report.last_command = last ? { ...last } : null;
    },
    async collectFailure(
      report,
      app,
      { collector = collectProbeFailure, options } = {},
    ) {
      try {
        const result = await collector(app, options);
        const { stats, ...diagnostics } = result;
        report.failure_diagnostics = safe(diagnostics);
        if (stats && typeof stats === "object" && !Array.isArray(stats))
          report.final_sample = sampleMetadata(stats);
      } catch (error) {
        report.failure_diagnostics_error = {
          name: [
            "Error",
            "TypeError",
            "AssertionError",
            "AbortError",
            "TimeoutError",
          ].includes(error?.name)
            ? error.name
            : "Error",
        };
      }
    },
    finish(report) {
      report.command_trace_enabled = enabled;
      report.command_trace = rows.map((row) => ({ ...row }));
      report.command_trace_dropped = dropped;
    },
  };
}
