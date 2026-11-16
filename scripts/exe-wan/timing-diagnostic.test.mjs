import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  installNativeTimingDiagnostic,
  createAckTimingObserver,
  assertTimingContext,
  measureTimingPhases,
} from "./timing-diagnostic.mjs";

function fixture({ frameWritable = true, writerWritable = true } = {}) {
  let now = 0,
    resolve,
    reject;
  const calls = [],
    failure = Error("original failure");
  class Frame {
    #brand = true;
    constructor(...args) {
      calls.push({ kind: "constructor", args, newTarget: new.target });
      now += 4;
      if (args[0] === failure) throw failure;
      if (args[1]) void args[1].format;
    }
    brand() {
      return this.#brand;
    }
  }
  const pending = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  class Writer {
    write(...args) {
      calls.push({ kind: "write", args, receiver: this });
      now += 2;
      if (args[1] === failure) throw failure;
      return pending;
    }
  }
  const originalWrite = Writer.prototype.write;
  Object.defineProperty(Writer.prototype, "write", {
    value: originalWrite,
    writable: writerWritable,
    configurable: writerWritable,
  });
  const context = {
    location: { origin: "http://tauri.localhost" },
    __TAURI_INTERNALS__: {},
    performance: { now: () => now },
    Promise,
    WritableStreamDefaultWriter: Writer,
  };
  context.window = context;
  Object.defineProperty(context, "VideoFrame", {
    value: Frame,
    writable: frameWritable,
    configurable: frameWritable,
  });
  vm.runInNewContext(
    `(${installNativeTimingDiagnostic.toString()})()`,
    context,
  );
  return {
    context,
    qa: context.__nativeTimingDiagnostic,
    Frame,
    Writer,
    originalWrite,
    calls,
    failure,
    pending,
    resolve,
    reject,
    advance: (n) => {
      now += n;
    },
  };
}
test("constructor forwards exact argument identities/newTarget and preserves frame brand; only plain BGRX inputs are timed", () => {
  const f = fixture(),
    bytes = new Uint8Array([1, 2]),
    init = { format: "BGRX", codedWidth: 1, codedHeight: 1 };
  const frame = new f.context.VideoFrame(bytes, init);
  assert.ok(frame instanceof f.Frame);
  assert.ok(frame instanceof f.context.VideoFrame);
  assert.equal(frame.brand(), true);
  assert.equal(f.calls[0].args[0], bytes);
  assert.equal(f.calls[0].args[1], init);
  assert.equal(f.calls[0].newTarget, f.context.VideoFrame);
  class Sub extends f.context.VideoFrame {}
  const sub = new Sub(bytes, init);
  assert.ok(sub instanceof Sub);
  assert.equal(f.calls[1].newTarget, Sub);
  let reads = 0;
  new f.context.VideoFrame(bytes, {
    get format() {
      reads++;
      return "BGRX";
    },
  });
  assert.equal(reads, 1);
  const stats = f.qa.snapshot();
  assert.equal(stats.constructor_bgrx.count, 2);
  assert.equal(stats.constructor_bgrx.mean_ms, 4);
});
test("write delegates this/arguments, returns the exact original Promise and separately measures synchronous and settled durations", async () => {
  const f = fixture(),
    frame = new f.context.VideoFrame(new Uint8Array(4), { format: "BGRX" }),
    writer = new f.Writer(),
    extra = {};
  const result = writer.write(frame, extra);
  assert.equal(result, f.pending);
  assert.equal(f.calls.at(-1).receiver, writer);
  assert.equal(f.calls.at(-1).args[0], frame);
  assert.equal(f.calls.at(-1).args[1], extra);
  f.advance(7);
  f.resolve("unchanged");
  assert.equal(await result, "unchanged");
  await Promise.resolve();
  const stats = f.qa.snapshot();
  assert.equal(stats.write_sync.mean_ms, 2);
  assert.equal(stats.write_settled.mean_ms, 9);
  assert.equal(stats.write_fulfilled, 1);
});
test("original constructor/write exceptions remain the exact same objects and rejected Promise is not replaced", async () => {
  const f = fixture(),
    init = { format: "BGRX" };
  assert.throws(
    () => new f.context.VideoFrame(f.failure, init),
    (error) => error === f.failure,
  );
  const frame = new f.context.VideoFrame(null, init),
    writer = new f.Writer();
  assert.throws(
    () => writer.write(frame, f.failure),
    (error) => error === f.failure,
  );
  const result = writer.write(frame);
  assert.equal(result, f.pending);
  f.reject(f.failure);
  await assert.rejects(result, (error) => error === f.failure);
  await Promise.resolve();
  const stats = f.qa.snapshot();
  assert.equal(stats.constructor_errors, 1);
  assert.equal(stats.write_errors, 1);
  assert.equal(stats.write_rejected, 1);
});
test("non-frame writes pass through without observations, and unobserved durations are NOT_VERIFIED/null rather than zero", async () => {
  const f = fixture();
  assert.equal(new f.Writer().write({ format: "BGRX" }), f.pending);
  f.resolve();
  await f.pending;
  const s = f.qa.snapshot();
  for (const key of ["constructor_bgrx", "write_sync", "write_settled"]) {
    assert.equal(s[key].status, "NOT_VERIFIED");
    assert.equal(s[key].count, 0);
    for (const n of ["mean_ms", "p50_ms", "p95_ms", "max_ms"])
      assert.equal(s[key][n], null);
  }
});
test("restore returns both originals, is idempotent and fences pending observations after removal", async () => {
  const f = fixture(),
    frame = new f.context.VideoFrame(null, { format: "BGRX" });
  new f.Writer().write(frame);
  const closed = f.qa.restore();
  assert.equal(f.context.VideoFrame, f.Frame);
  assert.equal(f.Writer.prototype.write, f.originalWrite);
  assert.equal(closed.restore.video_frame, "RESTORED");
  assert.equal(closed.restore.writer_write, "RESTORED");
  f.advance(100);
  f.resolve();
  await f.pending;
  await Promise.resolve();
  assert.equal(f.qa.snapshot().write_settled.count, 0);
  assert.equal(f.qa.restore().restore.video_frame, "RESTORED");
});
test("restore cannot overwrite a newer wrapper installed by another owner", () => {
  const f = fixture(),
    foreignFrame = function () {},
    foreignWrite = function () {};
  f.context.VideoFrame = foreignFrame;
  f.Writer.prototype.write = foreignWrite;
  const s = f.qa.restore();
  assert.equal(f.context.VideoFrame, foreignFrame);
  assert.equal(f.Writer.prototype.write, foreignWrite);
  assert.equal(s.restore.video_frame, "NOT_OWNER");
  assert.equal(s.restore.writer_write, "NOT_OWNER");
});
test("non-interceptable properties remain byte-for-byte original and are explicitly NOT_VERIFIED", () => {
  const f = fixture({ frameWritable: false, writerWritable: false });
  assert.equal(f.context.VideoFrame, f.Frame);
  assert.equal(f.Writer.prototype.write, f.originalWrite);
  const s = f.qa.restore();
  assert.equal(s.interception.video_frame, "NOT_VERIFIED");
  assert.equal(s.interception.writer_write, "NOT_VERIFIED");
  assert.equal(s.constructor_bgrx.mean_ms, null);
});
test("ACK observer only reads POST native_capture_ack timing and never exports URLs, bodies, headers or error messages", () => {
  const qa = createAckTimingObserver();
  qa.begin("control_before");
  const request = (
    id,
    method = "POST",
    url = "http://ipc.localhost/native_capture_ack",
  ) => ({
    method: "Network.requestWillBeSent",
    params: {
      requestId: id,
      timestamp: 10,
      request: {
        method,
        url,
        headers: { secret: "SECRET" },
        postData: "SECRET",
      },
    },
  });
  qa.onEvent(request("options", "OPTIONS"));
  qa.onEvent(request("other", "POST", "https://server.invalid/SECRET"));
  qa.onEvent(request("ack1"));
  qa.onEvent({
    method: "Network.loadingFinished",
    params: { requestId: "ack1", timestamp: 10.012, body: "SECRET" },
  });
  qa.onEvent(request("ack2"));
  qa.onEvent({
    method: "Network.loadingFailed",
    params: { requestId: "ack2", timestamp: 10.02, errorText: "SECRET" },
  });
  qa.end("control_before");
  const s = qa.snapshot("control_before");
  assert.equal(s.requests, 2);
  assert.equal(s.completed, 1);
  assert.equal(s.failed, 1);
  assert.ok(Math.abs(s.completed_ms.mean_ms - 12) < 1e-8);
  assert.ok(Math.abs(s.failed_ms.mean_ms - 20) < 1e-8);
  for (const banned of [
    "SECRET",
    "http",
    "headers",
    "postData",
    "body",
    "errorText",
  ])
    assert.equal(JSON.stringify(s).includes(banned), false);
});
test("ACK phases keep requests at their start phase, include pending/late completion and do not invent zero-duration samples", () => {
  const qa = createAckTimingObserver();
  qa.begin("control_before");
  qa.onEvent({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "late",
      timestamp: 3,
      request: {
        method: "POST",
        url: "http://ipc.localhost/native_capture_ack",
      },
    },
  });
  qa.end("control_before");
  qa.begin("instrumented");
  qa.onEvent({
    method: "Network.loadingFinished",
    params: { requestId: "late", timestamp: 3.1 },
  });
  qa.end("instrumented");
  assert.equal(qa.snapshot("control_before").completed, 1);
  assert.equal(qa.snapshot("control_before").pending_at_boundary, 1);
  const empty = qa.snapshot("instrumented");
  assert.equal(empty.completed_ms.mean_ms, null);
  assert.equal(empty.completed_ms.status, "NOT_VERIFIED");
  assert.throws(() => qa.begin("other"));
  assert.throws(() => qa.begin("control_before"));
});
test("timing context is limited to public hosted Windows main and pinned046 performance60 profiles", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    HARMONY_TIMING_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.6",
  };
  const profile = { id: "1080p60", fps: 60 };
  assert.doesNotThrow(() => assertTimingContext(env, "win32", profile));
  for (const [field, value] of Object.entries({
    GITHUB_ACTIONS: "false",
    GITHUB_REPOSITORY: "other/repo",
    GITHUB_REF: "refs/heads/dev",
    RUNNER_ENVIRONMENT: "self-hosted",
    HARMONY_TIMING_PUBLIC_REPOSITORY: "false",
    HARMONY_EXE_RELEASE: "0.4.5",
  }))
    assert.throws(() =>
      assertTimingContext({ ...env, [field]: value }, "win32", profile),
    );
  assert.throws(() => assertTimingContext(env, "darwin", profile));
  assert.throws(() =>
    assertTimingContext(env, "win32", { id: "720p30", fps: 30 }),
  );
});

