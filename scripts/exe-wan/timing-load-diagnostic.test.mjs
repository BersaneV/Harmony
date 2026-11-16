import test from "node:test";
import assert from "node:assert/strict";
import {
  assertLoadTimingContext,
  createBudget,
  createCohortProtocol,
  resolveFixtureUsers,
  createLoadMonitor,
  projectTimingPhase,
  runPublisherTiming,
  runReceiverTiming,
  timingLoadPhases,
} from "./timing-load-diagnostic.mjs";
import * as diagnostic from "./timing-load-diagnostic.mjs";

const profile = {
  id: "1440p60",
  width: 2560,
  height: 1440,
  fps: 60,
  bitrate_mbps: 16,
  min_source_fps: 54,
  min_displayed_fps: 54,
};
const owned = { index: 0, handle: 42, track_id: "private-source" };
const users = Array.from({ length: 8 }, (_, index) => ({
  index,
  id: `private-user-${index}`,
}));
const receipt = (index) => ({
  voice_in: 7,
  voice_out: 7,
  sfu_in: index === 0 ? 0 : 1,
  sfu_out: index === 0 ? 1 : 0,
  checks: 2,
});
const message = (index, action, stage) => ({
  probe: "native-timing-load-v1",
  action,
  index,
  author_id: users[index].id,
  ...(stage ? { stage } : {}),
  receipt: receipt(index),
});
const code = (expected) => (error) => error.code === expected;
const flush = async () => {
  for (let i = 0; i < 120; i++) await Promise.resolve();
};
async function drive(promise, context, maximum = 300) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < maximum && !done; i++) {
    await flush();
    context.mock.timers.tick(1000);
  }
  assert.ok(done, "Bounded orchestration must settle");
  return promise;
}
function snapshot(index = 0, at = 1000) {
  const frames = Math.floor(at * 0.027),
    settings = { width: 2560, height: 1440, frameRate: 27.4 };
  const peers = Array.from({ length: 7 }, (_, pc) => ({
    pc,
    route: "p2p",
    state: "connected",
    tracks: [],
    rtp: [
      {
        direction: "inbound",
        kind: "audio",
        source: "microphone",
        stats_id: `private-in-${pc}`,
        ssrc: 100 + pc,
        track_id: `private-mic-${pc}`,
        bytesReceived: at * 10,
        totalSamplesDuration: at / 1000,
        totalAudioEnergy: at / 10000,
      },
      {
        direction: "outbound",
        kind: "audio",
        source: "microphone",
        stats_id: `private-out-${pc}`,
        ssrc: 200 + pc,
        track_id: "private-local-mic",
        bytesSent: at * 10,
      },
    ],
  }));
  const screen = {
    direction: index === 0 ? "outbound" : "inbound",
    kind: "video",
    source: "screen",
    stats_id: "private-screen-stat",
    ssrc: 555,
    track_id: index === 0 ? owned.track_id : "private-remote-source",
    codec: "video/VP8",
    frameWidth: 2560,
    frameHeight: 1440,
    timestamp: at,
    totalEncodeTime: frames * 0.02,
  };
  if (index === 0)
    Object.assign(screen, {
      sender_active: true,
      framesEncoded: frames,
      bytesSent: frames * 100,
      sender_parameters: {
        encodings: [
          {
            active: true,
            maxBitrate: 16e6,
            maxFramerate: 60,
            scaleResolutionDownBy: 1,
          },
        ],
        degradationPreference: "maintain-resolution",
        contentHint: "detail",
      },
      media_source: {
        stats_id: "private-media-source",
        track_id: owned.track_id,
        frames,
      },
    });
  else
    Object.assign(screen, {
      framesDecoded: frames,
      bytesReceived: frames * 100,
    });
  peers.push({
    pc: 7,
    route: "sfu",
    state: "connected",
    rtp: [screen],
    tracks:
      index === 0
        ? []
        : [
            {
              kind: "video",
              source: "screen",
              ready: "live",
              track_id: screen.track_id,
              video: {
                width: 2560,
                height: 1440,
                ready_state: 4,
                paused: false,
                total_frames: frames,
              },
            },
          ],
  });
  return {
    at,
    wall_utc: at,
    peers,
    ui: {
      call_header: "Em chamada · 8 participantes",
      self_microphones: [{ ready: "live", enabled: true }],
    },
    captures:
      index === 0
        ? [
            {
              index: 0,
              kind: "native",
              backend: "native-wgc",
              label: "native-window:42",
              settings_source: "native-frame-metadata",
              ready: "live",
              track_id: owned.track_id,
              settings,
              processor_status: "running",
              processor_error: null,
              marker_copy_errors: 0,
              processor_frames: frames,
              distinct_marker_frames: Math.floor(at * 0.026),
              processor_sizes: ["2560x1440"],
            },
          ]
        : [],
    native_requests: [{ body: "private-secret", headers: "private-secret" }],
  };
}

