import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CHROMIUM_FLAGS, STARTUP_TIMEOUT_MS, ownedChromiumGroup, devtoolsEndpoint } from "./owned-chromium.mjs";
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
    fetch: options.fetch ?? (async () => ({status:200,json:async()=>({webSocketDebuggerUrl:"ws://127.0.0.1:41234/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"})})),
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
  assert.equal(entries[0].stderrHash.copy().digest("hex"), createHash("sha256").update(expected).digest("hex"));
  assert.equal("stderr_sha256" in r, false);
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

const endpoint = "ws://127.0.0.1:41234/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
const announce = (f, text = endpoint) => f.children.forEach((c) => c.stderr.write(`DevTools listening on ${text}\n`));
const absent = () => Promise.reject(Object.assign(new Error("private"),{code:"ENOENT"}));
test("strict loopback announcement without profile file verifies json/version on same deadline", async () => {
  let requests=0;const f=fixture({read:absent,fetch:async(url,options)=>{requests++;assert.equal(url,"http://127.0.0.1:41234/json/version");assert.equal(options.redirect,"error");assert.ok(options.signal);return{status:200,json:async()=>({webSocketDebuggerUrl:endpoint})};}});
  const entries=await f.group.launchAll();f.setNow(12);announce(f);await Promise.all(entries.map((r)=>r.ready));
  const snapshot=f.group.snapshot();assert.equal(requests,8);assert.ok(snapshot.every((r)=>r.readiness_source==="STDERR"&&r.announcement_elapsed_ms===12&&r.version_status==="VERIFIED"));
  f.setNow(50);announce(f);assert.ok(f.group.snapshot().every((r)=>r.announcement_elapsed_ms===12));
  assert.doesNotMatch(JSON.stringify(snapshot),/127\.0\.0\.1|41234|01234567|devtools|ws:\/\//);await f.group.close();
});
test("IPv6 announcement split across chunks is accepted only after complete line",async()=>{
  const e=endpoint.replace("127.0.0.1","[::1]");const f=fixture({read:absent,fetch:async(url)=>{assert.equal(url,"http://[::1]:41234/json/version");return{status:200,json:async()=>({webSocketDebuggerUrl:e})};}});
  const entries=await f.group.launchAll();f.children.forEach((c)=>c.stderr.write("DevTools listening on "+e.slice(0,20)));f.setNow(20);f.children.forEach((c)=>c.stderr.write(e.slice(20)+"\r\n"));
  await Promise.all(entries.map((r)=>r.ready));assert.ok(f.group.snapshot().every((r)=>r.announcement_elapsed_ms===20));await f.group.close();
});
test("nonloopback/malformed/ambiguous/conflicting announcements cannot establish readiness",async()=>{
  for(const bad of [endpoint.replace("127.0.0.1","evil.test"),endpoint.replace("127.0.0.1","127.0.0.2"),endpoint.replace(":41234",":0"),endpoint.replace(":41234",":65536"),endpoint+"?secret=TOKEN",endpoint.replace("/browser/","/page/"),endpoint.replace("abcdef","notuuid"),"wss://"+endpoint.slice(5)]){
    assert.equal(devtoolsEndpoint(bad),null);const f=fixture({read:absent});const entries=await f.group.launchAll();announce(f,bad);assert.ok((await Promise.allSettled(entries.map((r)=>r.ready))).every((r)=>r.status==="rejected"));assert.ok(f.group.snapshot().some((r)=>r.endpoint_error==="ANNOUNCEMENT_INVALID"));await f.group.close();
  }
  for(const conflict of [false,true]){const f=fixture({read:conflict?()=>Promise.resolve("41235\n"):absent});const entries=await f.group.launchAll();announce(f);if(!conflict)announce(f,endpoint.replace("abcdef","abcdee"));assert.ok((await Promise.allSettled(entries.map((r)=>r.ready))).every((r)=>r.status==="rejected"));assert.ok(f.group.snapshot().some((r)=>r.endpoint_error===(conflict?"FILE_STDERR_CONFLICT":"ANNOUNCEMENT_AMBIGUOUS")));await f.group.close();}
});
test("late announcement and late HTTP result never receive an extra10s",async()=>{
  const f=fixture({read:absent});const entries=await f.group.launchAll();f.setNow(10001);announce(f);assert.ok((await Promise.allSettled(entries.map((r)=>r.ready))).every((r)=>r.status==="rejected"));assert.ok(f.group.snapshot().some((r)=>r.endpoint_error==="ANNOUNCEMENT_LATE"));await f.group.close();
  const responses=[];const h=fixture({read:absent,fetch:()=>new Promise((resolve)=>responses.push(resolve))});const list=await h.group.launchAll();announce(h);await new Promise((r)=>setImmediate(r));h.setNow(10001);responses.forEach((resolve)=>resolve({status:200,json:async()=>({webSocketDebuggerUrl:endpoint})}));assert.ok((await Promise.allSettled(list.map((r)=>r.ready))).every((r)=>r.status==="rejected"));assert.ok(h.group.snapshot().every((r)=>r.stage==="DEADLINE"));await h.group.close();
});
test("version HTTP404/redirect failure/endpoint mismatch remain classified failures",async()=>{
  for(const mode of ["404","redirect","mismatch"]){const f=fixture({read:absent,fetch:async()=>{if(mode==="redirect")throw new Error("PRIVATE_REDIRECT_TOKEN");return{status:mode==="404"?404:200,json:async()=>({webSocketDebuggerUrl:endpoint.replace(":41234",":41235")})};}});const entries=await f.group.launchAll();announce(f);assert.ok((await Promise.allSettled(entries.map((r)=>r.ready))).every((r)=>r.status==="rejected" && r.reason.message === "Owned Chromium startup"));assert.ok(f.group.snapshot().every((r)=>r.version_status===({"404":"HTTP_STATUS_404",redirect:"REQUEST_FAILED",mismatch:"ENDPOINT_MISMATCH"}[mode])));assert.doesNotMatch(JSON.stringify(f.group.snapshot()),/PRIVATE_REDIRECT_TOKEN/);await f.group.close();}
});

test("endpoint conflict after READY or during cleanup fails the unchanged fullharness close sink",async()=>{
  for(const duringClose of [false,true]){
    const f=fixture();const entries=await f.group.launchAll();await Promise.all(entries.map((r)=>r.ready));
    const conflict=endpoint.replace("abcdef","abcdee");
    if(duringClose){for(const child of f.children){const kill=child.kill.bind(child);child.kill=(signal)=>{child.stderr.write(`DevTools listening on ${conflict}\n`);return kill(signal);};}}
    else {announce(f,conflict);assert.throws(f.group.guard,/Owned Chromium startup/);}
    assert.equal(await f.group.close(),false);assert.ok(f.group.snapshot().every((r)=>r.endpoint_error==="FILE_STDERR_CONFLICT"&&r.stdio_closed&&r.log_flush_verified&&r.cleanup==="CLOSED_AND_FLUSHED"));
  }
});
test("raw fetch/json error messages cannot escape via the real fullharness public error projection",async()=>{
  for(const json of [false,true]){const f=fixture({read:absent,fetch:async()=>{if(!json)throw new Error("PRIVATE_REDIRECT_TOKEN http://private/path");return{status:200,json:async()=>{throw new Error("PRIVATE_BODY_FRAGMENT");}};}});const entries=await f.group.launchAll();announce(f);const settled=await Promise.allSettled(entries.map((r)=>r.ready));for(const outcome of settled){assert.equal(outcome.status,"rejected");const publicError=String(outcome.reason.message).replace(/eyJ[A-Za-z0-9_.-]+/g,"<token>");assert.equal(publicError,"Owned Chromium startup");}await f.group.close();}
});
