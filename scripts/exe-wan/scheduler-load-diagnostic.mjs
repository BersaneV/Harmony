// Private candidate. Import-safe; only main performs owned compiled-UI actions.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const repoRoot = resolve(process.cwd());
const atRoot = (name) =>
  pathToFileURL(join(repoRoot, "scripts/exe-wan", name)).href;
const {
  createBudget,
  acquireSession,
  createDiagnosticHttp,
  createControlTransport,
  createCohortProtocol,
  createLoadMonitor,
  resolveFixtureUsers,
  runReceiverTiming,
  timingLoadPhases,
} = await import(atRoot("timing-load-diagnostic.mjs"));
const { session } = await import(atRoot("session.mjs"));
const { requestedProfile } = await import(atRoot("profiles.mjs"));
const { guard, cohort, identity, origin, mask } = await import(
  atRoot("lab.mjs")
);
const { rotatingToken } = await import(atRoot("auth.mjs"));
const { assertCallRoute } = await import(atRoot("fixture-contract.mjs"));
const { createClientDiagnostics } = await import(
  atRoot("client-diagnostics.mjs")
);
export const MAIN_SHA =
  "6a1517c44ed45c996ac8d32c08767ea7306e897a4cb73d703d9286b68c86c2cc";
export const INSTALLER_SHA =
  "cf42a6924ccd1c390e33bbf440b6d77381f15f57fd06c09d5c1a29035b23f7ca";
const failure = (code) => Object.assign(new Error(code), { code });
const check = (condition, code) => {
  if (!condition) throw failure(code);
};
const tag = "native-timing-load-v1"; // Imported cohort protocol's fixed tag; fresh cohort isolates each diagnostic.

