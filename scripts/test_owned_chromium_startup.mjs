// Diagnostic only: the exact shared eight-process startup, no backend or media.
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { ownedChromiumGroup } from "./owned-chromium.mjs";
if (process.platform !== "linux" || process.argv.length !== 2 || process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "BersaneV/Harmony" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.env.HARMONY_CHROMIUM_STARTUP_PUBLIC_REPOSITORY !== "true") throw new Error("Owned public Linux startup diagnostic required");
const root = resolve(import.meta.dirname, ".."), output = resolve(root, ".local/qa-owned-chromium");
await mkdir(output, { recursive: true, mode: 0o700 });
const phases = [];
for (const order of ["parallel", "sequential"]) {
  const directory = await mkdtemp(`${output}/${order}-`);
  const group = ownedChromiumGroup({ directory, cwd: root, binary: process.env.HARMONY_CHROME || "google-chrome", env: { ...process.env } });
  let ready = false, cleaned = false, uniqueEndpoints = 0, aliveAtReady = null;
  try {
    const entries = await group.launchAll({ order }); await Promise.all(entries.map((r) => r.ready));
    // Private browser identities must describe eight different browser endpoints.
    uniqueEndpoints = new Set(entries.map((r) => `${r.verified_endpoint.host}:${r.verified_endpoint.port}${r.verified_endpoint.path}`)).size;
    aliveAtReady = entries.filter((r) => r.spawned && !r.closed && r.exit_code === null && r.signal === null).length;
    ready = uniqueEndpoints === 8 && aliveAtReady === 8;
  } catch { /* Per-child observations retain the concrete classified failure. */ }
  finally { await group.close(); }
  const observations = group.snapshot();
  cleaned = observations.every((r) => r.cleanup === "CLOSED_AND_FLUSHED" && (!r.spawned || r.stdio_closed && r.log_flush_verified));
  ready = ready && group.snapshot().every((r) => r.stage === "DEVTOOLS_READY" && r.version_status === "VERIFIED" && r.endpoint_error === null);
  const phase = { order, status: ready && cleaned ? "OBSERVED" : "FAIL", ready, unique_endpoints: uniqueEndpoints, alive_at_cohort_ready: aliveAtReady, cleanup_verified: cleaned, chromium_startup: group.snapshot() };
  phases.push(phase);
  console.log(JSON.stringify({ kind: "OWNED_CHROMIUM_STARTUP_PHASE", capacity_approval: false, deadline_ms: 10000, ...phase }));
  if (!cleaned) break; // A residual process or unverified flush forbids the next cohort.
}
const selected = phases.find((r) => r.order === "sequential");
console.log(JSON.stringify({ kind: "OWNED_CHROMIUM_STARTUP", capacity_approval: false, scope: "SAME_VM_PARALLEL_CONTROL_THEN_SEQUENTIAL_EIGHT_ABOUT_BLANK_NO_MEDIA_OR_CAPACITY", selected_strategy: "sequential", status: selected?.status ?? "FAIL", sequential_status: selected?.status ?? "NOT_RUN", deadline_ms: 10000, ready: selected?.ready ?? false, cleanup_verified: selected?.cleanup_verified ?? false, parallel_status: phases[0].status, phases }));
if (selected?.status !== "OBSERVED") process.exitCode = 1;
