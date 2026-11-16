import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  assertSchedulerContext,
  validateCompanionReply,
  createCompanion,
  runSchedulerPhases,
  phaseObservation,
  overlapWindow,
} from "./scheduler-load-diagnostic.mjs";
const { createBudget } = await import(
  pathToFileURL(resolve("scripts/exe-wan/timing-load-diagnostic.mjs"))
);
const profile = {
  id: "1440p60",
  width: 2560,
  height: 1440,
  fps: 60,
  bitrate_mbps: 16,
  min_source_fps: 54,
  min_displayed_fps: 54,
};
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "BersaneV/Harmony",
  GITHUB_REF: "refs/heads/main",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Windows",
  HARMONY_SCHEDULER_LOAD_PUBLIC_REPOSITORY: "true",
  HARMONY_EXE_RELEASE: "0.4.9",
};
const receipt = { voice_in: 7, voice_out: 7, sfu_in: 0, sfu_out: 1, checks: 2 };
const row = (at) => ({
  at,
  wall_utc: at,
  receipt,
  capture: {
    processor_frames: Math.floor(at * 0.047),
    distinct_marker_frames: Math.floor(at * 0.044),
  },
});
const reply = (event, phase = null, extra = {}) => ({
  kind: "SCHEDULING_LOAD",
  event,
  phase,
  status: "OBSERVED",
  failure_code: "none",
  capacity_approval: false,
  utc_ms: 0,
  qpc_ticks: 0,
  qpc_frequency: 1000000,
  ...extra,
});
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
async function drive(promise, context, max = 300) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < max && !done; i++) {
    await flush();
    context.mock.timers.tick(1000);
  }
  assert.ok(done, "bounded orchestration");
  return promise;
}

test("only immutable049 public hosted main and unchanged60 profiles are admitted", () => {
  assert.doesNotThrow(() => assertSchedulerContext(env, "win32", profile, 0));
  for (const patch of [
    { HARMONY_EXE_RELEASE: "0.4.8" },
    { HARMONY_EXE_RELEASE: "0.5.0" },
    { HARMONY_SCHEDULER_LOAD_PUBLIC_REPOSITORY: "false" },
    { HARMONY_ENCODER_PROBE: "true" },
    { GITHUB_REF: "refs/heads/other" },
  ])
    assert.throws(() =>
      assertSchedulerContext({ ...env, ...patch }, "win32", profile, 0),
    );
  assert.throws(() => assertSchedulerContext(env, "darwin", profile, 0));
  assert.throws(() =>
    assertSchedulerContext(env, "win32", { ...profile, fps: 30 }, 0),
  );
});
test("companion rejects IDs, nonnumeric payloads and unexpected event/phase/capacity", () => {
  const value = reply("ended", "instrumented", {
    window: { start_utc_ms: 0, end_utc_ms: 10000 },
    trace: {
      status: "OBSERVED",
      integrity: "VERIFIED",
      roles: { capture: { wait_reason_counts: { 4: 3 } } },
    },
  });
  assert.equal(validateCompanionReply(value, "ended", "instrumented"), value);
  for (const patch of [
    { pid: 42 },
    { NativeId: 123 },
    { handle: 123 },
    { trace: { path: "private-path" } },
    { trace: { roles: { capture: { NativeId: 123 } } } },
    { cpu: { value: Infinity } },
    { utc_ms: false },
    { qpc_frequency: 0 },
    { trace: { events: false } },
    { phase: "control_after" },
    { capacity_approval: true },
    { cpu: { note: "private text" } },
  ])
    assert.throws(() =>
      validateCompanionReply({ ...value, ...patch }, "ended", "instrumented"),
    );
  const partial = reply("closed", null, {
    cpu: {
      capture: {
        amount: {
          status: "NOT_VERIFIED",
          failure_code: "counter_zero_ambiguous",
        },
      },
    },
    trace: {
      status: "NOT_VERIFIED",
      failure_code: "partial_interval_coverage",
      integrity: "VERIFIED",
    },
  });
  assert.equal(validateCompanionReply(partial, "closed"), partial);
  assert.throws(() =>
    validateCompanionReply(
      { ...partial, failure_code: "unknown_failure" },
      "closed",
    ),
  );
});
test("counter/window validation never labels missing, regressive, short or disjoint clocks OBSERVED", () => {
  const observation = phaseObservation([row(0), row(10000)], profile);
  assert.equal(observation.original_source_fps_gate, "FAIL");
  const ps = reply("ended", "instrumented", {
    window: {
      start_utc_ms: 0,
      end_utc_ms: 10000,
      start_qpc_ticks: 0,
      end_qpc_ticks: 10000000,
      qpc_frequency: 1000000,
      elapsed_ms: 10000,
    },
  });
  assert.equal(overlapWindow(observation, ps).status, "OBSERVED");
  for (const patch of [
    { first_wall_utc_ms: NaN },
    { last_wall_utc_ms: -1 },
    { observed_ms: 9999 },
  ])
    assert.equal(
      overlapWindow({ ...observation, ...patch }, ps).status,
      "NOT_VERIFIED",
    );
  for (const patch of [
    { start_utc_ms: 11000, end_utc_ms: 21000 },
    { start_utc_ms: 1 },
    { elapsed_ms: 10001 },
    { qpc_frequency: 0 },
    { end_qpc_ticks: 0 },
  ])
    assert.equal(
      overlapWindow(observation, { ...ps, window: { ...ps.window, ...patch } })
        .status,
      "NOT_VERIFIED",
    );
  const reset = row(10000);
  reset.capture.processor_frames = -1;
  assert.throws(() => phaseObservation([row(0), reset], profile));
  assert.throws(() => phaseObservation([row(0), row(9999)], profile));
});

