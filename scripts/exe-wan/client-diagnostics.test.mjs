import test from "node:test";
import assert from "node:assert/strict";
import { createClientDiagnostics } from "./client-diagnostics.mjs";
const trace = (extra = {}) => ({
  method: "Runtime.evaluate",
  id: 42,
  stage: "capture.preview.wait",
  utc: "2026-11-16T11:00:00.000Z",
  socket_state: "open",
  state: "timeout",
  elapsed_ms: 30000,
  timeout_ms: 30000,
  ...extra,
});
test("publisher trace retains only fixed metadata, is bounded, copies rows and cannot change command behavior", () => {
  const emitted = [],
    diagnostics = createClientDiagnostics(0, {
      limit: 3,
      onTrace: (row) => {
        emitted.push(row);
        throw Error("observer failure");
      },
    });
  const row = trace({
    params: { expression: "SECRET", postData: "SECRET" },
    headers: { authorization: "SECRET" },
    token: "SECRET",
  });
  assert.doesNotThrow(() => diagnostics.onCommandTrace(row));
  row.id = 999;
  diagnostics.onCommandTrace(
    trace({ method: "Input.insertText", params: { text: "SECRET" } }),
  );
  diagnostics.onCommandTrace(trace({ stage: "SECRET" }));
  diagnostics.onCommandTrace(trace({ state: "SECRET" }));
  for (let id = 43; id <= 46; id++) diagnostics.onCommandTrace(trace({ id }));
  const report = {};
  diagnostics.finish(report);
  assert.deepEqual(
    report.command_trace.map((r) => r.id),
    [44, 45, 46],
  );
  assert.equal(report.command_trace_dropped, 2);
  assert.equal(emitted.length, 3);
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
  report.command_trace[0].id = -1;
  const next = {};
  diagnostics.finish(next);
  assert.equal(next.command_trace[0].id, 44);
});
test("only publisher receives the optional passive trace callback; invalid client indices are rejected", () => {
  for (let index = 1; index < 8; index++) {
    const d = createClientDiagnostics(index);
    assert.equal(d.onCommandTrace, undefined);
    const report = {};
    d.finish(report);
    assert.equal(report.command_trace_enabled, false);
  }
  for (const bad of [-1, 8, NaN, "0"])
    assert.throws(() => createClientDiagnostics(bad));
});
test("failure stage and failing command are frozen before diagnostics issue their own CDP commands", async () => {
  const d = createClientDiagnostics(0),
    app = {
      cdp: { stage: "capture.preview.wait" },
      sample() {
        throw Error("must use bounded collector");
      },
    };
  d.onCommandTrace(trace());
  const report = { status: "FAIL" };
  d.noteFailure(report, app);
  await d.collectFailure(report, app, {
    collector: async (value) => {
      assert.equal(value, app);
      app.cdp.stage = "failure.stats";
      d.onCommandTrace(
        trace({ id: 43, stage: "failure.stats", state: "completed" }),
      );
      return {
        dom: { sharing_open: true },
        stats: {
          at: 1,
          peers: [],
          native_requests: [
            {
              command: "native_capture_start",
              state: "completed",
              at: 2,
              http_status: 200,
              body: "SECRET",
              headers: { secret: "SECRET" },
            },
          ],
          headers: { secret: "SECRET" },
          postData: "SECRET",
          access_token: "SECRET",
        },
      };
    },
  });
  d.finish(report);
  assert.equal(report.failure_stage, "capture.preview.wait");
  assert.equal(report.last_command.stage, "capture.preview.wait");
  assert.equal(report.last_command.state, "timeout");
  assert.equal(report.command_trace.at(-1).stage, "failure.stats");
  assert.equal(report.status, "FAIL");
  assert.equal(report.final_sample.at, 1);
  assert.deepEqual(report.final_sample.native_requests, [
    {
      command: "native_capture_start",
      state: "completed",
      at: 2,
      http_status: 200,
    },
  ]);
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
  assert.equal(report.failure_diagnostics.stats, undefined);
});
test("missing bounded stats leaves no invented final_sample while independent DOM/debugger/OS evidence survives", async () => {
  const d = createClientDiagnostics(0),
    report = { status: "FAIL" };
  d.noteFailure(report, { cdp: { stage: "capture.choose.click" } });
  await d.collectFailure(
    report,
    {},
    {
      collector: async () => ({
        dom_error: { name: "Error" },
        captures: { count: 0 },
        debugger_error: { name: "Error" },
        fresh_renderer_error: { name: "Error" },
        owned_windows: { completion: "PARTIAL_OR_UNAVAILABLE", records: [] },
        stats_error: { name: "Error" },
      }),
    },
  );
  assert.equal("final_sample" in report, false);
  assert.equal(report.failure_diagnostics.captures.count, 0);
  assert.equal(
    report.failure_diagnostics.owned_windows.completion,
    "PARTIAL_OR_UNAVAILABLE",
  );
  assert.equal(report.status, "FAIL");
});
test("collector exceptions do not erase the original error/status or serialize exception messages", async () => {
  const d = createClientDiagnostics(0),
    report = { status: "FAIL", error: "CDP timeout: Runtime.evaluate" };
  await assert.doesNotReject(
    d.collectFailure(
      report,
      {},
      {
        collector: async () => {
          throw Error("SECRET");
        },
      },
    ),
  );
  assert.equal(report.error, "CDP timeout: Runtime.evaluate");
  assert.equal(report.status, "FAIL");
  assert.equal(report.failure_diagnostics_error.name, "Error");
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
});
test("real failure collector retains independent evidence and reads bounded stats last through the client adapter", async () => {
  const d = createClientDiagnostics(0),
    order = [],
    report = { status: "FAIL", error: "CDP timeout: Runtime.evaluate" };
  const app = {
    cdp: {
      url: "ws://127.0.0.1/devtools/page/owned",
      stage: "capture.preview.wait",
      setStage(stage) {
        this.stage = stage;
        order.push(stage);
      },
      async evaluate(_expression, _gesture, timeout) {
        assert.equal(timeout, 2000);
        throw Error("renderer blocked");
      },
    },
    fixtureDiagnostic: () => ({ output: "WINDOW 42 1280x720 TARGET 30\n" }),
    async sample(timeout) {
      assert.equal(timeout, 2000);
      order.push("stats");
      return {
        at: 123,
        peers: [],
        native_requests: [
          {
            command: "native_capture_start",
            state: "completed",
            at: 1,
            body: "SECRET",
          },
        ],
      };
    },
  };
  d.noteFailure(report, app);
  await d.collectFailure(report, app, {
    options: {
      runId: "12345",
      fetcher: async (_url, options) => {
        assert.ok(options.signal);
        throw Error("HTTP blocked");
      },
      connect: () => ({
        setStage() {},
        async send(_method, _params, timeout) {
          assert.equal(timeout, 2000);
          throw Error("fresh debugger blocked");
        },
        close() {},
      }),
      windows: (_exe, _args, options) => {
        assert.equal(options.timeout, 8000);
        order.push("windows");
        return {
          status: 0,
          stdout: '{"kind":"owned_native_windows","windows":[]}\n',
        };
      },
    },
  });
  assert.ok(order.indexOf("windows") < order.indexOf("stats"));
  assert.equal(order.at(-1), "stats");
  assert.equal(report.final_sample.at, 123);
  assert.equal(report.failure_diagnostics.owned_windows.completion, "COMPLETE");
  assert.equal(report.failure_stage, "capture.preview.wait");
  assert.equal(report.status, "FAIL");
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
});
