import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
export const STARTUP_TIMEOUT_MS = 10_000;
export const CHROMIUM_FLAGS = Object.freeze([
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required", "--disable-audio-output",
  "--disable-audio-input", "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding", "--remote-debugging-port=0",
]);
const ERRNOS = new Set(["ENOENT", "EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "EAGAIN"]);
const SIGNALS = new Set(["SIGINT", "SIGKILL", "SIGTERM", "SIGABRT", "SIGTRAP", "SIGSEGV"]);
const errno = (code) => ERRNOS.has(code) ? code : "OTHER";
const patterns = [
  ["NO_USABLE_SANDBOX", /No usable sandbox/i],
  ["ROOT_SANDBOX_REFUSAL", /Running as root without --no-sandbox is not supported/i],
  ["USER_NAMESPACE_FAILURE", /Failed to move to new namespace|Failed to unshare/i],
  ["APPARMOR_MENTION", /apparmor/i],
  ["SUID_SANDBOX_CONFIGURATION", /SUID sandbox helper binary.*not configured correctly/i],
  ["MISSING_SHARED_LIBRARY", /error while loading shared libraries/i],
  ["DEVTOOLS_LISTENING", /DevTools listening on/i],
  ["THREAD_CREATE_UNAVAILABLE", /pthread_create.*Resource temporarily unavailable/i],
  ["OPEN_FILES_EXHAUSTED", /Too many open files/i],
  ["CRASHPAD_DATABASE_REQUIRED", /crashpad_handler.*--database is required/i],
];
export const classifyStderr = (text) => patterns.filter(([, re]) => re.test(text)).map(([code]) => code);
const failure = () => new Error("Owned Chromium startup");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bound = (old, data) => Buffer.concat([old, Buffer.from(data)]).subarray(-100_000);
// Endpoint stays private. Only a complete documented loopback URL is accepted.
const browserPath = /^\/devtools\/browser\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function devtoolsEndpoint(value) {
  if (typeof value !== "string") return null;
  const match = /^ws:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/devtools\/browser\/[^\s]+)$/.exec(value);
  if (!match || Number(match[2]) > 65535 || !browserPath.test(match[3])) return null;
  return { host: match[1], port: Number(match[2]), path: match[3] };
}
const sameEndpoint = (a, b) => a.host === b.host && a.port === b.port && a.path === b.path;
/** Exactly eight generated profiles/about:blank processes. No raw output enters snapshot(). */
export function ownedChromiumGroup({ directory, binary, env, cwd, io = {} }) {
  const deps = { spawn, mkdtemp, readFile, writeFile, rm, now: Date.now, sleep, fetch, ...io };
  const abort = new AbortController();
  let closing = false, launchTask;
  const entries = Array.from({ length: 8 }, (_, index) => ({ index, stage: "REGISTERED", child: null,
    verified_endpoint: null, announcement: null, announcement_at: null, endpoint_error: null, endpoint_tail: "", readiness_source: null, version_status: "NOT_RUN",
    profile: null, prepared: false, terminal_at: null, port: null, spawned: false, exit_code: null, signal: null, spawn_errno: null,
    read_status: "NOT_ATTEMPTED", read_attempts: 0, read_errno: Object.fromEntries([...ERRNOS, "OTHER"].map((e) => [e, 0])),
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderr_bytes: 0, stdout_bytes: 0,
    stderrHash: createHash("sha256"), classes: new Set(), closed: false, flushed: false, cleanup: "NOT_RUN",
  }));
  const guard = () => { if (closing || entries.some((r) => r.endpoint_error)) throw failure(); };
  const within = (promise, ms) => new Promise((resolve) => {
    const timer = (deps.setTimeout ?? setTimeout)(() => resolve(false), Math.max(0, ms));
    Promise.resolve(promise).then(() => { (deps.clearTimeout ?? clearTimeout)(timer); resolve(true); }, () => { (deps.clearTimeout ?? clearTimeout)(timer); resolve(false); });
  });
  function aliveWithinDeadline(r) {
    guard(); if (r.terminal_at !== null) throw failure();
    if (deps.now() >= r.deadline) { r.stage = "DEADLINE"; throw failure(); }
    if (r.spawn_errno || r.closed || r.exit_code !== null || r.signal !== null) { r.stage = "PROCESS_ENDED"; throw failure(); }
  }
  function observeAnnouncements(r, data) {
    const lines = (r.endpoint_tail + data.toString("utf8")).split("\n");
    r.endpoint_tail = lines.pop();
    if (r.endpoint_tail.length > 512) {
      if (r.endpoint_tail.startsWith("DevTools listening on ")) r.endpoint_error = "ANNOUNCEMENT_INVALID";
      r.endpoint_tail = r.endpoint_tail.slice(0, 513);
    }
    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("DevTools listening on ")) continue;
      const endpoint = line.length <= 512 ? devtoolsEndpoint(line.slice(22)) : null;
      if (!endpoint) { r.endpoint_error = "ANNOUNCEMENT_INVALID"; continue; }
      if (r.announcement && !sameEndpoint(r.announcement, endpoint)) { r.endpoint_error = "ANNOUNCEMENT_AMBIGUOUS"; continue; }
      if (r.verified_endpoint && !sameEndpoint(r.verified_endpoint, endpoint)) { r.endpoint_error = "FILE_STDERR_CONFLICT"; continue; }
      if (!r.announcement) { r.announcement = endpoint; r.announcement_at = deps.now(); }
      if (r.announcement_at >= r.deadline) r.endpoint_error = "ANNOUNCEMENT_LATE";
    }
  }
  async function confirmEndpoint(r, port, source) {
    aliveWithinDeadline(r);
    const host = r.announcement?.host ?? "127.0.0.1";
    try {
      const response = await deps.fetch(`http://${host}:${port}/json/version`, { redirect: "error", signal: r.readAbort.signal });
      aliveWithinDeadline(r);
      if (response.status !== 200) { r.version_status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `HTTP_STATUS_${response.status}` : "HTTP_STATUS_INVALID"; throw failure(); }
      const body = await response.json(); aliveWithinDeadline(r);
      const observed = devtoolsEndpoint(body?.webSocketDebuggerUrl);
      if (r.announcement && r.announcement.port !== port) { r.endpoint_error = "FILE_STDERR_CONFLICT"; }
      if (r.endpoint_error || !observed || observed.port !== port || r.announcement && !sameEndpoint(r.announcement, observed)) { r.version_status = "ENDPOINT_MISMATCH"; throw failure(); }
      r.version_status = "VERIFIED"; r.verified_endpoint = observed; r.port = port; r.readiness_source = source === "FILE" && r.announcement ? "FILE_AND_STDERR" : source; r.stage = "DEVTOOLS_READY"; return r;
    } catch { if (r.version_status === "NOT_RUN") r.version_status = "REQUEST_FAILED"; throw failure(); }
  }
  async function ready(r) {
    r.stage = "WAITING_DEVTOOLS";
    while (deps.now() < r.deadline) {
      aliveWithinDeadline(r); r.read_attempts++;
      let filePort = null;
      try {
        const text = await deps.readFile(`${r.profile}/DevToolsActivePort`, { encoding: "utf8", signal: r.readAbort.signal });
        aliveWithinDeadline(r);
        const port = Number(text.split("\n")[0]);
        r.read_status = !text ? "EMPTY" : Number.isInteger(port) && port > 0 && port <= 65535 ? "VALID" : "INVALID";
        if (r.read_status === "VALID") filePort = port;
      } catch (error) {
        if (closing || r.endpoint_error || r.terminal_at !== null || r.stage === "DEADLINE" || r.stage === "PROCESS_ENDED") throw failure();
        r.read_errno[errno(error.code)]++; r.read_status = error.code === "ENOENT" ? "ABSENT" : "READ_ERROR";
      }
      aliveWithinDeadline(r);
      if (r.announcement && (filePort !== null && filePort !== r.announcement.port || r.read_status === "INVALID")) { r.endpoint_error = "FILE_STDERR_CONFLICT"; throw failure(); }
      if (filePort !== null) return confirmEndpoint(r, filePort, r.announcement ? "FILE_AND_STDERR" : "FILE");
      if (r.announcement) return confirmEndpoint(r, r.announcement.port, "STDERR");
      await deps.sleep(30);
    }
    r.stage = "DEADLINE"; throw failure();
  }
  function launch(r) {
    r.started = deps.now(); r.deadline = r.started + STARTUP_TIMEOUT_MS;
    r.stage = "SPAWN_REQUESTED";
    let resolveClosed;
    r.closePromise = new Promise((resolve) => { resolveClosed = resolve; });
    try {
      r.child = deps.spawn(binary, [...CHROMIUM_FLAGS, `--user-data-dir=${r.profile}`, "about:blank"], {
        env, cwd, stdio: ["ignore", "pipe", "pipe"],
      });
      r.child.once("spawn", () => { r.spawned = true; });
      r.child.once("error", (error) => { r.spawn_errno = errno(error.code); });
      r.child.once("exit", (code, signal) => { r.exit_code = Number.isInteger(code) ? code : null; r.signal = signal ? SIGNALS.has(signal) ? signal : "OTHER" : null; });
      r.child.stdout.on("error", () => { r.classes.add("STDIO_ERROR"); });
      r.child.stderr.on("error", () => { r.classes.add("STDIO_ERROR"); });
      r.child.stdout.on("data", (data) => { r.stdout_bytes += data.length; r.stdout = bound(r.stdout, data); });
      r.child.stderr.on("data", (data) => {
        r.stderr_bytes += data.length; r.stderrHash.update(data); r.stderr = bound(r.stderr, data);
        observeAnnouncements(r, data);
        for (const code of classifyStderr(r.stderr.toString("utf8"))) r.classes.add(code);
      });
      // close follows process termination AND stdio closure. Await writes before cleanup/report.
      r.child.once("close", () => { r.closed = true; void (async () => {
        try {
          await Promise.all([deps.writeFile(`${directory}/browser-${r.index}.stderr.log`, r.stderr, { mode: 0o600 }), deps.writeFile(`${directory}/browser-${r.index}.stdout.log`, r.stdout, { mode: 0o600 })]);
          r.flushed = true;
        } finally { resolveClosed(); }
      })().catch(() => {}); });
    } catch (error) { r.spawn_errno = errno(error.code); r.closed = true; r.flushed = true; resolveClosed(); }
  }
  function startReady(r) {
    r.readAbort = new AbortController();
    r.ready = new Promise((resolve, reject) => {
      const done = (error, value) => {
        if (r.terminal_at !== null) return;
        r.terminal_at = deps.now(); (deps.clearTimeout ?? clearTimeout)(timer);
        abort.signal.removeEventListener("abort", cancelled); r.readAbort.abort();
        error ? reject(error) : resolve(value);
      };
      const cancelled = () => { if (!["DEADLINE", "PROCESS_ENDED"].includes(r.stage)) r.stage = "CANCELLED"; done(failure()); };
      const timer = (deps.setTimeout ?? setTimeout)(() => { r.stage = "DEADLINE"; done(failure()); }, Math.max(0, r.deadline - deps.now()));
      abort.signal.addEventListener("abort", cancelled, { once: true });
      ready(r).then((value) => done(null, value), (error) => done(error));
    });
    void r.ready.catch(() => {});
  }
  return {
    entries, signal: abort.signal, guard,
    async launchAll() {
      if (launchTask) throw failure();
      launchTask = (async () => {
        const profiles = await Promise.allSettled(entries.map(async (r) => { try { r.profile = await deps.mkdtemp(`${directory}/browser-${r.index}-`); } finally { r.prepared = true; } }));
        guard(); if (profiles.some((r) => r.status === "rejected")) throw failure();
        // All eight spawn attempts are registered before awaiting any readiness.
        entries.forEach(launch); entries.forEach(startReady); return entries;
      })(); return launchTask;
    },
    cancel() { closing = true; abort.abort(); },
    snapshot() { return entries.map((r) => ({ index: r.index, stage: r.stage, spawned: r.spawned,
      spawn_errno: r.spawn_errno, process_exit: r.exit_code, signal: r.signal,
      startup_elapsed_ms: r.started === undefined || r.terminal_at === null ? null : r.terminal_at - r.started,
      ...(r.started !== undefined && r.terminal_at === null ? { active_elapsed_ms: deps.now() - r.started } : {}),
      readiness_source: r.readiness_source, announcement_elapsed_ms: r.announcement_at === null ? null : r.announcement_at - r.started, endpoint_error: r.endpoint_error, version_status: r.version_status,
      read_status: r.read_status, read_attempts: r.read_attempts, read_errno_counts: r.read_errno,
      stderr_bytes: r.stderr_bytes, stderr_retained_bytes: r.stderr.length,
      stdout_bytes: r.stdout_bytes, stderr_classes: [...r.classes].sort(), stdio_closed: r.closed, log_flush_verified: r.flushed, cleanup: r.cleanup,
    })); },
    async close() {
      closing = true; abort.abort();
      const end = deps.now() + 5000;
      const kill = (r, signal) => { try { r.child.kill(signal); } catch { r.classes.add("KILL_ERROR"); } };
      // Kill first: unresolved profile/readiness/log IO must never prevent this.
      for (const r of entries) if (r.child && !r.closed) kill(r, "SIGINT");
      await within(Promise.all(entries.flatMap((r) => r.closePromise ? [r.closePromise] : [])), 4000);
      for (const r of entries) if (r.child && !r.closed) kill(r, "SIGKILL");
      await within(Promise.all(entries.flatMap((r) => r.closePromise ? [r.closePromise] : [])), end - deps.now());
      await within(launchTask, end - deps.now());
      await Promise.all(entries.map(async (r) => {
        r.cleanup = !r.prepared ? "PREPARATION_UNVERIFIED" : !r.child || r.closed && r.flushed ? "CLOSED_AND_FLUSHED" : r.closed ? "LOG_FLUSH_UNVERIFIED" : "CLOSE_UNVERIFIED";
        if (r.profile && r.cleanup === "CLOSED_AND_FLUSHED") {
          if (!await within(deps.rm(r.profile, { recursive: true, force: true }), end - deps.now())) r.cleanup = "PROFILE_CLEANUP_UNVERIFIED";
        }
      }));
      return entries.every((r) => r.cleanup === "CLOSED_AND_FLUSHED" && r.endpoint_error === null);
    },
  };
}
