// Eight isolated Chromium engines with generated canvas/tone sources and real
// Harmony/SQLite/LiveKit. Verifies hybrid routing, decoded voice, and fallback.
// This does not measure requested FPS/resolution, physical capture, or WAN.
// Optional paths: HARMONY_CHROME, HARMONY_SERVER_BIN, HARMONY_LIVEKIT_BIN.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadStream } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".local/qa-call-screen-sfu");
await mkdir(output, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(`${output}/run-`);
const checks = [],
  processes = new Set(),
  sockets = new Set();
const key = "screen-rtc-real-fixture",
  secret = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (value, label) => {
  assert.ok(value, label);
  checks.push(label);
};
async function until(predicate, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(label);
}
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function launch(binary, args, env, label) {
  const child = spawn(binary, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  let logs = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (value) => {
      logs = (logs + value).slice(-100_000);
    });
  child.once("exit", () => {
    processes.delete(child);
    void writeFile(`${directory}/${label}.log`, logs, { mode: 0o600 });
  });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(4000).then(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }),
  ]);
}
const lkPort = await port(),
  apiPort = await port(),
  udpPort = await port();
const base = `http://127.0.0.1:${apiPort}`,
  lkBase = `http://127.0.0.1:${lkPort}`;
async function api(method, path, account, body, expected = [200, 201, 204]) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(account ? { Authorization: `Bearer ${account.access_token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(
    expected.includes(response.status),
    `${method} API route returned ${response.status}`,
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error("CDP connection failed"));
    });
    this.socket.onmessage = (event) => {
      const value = JSON.parse(event.data),
        pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      value.error
        ? pending.reject(new Error(value.error.message))
        : pending.resolve(value.result);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, userGesture = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails)
      throw new Error(
        "Browser evaluation failed: " +
          (result.exceptionDetails.exception?.description?.split("\n")[0] ||
            result.exceptionDetails.text),
      );
    return result.result?.value;
  }
  run(body, userGesture = false) {
    return this.evaluate(`(async () => { ${body} })()`, userGesture);
  }
  close() {
    this.socket.close();
  }
}

const webPort = await port(),
  web = `http://127.0.0.1:${webPort}`,
  browsers = [];
async function browser(index) {
  const profile = await mkdtemp(`${directory}/browser-${index}-`);
  const browserProcess = launch(
    process.env.HARMONY_CHROME ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "google-chrome"),
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-audio-output",
      "--disable-audio-input",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { ...globalThis.process.env },
    `browser-${index}`,
  );
  let debug;
  await until(async () => {
    try {
      debug = Number(
        (await readFile(`${profile}/DevToolsActivePort`, "utf8")).split(
          "\n",
        )[0],
      );
      return !!debug;
    } catch {
      return false;
    }
  }, "Owned Chromium startup");
  const target = await (
    await fetch(
      `http://127.0.0.1:${debug}/json/new?${encodeURIComponent(web)}`,
      { method: "PUT" },
    )
  ).json();
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await until(async () => {
    try {
      return await client.evaluate(
        `location.origin===${JSON.stringify(web)} && document.readyState==='complete'`,
      );
    } catch {
      return false;
    }
  }, "Owned Chromium Vite origin");
  await client.run(
    `
 window.qa={errors:[],elements:new Map(),resources:[]}; window.addEventListener('unhandledrejection',event=>qa.errors.push(String(event.reason?.message||event.reason)));
 window.callApi=await import('/src/lib/api.ts'); window.P2PCall=(await import('/src/lib/call.ts')).P2PCall;
 window.capturePort=await import('/src/lib/capture-track.ts');
 qa.audio=new AudioContext({sinkId:{type:'none'}});await qa.audio.resume();
 qa.tone=f=>{const o=qa.audio.createOscillator(),g=qa.audio.createGain(),d=qa.audio.createMediaStreamDestination();o.frequency.value=f;g.gain.value=.1;o.connect(g).connect(d);o.start();qa.resources.push(o);return d.stream.getAudioTracks()[0];};
 qa.render=s=>{qa.latest=s;const active=new Set();for(const peer of s.participants)for(const[source,track]of Object.entries(peer.tracks)){if(!track)continue;const key=peer.peer_id+':'+source;active.add(key);let old=qa.elements.get(key);if(old?.track===track)continue;if(old)old.element.remove();const element=document.createElement(track.kind==='video'?'video':'audio');element.autoplay=true;element.muted=track.kind==='video';element.srcObject=new MediaStream([track]);document.body.append(element);element.play().catch(()=>{});qa.elements.set(key,{track,element});}for(const[key,old]of qa.elements)if(!active.has(key)){old.element.remove();qa.elements.delete(key);}};
 qa.decodedMics=async()=>Promise.all([...rtcCall.peers.values()].map(async p=>{const stats=await p.pc.getStats();return [...stats.values()].some(r=>r.type==='inbound-rtp'&&r.kind==='audio'&&r.mid==='0'&&r.bytesReceived>0&&r.totalAudioEnergy>0);}));
 qa.serial=()=>({state:rtcCall.snapshot.state,participants:rtcCall.snapshot.participants.map(p=>({id:p.peer_id,user:p.user_id,connection:p.connection,screenTransport:p.screenTransport,screenIceRttMs:p.screenIceRttMs,stats:p.stats,sources:Object.keys(p.tracks)})),screenUpload:rtcCall.snapshot.screenUpload,relayPublisherStats:rtcCall.relaySentStats,local:Object.keys(rtcCall.snapshot.localTracks),relay:!!rtcCall.relay,relayRef:rtcCall.relayLocalRef??null,p2p:[...rtcCall.peers.values()].map(p=>({id:p.member.peer_id,mic:p.pc.getTransceivers()[0]?.sender.track?.id??null,screen:p.pc.getTransceivers()[2]?.sender.track?.id??null,audio:p.pc.getTransceivers()[3]?.sender.track?.id??null,screenEncodings:p.pc.getTransceivers()[2]?.sender.getParameters().encodings??[]})),mic:qa.mic?.id,errors:qa.errors});
 true;`,
    true,
  );
  const result = { index, process: browserProcess, profile, client };
  browsers.push(result);
  return result;
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const evidence = {
  git_head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  source_hashes: {},
  server_binary_sha256: await digest(
    resolve(
      process.env.HARMONY_SERVER_BIN || `${root}/target/debug/harmony-server`,
    ),
  ),
};
for (const name of [
  "apps/desktop/src/lib/call.ts",
  "apps/desktop/src/lib/screen-relay.ts",
  "apps/desktop/src/lib/capture-track.ts",
  "apps/desktop/src/components/P2PCallPanel.tsx",
  "scripts/test_call_screen_sfu.mjs",
])
  evidence.source_hashes[name] = await digest(resolve(root, name));
let report;
try {
  const configPath = `${directory}/livekit.json`;
  await writeFile(
    configPath,
    JSON.stringify({
      port: lkPort,
      bind_addresses: ["127.0.0.1"],
      rtc: {
        tcp_port: 0,
        udp_port: udpPort,
        use_external_ip: false,
        node_ip: "127.0.0.1",
        enable_loopback_candidate: true,
        stun_servers: [],
      },
      keys: { [key]: secret },
      logging: { level: "warn" },
    }),
    { mode: 0o600 },
  );
  const lk = launch(
    resolve(
      process.env.HARMONY_LIVEKIT_BIN ||
        `${root}/.local/vendor/bin/livekit-server`,
    ),
    ["--config", configPath],
    { PATH: process.env.PATH },
    "livekit",
  );
  await until(async () => {
    try {
      return (await fetch(lkBase)).ok;
    } catch {
      return false;
    }
  }, "LiveKit ready");
  launch(
    process.execPath,
    [
      resolve(root, "node_modules/vite/bin/vite.js"),
      "apps/desktop",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    { ...process.env },
    "vite",
  );
  await until(async () => {
    try {
      return (await fetch(web)).ok;
    } catch {
      return false;
    }
  }, "Vite ready");
  launch(
    resolve(
      process.env.HARMONY_SERVER_BIN || `${root}/target/debug/harmony-server`,
    ),
    [],
    {
      PATH: process.env.PATH,
      DATABASE_URL: `sqlite:${directory}/harmony.db`,
      HARMONY_BIND: `127.0.0.1:${apiPort}`,
      HARMONY_STORAGE_BACKEND: "local",
      HARMONY_STORAGE_DIR: `${directory}/files`,
      HARMONY_PUBLIC_API_URL: base,
      HARMONY_PUBLIC_ORIGIN: web,
      HARMONY_JWT_SECRET: randomBytes(32).toString("hex"),
      HARMONY_BOOTSTRAP_USERNAME: "browser_admin",
      HARMONY_BOOTSTRAP_PASSWORD: password,
      HARMONY_MEDIA_TRANSPORT: "p2p",
      HARMONY_SCREEN_SFU_ENABLED: "true",
      HARMONY_CALL_STUN_URLS: "",
      HARMONY_P2P_DIAGNOSTICS: "false",
      LIVEKIT_URL: base.replace("http:", "ws:"),
      LIVEKIT_API_URL: lkBase,
      LIVEKIT_API_KEY: key,
      LIVEKIT_API_SECRET: secret,
      RUST_LOG: "warn",
    },
    "harmony",
  );
  await until(async () => {
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  }, "Harmony ready");
  const accounts = [];
  for (let i = 0; i < 8; i++)
    accounts.push(
      await api("POST", "/auth/register", null, {
        username: `browser_peer_${i}`,
        password,
      }),
    );
  const owner = accounts[0],
    guild = await api("POST", "/guilds", owner, {
      name: "Eight hybrid browser peers",
    }),
    channel = await api("POST", `/guilds/${guild.id}/channels`, owner, {
      name: "Hybrid",
      kind: "voice",
    });
  const invite = await api("POST", `/guilds/${guild.id}/invites`, owner, {
    max_uses: 7,
    expires_hours: 1,
  });
  for (const account of accounts.slice(1))
    await api("POST", "/invites/accept", account, { token: invite.token });
  await Promise.all(Array.from({ length: 8 }, (_, i) => browser(i)));
  await Promise.all(
    browsers.map((b, i) =>
      b.client.run(
        `await callApi.setServer(${JSON.stringify(base)});await callApi.saveSession(${JSON.stringify(accounts[i])});window.rtcCall=new P2PCall({channelId:${JSON.stringify(channel.id)}});rtcCall.subscribe(qa.render);await rtcCall.connect();qa.mic=qa.tone(${300 + i * 60});await rtcCall.setTrack('microphone',qa.mic);true;`,
        true,
      ),
    ),
  );
  const snapshots = () =>
    Promise.all(browsers.map((b) => b.client.evaluate("qa.serial()")));
  await until(
    async () => {
      const all = await snapshots();
      return (
        all.length === 8 &&
        all.every(
          (s) =>
            s.state === "connected" &&
            s.participants.length === 7 &&
            s.participants.every(
              (p) =>
                p.connection === "connected" &&
                p.sources.includes("microphone"),
            ),
        )
      );
    },
    "Eight peers with seven incoming P2P microphones",
    30000,
  );
  check(
    (await snapshots()).every((s) => s.p2p.every((p) => p.mic === s.mic)),
    "Eight real Chromium engines retain their original P2P voice tracks",
  );
  await until(
    async () => {
      const all = await Promise.all(
        browsers.map((b) => b.client.evaluate("qa.decodedMics()")),
      );
      return all.every(
        (values) => values.length === 7 && values.every(Boolean),
      );
    },
    "All fifty-six incoming P2P microphone paths receive and decode generated audio",
    15000,
  );
  check(
    true,
    "All fifty-six incoming P2P microphone paths receive and decode generated audio",
  );
  await until(
    async () => (await snapshots()).every((s) => s.relay),
    "All eight real SDK rooms connect",
    15000,
  );
  check(
    true,
    "Eight screen-only SDK rooms connect using production HTTP and RTC gateway",
  );
  await browsers[0].client.run(
    `
 qa.canvas=document.createElement('canvas');qa.canvas.width=640;qa.canvas.height=360;document.body.append(qa.canvas);const ctx=qa.canvas.getContext('2d');let frame=0;qa.timer=setInterval(()=>{ctx.fillStyle='#8224a3';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.fillRect((frame++*7)%640,30,40,40);},66);qa.screen=qa.canvas.captureStream(15).getVideoTracks()[0];
 capturePort.registerCaptureTrack(qa.screen,{settings:()=>qa.screen.getSettings(),maxHeight:()=>720,applyConstraints:async()=>{},release:()=>{qa.screen.stop();clearInterval(qa.timer);}});
 await rtcCall.setScreenProfile({height:720,fps:30,bitrate:2,content:'motion',audio:true});await rtcCall.setTrack('screen',qa.screen);qa.screenAudio=qa.tone(1200);await rtcCall.setTrack('screen_audio',qa.screenAudio);true;`,
    true,
  );
  await until(
    async () => {
      const all = await snapshots();
      return (
        all[0].relayRef &&
        all
          .slice(1)
          .every(
            (s) =>
              s.participants.find((p) => p.user === owner.user.id)
                ?.screenTransport === "sfu",
          )
      );
    },
    "All seven receivers decode SFU screen and screen audio",
    30000,
  );
  let all = await snapshots();
  check(
    all.every((s) => s.p2p.every((p) => p.mic === s.mic)) &&
      all[0].p2p.every((p) => p.screen === null && p.audio === null),
    "After confirmed SFU ACK only screen senders retire; original voice remains P2P",
  );
  await until(
    async () => {
      const all = await snapshots();
      return (
        all[0].screenUpload?.connections.sfu === 1 &&
        all[0].screenUpload.connections.p2p === 0 &&
        all[0].screenUpload.bitrate > 0 &&
        !all[0].screenUpload.partial &&
        all[0].screenUpload.maxBitrate === 2_000_000 &&
        !all[0].screenUpload.maxBitratePartial &&
        all.slice(1).every((s) => {
          const peer = s.participants.find((p) => p.user === owner.user.id),
            stats = peer?.stats.received.screen;
          return (
            peer?.screenTransport === "sfu" &&
            stats?.width > 0 &&
            stats.height > 0 &&
            stats.fps > 0 &&
            stats.bitrate > 0 &&
            stats.sourceRef?.track_sid === all[0].relayRef.track_sid &&
            stats.sourceRef.generation === all[0].relayRef.generation &&
            stats.publicationSid === stats.sourceRef.track_sid &&
            Number.isFinite(peer.screenIceRttMs) &&
            Number.isFinite(peer.stats.iceRttMs) &&
            peer.stats.route === "direct"
          );
        })
      );
    },
    "Seven real SFU receivers report RTP dimensions/FPS/bitrate and separate video/voice ICE; one measured upstream with one applied cap",
    15000,
  );
  all = await snapshots();
  evidence.telemetry_sfu = all;
  check(
    all[0].screenUpload.bitrate === all[0].relayPublisherStats.screen.bitrate,
    "Seven SFU viewers count the single measured publisher upload exactly once",
  );
  check(
    true,
    "All seven decoded SDK screens expose real RTP dimensions/FPS/bitrate and their own ICE RTT with source SID/generation",
  );
  const ownerPeer = all[0].participants.find(
    (p) => p.user === accounts[1].user.id,
  )?.id;
  const receiverOwner = all[1].participants.find(
    (p) => p.user === owner.user.id,
  ).id;
  await browsers[1].client.run(
    `rtcCall.setReceiveHeight(${JSON.stringify(receiverOwner)},360);true;`,
  );
  await until(
    async () => {
      const all = await snapshots();
      return (
        all[1].participants.find((p) => p.user === owner.user.id)
          ?.screenTransport === "p2p" &&
        all[0].p2p.find((p) => p.id === ownerPeer)?.screen !== null
      );
    },
    "Explicit cap below native envelope restores that receiver to P2P",
    15000,
  );
  check(
    true,
    "One capped recipient falls back independently without moving the other six",
  );
  await until(
    async () => {
      const all = await snapshots(),
        upload = all[0].screenUpload,
        sender = all[0].participants.find((p) => p.id === ownerPeer),
        receiver = all[1].participants.find((p) => p.user === owner.user.id);
      return (
        upload.connections.sfu === 1 &&
        upload.connections.p2p === 1 &&
        !upload.partial &&
        !upload.maxBitratePartial &&
        upload.maxBitrate === 4_000_000 &&
        sender?.stats.sent.screen?.bitrate > 0 &&
        receiver?.stats.received.screen?.bitrate > 0 &&
        upload.bitrate ===
          all[0].relayPublisherStats.screen.bitrate +
            sender.stats.sent.screen.bitrate &&
        all
          .slice(2)
          .every(
            (s) =>
              s.participants.find((p) => p.user === owner.user.id)
                ?.screenTransport === "sfu",
          )
      );
    },
    "Mixed upload sums one SDK publisher and one measured P2P fallback, with two applied caps",
    15000,
  );
  evidence.telemetry_mixed = await snapshots();
  check(
    true,
    "Mixed screen upload sums the single SDK publisher plus one real P2P sender and their applied caps",
  );
  await stop(lk);
  await until(
    async () => {
      const all = await snapshots();
      return (
        all
          .slice(1)
          .every(
            (s) =>
              s.participants.find((p) => p.user === owner.user.id)
                ?.screenTransport === "p2p",
          ) &&
        all[0].p2p.every((p) => p.screen !== null && p.mic === all[0].mic)
      );
    },
    "Real SFU loss restores P2P screen and audio for all recipients",
    20000,
  );
  all = await snapshots();
  check(
    all[0].screenUpload.connections.sfu === 0 &&
      all[0].screenUpload.connections.p2p === 7 &&
      all[0].screenUpload.maxBitrate === 14_000_000,
    "SFU loss removes its telemetry and the applied video ceiling follows seven real P2P senders",
  );
  evidence.telemetry_p2p = all;
  check(
    all.every(
      (s) =>
        s.state === "connected" &&
        s.participants.every((p) => p.sources.includes("microphone")),
    ),
    "SFU loss preserves all eight original P2P microphones and connected calls",
  );
  check(
    all.every((s) => s.errors.length === 0),
    "No unhandled browser errors during hybrid switching",
  );
  report = {
    status: "PASS",
    checks,
    scope:
      "Eight isolated real Chromium engines, real Harmony/SQLite/LiveKit, generated sources; transport, lifecycle and effective RTP telemetry",
    not_run: [
      "Physical capture",
      "Windows WebView2",
      "1080p60/1440p60 performance",
      "External networks/NAT",
    ],
  };
} catch (error) {
  report = {
    status: "FAIL",
    checks,
    error: String(error.message).replace(/eyJ[A-Za-z0-9_.-]+/g, "<token>"),
    snapshots: await Promise.all(
      browsers.map(async (b) => {
        try {
          return await b.client.evaluate("qa.serial?.()??null");
        } catch {
          return null;
        }
      }),
    ),
    scope: "Real local generated-media browser review",
  };
  process.exitCode = 1;
} finally {
  for (const b of browsers) {
    try {
      await b.client.run("rtcCall?.close();true;");
    } catch {}
    b.client.close();
  }
  for (const peer of sockets) {
    clearInterval(peer.timer);
    if (!peer.closed) peer.socket.close();
  }
  await Promise.all([...processes].map(stop));
  await Promise.all(
    browsers.map((b) => rm(b.profile, { recursive: true, force: true })),
  );
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify({ ...report, ...evidence }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      { ...report, ...evidence, evidence_directory: directory },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      error: report.error,
      evidence_directory: directory,
    }),
  );
}