test("only exact048, public hosted Windows main and unchanged named60 profiles are admitted", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    HARMONY_TIMING_LOAD_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.8",
  };
  assert.doesNotThrow(() => assertLoadTimingContext(env, "win32", profile, 0));
  for (const bad of [
    { HARMONY_EXE_RELEASE: "0.4.6" },
    { HARMONY_EXE_RELEASE: "0.4.9" },
    { GITHUB_REF: "refs/heads/other" },
    { HARMONY_TIMING_LOAD_PUBLIC_REPOSITORY: "false" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { HARMONY_ENCODER_PROBE: "true" },
  ])
    assert.throws(() =>
      assertLoadTimingContext({ ...env, ...bad }, "win32", profile, 0),
    );
  assert.throws(() => assertLoadTimingContext(env, "darwin", profile, 0));
  assert.throws(() =>
    assertLoadTimingContext(env, "win32", { ...profile, fps: 30 }, 0),
  );
  assert.throws(() => assertLoadTimingContext(env, "win32", profile, 8));
});
test("operation and global deadlines reject late values and pending reads rather than establishing readiness", async () => {
  let now = 0;
  const budget = createBudget({ now: () => now, duration: 100 });
  await assert.rejects(
    budget.run(async (remaining) => {
      assert.equal(remaining, 10);
      now = 11;
      return true;
    }, 10),
    code("DEADLINE"),
  );
  await assert.rejects(
    budget.run(() => new Promise(() => {}), 2),
    code("DEADLINE"),
  );
  now = 101;
  await assert.rejects(
    budget.run(() => true),
    code("DEADLINE"),
  );
  budget.close();
});
test("fixture identities are discovered by all eight exact synthetic usernames without accepting admins or extra members", () => {
  const names = users.map((_, i) => `owned-${i}`),
    members = names.map((username, i) => ({
      username,
      id: users[i].id,
      is_admin: false,
    }));
  assert.deepEqual(resolveFixtureUsers(members, names), users);
  assert.throws(() => resolveFixtureUsers([...members, members[0]], names));
  assert.throws(() =>
    resolveFixtureUsers(
      members.map((m, i) => (i === 4 ? { ...m, is_admin: true } : m)),
      names,
    ),
  );
  assert.throws(() =>
    resolveFixtureUsers(
      members.map((m, i) => (i === 4 ? { ...m, id: members[0].id } : m)),
      names,
    ),
  );
});
test("network barriers bind authenticated authors, deduplicate clients and reject foreign stage/owner receipts", async () => {
  const budget = createBudget({ duration: 500 }),
    rows = users.map((_, i) => message(i, "phase-ready", "instrumented"));
  let sent;
  const p = createCohortProtocol({
    index: 0,
    users,
    list: async () => [
      ...rows,
      rows[0],
      { ...rows[7], index: 0 },
      { ...rows[0], stage: "future" },
    ],
    send: async (value) => {
      sent = value;
    },
    budget,
  });
  assert.equal(
    (await p.wait("phase-ready", 8, { stage: "instrumented" })).length,
    8,
  );
  await p.post("prepare", { stage: "instrumented" });
  assert.equal(sent.index, 0);
  const forged = [...rows.slice(0, 7), { ...rows[7], author_id: users[6].id }];
  assert.equal(p.parse(forged).length, 7);
  assert.equal(
    p.parse([{ ...message(2, "prepare", "instrumented") }]).length,
    0,
  );
  assert.equal(
    p.parse([{ ...rows[0], receipt: { ...receipt(0), voice_in: 6 } }]).length,
    0,
  );
  const receiver = createCohortProtocol({
    index: 1,
    users,
    list: async () => [],
    send: async () => assert.fail("Unauthorized owner message"),
    budget,
  });
  assert.throws(
    () => receiver.post("prepare", { stage: "instrumented" }),
    code("ROLE_REFUSED"),
  );
  budget.close();
});
test("missing clients time out, and an authorized abort wins even over a complete quorum", async () => {
  const budget = createBudget({ duration: 500 });
  let rows = [message(0, "finished")];
  const p = createCohortProtocol({
    index: 0,
    users,
    list: async () => rows,
    send: async () => {},
    budget,
  });
  await assert.rejects(p.wait("finished", 8, { maximum: 8 }), (error) =>
    ["DEADLINE", "BARRIER_TIMEOUT"].includes(error.code),
  );
  rows = [...users.map((_, i) => message(i, "finished")), message(4, "abort")];
  await assert.rejects(p.wait("finished", 8), code("COHORT_ABORTED"));
  budget.close();
});
test("each client proves seven voice directions and one correct SDK source, without exporting private identities", () => {
  for (const index of [0, 1, 7]) {
    const monitor = createLoadMonitor(index, profile, { owned });
    monitor.accept(snapshot(index, 1000));
    const safe = monitor.accept(snapshot(index, 4000));
    assert.deepEqual(safe.receipt, receipt(index));
    assert.equal(safe.voice_in.length, 7);
    assert.equal(safe.voice_out.length, 7);
    const text = JSON.stringify(safe);
    for (const forbidden of [
      "private-",
      "track_id",
      "ssrc",
      "stats_id",
      "native_requests",
      "native-window",
      "headers",
    ])
      assert.ok(!text.includes(forbidden));
    if (index === 0) {
      assert.equal(safe.screen.max_bitrate, 16e6);
      assert.equal(safe.screen.max_framerate, 60);
      assert.equal(safe.screen.content_hint, "detail");
    }
  }
});
test("voice, source, codec, hint, cap, geometry and parallel screen changes fail before a timing phase", () => {
  for (const mutate of [
    (s) => s.peers.pop(),
    (s) => s.peers[0].rtp.pop(),
    (s) => {
      s.ui.self_microphones[0].enabled = false;
    },
    (s) => {
      s.captures[0].label = "native-window:99";
    },
    (s) => {
      s.peers[7].rtp[0].codec = "video/H264";
    },
    (s) => {
      s.peers[7].rtp[0].sender_parameters.contentHint = "motion";
    },
    (s) => {
      s.peers[7].rtp[0].sender_parameters.encodings[0].maxBitrate = 8e6;
    },
    (s) => {
      s.peers[7].rtp[0].frameWidth = 1280;
    },
    (s) => s.peers[7].rtp.push({ kind: "audio", bytesSent: 1 }),
    (s) => s.peers[0].rtp.push({ source: "camera", bytesReceived: 1 }),
    (s) =>
      s.peers[0].rtp.push({
        source: "screen",
        direction: "outbound",
        sender_active: true,
      }),
  ]) {
    const data = snapshot();
    mutate(data);
    assert.throws(() => createLoadMonitor(0, profile, { owned }).accept(data));
  }
});
test("a cached inactive mesh screen is ignored, while binding changes, resets and stopped flows invalidate the comparison", () => {
  const s = snapshot();
  s.peers[0].rtp.push({
    source: "screen",
    direction: "outbound",
    sender_active: false,
    bytesSent: 9000,
  });
  assert.doesNotThrow(() => createLoadMonitor(0, profile, { owned }).accept(s));
  for (const [mutate, expected] of [
    [
      (s) => {
        s.peers[7].rtp[0].ssrc = 999;
      },
      "BINDING_CHANGED",
    ],
    [
      (s) => {
        s.peers[7].rtp[0].framesEncoded = 1;
      },
      "COUNTER_RESET",
    ],
    [
      (s) => {
        s.peers[7].rtp[0].media_source.frames = 1;
      },
      "COUNTER_RESET",
    ],
    [
      (s) => {
        s.peers[0].rtp[0].bytesReceived = 10000;
      },
      "MEDIA_NOT_ADVANCING",
    ],
  ]) {
    const m = createLoadMonitor(0, profile, { owned });
    m.accept(snapshot());
    const next = snapshot(0, 4000);
    mutate(next);
    assert.throws(() => m.accept(next), code(expected));
  }
});
test("receiver must continue actual decode and render with all voice streams active", () => {
  const monitor = createLoadMonitor(1, profile);
  monitor.accept(snapshot(1));
  const next = snapshot(1, 4000);
  next.peers[7].tracks[0].video.total_frames = 27;
  assert.throws(() => monitor.accept(next), code("MEDIA_NOT_ADVANCING"));
});
test("SDK, tile and focus observations of the same decoded receiver are one track, not three receivers", () => {
  const monitor = createLoadMonitor(1, profile);
  for (const at of [1000, 4000]) {
    const s = snapshot(1, at),
      t = s.peers[7].tracks[0];
    // The real observer emits the SDK track without a video element and one
    // observation per UI element (tile and focus) for that same track.
    s.peers[7].tracks = [
      { ...t, video: null },
      { ...t, video: { ...t.video, total_frames: t.video.total_frames - 1 } },
      t,
    ];
    assert.equal(monitor.accept(s).receipt.sfu_in, 1);
  }
});
test("receiver selection requires a usable UI video and rejects a second rendered track identity", () => {
  for (const mode of ["absent", "paused", "geometry", "other-track"]) {
    const s = snapshot(1),
      t = s.peers[7].tracks[0];
    if (mode === "absent") t.video = null;
    if (mode === "paused") t.video.paused = true;
    if (mode === "geometry") t.video.width = 1280;
    if (mode === "other-track")
      s.peers[7].tracks.push({ ...t, track_id: "different-track" });
    assert.throws(
      () => createLoadMonitor(1, profile).accept(s),
      code("SCREEN_NOT_DECODED"),
    );
  }
  const s = snapshot(1),
    t = s.peers[7].tracks[0];
  s.peers[7].tracks.unshift(
    { ...t, video: null },
    { ...t, video: { ...t.video, paused: true } },
  );
  assert.doesNotThrow(() => createLoadMonitor(1, profile).accept(s));
});