function fixture(
  context,
  { hangAttach = false, missingReceiver = false, invalidClose = false } = {},
) {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const budget = createBudget({
      now: () => Date.now(),
      duration: hangAttach ? 1000 : 600000,
    }),
    events = [],
    phases = [];
  let started;
  const companion = {
    async command(command, phase) {
      events.push(command + ":" + (phase || ""));
      if (command === "attach" && hangAttach) return new Promise(() => {});
      if (command === "begin") {
        started = Date.now();
        return reply("begun", phase);
      }
      if (command === "end")
        return reply("ended", phase, {
          window: {
            start_utc_ms: started,
            end_utc_ms: Date.now(),
            start_qpc_ticks: started * 1000,
            end_qpc_ticks: Date.now() * 1000,
            qpc_frequency: 1000000,
            elapsed_ms: Date.now() - started,
          },
        });
      return reply("attached");
    },
    async close() {
      events.push("close");
      return reply("closed", null, {
        status: invalidClose ? "NOT_VERIFIED" : "OBSERVED",
      });
    },
  };
  const protocol = {
    async post(action, { stage } = {}) {
      events.push(action + ":" + (stage || ""));
    },
    async wait(action, count, { stage }) {
      events.push("quorum:" + action + ":" + stage);
      return Array.from({ length: missingReceiver ? 7 : 8 }, (_, i) => ({
        index: i,
        receipt: {
          ...receipt,
          sfu_out: i === 0 ? 1 : 0,
          sfu_in: i === 0 ? 0 : 1,
        },
      }));
    },
  };
  return {
    budget,
    events,
    phases,
    companion,
    protocol,
    run: () =>
      runSchedulerPhases({
        companion,
        protocol,
        budget,
        profile,
        phases,
        sample: async () => row(Date.now()),
      }),
  };
}
test("three simulated-clock controller phases preserve FAIL FPS and eight-client load; close follows final CPU endpoint", async (context) => {
  const f = fixture(context),
    result = await drive(f.run(), context);
  assert.equal(result.observations_verified, true);
  assert.deepEqual(
    result.phases.map((p) => p.name),
    ["control_before", "instrumented", "control_after"],
  );
  for (const p of result.phases) {
    assert.equal(p.capacity_approval, false);
    assert.equal(p.observation.original_source_fps_gate, "FAIL");
    assert.equal(p.start_receipts.voice_in, 56);
    assert.equal(p.end_receipts.screen_receivers, 7);
    assert.ok(p.observation.observed_ms >= 10000);
  }
  assert.ok(f.events.indexOf("end:control_after") < f.events.indexOf("close"));
  assert.ok(!f.events.some((e) => /install|VideoFrame|writer/.test(e)));
  f.budget.close();
});
test("missing receiver and failed close remain failures and still close before returning", async (context) => {
  const f = fixture(context, { missingReceiver: true });
  await assert.rejects(
    drive(f.run(), context),
    (e) => e.code === "COHORT_LOAD_CHANGED",
  );
  assert.equal(f.events.at(-1), "close");
  f.budget.close();
});
test("global expiry during attach cannot issue a late begin and cleanup is still attempted", async (context) => {
  const f = fixture(context, { hangAttach: true });
  await assert.rejects(drive(f.run(), context), (e) => e.code === "DEADLINE");
  assert.deepEqual(f.events, ["attach:", "close"]);
  f.budget.close();
});
test("trace validation failure at close cannot become diagnostic COMPLETE", async (context) => {
  const f = fixture(context, { invalidClose: true });
  await assert.rejects(
    drive(f.run(), context),
    (e) => e.code === "PS_CLOSE_NOT_VERIFIED",
  );
  f.budget.close();
});
test("cleanup failure preserves the primary media/barrier error separately", async (context) => {
  const f = fixture(context, { missingReceiver: true });
  f.companion.close = async () => {
    throw Object.assign(new Error("private detail"), {
      code: "COMPANION_CLEANUP",
    });
  };
  await assert.rejects(
    drive(f.run(), context),
    (e) =>
      e.code === "COHORT_LOAD_CHANGED" &&
      e.cleanup_error_code === "COMPANION_CLEANUP",
  );
  f.budget.close();
});
test("pipe stream errors are sanitized and never become unhandled EPIPE events", async () => {
  for (const [stream, expected] of [
    ["stdin", "COMPANION_STDIN"],
    ["stdout", "COMPANION_STDOUT"],
    ["stderr", "COMPANION_STDERR"],
  ]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.kill = () => child.emit("close", 1);
    child.stdin.write = () =>
      queueMicrotask(() =>
        child[stream].emit("error", new Error("private pipe failure")),
      );
    const port = createCompanion({
        script: "private.ps1",
        spawnChild: () => child,
      }),
      budget = createBudget();
    await assert.rejects(
      port.command("attach", undefined, budget),
      (e) => e.code === expected && !e.message.includes("private"),
    );
    await assert.rejects(port.close());
    budget.close();
  }
});
test("pipe sends only fixed operations, strips seed and waits for closed before child exit", async () => {
  let child, seenEnv;
  const commands = [];
  const port = createCompanion({
    script: "private-test.ps1",
    env: {
      HARMONY_EXE_WAN_SEED: "synthetic-secret",
      GH_TOKEN: "synthetic-token",
    },
    spawnChild: (_bin, _args, options) => {
      seenEnv = options.env;
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin = {
        write(text, callback) {
          const q = JSON.parse(text);
          commands.push(q);
          queueMicrotask(() => {
            child.stdout.write(
              JSON.stringify(
                reply({ attach: "attached", close: "closed" }[q.command]),
              ) + "\n",
            );
            callback();
            if (q.command === "close") child.emit("close", 0);
          });
        },
      };
      return child;
    },
  });
  const budget = createBudget();
  await port.command("attach", undefined, budget);
  await port.close();
  assert.deepEqual(commands, [{ command: "attach" }, { command: "close" }]);
  assert.equal(seenEnv.HARMONY_EXE_WAN_SEED, undefined);
  assert.equal(seenEnv.GH_TOKEN, undefined);
  budget.close();
});
test("a late attach reply cannot satisfy close or trigger a new begin", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const child = new EventEmitter(),
    commands = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.kill = () => {};
  child.stdin.write = (text, callback) => {
    const q = JSON.parse(text);
    commands.push(q.command);
    queueMicrotask(() => {
      callback();
      if (q.command === "close") {
        child.stdout.write(JSON.stringify(reply("attached")) + "\n");
        child.stdout.write(JSON.stringify(reply("closed")) + "\n");
        child.emit("close", 0);
      }
    });
  };
  const port = createCompanion({ script: "unit.ps1", spawnChild: () => child }),
    budget = createBudget({ now: () => Date.now(), duration: 20 });
  const pending = port.command("attach", undefined, budget);
  await flush();
  const rejected = assert.rejects(pending, (e) => e.code === "DEADLINE");
  context.mock.timers.tick(21);
  await rejected;
  budget.close();
  assert.equal((await port.close()).event, "closed");
  assert.deepEqual(commands, ["attach", "close"]);
});
test("concurrent and invalid operations never overwrite the pending pipe owner", async () => {
  const child = new EventEmitter(),
    commands = [];
  let release;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.kill = () => {};
  child.stdin.write = (text, callback) => {
    const q = JSON.parse(text);
    commands.push(q.command);
    if (q.command === "attach")
      release = () => {
        child.stdout.write(JSON.stringify(reply("attached")) + "\n");
        callback();
      };
    else {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify(reply("closed")) + "\n");
        callback();
        child.emit("close", 0);
      });
    }
  };
  const port = createCompanion({ script: "unit.ps1", spawnChild: () => child }),
    budget = createBudget();
  await assert.rejects(
    port.command("toString", undefined, budget),
    (e) => e.code === "COMPANION_COMMAND",
  );
  const pending = port.command("attach", undefined, budget);
  await assert.rejects(
    port.command("attach", undefined, budget),
    (e) => e.code === "COMPANION_UNAVAILABLE",
  );
  await flush();
  release();
  await pending;
  await port.close();
  assert.deepEqual(commands, ["attach", "close"]);
  budget.close();
});

