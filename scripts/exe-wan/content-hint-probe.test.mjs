import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  assertHintContext,
  createContentHintControl,
  selectScreenSender,
  summarizeHintPhase,
  runHintExperiment,
  waitForProduction,
} from "./content-hint-probe.mjs";
const profile = {
  id: "1440p60",
  width: 2560,
  height: 1440,
  fps: 60,
  bitrate_mbps: 16,
  min_source_fps: 54,
  min_displayed_fps: 54,
};
test("diagnostic accepts only public main Windows047 and named60 profiles", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    HARMONY_CONTENT_HINT_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.7",
  };
  assert.doesNotThrow(() => assertHintContext(env, "win32", profile));
  for (const change of [
    { GITHUB_REPOSITORY: "other/Harmony" },
    { GITHUB_REF: "refs/heads/other" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { HARMONY_CONTENT_HINT_PUBLIC_REPOSITORY: "false" },
    { HARMONY_EXE_RELEASE: "0.4.8" },
  ])
    assert.throws(() =>
      assertHintContext({ ...env, ...change }, "win32", profile),
    );
  assert.throws(() => assertHintContext(env, "darwin", profile));
  assert.throws(() =>
    assertHintContext(env, "win32", { ...profile, id: "720p30", fps: 30 }),
  );
});
function row(at, frames = (at / 1000) * 30) {
  return {
    at,
    wall_utc: at,
    source: {
      track_id: "source",
      settings: { width: 2560, height: 1440, frameRate: 40 },
      processor_frames: (at / 1000) * 40,
      distinct_marker_frames: (at / 1000) * 38,
      marker_copy_errors: 0,
      processor_status: "running",
      processor_sizes: ["2560x1440"],
    },
    control: { observed_hint: "motion" },
    outbound: {
      pc: 1,
      stats_id: "OT1",
      ssrc: 1,
      track_id: "source",
      source: "screen",
      direction: "outbound",
      kind: "video",
      sender_active: true,
      codec: "video/VP8",
      framesEncoded: frames,
      bytesSent: frames * 100,
      totalEncodeTime: frames * 0.02,
      frameWidth: 2560,
      frameHeight: 1440,
      quality_limitation_reason: "cpu",
      quality_limitation_durations: { cpu: at / 1000, bandwidth: 0, none: 0 },
      sender_parameters: {
        contentHint: "motion",
        degradationPreference: "maintain-resolution",
        encodings: [
          { maxBitrate: 16e6, maxFramerate: 60, scaleResolutionDownBy: 1 },
        ],
      },
      media_source: {
        stats_id: "SV1",
        track_id: "source",
        frames,
        width: 2560,
        height: 1440,
      },
    },
  };
}
function context() {
  const track = {
    id: "source",
    kind: "video",
    readyState: "live",
    contentHint: "motion",
  };
  const parameters = {
    degradationPreference: "maintain-resolution",
    encodings: [
      { maxBitrate: 16e6, maxFramerate: 60, scaleResolutionDownBy: 1 },
    ],
    codecs: [{ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 }],
  };
  const sender = {
    track,
    getParameters: () => structuredClone(parameters),
    setParameters() {
      assert.fail("sender parameters must not change");
    },
  };
  const pc = { connectionState: "connected", getSenders: () => [sender] };
  const capture = {
    kind: "native",
    backend: "native-wgc",
    label: "native-window:42",
    track,
    getSettings: () => ({ width: 2560, height: 1440 }),
  };
  const context = {
    __TAURI_INTERNALS__: {},
    location: { origin: "http://tauri.localhost" },
    __exeWan: {
      captures: [capture],
      pcs: [pc],
      microphones: [{ readyState: "live" }],
      screenAudio: [],
    },
    document: {
      querySelector: () => ({ textContent: "Em chamada · 1 participante" }),
    },
  };
  context.window = context;
  const control = vm.runInNewContext(
    `(${createContentHintControl.toString()})(${JSON.stringify({ capture_index: 0, track_id: "source", pc: 0, handle: 42 })},${JSON.stringify(profile)})`,
    context,
  );
  return { context, control, track, parameters, sender, capture, pc };
}
test("control touches only contentHint on the existing owned track and restores the exact original value", () => {
  const f = context(),
    before = structuredClone(f.parameters);
  assert.equal(f.control.apply("motion").observed_hint, "motion");
  assert.equal(f.control.apply("detail").observed_hint, "detail");
  assert.equal(f.track.contentHint, "detail");
  assert.deepEqual(f.parameters, before);
  assert.equal(f.control.restore().restored, true);
  assert.equal(f.track.contentHint, "motion");
  assert.equal(f.control.restore().restored, true);
  assert.throws(() => f.control.apply("detail"), /retired/);
  assert.throws(() => f.control.apply("text"));
});
test("reentrant replacement during setter fails closed and restore still acts on the original track only", () => {
  const f = context();
  let value = "motion";
  const foreign = { ...f.track };
  Object.defineProperty(f.track, "contentHint", {
    get: () => value,
    set: (next) => {
      value = next;
      if (next === "detail") f.sender.track = foreign;
    },
  });
  assert.throws(() => f.control.apply("detail"));
  assert.equal(f.control.restore().restored, true);
  assert.equal(value, "motion");
  assert.equal(foreign.contentHint, "motion");
});
test("restore uses the captured object after its source ends, remains idempotent and does not stop media", () => {
  const f = context(),
    writes = [];
  let hint = "motion";
  f.track.stop = () => assert.fail("hint diagnostic must not stop the source");
  Object.defineProperty(f.track, "contentHint", {
    get: () => hint,
    set: (value) => {
      writes.push(value);
      hint = value;
    },
  });
  f.control.apply("detail");
  f.track.readyState = "ended";
  assert.equal(f.control.restore().restored, true);
  assert.equal(f.control.restore().restored, true);
  assert.deepEqual(writes, ["detail", "motion"]);
});
test("codec or scalability drift is refused without changing encoder parameters", () => {
  for (const mutate of [
    (f) => {
      f.parameters.encodings[0].scalabilityMode = "L1T3";
    },
    (f) => {
      f.parameters.codecs[0].mimeType = "video/H264";
    },
    (f) => {
      f.parameters.degradationPreference = "balanced";
    },
  ]) {
    const f = context();
    mutate(f);
    assert.throws(() => f.control.apply("detail"));
    assert.equal(f.track.contentHint, "motion");
  }
});
test("control refuses extra participant, audio, wrong source or parameter drift before the hint write", () => {
  for (const mutate of [
    (f) => {
      f.context.document.querySelector = () => ({
        textContent: "Em chamada · 2 participantes",
      });
    },
    (f) => {
      f.context.__exeWan.screenAudio.push({ readyState: "live" });
    },
    (f) => {
      f.capture.label = "native-window:99";
    },
    (f) => {
      f.parameters.encodings[0].maxFramerate = 30;
    },
    (f) => {
      f.sender.track = { ...f.track };
    },
  ]) {
    const f = context();
    mutate(f);
    assert.throws(() => f.control.apply("detail"));
    assert.equal(f.track.contentHint, "motion");
  }
});
test("selection requires an active SDK screen bound to the capture and preserves VP8/caps, ignoring inactive mesh stats", () => {
  const out = row(0).outbound;
  const sample = {
    peers: [
      { pc: 8, route: "p2p", rtp: [{ ...out, sender_active: false }] },
      { pc: 1, route: "sfu", rtp: [out] },
    ],
  };
  assert.equal(selectScreenSender(sample, "source", profile).ssrc, 1);
  assert.equal(selectScreenSender({ peers: [] }, "source", profile), null);
  for (const changed of [
    { track_id: "other" },
    { media_source: { ...out.media_source, track_id: "other" } },
    { codec: "video/H264" },
    {
      sender_parameters: {
        ...out.sender_parameters,
        encodings: [{ maxBitrate: 1, maxFramerate: 60 }],
      },
    },
  ])
    assert.throws(() =>
      selectScreenSender(
        { peers: [{ pc: 1, route: "sfu", rtp: [{ ...out, ...changed }] }] },
        "source",
        profile,
      ),
    );
  assert.throws(() =>
    selectScreenSender(
      {
        peers: [
          { pc: 1, route: "sfu", rtp: [out, { ...out, stats_id: "extra" }] },
        ],
      },
      "source",
      profile,
    ),
  );
  assert.throws(
    () =>
      selectScreenSender(
        {
          peers: [
            {
              pc: 1,
              route: "sfu",
              rtp: [
                out,
                {
                  direction: "outbound",
                  kind: "audio",
                  source: "unknown_audio",
                  bytesSent: 1,
                },
              ],
            },
          ],
        },
        "source",
        profile,
      ),
    /forbidden/,
  );
});
test("phase metrics keep native source, SDK source and encoded frames separate and do not invent optional contentType", () => {
  const s = summarizeHintPhase([row(0), row(60000)], profile);
  assert.equal(s.encode.frames_delta, 1800);
  assert.equal(s.encode.fps, 30);
  assert.equal(s.encode.mean_ms_per_frame, 20);
  assert.equal(s.source.native_fps, 40);
  assert.equal(s.source.distinct_fps, 38);
  assert.equal(s.source.sdk_fps, 30);
  assert.equal(s.quality_limitation.reason_counts.cpu, 2);
  assert.equal(s.quality_limitation.duration_deltas.cpu, 60);
  assert.equal(s.content_type.present_samples, 0);
  assert.equal(s.content_type.absent_samples, 2);
  assert.deepEqual(s.content_type.observed_values, []);
  assert.equal(s.remote.fps, null);
  assert.equal(s.capacity_approval, false);
  assert.equal(s.original_180s_capacity_gate, "NOT_RUN");
});
test("SSRC/source ID or counter reset starts a new segment and is never interpolated", () => {
  for (const mutate of [
    (r) => {
      r.outbound.ssrc = 2;
    },
    (r) => {
      r.outbound.media_source.stats_id = "SV2";
    },
    (r) => {
      r.outbound.totalEncodeTime = 0;
    },
  ]) {
    const a = row(0, 300),
      b = row(3000, 390),
      c = row(6000, 480);
    mutate(b);
    mutate(c);
    const s = summarizeHintPhase([a, b, c], profile);
    assert.ok(s.boundaries.length);
    assert.equal(s.encode.covered_seconds, 3);
    assert.equal(s.encode.frames_delta, 90);
    assert.equal(s.source.native_fps, 40);
  }
});
test("missing encode/source fields remain unverified rather than zero or substituted counters", () => {
  const a = row(0),
    b = row(3000);
  delete a.outbound.totalEncodeTime;
  delete b.outbound.totalEncodeTime;
  delete a.outbound.media_source;
  delete b.outbound.media_source;
  const s = summarizeHintPhase([a, b], profile);
  assert.equal(s.encode.mean_ms_per_frame, null);
  assert.equal(s.source.sdk_fps, null);
  assert.equal(s.content_type.absent_samples, 2);
});
test("an unobserved sender interval is excluded rather than bridged and RTP timestamps fence resets", () => {
  const a = row(0),
    b = row(3000),
    c = row(6000),
    d = row(9000);
  b.outbound = null;
  const summary = summarizeHintPhase([a, b, c, d], profile);
  assert.equal(summary.encode.covered_seconds, 3);
  assert.equal(summary.encode.frames_delta, 90);
  assert.equal(summary.missing_sender_samples, 1);
  assert.equal(summary.source.native_fps, 40);
  assert.equal(summary.source.sdk_covered_seconds, 3);
  const x = row(0),
    y = row(3000);
  x.outbound.timestamp = y.outbound.timestamp = 100;
  const reset = summarizeHintPhase([x, y], profile);
  assert.equal(reset.encode.fps, null);
  assert.equal(reset.encode.mean_ms_per_frame, null);
  assert.deepEqual(
    reset.segments.map((s) => s.samples),
    [1, 1],
  );
  assert.equal(reset.boundaries[0].reason, "counter_reset");
});
test("A/B/A uses30s settle and60s measurement per phase and restores even on sampling failure", async () => {
  let now = 0,
    hint = "motion",
    restored = 0;
  const applied = [],
    waits = [];
  const port = {
    apply: async (next) => {
      hint = next;
      applied.push(next);
      return { observed_hint: next };
    },
    sample: async () => {
      const r = row(now);
      r.control.observed_hint = hint;
      return r;
    },
    pixels: async () => ({ pixel_width: 2560, pixel_height: 1440 }),
    restore: async () => {
      restored++;
      hint = "motion";
      return { restored: true };
    },
  };
  const phases = [];
  await runHintExperiment(port, phases, {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    emit() {},
  });
  assert.deepEqual(applied, ["motion", "detail", "motion"]);
  assert.equal(restored, 1);
  assert.equal(phases.length, 3);
  assert.ok(phases.every((p) => p.summary.measurement_seconds >= 60));
  assert.equal(now, 270000);
  assert.ok(waits.every((ms) => ms === 3000));
  port.sample = async () => {
    throw Error("sample failed");
  };
  await assert.rejects(
    runHintExperiment(port, [], {
      now: () => now,
      sleep: async () => {},
      emit() {},
    }),
    /sample failed/,
  );
  assert.equal(restored, 2);
  assert.equal(hint, "motion");
});
test("absence of produced SDK frames yields NOT_RUN without hint mutation or a fabricated viewer", async () => {
  let now = 0,
    calls = 0;
  await assert.rejects(
    waitForProduction(
      async () => {
        calls++;
        return { outbound: row(now, 0).outbound };
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ),
    (error) => error.code === "NOT_RUN",
  );
  assert.ok(calls > 1);
  assert.equal(now, 30000);
});
test("production requires bytes and encoded frames to advance on the same strong RTP identity", async () => {
  let now = 0,
    count = 0;
  const result = await waitForProduction(
    async () => {
      const r = row(now);
      count++;
      if (count === 2) r.outbound.ssrc = 2;
      if (count === 3) r.outbound.bytesSent = 0;
      return r;
    },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(count, 4);
  assert.equal(result.outbound.ssrc, 1);
});
test("pixel inspection or hint failure still requests restoration before the error escapes", async () => {
  for (const failing of ["apply", "pixels"]) {
    const events = [];
    const port = Object.fromEntries(
      ["apply", "pixels", "sample", "restore"].map((name) => [
        name,
        async () => {
          events.push(name);
          if (name === failing) throw Error(name);
        },
      ]),
    );
    await assert.rejects(runHintExperiment(port, []), new RegExp(failing));
    assert.equal(events.at(-1), "restore");
    assert.ok(!events.includes("sample"));
  }
});
test("review P2: production returning at35s is refused even when counters finally advance", async () => {
  let now = 0;
  await assert.rejects(
    waitForProduction(
      async () => {
        if (now >= 30000) {
          now += 5000;
          return { outbound: row(now, 1).outbound };
        }
        return { outbound: row(now, 0).outbound };
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ),
    (error) => error.code === "NOT_RUN",
  );
  assert.ok(now <= 30000);
});
test("review P2: slow samples still cover at least60s of actual observed timestamps in every phase", async () => {
  let now = 0,
    hint = "motion",
    restored = 0;
  const phases = [];
  await runHintExperiment(
    {
      profile,
      apply: async (next) => {
        hint = next;
      },
      pixels: async () => ({}),
      sample: async () => {
        now += 5000;
        const r = row(now);
        r.control.observed_hint = hint;
        return r;
      },
      restore: async () => {
        restored++;
      },
    },
    phases,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(restored, 1);
  for (const phase of phases) {
    const measurements = phase.samples.filter((r) => r.segment === "measure");
    const observed = (measurements.at(-1).at - measurements[0].at) / 1000;
    assert.ok(observed >= 60, `Only${observed}s actually observed`);
    assert.equal(phase.summary.measurement_seconds, observed);
  }
  assert.ok(now <= 400000);
});
test("production bounds each read to the remaining window and rejects an already-started late response", async () => {
  let now = 0,
    calls = 0;
  const budgets = [];
  await assert.rejects(
    waitForProduction(
      async (budget) => {
        budgets.push(budget);
        calls++;
        if (calls === 2) {
          now += 5000;
          return { outbound: row(now, 1).outbound };
        }
        return { outbound: row(now, 0).outbound };
      },
      {
        now: () => now,
        sleep: async () => {
          now = 29000;
        },
      },
    ),
    (error) => error.code === "NOT_RUN",
  );
  assert.deepEqual(budgets, [30000, 1000]);
  assert.equal(now, 34000);
});
test("an unresponsive production read cannot keep the observation alive past its remaining budget", async () => {
  let now = 0,
    calls = 0;
  await assert.rejects(
    waitForProduction(
      async (budget) => {
        calls++;
        if (calls === 2) {
          assert.equal(budget, 1);
          return new Promise(() => {});
        }
        return { outbound: row(now, 0).outbound };
      },
      {
        now: () => now,
        sleep: async () => {
          now = 29999;
        },
      },
    ),
    (error) => error.code === "NOT_RUN",
  );
  assert.equal(calls, 2);
});
test("the total collection budget never expands beyond400s and expiration restores the hint", async () => {
  let now = 0,
    restored = 0;
  const phases = [],
    budgets = [];
  await assert.rejects(
    runHintExperiment(
      {
        apply: async () => ({}),
        pixels: async () => ({}),
        sample: async (budget) => {
          budgets.push(budget);
          now += 400001;
          return row(now);
        },
        restore: async () => {
          restored++;
        },
      },
      phases,
      {
        deadline: 9999999,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ),
    /deadline/,
  );
  assert.deepEqual(budgets, [400000]);
  assert.equal(restored, 1);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].summary, undefined);
});
test("invalid observed timestamps fail without substituting wall-clock duration and restore the hint", async () => {
  let restored = 0;
  await assert.rejects(
    runHintExperiment(
      {
        apply: async () => ({}),
        pixels: async () => ({}),
        sample: async () => ({ ...row(0), at: NaN }),
        restore: async () => {
          restored++;
        },
      },
      [],
      { now: () => 0 },
    ),
    /observed sample timestamps/,
  );
  assert.equal(restored, 1);
});
