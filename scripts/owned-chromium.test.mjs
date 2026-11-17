import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CHROMIUM_FLAGS, STARTUP_TIMEOUT_MS, ownedChromiumGroup } from "./owned-chromium.mjs";
function fixture(options = {}) {
  let now = 0;
  const children = [], writes = [], removed = [], deadlines = [];
  class Child extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough(); signals = [];
    kill(signal) {
      this.signals.push(signal);
      if (options.ignoreInt && signal === "SIGINT") return true;
      this.emit("exit", null, signal);
      this.stderr.write("trailing-private-value"); this.stderr.end(); this.stdout.end();
      queueMicrotask(() => this.emit("close")); return true;
    }
  }
  const group = ownedChromiumGroup({ directory: "/private/generated", binary: "owned-chrome", cwd: "/owned", env: {}, io: {
    now: () => now, sleep: async (ms) => { now += ms; },
    setTimeout: (fn, ms) => { deadlines.push(ms); return setTimeout(fn, Math.min(ms, 35)); }, clearTimeout,
    mkdtemp: async (prefix) => prefix + "owned",
    spawn: (_binary, args) => { const child = new Child(); children.push(child); assert.equal(group.entries.length, 8); assert.deepEqual(args.slice(0, -2), CHROMIUM_FLAGS); queueMicrotask(() => child.emit("spawn")); return child; },
    readFile: (...args) => { assert.equal(children.length, 8); return options.read ? options.read(...args) : Promise.resolve("41234\n/private/socket"); },
    writeFile: async (path, bytes, mode) => { writes.push({ path, bytes: Buffer.from(bytes), mode }); if (options.write) await options.write(path); },
    rm: async (path) => { removed.push(path); },
  } });
  return { group, children, writes, removed, deadlines, setNow: (v) => { now = v; } };
}
test("eight exact-flag spawns and bounded private stderr survive exit until close/write completion", async () => {
  let flush;
  const blocked = new Promise((resolve) => { flush = resolve; });
  const f = fixture({ write: (path) => path.endsWith("0.stderr.log") ? blocked : undefined });
  const entries = await f.group.launchAll(); await Promise.all(entries.map((r) => r.ready));
  const payload = "private-path=/secret TOKEN_VALUE No usable sand";
  f.children[0].stderr.write(payload); f.children[0].stderr.write("box! DevTools listening on ws://private\n");
  f.children[0].stderr.write(Buffer.alloc(110_000, 120));
  const before = f.group.snapshot()[0]; assert.equal(before.stage, "DEVTOOLS_READY"); assert.ok(Number.isFinite(before.startup_elapsed_ms));
  f.setNow(50_000); assert.equal(f.group.snapshot()[0].startup_elapsed_ms, before.startup_elapsed_ms);
  let done = false; const closing = f.group.close().then((v) => { done = true; return v; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(done, false); assert.equal(f.removed.includes(entries[0].profile), false);
  flush(); assert.equal(await closing, true);
  const r = f.group.snapshot()[0]; assert.deepEqual(r.stderr_classes, ["DEVTOOLS_LISTENING", "NO_USABLE_SANDBOX"]);
  assert.equal(r.stderr_retained_bytes, 100_000); assert.ok(r.stderr_bytes > 110_000); assert.equal(r.log_flush_verified, true);
  assert.equal(f.writes[0].mode.mode, 0o600); assert.equal(f.removed.length, 8);
  const expected = Buffer.concat([Buffer.from(payload),Buffer.from("box! DevTools listening on ws://private\n"),Buffer.alloc(110_000,120),Buffer.from("trailing-private-value")]);
  assert.equal(r.stderr_sha256, createHash("sha256").update(expected).digest("hex"));
  assert.doesNotMatch(JSON.stringify(f.group.snapshot()), /TOKEN_VALUE|\/private|\/secret|ws:\/\//);
});
test("port resolving after the original 10s deadline is rejected, not accepted late", async () => {
  const resolvers = []; const f = fixture({ read: () => new Promise((resolve) => resolvers.push(resolve)) });
  const entries = await f.group.launchAll(); f.setNow(10_001); resolvers.forEach((resolve) => resolve("41234\n"));
  assert.ok((await Promise.allSettled(entries.map((r) => r.ready))).every((r) => r.status === "rejected"));
  assert.ok(f.group.snapshot().every((r) => r.stage === "DEADLINE")); assert.equal(STARTUP_TIMEOUT_MS,10_000); assert.ok(f.deadlines.includes(10_000));
  await f.group.close();
});
test("process exit during a port read cannot become ready", async () => {
  const resolvers=[];const f=fixture({read:()=>new Promise((resolve)=>resolvers.push(resolve))});const entries=await f.group.launchAll();
  f.children.forEach((child)=>child.emit("exit",1,null));resolvers.forEach((resolve)=>resolve("41234\n"));
  assert.ok((await Promise.allSettled(entries.map((r)=>r.ready))).every((r)=>r.status==="rejected"));
  assert.ok(f.group.snapshot().every((r)=>r.stage==="PROCESS_ENDED"));await f.group.close();
});
test("never-resolving read does not prevent immediate kill/cancellation or late readiness", async () => {
  const f=fixture({read:()=>new Promise(()=>{})});const entries=await f.group.launchAll();const closing=f.group.close();
  assert.ok(f.children.every((child)=>child.signals[0]==="SIGINT"));assert.equal(await closing,true);
  assert.ok((await Promise.allSettled(entries.map((r)=>r.ready))).every((r)=>r.status==="rejected"));assert.throws(f.group.guard,/Owned Chromium startup/);
});
test("never-resolving log write is bounded and fails cleanup without deleting profiles", async () => {
  const f=fixture({write:()=>new Promise(()=>{})});const entries=await f.group.launchAll();await Promise.all(entries.map((r)=>r.ready));
  assert.equal(await f.group.close(),false);assert.equal(f.removed.length,0);assert.ok(f.group.snapshot().every((r)=>r.cleanup==="LOG_FLUSH_UNVERIFIED"));
});
test("file errno/empty/invalid statuses and spawn error/signal use only allowlisted metadata", async () => {
  const f=fixture({read:(path)=>{if(path.includes("browser-0"))return Promise.reject(Object.assign(new Error("PRIVATE"),{code:"ENOENT"}));if(path.includes("browser-1"))return Promise.resolve("");if(path.includes("browser-2"))return Promise.resolve("bad");return Promise.reject(Object.assign(new Error("TOKEN_PRIVATE"),{code:"PRIVATE_ERRNO"}));}});
  const entries=await f.group.launchAll();await Promise.allSettled(entries.map((r)=>r.ready));await f.group.close();const s=f.group.snapshot();
  assert.equal(s[0].read_status,"ABSENT");assert.equal(s[1].read_status,"EMPTY");assert.equal(s[2].read_status,"INVALID");assert.ok(s[3].read_errno_counts.OTHER>0);assert.doesNotMatch(JSON.stringify(s),/PRIVATE/);
});
test("cleanup escalates owned process only and never respawns/retries", async () => {
  const f=fixture({ignoreInt:true});const entries=await f.group.launchAll();await Promise.all(entries.map((r)=>r.ready));assert.equal(await f.group.close(),true);
  assert.equal(f.children.length,8);assert.ok(f.children.every((r)=>r.signals.join(",")==="SIGINT,SIGKILL"));await assert.rejects(f.group.launchAll(),/Owned Chromium startup/);
});
test("real runner CDP close rejects pending ready/commands before startup cleanup drains", async () => {
  const source=await readFile(new URL("./test_call_screen_sfu.mjs",import.meta.url),"utf8");const start=source.indexOf("class CDP {");const end=source.indexOf("\nconst webPort",start);
  class Socket { send(){} close(){this.onclose?.();} }
  const CDP=vm.runInNewContext(`(${source.slice(start,end)})`,{WebSocket:Socket,setTimeout,clearTimeout,Error,Map});
  const pending=new CDP("owned");const request=pending.send("Runtime.enable");pending.close();await assert.rejects(request,/CDP closed/);
  const open=new CDP("owned");open.socket.onopen();const command=open.send("Runtime.enable");await Promise.resolve();open.close();await assert.rejects(command,/CDP closed/);assert.equal(open.pending.size,0);
});

test("real browser target continuation cannot register a CDP after cleanup begins", async () => {
  const source=await readFile(new URL("./test_call_screen_sfu.mjs",import.meta.url),"utf8");
  const a=source.indexOf("async function browser(index) {");const b=source.indexOf('  await client.send("Runtime.enable")',a);
  const f=fixture();await f.group.launchAll();let resolveTarget;const target=new Promise((resolve)=>resolveTarget=resolve);let created=0;
  const browser=vm.runInNewContext(`(${source.slice(a,b)} })`,{chrome:f.group,browsers:Array.from({length:8},(_,index)=>({index})),web:"http://127.0.0.1",encodeURIComponent,fetch:async()=>({json:()=>target}),CDP:class{constructor(){created++;}}});
  const pending=browser(0);await new Promise((resolve)=>setImmediate(resolve));f.group.cancel();resolveTarget({webSocketDebuggerUrl:"owned"});
  await assert.rejects(pending,/Owned Chromium startup/);assert.equal(created,0);await f.group.close();
});
