// Diagnostic on one immutable published EXE and one owned capture. The only
// experimental API write is that track's supported contentHint property.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
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
import { assertOwnedCapture } from "./capture-ui.mjs";
import { assertCallRoute } from "./fixture-contract.mjs";
import { summarizeHostCpu } from "./host-cpu.mjs";
import { createClientDiagnostics } from "./client-diagnostics.mjs";

const failNotRun = () =>
  Object.assign(
    Error(
      "No advancing single SDK screen sender without a viewer; no peer or media was injected",
    ),
    { code: "NOT_RUN" },
  );
export function assertHintContext(env, platform, profile) {
  assert.equal(platform, "win32");
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "BersaneV/Harmony",
    GITHUB_REF: "refs/heads/main",
    RUNNER_ENVIRONMENT: "github-hosted",
    HARMONY_CONTENT_HINT_PUBLIC_REPOSITORY: "true",
    HARMONY_EXE_RELEASE: "0.4.7",
  }))
    assert.equal(env[key], value, `Required diagnostic context: ${key}`);
  assert.ok(profile.fps === 60 && ["1080p60", "1440p60"].includes(profile.id));
}
// Injected only after real SDK production has been observed. This does not
// capture/publish, call setParameters, wrap APIs, or alter codec/CPU adaptation.
export function createContentHintControl(binding, profile) {
  if (
    !window.__TAURI_INTERNALS__ ||
    !["http://tauri.localhost", "https://tauri.localhost"].includes(
      location.origin,
    )
  )
    throw Error("Owned compiled page required");
  if (window.__contentHintProbe)
    throw Error("Content hint diagnostic already installed");
  if (
    !Number.isInteger(binding.capture_index) ||
    binding.capture_index < 0 ||
    !Number.isInteger(binding.pc) ||
    binding.pc < 0 ||
    !Number.isSafeInteger(binding.handle) ||
    binding.handle <= 0
  )
    throw Error("Exact capture binding required");
  if (
    !(
      (profile.width === 1920 &&
        profile.height === 1080 &&
        profile.bitrate_mbps === 8) ||
      (profile.width === 2560 &&
        profile.height === 1440 &&
        profile.bitrate_mbps === 16)
    ) ||
    profile.fps !== 60
  )
    throw Error("Unchanged named performance60 profile required");
  const capture = __exeWan.captures[binding.capture_index],
    track = capture?.track,
    pc = __exeWan.pcs[binding.pc];
  const original = track?.contentHint;
  let retired = false,
    lastRequested = original,
    baselineParameters;
  const read = () => {
    const live = __exeWan.captures.filter(
      (c) => c.track?.readyState === "live",
    );
    if (
      live.length !== 1 ||
      live[0] !== capture ||
      capture.kind !== "native" ||
      capture.backend !== "native-wgc" ||
      capture.label !== `native-window:${binding.handle}` ||
      track.id !== binding.track_id ||
      track.kind !== "video" ||
      track.readyState !== "live"
    )
      throw Error("Owned native capture binding changed");
    const dimensions = capture.getSettings();
    if (
      dimensions.width !== profile.width ||
      dimensions.height !== profile.height
    )
      throw Error("Native source geometry changed");
    const count = Number(
      document
        .querySelector(".call-header small")
        ?.textContent?.trim()
        .match(/^Em chamada · ([0-9]+)/)?.[1],
    );
    if (
      count !== 1 ||
      __exeWan.microphones.filter((t) => t.readyState === "live").length !==
        1 ||
      __exeWan.screenAudio.some((t) => t.readyState === "live")
    )
      throw Error(
        "Only one participant and generated microphone without screen audio are allowed",
      );
    if (__exeWan.pcs[binding.pc] !== pc || pc?.connectionState !== "connected")
      throw Error("SDK connection binding changed");
    const senders = pc
      .getSenders()
      .filter(
        (s) =>
          s.track?.kind === "video" &&
          s.track.readyState === "live" &&
          s.getParameters().encodings?.some((e) => e.active !== false),
      );
    if (senders.length !== 1 || senders[0].track !== track)
      throw Error("One SDK sender bound to the original capture is required");
    const parameters = senders[0].getParameters(),
      encodings = parameters.encodings;
    if (
      encodings?.length !== 1 ||
      encodings[0].active === false ||
      encodings[0].maxBitrate !== profile.bitrate_mbps * 1e6 ||
      encodings[0].maxFramerate !== 60 ||
      (encodings[0].scaleResolutionDownBy ?? 1) !== 1 ||
      parameters.degradationPreference !== "maintain-resolution"
    )
      throw Error("Original sender caps or degradation preference changed");
    const fixed = JSON.stringify({
      degradationPreference: parameters.degradationPreference,
      encodings: encodings.map((e) => ({
        active: e.active ?? true,
        maxBitrate: e.maxBitrate,
        maxFramerate: e.maxFramerate,
        scaleResolutionDownBy: e.scaleResolutionDownBy ?? 1,
        codec: e.codec ?? null,
        scalabilityMode: e.scalabilityMode ?? null,
      })),
      codecs: parameters.codecs?.map((c) => ({
        mimeType: c.mimeType,
        clockRate: c.clockRate,
        payloadType: c.payloadType,
        sdpFmtpLine: c.sdpFmtpLine ?? null,
      })),
    });
    if (baselineParameters === undefined) baselineParameters = fixed;
    else if (fixed !== baselineParameters)
      throw Error("Sender encoding or codec parameters drifted");
    return {
      requested_hint: lastRequested,
      observed_hint: track.contentHint,
      track_id: track.id,
      pc: binding.pc,
      participants: count,
      encoding: {
        active: encodings[0].active ?? true,
        maxBitrate: encodings[0].maxBitrate,
        maxFramerate: encodings[0].maxFramerate,
        scaleResolutionDownBy: encodings[0].scaleResolutionDownBy ?? 1,
        ...(typeof encodings[0].scalabilityMode === "string"
          ? { scalabilityMode: encodings[0].scalabilityMode }
          : {}),
      },
      degradationPreference: parameters.degradationPreference,
    };
  };
  if (original !== "motion")
    throw Error("The compiled initial motion profile is required");
  read();
  const control = {
    read,
    apply(hint) {
      if (retired) throw Error("Content hint control retired");
      if (!["motion", "detail"].includes(hint))
        throw Error("Only motion/detail are authorized");
      read();
      lastRequested = hint;
      track.contentHint = hint;
      const after = read();
      if (after.observed_hint !== hint)
        throw Error("Content hint setter was not reflected");
      return after;
    },
    restore() {
      retired = true;
      // Restore the captured original object even if its SDK sender or source ended.
      if (track.contentHint !== original) track.contentHint = original;
      return {
        requested_hint: original,
        observed_hint: track.contentHint,
        restored: track.contentHint === original,
        track_id: track.id,
      };
    },
  };
  window.__contentHintProbe = control;
  return control;
}
export function selectScreenSender(sample, trackId, profile) {
  const candidates = (sample.peers || []).flatMap((peer) =>
    (peer.rtp || [])
      .filter(
        (r) =>
          r.direction === "outbound" &&
          r.kind === "video" &&
          r.source === "screen" &&
          r.sender_active === true,
      )
      .map((r) => ({ ...r, pc: peer.pc, route: peer.route })),
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw Object.assign(
      Error("Ambiguous active RTP rows; no sender delta inferred"),
      { code: "AMBIGUOUS_RTP" },
    );
  const r = candidates[0];
  assert.equal(r.route, "sfu", "Only the real SDK sender is allowed");
  assert.equal(
    r.track_id,
    trackId,
    "SDK sender must reference the captured source",
  );
  assert.equal(r.codec?.toLowerCase(), "video/vp8");
  if (r.media_source?.track_id !== undefined)
    assert.equal(
      r.media_source.track_id,
      trackId,
      "SDK media-source must reference the captured source",
    );
  const p = r.sender_parameters,
    e = p?.encodings;
  assert.equal(e?.length, 1);
  assert.ok(e[0].active !== false);
  assert.equal(e[0].maxBitrate, profile.bitrate_mbps * 1e6);
  assert.equal(e[0].maxFramerate, 60);
  assert.equal(e[0].scaleResolutionDownBy ?? 1, 1);
  assert.equal(p.degradationPreference, "maintain-resolution");
  assert.ok(
    !(sample.peers || [])
      .filter((p) => p.route === "sfu")
      .some((p) =>
        p.rtp.some(
          (r) =>
            r.direction === "outbound" &&
            r.source !== "screen" &&
            (r.bytesSent ?? 0) > 0,
        ),
      ),
    "SDK microphone/camera/audio publication is forbidden",
  );
  return r;
}
const rtpIdentity = (r) =>
  r && Number.isFinite(r.ssrc) && typeof r.stats_id === "string" && r.track_id
    ? JSON.stringify([
        r.pc,
        r.stats_id,
        r.ssrc,
        r.track_id,
        r.media_source?.stats_id ?? null,
      ])
    : null;
const delta = (a, b, key) =>
  Number.isFinite(a?.[key]) && Number.isFinite(b?.[key]) && b[key] >= a[key]
    ? b[key] - a[key]
    : null;
const distribution = (values) => {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b),
    n = rows.length;
  return {
    status: n ? "OBSERVED" : "NOT_VERIFIED",
    count: n,
    min: n ? rows[0] : null,
    p50: n ? rows[Math.ceil(n * 0.5) - 1] : null,
    p95: n ? rows[Math.ceil(n * 0.95) - 1] : null,
    max: n ? rows.at(-1) : null,
  };
};
export function summarizeHintPhase(rows, profile) {
  let frames = 0,
    seconds = 0,
    encodeTime = 0,
    pairedFrames = 0,
    encodeIntervals = 0,
    nativeFrames = 0,
    nativeSeconds = 0,
    distinct = 0,
    distinctSeconds = 0,
    sdkFrames = 0,
    sdkSeconds = 0;
  const boundaries = [],
    segments = [],
    quality = {},
    qualityCounts = {},
    qualityCoverage = {};
  let segment;
  for (let i = 0; i < rows.length; i++) {
    const current = rows[i],
      r = current.outbound,
      key = rtpIdentity(r);
    if (r?.quality_limitation_reason)
      qualityCounts[r.quality_limitation_reason] =
        (qualityCounts[r.quality_limitation_reason] || 0) + 1;
    if (!i || key !== rtpIdentity(rows[i - 1].outbound)) {
      segment = { identity: key, samples: 0 };
      segments.push(segment);
    }
    segment.samples++;
    if (!i) continue;
    const previous = rows[i - 1],
      a = previous.outbound,
      dt = (current.at - previous.at) / 1000;
    if (!(dt > 0)) {
      boundaries.push({ at: current.at, reason: "nonmonotonic_sample_clock" });
      continue;
    }
    if (current.source?.track_id === previous.source?.track_id) {
      const n = delta(previous.source, current.source, "processor_frames"),
        d = delta(previous.source, current.source, "distinct_marker_frames");
      if (n !== null) {
        nativeFrames += n;
        nativeSeconds += dt;
      }
      if (d !== null) {
        distinct += d;
        distinctSeconds += dt;
      }
    }
    if (
      a?.media_source?.stats_id &&
      a.media_source.stats_id === r?.media_source?.stats_id &&
      a.media_source.track_id === r.media_source.track_id
    ) {
      const n = delta(a.media_source, r.media_source, "frames");
      if (n !== null) {
        sdkFrames += n;
        sdkSeconds += dt;
      }
    }
    const reset =
      key &&
      key === rtpIdentity(a) &&
      (["framesEncoded", "bytesSent", "totalEncodeTime"].some(
        (k) =>
          Number.isFinite(a?.[k]) && Number.isFinite(r?.[k]) && r[k] < a[k],
      ) ||
        ["cpu", "bandwidth", "none", "other"].some(
          (k) =>
            Number.isFinite(a?.quality_limitation_durations?.[k]) &&
            Number.isFinite(r?.quality_limitation_durations?.[k]) &&
            r.quality_limitation_durations[k] <
              a.quality_limitation_durations[k],
        ) ||
        (Number.isFinite(a?.timestamp) &&
          Number.isFinite(r?.timestamp) &&
          r.timestamp <= a.timestamp));
    if (!key || key !== rtpIdentity(a) || reset) {
      boundaries.push({
        at: current.at,
        reason: reset
          ? "counter_reset"
          : "missing_or_changed_rtp_source_identity",
      });
      if (reset) {
        segment.samples--;
        segment = { identity: key, samples: 1 };
        segments.push(segment);
      }
      continue;
    }
    const n = delta(a, r, "framesEncoded"),
      t = delta(a, r, "totalEncodeTime");
    if (n !== null) {
      frames += n;
      seconds += dt;
    }
    if (n !== null && t !== null) {
      pairedFrames += n;
      encodeTime += t;
      encodeIntervals++;
    }
    for (const k of ["cpu", "bandwidth", "none", "other"]) {
      const d = delta(
        a.quality_limitation_durations,
        r.quality_limitation_durations,
        k,
      );
      if (d !== null) {
        quality[k] = (quality[k] ?? 0) + d;
        qualityCoverage[k] = (qualityCoverage[k] ?? 0) + dt;
      }
    }
  }
  const missingFields = Object.fromEntries(
    [
      "timestamp",
      "framesEncoded",
      "totalEncodeTime",
      "media_source",
      "content_type",
      "encoder_implementation",
      "power_efficient_encoder",
      "quality_limitation_reason",
    ].map((k) => [k, rows.filter((r) => r.outbound?.[k] === undefined).length]),
  );
  const types = rows.flatMap((r) =>
    typeof r.outbound?.content_type === "string"
      ? [r.outbound.content_type]
      : [],
  );
  return {
    capacity_approval: false,
    original_180s_capacity_gate: "NOT_RUN",
    requested_profile: profile,
    measurement_seconds:
      rows.length > 1 ? (rows.at(-1).at - rows[0].at) / 1000 : 0,
    samples: rows.length,
    missing_fields: missingFields,
    missing_sender_samples: rows.filter((r) => !r.outbound).length,
    segments,
    boundaries,
    encode: {
      status: seconds > 0 ? "OBSERVED" : "NOT_VERIFIED",
      frames_delta: seconds > 0 ? frames : null,
      covered_seconds: seconds,
      fps: seconds > 0 ? frames / seconds : null,
      paired_frames: encodeIntervals ? pairedFrames : null,
      total_encode_seconds: encodeIntervals ? encodeTime : null,
      mean_ms_per_frame:
        pairedFrames > 0 ? (encodeTime * 1000) / pairedFrames : null,
    },
    source: {
      native_frames_delta: nativeSeconds ? nativeFrames : null,
      native_covered_seconds: nativeSeconds,
      native_fps: nativeSeconds ? nativeFrames / nativeSeconds : null,
      distinct_frames_delta: distinctSeconds ? distinct : null,
      distinct_fps: distinctSeconds ? distinct / distinctSeconds : null,
      sdk_frames_delta: sdkSeconds ? sdkFrames : null,
      sdk_covered_seconds: sdkSeconds,
      sdk_fps: sdkSeconds ? sdkFrames / sdkSeconds : null,
      native_producer_fps: distribution(
        rows.map((r) => r.source?.settings?.frameRate),
      ),
      native_sizes: [
        ...new Set(rows.flatMap((r) => r.source?.processor_sizes || [])),
      ],
      encoded_sizes: [
        ...new Set(
          rows.map((r) =>
            r.outbound?.frameWidth && r.outbound?.frameHeight
              ? `${r.outbound.frameWidth}x${r.outbound.frameHeight}`
              : "unavailable",
          ),
        ),
      ],
    },
    content_type: {
      present_samples: types.length,
      absent_samples: rows.length - types.length,
      observed_values: [...new Set(types)],
    },
    quality_limitation: {
      reason_counts: qualityCounts,
      duration_deltas: quality,
      duration_covered_seconds: qualityCoverage,
    },
    observed_hints: [
      ...new Set(rows.map((r) => r.control?.observed_hint ?? "unavailable")),
    ],
    host_cpu: summarizeHostCpu(rows),
    remote: {
      status: "NOT_RUN_NO_RECEIVER",
      fps: null,
      freeze_count: null,
      freeze_seconds: null,
    },
  };
}
async function beforeDeadline(read, deadline, now, expired) {
  const remaining = deadline - now();
  if (!(remaining >= 1)) throw expired();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        const budget = deadline - now();
        if (!(budget >= 1)) throw expired();
        return read(budget);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(expired()), remaining);
      }),
    ]);
    // A slow/late response must not validate a window that has already ended.
    if (now() > deadline) throw expired();
    return value;
  } finally {
    clearTimeout(timer);
  }
}
export async function waitForProduction(
  sample,
  { now = () => performance.now(), sleep = delay } = {},
) {
  const deadline = now() + 30000;
  let previous;
  while (now() < deadline) {
    const current = await beforeDeadline(sample, deadline, now, failNotRun),
      a = previous?.outbound,
      b = current.outbound;
    if (
      rtpIdentity(a) &&
      rtpIdentity(a) === rtpIdentity(b) &&
      b.framesEncoded > a.framesEncoded &&
      b.bytesSent > a.bytesSent
    )
      return current;
    previous = current;
    if (now() >= deadline) break;
    await sleep(Math.min(3000, deadline - now()));
  }
  throw failNotRun();
}
export async function runHintExperiment(
  port,
  phases,
  {
    now = () => performance.now(),
    sleep = delay,
    emit = () => {},
    deadline,
  } = {},
) {
  const end = Math.min(deadline ?? Infinity, now() + 400000),
    expired = () => Error("Owned fixture diagnostic deadline reached");
  try {
    for (const [name, hint] of [
      ["A_motion", "motion"],
      ["B_detail", "detail"],
      ["A2_motion", "motion"],
    ]) {
      const phase = {
        name,
        requested_hint: hint,
        capacity_approval: false,
        samples: [],
      };
      phases.push(phase);
      phase.applied = await beforeDeadline(
        () => port.apply(hint),
        end,
        now,
        expired,
      );
      phase.capture_pixels = await beforeDeadline(
        () => port.pixels(),
        end,
        now,
        expired,
      );
      for (const [segment, duration] of [
        ["settle", 30000],
        ["measure", 60000],
      ]) {
        let firstAt, lastAt;
        while (true) {
          const row = await beforeDeadline(
            (timeout) => port.sample(timeout),
            end,
            now,
            expired,
          );
          assert.ok(
            Number.isFinite(row.at) &&
              row.at >= 0 &&
              (lastAt === undefined || row.at > lastAt),
            "Valid increasing observed sample timestamps required",
          );
          firstAt ??= row.at;
          lastAt = row.at;
          assert.equal(
            row.control.observed_hint,
            hint,
            "Application overwrote the requested hint",
          );
          phase.samples.push({ segment, ...row });
          emit({ phase: name, requested_hint: hint, segment, sample: row });
          // Collection latency before the first sample is not observed time.
          if (row.at - firstAt >= duration) break;
          await sleep(Math.min(3000, Math.max(0, end - now())));
        }
        (phase.observed_windows ??= {})[segment] = {
          first_at: firstAt,
          last_at: lastAt,
          observed_ms: lastAt - firstAt,
        };
      }
      phase.summary = summarizeHintPhase(
        phase.samples.filter((r) => r.segment === "measure"),
        port.profile ?? profileForRows(phase.samples),
      );
      assert.ok(
        phase.summary.measurement_seconds >= 60,
        "At least60s of observed measurement required",
      );
    }
  } finally {
    await port.restore();
  }
}
function profileForRows(rows) {
  const source = rows[0]?.source?.settings;
  return { width: source?.width, height: source?.height, fps: 60 };
}