test("a valid fatal closed reply preserves sanitized cause before and during attach", async () => {
  for (const early of [false, true]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.kill = () => {};
    const fatal = () => {
      child.stdout.write(
        JSON.stringify(
          reply("closed", null, {
            status: "NOT_VERIFIED",
            failure_code: "native_compile_unverified",
            native_error_code: 5,
          }),
        ) + "\n",
      );
      child.emit("close", 2);
    };
    child.stdin.write = (_text, callback) =>
      queueMicrotask(() => {
        fatal();
        callback();
      });
    const port = createCompanion({
        script: "synthetic.ps1",
        spawnChild: () => child,
      }),
      budget = createBudget();
    if (early) fatal();
    await assert.rejects(
      port.command("attach", undefined, budget),
      (e) =>
        e.code === "COMPANION_FATAL" &&
        e.companion_failure_code === "native_compile_unverified" &&
        e.native_error_code === 5,
    );
    await assert.rejects(port.close());
    budget.close();
  }
});

test("fatal handling rejects unknown enums, private fields and observed close out of order", async () => {
  for (const patch of [
    { failure_code: "unknown_failure" },
    { handle: 123 },
    { status: "OBSERVED" },
    { phase: "instrumented" },
    { native_error_code: "private error" },
  ]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.write = (_text, callback) =>
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify(
            reply("closed", null, {
              status: "NOT_VERIFIED",
              failure_code: "native_compile_unverified",
              ...patch,
            }),
          ) + "\n",
        );
        callback();
        child.emit("close", 2);
      });
    const port = createCompanion({
        script: "synthetic.ps1",
        spawnChild: () => child,
      }),
      budget = createBudget();
    await assert.rejects(
      port.command("attach", undefined, budget),
      (e) =>
        e.code === "COMPANION_SCHEMA" &&
        e.companion_failure_code === undefined &&
        e.native_error_code === undefined,
    );
    await assert.rejects(port.close());
    budget.close();
  }
});