function phaseFixture(
  context,
  {
    failCapture = false,
    loseInstall = false,
    duration = 600000,
    noObservations = false,
    pendingBeforeInstrument = false,
  } = {},
) {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const budget = createBudget({ now: () => Date.now(), duration }),
    events = [],
    phases = [],
    source = snapshot().captures[0];
  const measured = {
    ...source,
    pixel_width: 2560,
    pixel_height: 1440,
    sampled_sizes: ["2560x1440"],
    light_pixels: 14400,
    colored_pixels: 14000,
    observation_ms: 10000,
    processor_source_fps: 27,
    distinct_marker_fps: 26,
    marker_copy_calls_delta: 270,
    marker_copy_total_ms_delta: 27,
  };
  const timing = {
    interception: { video_frame: "INTERCEPTED", writer_write: "INTERCEPTED" },
    restore: { video_frame: "RESTORED", writer_write: "RESTORED" },
    dropped_observations: 0,
    constructor_bgrx: { count: 270, mean_ms: 1 },
    write_sync: { count: 270, mean_ms: 0.1 },
    write_settled: { count: 270, mean_ms: 2 },
  };
  if (noObservations)
    for (const key of ["constructor_bgrx", "write_sync", "write_settled"])
      timing[key].count = 0;
  let releaseSnapshot,
    snapshots = 0;
  const originalEvent = () => events.push("base-event");
  const app = {
    cdp: {
      onEvent: originalEvent,
      setStage() {},
      async evaluate(expression) {
        if (expression.includes("captureSnapshots")) {
          if (pendingBeforeInstrument && ++snapshots === 2) {
            events.push("pending-before-instrument");
            return new Promise((resolve) => {
              releaseSnapshot = () => resolve(source);
            });
          }
          return source;
        }
        if (expression === "window.__nativeTimingDiagnostic?.restore()") {
          events.push("restore");
          return timing;
        }
        events.push("install");
        if (loseInstall) throw Error("lost response");
        return {};
      },
    },
    async measureCapture() {
      events.push("capture");
      if (failCapture && events.includes("install"))
        throw Error("capture failed");
      await budget.pause(10000);
      return measured;
    },
  };
  const protocol = {
    async post(action, { stage } = {}) {
      events.push(action + (stage ? ":" + stage : ""));
    },
    async wait(action, count, { stage }) {
      events.push("quorum:" + action + ":" + stage);
      return users.map((_, i) => ({ index: i, receipt: receipt(i) }));
    },
  };
  const sample = async () => ({ at: Date.now(), receipt: receipt(0) });
  const run = () =>
    runPublisherTiming({
      app,
      selection: { captures: [source], owned_window_handle: 42 },
      profile,
      protocol,
      budget,
      sample,
      phases,
    });
  return {
    app,
    budget,
    events,
    phases,
    run,
    originalEvent,
    releaseSnapshot: () => releaseSnapshot(),
  };
}
test("real phase helper keeps FAIL FPS and requires all start/end load receipts; wrappers restore before the next barrier", async (context) => {
  const f = phaseFixture(context),
    result = await drive(f.run(), context);
  assert.equal(result.observations_verified, true);
  assert.deepEqual(
    result.phases.map((p) => p.name),
    timingLoadPhases,
  );
  assert.deepEqual(
    result.phases.map((p) => p.original_quality_gate.status),
    ["FAIL", "FAIL", "FAIL"],
  );
  for (const phase of result.phases) {
    assert.equal(phase.load_start_receipts.voice_in, 56);
    assert.equal(phase.load_end_receipts.voice_out, 56);
    assert.equal(phase.load_end_receipts.screen_receivers, 7);
    assert.equal(projectTimingPhase(phase).capacity_approval, false);
  }
  assert.ok(
    f.events.indexOf("quorum:phase-ready:instrumented") <
      f.events.indexOf("install"),
  );
  assert.ok(f.events.indexOf("restore") < f.events.indexOf("end:instrumented"));
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budget.close();
});
test("capture failure and lost install response both restore the owner and event handler before teardown", async (context) => {
  const f = phaseFixture(context, { loseInstall: true });
  const pending = f.run();
  await assert.rejects(drive(pending, context), /lost response/);
  assert.ok(f.events.includes("restore"));
  assert.ok(!f.events.includes("prepare:control_after"));
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budget.close();
});
test("a capture failure during the instrumented window preserves partial phases and restores before returning", async (context) => {
  const f = phaseFixture(context, { failCapture: true });
  await assert.rejects(drive(f.run(), context), /capture failed/);
  assert.equal(f.phases.length, 2);
  assert.ok(f.events.includes("restore"));
  assert.ok(!f.events.includes("prepare:control_after"));
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budget.close();
});
test("global expiration during instrumentation restores both dispatch and the previous event handler without starting the final control", async (context) => {
  const f = phaseFixture(context, { duration: 55000 });
  await assert.rejects(drive(f.run(), context), code("DEADLINE"));
  assert.ok(f.events.includes("install"));
  assert.ok(f.events.includes("restore"));
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budget.close();
  context.mock.timers.tick(200000);
  await flush();
  assert.equal(f.events.filter((e) => e === "install").length, 1);
  assert.ok(!f.events.includes("prepare:control_after"));
});
test("zero interception counts remain unverified even when the short capture phases finish", async (context) => {
  const f = phaseFixture(context, { noObservations: true });
  const result = await drive(f.run(), context);
  assert.equal(result.observations_verified, false);
  const middle = projectTimingPhase(result.phases[1]);
  assert.equal(middle.timings.constructor_bgrx.status, "NOT_VERIFIED");
  assert.equal(middle.original_quality_gate.status, "FAIL");
  f.budget.close();
});
test("the real046 helper cannot install after its pending pre-instrument snapshot outlives cleanup", async (context) => {
  const f = phaseFixture(context, {
    pendingBeforeInstrument: true,
    duration: 50000,
  });
  await assert.rejects(drive(f.run(), context), code("DEADLINE"));
  assert.ok(f.events.includes("pending-before-instrument"));
  assert.ok(f.events.includes("restore"));
  f.budget.close();
  f.releaseSnapshot();
  await flush();
  context.mock.timers.tick(200000);
  await flush();
  assert.equal(f.events.filter((e) => e === "install").length, 0);
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
});
test("an acquisition resolving after the deadline closes its late session exactly once", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const budget = createBudget({ now: () => Date.now(), duration: 100 }),
    closed = [],
    app = { close: () => closed.push("close") };
  let release;
  const pending = diagnostic.acquireSession(
    budget,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    20,
  );
  await flush();
  const rejected = assert.rejects(pending, code("DEADLINE"));
  context.mock.timers.tick(21);
  await rejected;
  budget.close();
  release(app);
  await flush();
  assert.deepEqual(closed, ["close"]);
});
test("accepted sessions remain caller-owned, and a value failing the deadline recheck is closed", async () => {
  let now = 0,
    closes = 0;
  const budget = createBudget({ now: () => now, duration: 100 }),
    app = {
      close: () => {
        closes++;
      },
    };
  assert.equal(
    await diagnostic.acquireSession(budget, async () => app, 20),
    app,
  );
  assert.equal(closes, 0);
  await assert.rejects(
    diagnostic.acquireSession(
      budget,
      async () => {
        now = 21;
        return app;
      },
      20,
    ),
    code("DEADLINE"),
  );
  assert.equal(closes, 1);
  budget.close();
});
test("an unresponsive restore is bounded separately and preserves event-handler ownership", async (context) => {
  const f = phaseFixture(context),
    evaluate = f.app.cdp.evaluate;
  f.app.cdp.evaluate = function (expression, ...args) {
    if (expression === "window.__nativeTimingDiagnostic?.restore()")
      return new Promise(() => {});
    return evaluate.call(this, expression, ...args);
  };
  await assert.rejects(drive(f.run(), context), code("DEADLINE"));
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budget.close();
});
test("unexecuted phase gates remain NOT_RUN while observed FAIL and PASS are preserved", () => {
  assert.equal(
    projectTimingPhase({ name: "instrumented" }).original_quality_gate.status,
    "NOT_RUN",
  );
  for (const status of ["FAIL", "PASS"])
    assert.equal(
      projectTimingPhase({
        name: "instrumented",
        original_quality_gate: { status },
      }).original_quality_gate.status,
      status,
    );
});