async function main() {
  const request = requestedProfile(),
    result = {
      kind: "exe_content_hint_diagnostic",
      status: "DIAGNOSTIC",
      capacity_approval: false,
      completion: "RUNNING",
      release: "0.4.7",
      requested_profile: request,
      scope:
        "One pinned public EXE/VM with one generated microphone and one owned WGC screen published by compiled UI to SDK VP8, without another participant or receiver",
      phases: [],
      limitations: [
        "30s settle plus60s measurement per phase is not the180s capacity gate.",
        "Only contentHint changes; codec, caps, CPU protection and sender parameters are unchanged.",
        "Whole-VM CPU includes fixture/app/observer/encoder and is not encoder CPU attribution.",
        "Counters are segmented on identity/counter reset without interpolation.",
        "No remote FPS, freeze count, MOS or GPU behavior is fabricated.",
      ],
    };
  let app,
    controllerInstalled = false;
  const diagnostics = createClientDiagnostics(0);
  let sourceDeadline;
  try {
    guard();
    assertHintContext(process.env, process.platform, request);
    const release = JSON.parse(
      await readFile(new URL("./releases/0.4.7.json", import.meta.url), "utf8"),
    );
    assert.equal(release.version, "0.4.7");
    assert.equal(
      release.installer_url,
      "https://github.com/BersaneV/Harmony/releases/download/v0.4.7/Harmony_0.4.7_x64-setup.exe",
    );
    for (const k of ["installer_sha256", "main_sha256"])
      assert.match(release[k], /^[a-f0-9]{64}$/);
    const mainHash = createHash("sha256")
      .update(await readFile(process.env.HARMONY_EXE_PATH))
      .digest("hex");
    assert.equal(mainHash, release.main_sha256);
    const users = JSON.parse(process.env.HARMONY_COHORT_USERS);
    assert.equal(users.length, 8);
    assert.equal(process.env.HARMONY_GUILD_NAME, "EXE WAN " + cohort());
    const token = await ownedSession(0),
      members = (
        await api(`/guilds/${process.env.HARMONY_GUILD_ID}/members`, token)
      ).items;
    assert.equal(members.length, 8);
    assert.ok(members.every((m) => users.some((u) => u.id === m.id)));
    const instance = await api("/instance"),
      info = await api(`/channels/${process.env.HARMONY_VOICE_ID}/call`, token);
    assertCallRoute(instance, info);
    assert.equal(
      info.screen_sfu_enabled,
      true,
      "Existing SDK screen relay required",
    );
    result.server = { version: instance.version, screen_sfu_enabled: true };
    app = await session(0, { onCommandTrace: diagnostics.onCommandTrace });
    result.attestation = app.attestation;
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
          `Number(document.querySelector('.call-header small')?.textContent.trim().match(/^Em chamada · ([0-9]+)/)?.[1])===1`,
        ),
      "solo compiled call joined",
      60000,
    );
    await app.labelled("Ligar microfone");
    app.cdp.setStage("call.microphone.ready");
    await until(
      () =>
        app.cdp.evaluate(
          `__exeWan.microphones.filter(t=>t.readyState==='live').length===1`,
        ),
      "one generated microphone",
    );
    result.microphone = await app.cdp.evaluate("__exeWan.measureMicrophone()");
    assert.ok(result.microphone.rms > 0.03);
    await app.click("Compartilhar tela");
    await app.select("Resolução", request.height);
    await app.select("Quadros por segundo", 60);
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
    const capture = result.capture_selection.captures[0],
      index = capture.index,
      handle = result.capture_selection.owned_window_handle;
    sourceDeadline = performance.now() + 400000;
    assert.equal(
      await app.cdp.evaluate(
        `Number(document.querySelector('.call-header small')?.textContent.trim().match(/^Em chamada · ([0-9]+)/)?.[1])`,
      ),
      1,
      "No receiver or other participant may join",
    );
    await app.click("Iniciar transmissão");
    const sample = async (timeout = 7000) => {
      const end = Math.min(sourceDeadline, performance.now() + timeout);
      const remaining = (limit) => {
        const value = end - performance.now();
        assert.ok(value >= 1, "Owned capture sample deadline reached");
        return Math.min(limit, value);
      };
      app.cdp.setStage("capture.snapshot");
      const value = await app.sample(remaining(5000)),
        source = value.captures?.[index];
      assertOwnedCapture(source, handle, request, "native");
      assert.equal(source.track_id, capture.track_id);
      assert.equal(value.captures.filter((c) => c.ready === "live").length, 1);
      let outbound, selection_status;
      try {
        outbound = selectScreenSender(value, capture.track_id, request);
      } catch (error) {
        if (!controllerInstalled || error.code !== "AMBIGUOUS_RTP") throw error;
        outbound = null;
        selection_status = "NOT_VERIFIED_AMBIGUOUS_RTP_ROWS";
      }
      const row = {
        at: value.at,
        wall_utc: value.wall_utc,
        source,
        outbound,
        ...(selection_status ? { selection_status } : {}),
        host_cpu: {
          platform: process.platform,
          at_ms: performance.now(),
          cores: cpus().map((c) => ({ ...c.times })),
        },
      };
      if (controllerInstalled)
        row.control = await app.cdp.evaluate(
          "__contentHintProbe.read()",
          false,
          remaining(2000),
        );
      assert.ok(
        performance.now() <= end,
        "Owned capture sample deadline reached",
      );
      return row;
    };
    result.production_probe_samples = [];
    const produced = await waitForProduction(async (timeout) => {
      const value = await sample(timeout);
      result.production_probe_samples.push(value);
      return value;
    });
    result.initial_production = {
      pc: produced.outbound.pc,
      stats_id: produced.outbound.stats_id,
      ssrc: produced.outbound.ssrc,
      track_id: capture.track_id,
      framesEncoded: produced.outbound.framesEncoded,
      bytesSent: produced.outbound.bytesSent,
    };
    const binding = {
      capture_index: index,
      track_id: capture.track_id,
      pc: produced.outbound.pc,
      handle,
    };
    controllerInstalled = true;
    await app.cdp.evaluate(
      `(()=>{const c=(${createContentHintControl.toString()})(${JSON.stringify(binding)},${JSON.stringify(request)});return c.read()})()`,
      false,
      2000,
    );
    const port = {
      profile: request,
      apply: (hint) =>
        app.cdp.evaluate(
          `__contentHintProbe.apply(${JSON.stringify(hint)})`,
          false,
          2000,
        ),
      sample,
      pixels: async () => {
        const value = await app.measureCapture(index, 1000);
        assertOwnedCapture(value, handle, request, "native");
        assert.equal(value.track_id, capture.track_id);
        assert.equal(value.pixel_width, request.width);
        assert.equal(value.pixel_height, request.height);
        assert.ok(
          value.sampled_sizes.every(
            (s) => s === `${request.width}x${request.height}`,
          ),
        );
        assert.ok(
          value.light_pixels > 13680 && value.colored_pixels > 13680,
          "Original full-pixel criterion required",
        );
        return value;
      },
      restore: async () => {
        result.hint_restore = await app.cdp.evaluate(
          "window.__contentHintProbe?.restore()",
          false,
          2000,
        );
        assert.equal(
          result.hint_restore?.restored,
          true,
          "Original hint restoration must be observed",
        );
      },
    };
    await runHintExperiment(port, result.phases, {
      deadline: sourceDeadline,
      emit: (row) =>
        console.log("HARMONY_EXE_CONTENT_HINT_SAMPLE " + JSON.stringify(row)),
    });
    result.completion = "COMPLETE";
  } catch (error) {
    result.completion = error.code === "NOT_RUN" ? "NOT_RUN" : "FAILED";
    result.error = String(error.message).slice(0, 500);
    diagnostics.noteFailure(result, app);
  } finally {
    if (app) {
      if (controllerInstalled) {
        try {
          result.final_hint_restore = await app.cdp.evaluate(
            "window.__contentHintProbe?.restore()",
            false,
            2000,
          );
          if (result.final_hint_restore?.restored !== true)
            result.completion = "FAILED";
        } catch {
          result.final_hint_restore = { status: "NOT_VERIFIED" };
          result.completion = "FAILED";
        }
      }
      if (result.completion === "FAILED")
        await diagnostics.collectFailure(result, app);
      // Normal compiled UI teardown follows restoration, even after NOT_RUN.
      for (const expression of [
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Parar tela'&&!b.disabled);if(b)b.click();return{clicked:!!b}})()`,
        `(()=>{const b=document.querySelector('button[aria-label="Sair da chamada"]:not(:disabled)');if(b)b.click();return{clicked:!!b}})()`,
      ]) {
        try {
          (result.ui_cleanup ??= []).push(
            await app.cdp.evaluate(expression, true, 2000),
          );
        } catch {
          (result.ui_cleanup ??= []).push({ status: "NOT_VERIFIED" });
        }
      }
      diagnostics.finish(result);
      result.fixture_diagnostic = app.fixtureDiagnostic();
      try {
        app.close();
      } catch {
        result.cleanup_policy = "FAILED";
        result.completion = "FAILED";
      }
      await writeFile(
        join(app.root, "content-hint-probe.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
    }
    diagnostics.finish(result);
    console.log("HARMONY_EXE_CONTENT_HINT " + JSON.stringify(result));
  }
  if (result.completion !== "COMPLETE") process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href)
  await main();