test("legitimate NOT_VERIFIED operations retain their sanitized cause", async (context) => {
  for (const operation of ["attach", "begin", "end"])
    await context.test(operation, async (subcontext) => {
      const f = fixture(subcontext),
        original = f.companion.command;
      f.companion.command = async (command, phase) =>
        command === operation
          ? reply(
              { attach: "attached", begin: "begun", end: "ended" }[command],
              phase ?? null,
              {
                status: "NOT_VERIFIED",
                failure_code: "window_not_unique",
                native_error_code: 5,
              },
            )
          : original(command, phase);
      await assert.rejects(
        drive(f.run(), subcontext),
        (e) =>
          e.code === "PS_NOT_VERIFIED" &&
          e.companion_failure_code === "window_not_unique" &&
          e.native_error_code === 5,
      );
      assert.equal(f.phases.length, operation === "attach" ? 0 : 1);
      assert.equal(f.events.at(-1), "close");
      f.budget.close();
    });
});

test("NOT_VERIFIED cleanup preserves its own cause without replacing the primary load failure", async (context) => {
  const f = fixture(context, { missingReceiver: true });
  f.companion.close = async () =>
    reply("closed", null, {
      status: "NOT_VERIFIED",
      failure_code: "owned_session_cleanup_not_verified",
      native_error_code: 5,
    });
  await assert.rejects(
    drive(f.run(), context),
    (e) =>
      e.code === "COHORT_LOAD_CHANGED" &&
      e.cleanup_error_code === "PS_CLOSE_NOT_VERIFIED" &&
      e.cleanup_companion_failure_code ===
        "owned_session_cleanup_not_verified" &&
      e.cleanup_native_error_code === 5,
  );
  f.budget.close();
});