function phaseFixture() {
  const f = fixture();
  f.qa.restore();
  delete f.context.__nativeTimingDiagnostic;
  const capture = {
    index: 0,
    track_id: "same-compiled-track",
    ready: "live",
    kind: "native",
    backend: "native-wgc",
    label: "native-window:42",
    settings_source: "native-frame-metadata",
    settings: { width: 1920, height: 1080, frameRate: 53.5 },
  };
  f.context.__exeWan = { captureSnapshots: () => [capture] };
  const calls = [],
    waits = [],
    phases = [],
    ack = createAckTimingObserver();
  let failAt = 0,
    installTimeout = false;
  const app = {
    cdp: {
      setStage() {},
      async evaluate(expression) {
        calls.push(expression);
        const value = vm.runInNewContext(expression, f.context);
        if (
          installTimeout &&
          expression.includes("function installNativeTimingDiagnostic")
        )
          throw Error("simulated lost CDP install response");
        return value;
      },
    },
    async measureCapture(index, duration) {
      calls.push([index, duration]);
      if (failAt === calls.filter(Array.isArray).length)
        throw Error("source observation failed");
      new f.context.VideoFrame(null, { format: "BGRX" });
      return {
        ...capture,
        pixel_width: 1920,
        pixel_height: 1080,
        sampled_sizes: ["1920x1080"],
        light_pixels: 14300,
        colored_pixels: 14300,
        processor_source_fps: 53,
        distinct_marker_fps: 52,
        marker_copy_calls_delta: 530,
        marker_copy_total_ms_delta: 53,
      };
    },
  };
  return {
    ...f,
    capture,
    calls,
    phases,
    ack,
    app,
    waits,
    failAt: (value) => {
      failAt = value;
    },
    loseInstallResponse: () => {
      installTimeout = true;
    },
    run: () =>
      measureTimingPhases(
        app,
        { captures: [capture], owned_window_handle: 42 },
        {
          id: "1080p60",
          width: 1920,
          height: 1080,
          fps: 60,
          min_source_fps: 54,
        },
        phases,
        ack,
        async (ms) => {
          waits.push(ms);
        },
      ),
  };
}
test("three phases retain the same normal10s capture, preserve failed quality gates and restore wrappers before the last control", async () => {
  const f = phaseFixture();
  await f.run();
  assert.deepEqual(f.waits, [5000, 2000, 2000]);
  assert.deepEqual(f.calls.filter(Array.isArray), [
    [0, 10000],
    [0, 10000],
    [0, 10000],
  ]);
  assert.deepEqual(
    f.phases.map((p) => p.name),
    ["control_before", "instrumented", "control_after"],
  );
  assert.deepEqual(
    f.phases.map((p) => p.original_quality_gate.status),
    ["FAIL", "FAIL", "FAIL"],
  );
  assert.ok(f.phases.every((p) => p.capacity_approval === false));
  assert.equal(f.phases[0].timings, undefined);
  assert.equal(f.phases[1].timings.constructor_bgrx.count, 1);
  assert.equal(f.phases[2].timings, undefined);
  assert.equal(f.context.VideoFrame, f.Frame);
  assert.equal(f.Writer.prototype.write, f.originalWrite);
  assert.equal(f.phases[2].native_producer_fps, 53.5);
  assert.equal(f.phases[2].marker_copy_mean_ms, 0.1);
});
test("measurement failure during instrumentation restores both originals and does not run the final control", async () => {
  const f = phaseFixture();
  f.failAt(2);
  await assert.rejects(f.run(), /source observation failed/);
  assert.equal(f.context.VideoFrame, f.Frame);
  assert.equal(f.Writer.prototype.write, f.originalWrite);
  assert.equal(f.phases.length, 2);
});
test("even a lost install response attempts bounded restoration after the script already installed wrappers", async () => {
  const f = phaseFixture();
  f.loseInstallResponse();
  await assert.rejects(f.run(), /lost CDP/);
  assert.equal(f.context.VideoFrame, f.Frame);
  assert.equal(f.Writer.prototype.write, f.originalWrite);
  assert.equal(f.calls.filter(Array.isArray).length, 1);
});