export function assertSchedulerContext(env, platform, profile, index) {
  check(platform === "win32", "WINDOWS_REQUIRED");
  for (const [k, v] of Object.entries({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Windows",
    HARMONY_SCHEDULER_LOAD_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.9",
  }))
    check(env[k] === v, "CONTEXT_REFUSED");
  check(Number.isInteger(index) && index >= 0 && index < 8, "CLIENT_REFUSED");
  check(
    profile.fps === 60 &&
      profile.min_source_fps === 54 &&
      profile.min_displayed_fps === 54 &&
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

const events = {
  attach: "attached",
  begin: "begun",
  end: "ended",
  close: "closed",
};
const identityCountKeys = [
  "identity_visible_candidates",
  "identity_title_matches",
];
const COMPANION_SCHEMA = {
  reply: [
    "kind",
    "event",
    "phase",
    "status",
    "failure_code",
    "capacity_approval",
    "utc_ms",
    "qpc_ticks",
    "qpc_frequency",
    "window",
    "cpu",
    "trace",
    "native_error_code",
    "identity_visible_candidates",
    "identity_title_matches",
  ],
  window: [
    "start_utc_ms",
    "end_utc_ms",
    "start_qpc_ticks",
    "end_qpc_ticks",
    "qpc_frequency",
    "elapsed_ms",
  ],
  cpu_roles: ["capture", "ui"],
  cpu_role: [
    "status",
    "failure_code",
    "start",
    "end",
    "canonical_monotonic",
    "legacy_monotonic",
    "cycles_monotonic",
    "kernel_ms",
    "user_ms",
    "legacy_kernel_ms",
    "legacy_user_ms",
    "cycles_delta",
    "query_span_min_ms",
    "query_span_max_ms",
    "amount",
  ],
  cpu_query: [
    "canonical_ok",
    "legacy_ok",
    "cycles_ok",
    "canonical_error",
    "legacy_error",
    "cycle_error",
    "kernel_100ns",
    "user_100ns",
    "legacy_kernel_100ns",
    "legacy_user_100ns",
    "cycles",
    "canonical_before_qpc_ticks",
    "canonical_after_qpc_ticks",
    "legacy_before_qpc_ticks",
    "legacy_after_qpc_ticks",
    "cycles_before_qpc_ticks",
    "cycles_after_qpc_ticks",
  ],
  amount: ["status", "failure_code"],
  trace: [
    "status",
    "failure_code",
    "integrity",
    "events",
    "malformed_scheduler",
    "lost_events",
    "lost_buffers",
    "dropped_events",
    "roles",
    "schema_shape",
    "field_shapes",
    "native_tools",
  ],
  trace_roles: ["capture", "ui"],
  trace_role: [
    "status",
    "failure_code",
    "events",
    "window_events",
    "boundary_intervals",
    "unclassified_intervals",
    "regressions",
    "transition_errors",
    "unsupported",
    "redundant_ready",
    "distribution_overflow",
    "window_ms",
    "running_ms",
    "ready_ms",
    "wait_ms",
    "covered_ms",
    "unknown_ms",
    "wait_delay_execution_ms",
    "wait_user_request_ms",
    "wait_other_ms",
    "wait_reason_counts",
    "running_intervals",
    "ready_intervals",
    "wait_intervals",
    "timestamps_missing",
    "timestamps_invalid",
    "timestamps_nonfinite",
  ],
  distribution: ["samples", "min_ms", "p50_ms", "p95_ms", "max_ms", "mean_ms"],
  schema_shape: [
    "provider_guid",
    "extended_guid",
    "opcode",
    "named_fields",
    "direct_fields",
    "thread_headers",
    "log_headers",
    "header_fields_missing",
    "header_fields_invalid",
  ],
  field_shapes: [
    "OldThreadId",
    "NewThreadId",
    "OldThreadState",
    "OldThreadWaitReason",
    "TThreadId",
    "EventsLost",
    "BuffersLost",
  ],
  field_shape: [
    "present",
    "missing",
    "duplicate",
    "decimal",
    "hex",
    "whitespace",
    "empty",
    "negative",
    "nonfinite",
    "fractional",
    "exceeds_u32",
    "other",
    "rejected",
    "zero",
    "positive",
    "domain_rejected",
  ],
  native_tools: ["wpr", "logman", "tracerpt"],
  native_tool: [
    "calls",
    "last_exit_code",
    "last_nonzero_exit_code",
    "last_timed_out",
    "timeouts",
    "start_failures",
  ],
  enums: {
    kind: ["SCHEDULING_LOAD"],
    event: ["attached", "begun", "ended", "closed"],
    phase: ["control_before", "instrumented", "control_after", null],
    status: ["OBSERVED", "NOT_VERIFIED"],
    integrity: ["VERIFIED", "NOT_VERIFIED"],
    failure_code: [
      "already_attached",
      "attach_required",
      "buffers_lost",
      "capture_description_not_unique",
      "command_schema",
      "companion_failed",
      "counter_zero_ambiguous",
      "cpu_cycles_unverified",
      "cpu_queries_unverified",
      "cpu_times_unverified",
      "creation_query_failed",
      "description_query_failed",
      "distribution_bound",
      "dropped_events",
      "duration_invalid",
      "etl_size_bound",
      "event_count_bound",
      "events_lost",
      "global_deadline",
      "guard_unverified",
      "header_fields_invalid",
      "header_fields_missing",
      "header_missing",
      "input_bound",
      "input_eof",
      "input_incomplete",
      "input_json",
      "installed_path_unverified",
      "left_boundary_unknown",
      "loss_counter_missing",
      "main_hash_mismatch",
      "native_compile_unverified",
      "native_tool_nonzero_exit",
      "native_tool_output_bound",
      "native_tool_start_failed",
      "native_tool_timeout",
      "none",
      "nonfinite_metrics",
      "not_decoded",
      "not_started",
      "output_bound",
      "owned_session_cleanup_not_verified",
      "owned_windows_runner_required",
      "partial_interval_coverage",
      "phase_sequence",
      "preexisting_wpr_session",
      "private_path_already_exists",
      "process_changed",
      "process_identity_unverified",
      "process_not_unique",
      "process_query_failed",
      "profile_not_verified",
      "query_windows_differ",
      "right_boundary_unknown",
      "role_invalid",
      "roles_not_distinct",
      "scheduler_malformed",
      "scheduler_schema_missing",
      "schema_fixture_failure",
      "session_status_unknown",
      "sleep_not_exercised",
      "state_transition_unknown",
      "state_unsupported",
      "subject_changed",
      "synthetic_workload_timeout",
      "target_events_missing",
      "target_scheduler_missing",
      "thread_changed",
      "thread_description_not_verified",
      "thread_enumeration_unverified",
      "thread_open_failed",
      "timestamp_coverage_incomplete",
      "timestamp_invalid",
      "timestamp_missing",
      "timestamp_nonfinite",
      "timestamp_regressive",
      "timestamp_span_insufficient",
      "tools_or_access_unavailable",
      "trace_incomplete",
      "trace_not_recording",
      "tracerpt_output_missing",
      "unexpected_failure",
      "window_deadline",
      "window_not_unique",
      "window_owner_changed",
      "window_query_failed",
      "window_too_long",
      "window_too_short",
      "worker_cleanup_not_verified",
      "workload_duration_unverified",
      "xml_size_bound",
    ],
  },
  dynamic_map: {
    wait_reason_counts:
      "integer keys0..255 -> nonnegative finite integer values",
  },
  all_other_values:
    "numeric, bool or null; failure_code fixed enum in frozen script. No other string/dynamic key allowed.",
  optional_identity_counts: {
    identity_visible_candidates: "safe integer>=0, absent if not enumerated",
    identity_title_matches: "safe integer>=0, absent if not enumerated",
  },
};
export function validateCompanionReply(row, event, phase) {
  check(
    row?.kind === "SCHEDULING_LOAD" &&
      row.event === event &&
      row.phase === (phase ?? null) &&
      row.capacity_approval === false &&
      COMPANION_SCHEMA.enums.status.includes(row.status),
    "COMPANION_SCHEMA",
  );
  const nested = {
    reply: { window: "window", cpu: "cpu_roles", trace: "trace" },
    cpu_role: { start: "cpu_query", end: "cpu_query", amount: "amount" },
    trace: {
      roles: "trace_roles",
      schema_shape: "schema_shape",
      field_shapes: "field_shapes",
      native_tools: "native_tools",
    },
    trace_role: {
      running_intervals: "distribution",
      ready_intervals: "distribution",
      wait_intervals: "distribution",
    },
  };
  const primitive = (value, key) => {
    if (identityCountKeys.includes(key)) {
      check(Number.isSafeInteger(value) && value >= 0, "COMPANION_SCHEMA");
      return;
    }
    if (Object.hasOwn(COMPANION_SCHEMA.enums, key)) {
      check(COMPANION_SCHEMA.enums[key].includes(value), "COMPANION_SCHEMA");
      return;
    }
    const boolean = [
      "capacity_approval",
      "canonical_monotonic",
      "legacy_monotonic",
      "cycles_monotonic",
      "canonical_ok",
      "legacy_ok",
      "cycles_ok",
      "last_timed_out",
    ].includes(key);
    check(
      value === null ||
        (boolean
          ? typeof value === "boolean"
          : typeof value === "number" && Number.isFinite(value)),
      "COMPANION_SCHEMA",
    );
  };
  const object = (value, type) => {
    check(
      value && typeof value === "object" && !Array.isArray(value),
      "COMPANION_SCHEMA",
    );
    for (const [k, v] of Object.entries(value)) {
      check(COMPANION_SCHEMA[type].includes(k), "COMPANION_SCHEMA");
      let child = nested[type]?.[k];
      if (type === "cpu_roles") child = "cpu_role";
      if (type === "trace_roles") child = "trace_role";
      if (type === "field_shapes") child = "field_shape";
      if (type === "native_tools") child = "native_tool";
      if (type === "trace_role" && k === "wait_reason_counts") {
        check(
          v && typeof v === "object" && !Array.isArray(v),
          "COMPANION_SCHEMA",
        );
        for (const [code, count] of Object.entries(v))
          check(
            /^(0|[1-9][0-9]{0,2})$/.test(code) &&
              Number(code) <= 255 &&
              Number.isSafeInteger(count) &&
              count >= 0,
            "COMPANION_SCHEMA",
          );
      } else if (child) {
        if (v !== null) object(v, child);
      } else primitive(v, k);
    }
  };
  object(row, "reply");
  for (const key of [
    "kind",
    "event",
    "phase",
    "status",
    "failure_code",
    "capacity_approval",
    "utc_ms",
    "qpc_ticks",
    "qpc_frequency",
  ])
    check(Object.hasOwn(row, key), "COMPANION_SCHEMA");
  check(
    [row.utc_ms, row.qpc_ticks, row.qpc_frequency].every(
      Number.isSafeInteger,
    ) &&
      row.utc_ms >= 0 &&
      row.qpc_ticks >= 0 &&
      row.qpc_frequency > 0,
    "COMPANION_SCHEMA",
  );
  return row;
}

function copyCompanionDetails(target, error, prefix = "") {
  if (
    COMPANION_SCHEMA.enums.failure_code.includes(error?.companion_failure_code)
  )
    target[prefix + "companion_failure_code"] = error.companion_failure_code;
  if (
    Object.hasOwn(error ?? {}, "native_error_code") &&
    (error.native_error_code === null ||
      (typeof error.native_error_code === "number" &&
        Number.isFinite(error.native_error_code)))
  )
    target[prefix + "native_error_code"] = error.native_error_code;
  for (const key of identityCountKeys)
    if (Number.isSafeInteger(error?.[key]) && error[key] >= 0)
      target[prefix + key] = error[key];
  return target;
}
function companionFailure(row, code) {
  validateCompanionReply(row, row.event, row.phase);
  const details = {
    companion_failure_code: row.failure_code,
    ...(Object.hasOwn(row, "native_error_code")
      ? { native_error_code: row.native_error_code }
      : {}),
  };
  for (const key of identityCountKeys)
    if (Object.hasOwn(row, key)) details[key] = row[key];
  return copyCompanionDetails(failure(code), details);
}
function requireObserved(row, code) {
  if (row.status !== "OBSERVED") throw companionFailure(row, code);
}

/** One owned persistent child; no raw stdout/stderr is forwarded. */
export function createCompanion({
  script,
  env = process.env,
  spawnChild = spawn,
}) {
  const childEnv = { ...env };
  delete childEnv.HARMONY_EXE_WAN_SEED;
  delete childEnv.GH_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  const child = spawnChild("pwsh", ["-NoProfile", "-File", script], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending,
    buffer = "",
    bytes = 0,
    terminal,
    exited = false,
    exitCode,
    closing,
    late,
    busy = false;
  const fail = (code) => {
    terminal ??= typeof code === "string" ? failure(code) : code;
    if (pending) {
      const p = pending;
      pending = undefined;
      p.reject(terminal);
    }
  };
  child.on("error", () => fail("COMPANION_START"));
  child.stdin.on?.("error", () => fail("COMPANION_STDIN"));
  child.stdout.on("error", () => fail("COMPANION_STDOUT"));
  child.stderr.on("error", () => fail("COMPANION_STDERR"));
  child.on("close", (code) => {
    exited = true;
    exitCode = code;
    if (pending) fail("COMPANION_EXIT");
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", (data) => {
    bytes += data.length;
    if (bytes > 1048576) return fail("COMPANION_OUTPUT_BOUND");
    buffer += data.toString("utf8");
    if (Buffer.byteLength(buffer) > 65536 && !buffer.includes("\n"))
      return fail("COMPANION_OUTPUT_BOUND");
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 65536)
        return fail("COMPANION_OUTPUT_BOUND");
      try {
        const parsed = JSON.parse(line);
        // Fatal startup/global failures close the companion before its normal
        // operation reply. They are failures, never successful close receipts.
        if (
          parsed?.event === "closed" &&
          parsed.status === "NOT_VERIFIED" &&
          parsed.failure_code !== "none"
        ) {
          validateCompanionReply(parsed, "closed");
          fail(companionFailure(parsed, "COMPANION_FATAL"));
          continue;
        }
        check(Boolean(pending), "COMPANION_ORDER");
        const p = pending;
        if (
          p.event === "closed" &&
          late &&
          parsed.event === late.event &&
          parsed.phase === (late.phase ?? null)
        ) {
          validateCompanionReply(parsed, late.event, late.phase);
          late = undefined;
          continue;
        }
        const row = validateCompanionReply(parsed, p.event, p.phase);
        pending = undefined;
        p.resolve(row);
      } catch {
        fail("COMPANION_SCHEMA");
      }
    }
  });
  const command = async (command, phase, budget) => {
    if (terminal) throw terminal;
    check(!exited && !pending && !busy, "COMPANION_UNAVAILABLE");
    check(
      Object.hasOwn(events, command) &&
        (["begin", "end"].includes(command)
          ? timingLoadPhases.includes(phase)
          : phase === undefined),
      "COMPANION_COMMAND",
    );
    const maximum = { attach: 90000, begin: 60000, end: 90000, close: 120000 }[
      command
    ];
    busy = true;
    try {
      return await budget.run(
        () =>
          new Promise((resolve, reject) => {
            pending = { event: events[command], phase, resolve, reject };
            const row = {
              command,
              ...(phase ? { phase } : {}),
              ...(command === "begin" ? { duration_ms: 10000 } : {}),
            };
            child.stdin.write(JSON.stringify(row) + "\n", (error) => {
              if (error) fail("COMPANION_STDIN");
            });
          }),
        maximum,
      );
    } catch (error) {
      if (pending) late = { event: pending.event, phase: pending.phase };
      pending = undefined;
      terminal ??= error;
      throw error;
    } finally {
      busy = false;
    }
  };
  const close = () =>
    (closing ??= (async () => {
      const cleanup = createBudget({ duration: 120000 });
      try {
        // A timed-out request may still emit a reply. Close must not accept it as
        // the next command: only the fixed closed event can complete cleanup.
        terminal = undefined;
        const result = await command("close", undefined, cleanup);
        const deadline = cleanup.now() + Math.min(5000, cleanup.remaining());
        while (!exited && cleanup.now() < deadline) await cleanup.pause(50);
        check(
          exited && exitCode === 0 && !terminal && !buffer.trim(),
          "COMPANION_CLEANUP",
        );
        return result;
      } finally {
        cleanup.close();
        if (!exited)
          try {
            child.kill();
          } catch {}
      }
    })());
  return { command, close };
}

function receiptSummary(rows) {
  const value = {
    clients: rows.length,
    voice_in: rows.reduce((n, r) => n + r.receipt.voice_in, 0),
    voice_out: rows.reduce((n, r) => n + r.receipt.voice_out, 0),
    screen_publishers: rows.reduce((n, r) => n + r.receipt.sfu_out, 0),
    screen_receivers: rows.reduce((n, r) => n + r.receipt.sfu_in, 0),
  };
  check(
    value.clients === 8 &&
      value.voice_in === 56 &&
      value.voice_out === 56 &&
      value.screen_publishers === 1 &&
      value.screen_receivers === 7,
    "COHORT_LOAD_CHANGED",
  );
  return value;
}
async function sampleFor(budget, sample, emit, phase, rows) {
  const row = await budget.run((ms) => sample(ms), 2000);
  rows?.push(row);
  emit({ phase, sample: row });
  return row;
}
export function phaseObservation(rows, profile) {
  check(rows.length >= 2, "WINDOW_NOT_OBSERVED");
  const first = rows[0],
    last = rows.at(-1),
    duration = last.at - first.at;
  check(
    Number.isFinite(first.at) &&
      Number.isFinite(last.at) &&
      duration >= 10000 &&
      Number.isFinite(first.wall_utc) &&
      Number.isFinite(last.wall_utc) &&
      last.wall_utc >= first.wall_utc,
    "WINDOW_NOT_OBSERVED",
  );
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const key of ["processor_frames", "distinct_marker_frames"])
      check(
        Number.isSafeInteger(row.capture?.[key]) &&
          row.capture[key] >= 0 &&
          (!i || row.capture[key] >= rows[i - 1].capture[key]),
        "WINDOW_NOT_OBSERVED",
      );
    if (i)
      check(
        row.at > rows[i - 1].at && row.wall_utc >= rows[i - 1].wall_utc,
        "WINDOW_NOT_OBSERVED",
      );
  }
  const raw = last.capture.processor_frames - first.capture.processor_frames,
    distinct =
      last.capture.distinct_marker_frames -
      first.capture.distinct_marker_frames;
  return {
    observed_ms: duration,
    first_wall_utc_ms: first.wall_utc,
    last_wall_utc_ms: last.wall_utc,
    source_fps: (raw / duration) * 1000,
    distinct_fps: (distinct / duration) * 1000,
    original_source_fps_gate:
      (raw / duration) * 1000 >= profile.min_source_fps &&
      (distinct / duration) * 1000 >= profile.min_source_fps
        ? "PASS"
        : "FAIL",
    capacity_approval: false,
  };
}
export function overlapWindow(observation, reply) {
  const w = reply.window ?? {},
    start = w.start_utc_ms,
    end = w.end_utc_ms,
    a = observation.first_wall_utc_ms,
    b = observation.last_wall_utc_ms;
  const invalid = { status: "NOT_VERIFIED", overlap_ms: null };
  if (
    ![start, end, a, b, observation.observed_ms, w.elapsed_ms].every(
      Number.isFinite,
    ) ||
    end < start ||
    b < a ||
    b - a < 10000 ||
    observation.observed_ms < 10000
  )
    return invalid;
  if (
    ![w.start_qpc_ticks, w.end_qpc_ticks, w.qpc_frequency].every(
      Number.isSafeInteger,
    ) ||
    w.qpc_frequency <= 0 ||
    w.end_qpc_ticks <= w.start_qpc_ticks
  )
    return invalid;
  const elapsed =
    ((w.end_qpc_ticks - w.start_qpc_ticks) * 1000) / w.qpc_frequency;
  if (
    elapsed !== w.elapsed_ms ||
    elapsed < 10000 ||
    elapsed >= 15000 ||
    elapsed < observation.observed_ms
  )
    return invalid;
  const overlap = Math.max(0, Math.min(end, b) - Math.max(start, a));
  return {
    status:
      start <= a && end >= b && overlap >= 10000 ? "OBSERVED" : "NOT_VERIFIED",
    overlap_ms: overlap,
    ps_elapsed_ms: elapsed,
    ps_utc_elapsed_ms: end - start,
  };
}
export async function runSchedulerPhases({
  companion,
  protocol,
  budget,
  sample,
  profile,
  phases = [],
  emit = () => {},
}) {
  let active = true,
    result,
    primaryError;
  const invoke = async (command, phase) => {
    check(active, "DEADLINE");
    const before = Date.now();
    const result = await budget.run(
      () => companion.command(command, phase, budget),
      { attach: 90000, begin: 60000, end: 90000 }[command],
    );
    check(active && budget.remaining() > 0, "DEADLINE");
    return {
      reply: result,
      request_utc_ms: before,
      response_utc_ms: Date.now(),
    };
  };
  try {
    const attached = await invoke("attach");
    requireObserved(attached.reply, "PS_NOT_VERIFIED");
    const settleEnd = budget.now() + 30000;
    while (budget.now() < settleEnd) {
      await sampleFor(budget, sample, emit, "load_settle");
      await budget.pause(Math.min(3000, Math.max(0, settleEnd - budget.now())));
    }
    for (const name of timingLoadPhases) {
      const phase = { name, capacity_approval: false, load_samples: [] };
      phases.push(phase);
      await protocol.post("prepare", { stage: name });
      const ready = await sampleFor(budget, sample, emit, "barrier");
      await protocol.post("phase-ready", {
        stage: name,
        receipt: ready.receipt,
      });
      phase.start_receipts = receiptSummary(
        await protocol.wait("phase-ready", 8, {
          stage: name,
          inspect: () => sampleFor(budget, sample, emit, "barrier"),
        }),
      );
      phase.begin = await invoke("begin", name);
      requireObserved(phase.begin.reply, "PS_NOT_VERIFIED");
      const limit = budget.now() + 15000;
      let first = await sampleFor(
          budget,
          sample,
          emit,
          name,
          phase.load_samples,
        ),
        last = first;
      while (last.at - first.at < 10000) {
        check(budget.now() < limit, "WINDOW_NOT_OBSERVED");
        await budget.pause(Math.min(3000, 10000 - (last.at - first.at)));
        last = await sampleFor(budget, sample, emit, name, phase.load_samples);
      }
      phase.end = await invoke("end", name);
      requireObserved(phase.end.reply, "PS_NOT_VERIFIED");
      phase.observation = phaseObservation(phase.load_samples, profile);
      phase.overlap = overlapWindow(phase.observation, phase.end.reply);
      check(
        phase.end.reply.status === "OBSERVED" &&
          phase.end.reply.window?.elapsed_ms >= 10000 &&
          phase.end.reply.window.elapsed_ms < 15000,
        "PS_NOT_VERIFIED",
      );
      await protocol.post("end", { stage: name });
      const done = await sampleFor(budget, sample, emit, "barrier");
      await protocol.post("phase-done", { stage: name, receipt: done.receipt });
      phase.end_receipts = receiptSummary(
        await protocol.wait("phase-done", 8, {
          stage: name,
          inspect: () => sampleFor(budget, sample, emit, "barrier"),
        }),
      );
      if (name !== "control_after") await budget.pause(2000);
    }
    result = {
      phases,
      observations_verified:
        phases.length === 3 &&
        phases.every((p) => p.overlap.status === "OBSERVED"),
    };
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    active = false;
    try {
      const closed = await companion.close();
      if (result) result.closed = closed;
      requireObserved(closed, "PS_CLOSE_NOT_VERIFIED");
    } catch (error) {
      if (primaryError) {
        primaryError.cleanup_error_code = /^[A-Z_]{1,64}$/.test(error?.code)
          ? error.code
          : "COMPANION_CLEANUP";
        copyCompanionDetails(primaryError, error, "cleanup_");
      } else throw error;
    }
  }
}

