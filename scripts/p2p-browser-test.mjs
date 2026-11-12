// Real Chromium/WebRTC peers using the shipped probe client and the real API.
// Two separate browser processes on ONE machine: never a WAN latency claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const api = process.env.HARMONY_TEST_URL || 'http://127.0.0.1:8080';
const web = process.env.HARMONY_WEB_URL || 'http://127.0.0.1:1420';
const chrome = process.env.HARMONY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
for (const url of [api, web]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Integration harness accepts loopback only');
const report = { status: 'RUNNING', scope: 'same-machine', browser_processes: 2, source: 'actual Harmony API + actual P2PProbe in two isolated Chromium processes', checks: [], benchmarks: [], not_verified: ['WAN / two independent networks', 'physical Windows / Tauri WebView2', 'screen or microphone capture', 'TURN', 'improvement against the historical 137 ms route'] };
const check = (value, label) => { assert.ok(value, label); report.checks.push(label); };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, seconds = 15) { const end = Date.now() + seconds * 1000; while (Date.now() < end) { if (await fn()) { report.checks.push(label); return; } await delay(100); } throw new Error(label); }
async function call(method, path, body, token, expected = [200, 201, 204]) {
  const response = await fetch(api + '/api' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(expected.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.sequence = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('CDP unavailable')); });
    this.ws.onmessage = event => { const value = JSON.parse(event.data); const pending = this.pending.get(value.id); if (!pending) return; this.pending.delete(value.id); value.error ? pending.reject(new Error(value.error.message)) : pending.resolve(value.result); };
  }
  async call(method, params = {}) {
    await this.ready; const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + (result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text));
    return result.result?.value;
  }
  close() { this.ws.close(); }
}
const processes = [];
const rawSockets = new Set();
async function browser() {
  const profile = await mkdtemp(join(tmpdir(), 'harmony-p2p-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  processes.push({ child, profile });
  child.stderr.resume();
  let port;
  await until(async () => { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port; } catch { return false; } }, 'isolated Chromium started');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(web)}`, { method: 'PUT' })).json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await until(async () => { try { return await cdp.evaluate('document.readyState === \"complete\" && location.origin === ' + JSON.stringify(web)); } catch { return false; } }, 'probe page origin loaded');
  await until(async () => { try { return await cdp.evaluate(`(async () => { window.P2PProbe = (await import('/src/lib/p2p.ts')).P2PProbe; return true; })()`); } catch { return false; } }, 'actual probe module loaded');
  return cdp;
}
async function start(cdp, session, probeId, channelId, height = 720) {
  const settings = { server: api, token: session.access_token, probeId, channelId, profile: { height, fps: 30, bitrate: 2_000_000 }, scope: 'same-machine' };
  await cdp.evaluate(`window.measurement = { status: '', snapshots: [], report: null }; window.probe = new window.P2PProbe({ ...${JSON.stringify(settings)}, onStatus: s => window.measurement.status = s, onSnapshot: s => window.measurement.snapshots.push(s), onVideo: stream => { const video = document.createElement('video'); video.muted = true; video.autoplay = true; video.srcObject = stream; document.body.append(video); }, onClosed: r => window.measurement.report = r }); true`);
}
const last = cdp => cdp.evaluate('window.measurement.snapshots.at(-1) || null');
async function rawJoin(token, probeId, channelId) {
  const socket = new WebSocket(api.replace(/^http/, 'ws') + '/api/p2p/ws');
  rawSockets.add(socket);
  const frames = []; let closed = false;
  socket.onmessage = event => frames.push(JSON.parse(event.data)); socket.onclose = () => { closed = true; rawSockets.delete(socket); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Probe WS unavailable')); });
  socket.send(JSON.stringify({ type: 'auth', token, probe_id: probeId, channel_id: channelId }));
  return { socket, frames, isClosed: () => closed };
}
let a, b;
try {
  await until(async () => { try { return (await fetch(api + '/health')).ok; } catch { return false; } }, 'API ready', 30);
  report.server_probe_source_sha256 = createHash('sha256').update(await readFile('crates/server/src/p2p.rs')).digest('hex');
  report.client_sha256 = createHash('sha256').update(await readFile('apps/desktop/src/lib/p2p.ts')).digest('hex');
  const admin = await call('POST', '/auth/login', { username: process.env.HARMONY_BOOTSTRAP_USERNAME, password: process.env.HARMONY_BOOTSTRAP_PASSWORD });
  const invite = await call('POST', '/admin/invites', { max_uses: 3, expires_hours: 1 }, admin.access_token);
  const suffix = randomBytes(4).toString('hex'), password = randomBytes(24).toString('hex');
  const people = [];
  for (const name of ['p2p_a', 'p2p_b', 'p2p_out']) people.push(await call('POST', '/auth/register', { username: name + '_' + suffix, display_name: name, password, invite_token: invite.token }));
  const [owner, guest, outsider] = people;
  const guild = await call('POST', '/guilds', { name: 'P2P probe ' + suffix }, owner.access_token);
  const channel = await call('POST', `/guilds/${guild.id}/channels`, { name: 'P2P probe', kind: 'voice' }, owner.access_token);
  const text = await call('POST', `/guilds/${guild.id}/channels`, { name: 'No calls', kind: 'text' }, owner.access_token);
  const joinInvite = await call('POST', `/guilds/${guild.id}/invites`, { max_uses: 1, expires_hours: 1 }, owner.access_token);
  await call('POST', '/invites/accept', { token: joinInvite.token }, guest.access_token);
  await call('POST', `/channels/${channel.id}/p2p-probes`, {}, undefined, [401]); report.checks.push('anonymous probe creation denied');
  await call('POST', `/channels/${channel.id}/p2p-probes`, {}, outsider.access_token, [403]); report.checks.push('outsider probe creation denied');
  await call('POST', `/channels/${text.id}/p2p-probes`, {}, owner.access_token, [403]); report.checks.push('text channel rejected');
  [a, b] = await Promise.all([browser(), browser()]);
  report.browser = await a.call('Browser.getVersion');
  let probe = await call('POST', `/channels/${channel.id}/p2p-probes`, {}, owner.access_token);
  await call('POST', `/channels/${channel.id}/p2p-probes`, {}, owner.access_token, [409]); report.checks.push('duplicate live probe denied');
  for (const [token, cid, label] of [['invalid', channel.id, 'invalid auth rejected'], [outsider.access_token, channel.id, 'outsider signaling rejected'], [guest.access_token, text.id, 'cross-channel signaling rejected']]) {
    const raw = await rawJoin(token, probe.probe_id, cid); await until(raw.isClosed, label); check(!raw.frames.some(x => x.type === 'ready'), label + ' before SDP');
  }
  await start(a, owner, probe.probe_id, channel.id);
  await until(async () => (await a.evaluate('window.measurement.status')).includes('Aguardando'), 'owner signaling authenticated');
  const duplicate = await rawJoin(owner.access_token, probe.probe_id, channel.id); await until(duplicate.isClosed, 'duplicate identity connection rejected');
  await start(b, guest, probe.probe_id, channel.id);
  await until(async () => { const [x,y] = await Promise.all([last(a),last(b)]); return x?.pingReceived >= 8 && y?.pingReceived >= 8 && y?.videoWidth > 0 && y?.videoFps > 0; }, 'bidirectional real RTCDataChannel pings and decoded synthetic video', 30);
  const snapshots = await Promise.all([last(a), last(b)]);
  check(snapshots.every(s => s.route === 'direct'), 'selected candidate pair confirmed direct');
  check(snapshots.every(s => s.signalingMedianMs !== null), 'server RTT measured separately');
  report.benchmarks.push({ label: 'same-machine synthetic 720p30', peers: snapshots });
  await call('PUT', `/channels/${channel.id}/permissions`, { role_id: null, allow: '0', deny: '32' }, owner.access_token);
  await until(async () => (await a.evaluate('!!window.measurement.report')) && (await b.evaluate('!!window.measurement.report')), 'PUBLISH revocation closes both official peers', 8);
  await call('POST', `/channels/${channel.id}/p2p-probes`, {}, guest.access_token, [403]); report.checks.push('revoked PUBLISH denies new probe');
  await call('PUT', `/channels/${channel.id}/permissions`, { role_id: null, allow: '0', deny: '0' }, owner.access_token);
  probe = await call('POST', `/channels/${channel.id}/p2p-probes`, {}, owner.access_token);
  await start(a, owner, probe.probe_id, channel.id, 1440);
  await until(async () => (await a.evaluate('window.measurement.status')).includes('Aguardando'), 'second owner probe ready');
  await start(b, guest, probe.probe_id, channel.id, 1440);
  await until(async () => (await last(b))?.videoHeight === 1440 && (await last(b))?.pingReceived >= 3, 'synthetic 1440p received by real browser', 30);
  report.benchmarks.push({ label: 'same-machine synthetic 1440p30', peers: await Promise.all([last(a),last(b)]) });
  await call('POST', `/admin/users/${guest.user.id}/reset`, { password: process.env.HARMONY_BOOTSTRAP_PASSWORD }, admin.access_token);
  await until(async () => (await a.evaluate('!!window.measurement.report')) && (await b.evaluate('!!window.measurement.report')), 'password reset closes both official peers', 8);
  const revoked = await rawJoin(guest.access_token, probe.probe_id, channel.id); await until(revoked.isClosed, 'revoked token denied');
  probe = await call('POST', `/channels/${channel.id}/p2p-probes`, {}, owner.access_token);
  const expiry = await rawJoin(owner.access_token, probe.probe_id, channel.id);
  await until(() => expiry.frames.some(x => x.type === 'ready'), 'expiry probe admitted');
  const ready = expiry.frames.find(x => x.type === 'ready'); check(ready.expires_in <= 120, 'server TTL at most 120 seconds');
  await until(expiry.isClosed, 'idle probe actually expires without participant traffic', 125);
  const expired = await rawJoin(owner.access_token, probe.probe_id, channel.id); await until(expired.isClosed, 'expired probe cannot be rejoined');
  probe = await call('POST', `/channels/${channel.id}/p2p-probes`, {}, owner.access_token);
  const malformed = await rawJoin(owner.access_token, probe.probe_id, channel.id);
  await until(() => malformed.frames.some(x => x.type === 'ready'), 'malformed probe admitted');
  malformed.socket.send(JSON.stringify({ type: 'description', description: { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' } }));
  await until(malformed.isClosed, 'audio SDP refused by diagnostic signaling');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.message; process.exitCode = 1;
} finally {
  for (const socket of rawSockets) socket.close();
  for (const cdp of [a,b].filter(Boolean)) { await cdp.evaluate('window.probe?.stop()').catch(() => {}); cdp.close(); }
  for (const { child, profile } of processes) { child.kill('SIGTERM'); await delay(300); if (child.exitCode === null) child.kill('SIGKILL'); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  const output = resolve(process.env.HARMONY_P2P_REPORT || '.local/p2p/browser-evidence.json');
  await mkdir(join(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
  await new Promise(resolve => process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks.length, scope: report.scope, benchmarks: report.benchmarks, error: report.error, evidence: output, not_verified: report.not_verified }) + '\n', resolve));
  // Chromium/undici may retain closed debugging sockets; all owned children and files are already cleaned up.
  process.exit(process.exitCode || 0);
}