function eightClients(context, { dropInstrumentedDone = false } = {}) {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5000 });
  const events = [],
    messages = [],
    phases = [],
    budgets = [],
    reads = Array(8).fill(0),
    monitors = users.map((_, i) => createLoadMonitor(i, profile, { owned }));
  monitors.forEach((m, i) => {
    m.accept(snapshot(i, 1000));
    m.accept(snapshot(i, 4000));
  });
  const protocols = users.map((_, index) => {
    const budget = createBudget({ now: () => Date.now() });
    budgets.push(budget);
    return createCohortProtocol({
      index,
      users,
      budget,
      list: async () => messages,
      send: async (row) => {
        events.push(`${index}:${row.action}:${row.stage || ""}`);
        if (!(
          dropInstrumentedDone &&
          index === 4 &&
          row.action === "phase-done" &&
          row.stage === "instrumented"
        ))
          messages.push({ ...row, author_id: users[index].id });
      },
    });
  });
  const sample = (index) => async () =>
    monitors[index].accept(snapshot(index, Date.now() + ++reads[index] / 100));
  const originalEvent = () => {};
  const timing = {
    interception: { video_frame: "INTERCEPTED", writer_write: "INTERCEPTED" },
    restore: { video_frame: "RESTORED", writer_write: "RESTORED" },
    dropped_observations: 0,
    constructor_bgrx: { count: 270 },
    write_sync: { count: 270 },
    write_settled: { count: 270 },
  };
  const app = {
    cdp: {
      onEvent: originalEvent,
      setStage() {},
      async evaluate(expression) {
        if (expression.includes("captureSnapshots"))
          return snapshot().captures[0];
        if (expression === "window.__nativeTimingDiagnostic?.restore()") {
          events.push("restore");
          return timing;
        }
        events.push("install");
        return {};
      },
    },
    async measureCapture() {
      const requestId = `ack_${Date.now()}`;
      app.cdp.onEvent({
        method: "Network.requestWillBeSent",
        params: {
          requestId,
          timestamp: Date.now() / 1000,
          request: {
            method: "POST",
            url: "http://ipc.localhost/native_capture_ack",
          },
        },
      });
      await budgets[0].pause(10000);
      app.cdp.onEvent({
        method: "Network.loadingFinished",
        params: { requestId, timestamp: Date.now() / 1000 },
      });
      return {
        ...snapshot().captures[0],
        pixel_width: 2560,
        pixel_height: 1440,
        sampled_sizes: ["2560x1440"],
        light_pixels: 14400,
        colored_pixels: 14000,
        observation_ms: 10000,
        processor_source_fps: 27,
        distinct_marker_fps: 26,
      };
    },
  };
  const publisher = async () => {
    try {
      const result = await runPublisherTiming({
        app,
        selection: {
          captures: [snapshot().captures[0]],
          owned_window_handle: 42,
        },
        profile,
        protocol: protocols[0],
        budget: budgets[0],
        sample: sample(0),
        phases,
      });
      await protocols[0].post("finished");
      await protocols[0].wait("finished", 8, { maximum: 60000 });
      events.push("owner-close");
      return result;
    } catch (error) {
      await protocols[0].post("abort");
      throw error;
    }
  };
  const receiver = (index) =>
    (async () => {
      const result = await runReceiverTiming({
        index,
        protocol: protocols[index],
        budget: budgets[index],
        sample: sample(index),
      });
      await protocols[index].post("finished");
      await protocols[index].wait("finished", 8, { maximum: 60000 });
      events.push(`receiver-close-${index}`);
      return result;
    })();
  return {
    start: () =>
      Promise.allSettled([
        publisher(),
        ...users.slice(1).map((_, i) => receiver(i + 1)),
      ]),
    budgets,
    events,
    phases,
    app,
    originalEvent,
  };
}
test("eight authenticated mock clients keep seven receivers and56 microphone directions through all phases and final restoration", async (context) => {
  const f = eightClients(context),
    result = await drive(f.start(), context);
  assert.ok(result.every((r) => r.status === "fulfilled"));
  assert.equal(result[0].value.observations_verified, true);
  assert.equal(f.phases.length, 3);
  for (const p of f.phases) {
    assert.equal(p.load_start_receipts.voice_in, 56);
    assert.equal(p.load_start_receipts.voice_out, 56);
    assert.equal(p.load_end_receipts.screen_receivers, 7);
    assert.equal(p.ack.completed, 1);
  }
  const lastRestore = f.events.lastIndexOf("restore"),
    firstClose = f.events.findIndex((s) => s.includes("close"));
  assert.ok(lastRestore < firstClose);
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budgets.forEach((b) => b.close());
});
test("a missing receiver phase receipt aborts the cohort instead of accepting seven clients or continuing after instrumentation", async (context) => {
  const f = eightClients(context, { dropInstrumentedDone: true }),
    result = await drive(f.start(), context);
  assert.ok(result.every((r) => r.status === "rejected"));
  assert.ok(["BARRIER_TIMEOUT", "DEADLINE"].includes(result[0].reason.code));
  assert.equal(f.phases.length, 2);
  assert.ok(!f.events.includes("0:prepare:control_after"));
  assert.ok(f.events.indexOf("restore") < f.events.indexOf("0:abort:"));
  assert.equal(f.app.cdp.onEvent, f.originalEvent);
  f.budgets.forEach((b) => b.close());
});
test("projection omits capture and ACK identities, bodies and unknown timing values", () => {
  const source = snapshot().captures[0],
    p = projectTimingPhase({
      name: "instrumented",
      before: source,
      capture: source,
      original_quality_gate: { status: "FAIL", reason: "private-secret" },
      timings: { body: "private-secret", constructor_bgrx: { count: 0 } },
      ack: {
        requests: 1,
        records: [{ request_id: "private-id", url: "private-secret" }],
        completed_ms: { count: 0 },
      },
    });
  const text = JSON.stringify(p);
  assert.ok(!text.includes("private-"));
  assert.ok(!text.includes("track_id"));
  assert.ok(!text.includes("records"));
  assert.equal(p.timings.constructor_bgrx.status, "NOT_VERIFIED");
  assert.equal(p.ack.completed_ms.status, "NOT_VERIFIED");
  assert.equal(p.capacity_approval, false);
});