async function main() {
  const profile = requestedProfile(),
    index = Number(process.env.HARMONY_CLIENT_INDEX),
    budget = createBudget(),
    hostCpus = cpus(),
    http = createDiagnosticHttp({ budget });
  const report = {
    kind: "exe_native_scheduler_load_diagnostic",
    status: "DIAGNOSTIC",
    capacity_approval: false,
    completion: "RUNNING",
    release: "0.4.9",
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
      "Eight independent public Windows EXEs with generated microphones, one real WGC screen and seven SDK receivers. Only external publisher CPU/scheduler observation; no JavaScript wrappers or capacity approval.",
    phases: [],
    limitations: [
      "DIAGNOSTIC only: nominal 10s windows do not approve 180s/eight-person quality.",
      "External WPR changes scheduling; process/thread CPU is not GPU or exclusive encoder attribution.",
      "Record actual PS/JS windows and overlap; start/flush/transport overhead is not silently counted as exact 10s.",
      "ETL/XML stay private and are not uploaded; schema/loss/target failures are NOT_VERIFIED.",
    ],
  };
  const diagnostics = createClientDiagnostics(
    Number.isInteger(index) && index >= 0 && index < 8 ? index : 0,
  );
  const emit = (row) =>
    console.log(
      "HARMONY_EXE_SCHEDULER_LOAD_SAMPLE " +
        JSON.stringify({ index, capacity_approval: false, ...row }),
    );
  let app, token, protocol, controlChannel, companion;
  const publisherPhases = [];
  try {
    guard();
    assertSchedulerContext(process.env, process.platform, profile, index);
    const manifest = JSON.parse(
      await readFile(
        join(repoRoot, "scripts/exe-wan/releases/0.4.9.json"),
        "utf8",
      ),
    );
    check(
      manifest.version === "0.4.9" &&
        manifest.installer_url ===
          "https://github.com/BersaneV/Harmony/releases/download/v0.4.9/Harmony_0.4.9_x64-setup.exe" &&
        manifest.main_sha256 === MAIN_SHA &&
        manifest.installer_sha256 === INSTALLER_SHA,
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
              "MESH_SCREEN_ACTIVE",
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
    if (index === 0) {
      const script = join(repoRoot, "scripts/exe-wan/scheduling-load.ps1");
      check(
        /^[a-f0-9]{64}$/.test(process.env.HARMONY_SCHEDULER_PS_SHA256 || ""),
        "PS_FINGERPRINT_REQUIRED",
      );
      report.ps_sha256 = createHash("sha256")
        .update(await readFile(script))
        .digest("hex");
      check(
        report.ps_sha256 === process.env.HARMONY_SCHEDULER_PS_SHA256,
        "PS_FINGERPRINT_MISMATCH",
      );
      companion = createCompanion({ script });
    }
    const result =
      index === 0
        ? await runSchedulerPhases({
            companion,
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
    report.phases = result.phases;
    report.completion =
      index === 0 && !result.observations_verified
        ? "NOT_VERIFIED"
        : "COMPLETE";
    // The owner posts finished only after restoring. Once that final quorum
    // exists peers may leave; do not turn their expected departure into a load
    // failure while another client is reading the same final barrier.
    await protocol.post("finished");
    await protocol.wait("finished", 8, { maximum: 180000 });
  } catch (error) {
    report.completion = [
      "PS_NOT_VERIFIED",
      "PS_CLOSE_NOT_VERIFIED",
      "WINDOW_NOT_OBSERVED",
    ].includes(error.code)
      ? "NOT_VERIFIED"
      : error.code === "HTTP_RATE_LIMITED" ||
          (error.code === "DEADLINE" &&
            http.snapshot().classification === "NOT_RUN")
        ? "NOT_RUN"
        : "FAILED";
    report.error_code = /^[A-Z_]{1,64}$/.test(error?.code)
      ? error.code
      : "DIAGNOSTIC_FAILED";
    report.primary_error_code = report.error_code;
    copyCompanionDetails(report, error);
    const cleanupDetails = {
      companion_failure_code: error?.cleanup_companion_failure_code,
      ...(Object.hasOwn(error ?? {}, "cleanup_native_error_code")
        ? { native_error_code: error.cleanup_native_error_code }
        : {}),
    };
    for (const key of identityCountKeys)
      if (Object.hasOwn(error ?? {}, "cleanup_" + key))
        cleanupDetails[key] = error["cleanup_" + key];
    copyCompanionDetails(report, cleanupDetails, "cleanup_");
    if (error?.cleanup_error_code)
      report.cleanup_error_code = error.cleanup_error_code;
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
    if (index === 0 && publisherPhases.length) report.phases = publisherPhases;
    if (companion) {
      try {
        report.companion_close = await companion.close();
        requireObserved(report.companion_close, "PS_CLOSE_NOT_VERIFIED");
      } catch (error) {
        report.completion = "FAILED";
        report.companion_cleanup = "NOT_VERIFIED";
        report.cleanup_error_code ??= "COMPANION_CLEANUP";
        copyCompanionDetails(report, error, "cleanup_");
      }
    }
    if (app) {
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
          join(app.root, "scheduler-load-diagnostic.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
      } catch {
        report.write_status = "FAILED";
        report.completion = "FAILED";
      }
    }
    budget.close();
    if (!app) diagnostics.finish(report);
    console.log("HARMONY_EXE_SCHEDULER_LOAD_REPORT " + JSON.stringify(report));
  }
  if (report.completion !== "COMPLETE") process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href)
  await main();
