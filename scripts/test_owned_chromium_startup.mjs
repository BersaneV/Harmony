// Diagnostic only: the exact shared eight-process startup, no backend or media.
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { ownedChromiumGroup } from "./owned-chromium.mjs";
if (process.platform !== "linux" || process.argv.length !== 2 || process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "BersaneV/Harmony" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.env.HARMONY_CHROMIUM_STARTUP_PUBLIC_REPOSITORY !== "true") throw new Error("Owned public Linux startup diagnostic required");
const root = resolve(import.meta.dirname, ".."), output = resolve(root, ".local/qa-owned-chromium");
await mkdir(output, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(`${output}/run-`);
const group = ownedChromiumGroup({ directory, cwd: root, binary: process.env.HARMONY_CHROME || "google-chrome", env: { ...process.env } });
let ready = false, cleaned = false;
try { const entries = await group.launchAll(); await Promise.all(entries.map((r) => r.ready)); ready = true; }
catch { process.exitCode = 1; }
finally { cleaned = await group.close(); }
console.log(JSON.stringify({ kind: "OWNED_CHROMIUM_STARTUP", capacity_approval: false, scope: "EIGHT_ABOUT_BLANK_STARTUP_ONLY_NO_BACKEND_MEDIA_OR_CAPACITY", status: ready && cleaned ? "OBSERVED" : "FAIL", deadline_ms: 10000, ready, cleanup_verified: cleaned, chromium_startup: group.snapshot() }));
if (!ready || !cleaned) process.exitCode = 1;
