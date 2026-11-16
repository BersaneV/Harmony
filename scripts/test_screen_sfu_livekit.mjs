// Disposable real Harmony/SQLite/LiveKit signaling proof. No RTP, capture,
// Windows devices, public networking or production account is used here.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignalResponse, SignalRequest, JoinRequest, WrappedJoinRequest } from '@livekit/protocol';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.local/qa-screen-sfu-livekit');
await mkdir(output, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(`${output}/run-`);
const checks = [], processes = new Set(), sockets = new Set();
const key = 'screen-rtc-real-fixture', secret = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, label) => { assert.ok(value, label); checks.push(label); };
async function until(predicate, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(30); }
  throw new Error(label);
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function launch(binary, args, env, label) {
  const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs = (logs + value).slice(-100_000); });
  child.once('exit', () => { processes.delete(child); void writeFile(`${directory}/${label}.log`, logs, { mode: 0o600 }); });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(4000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }),
  ]);
}
const lkPort = await port(), apiPort = await port(), udpPort = await port();
const base = `http://127.0.0.1:${apiPort}`, lkBase = `http://127.0.0.1:${lkPort}`;
function sign(body) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
function claims(token) {
  const [header, payload, signature] = token.split('.');
  assert.equal(signature, createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'));
  return JSON.parse(Buffer.from(payload, 'base64url'));
}
async function rpc(method, room, body) {
  const now = Math.floor(Date.now() / 1000);
  const token = sign({ iss: key, exp: now + 60, nbf: now - 2, video: { roomAdmin: true, room } });
  const response = await fetch(`${lkBase}/twirp/livekit.RoomService/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `Real LiveKit ${method}`);
  return response.json();
}
async function api(method, path, account, body, expected = [200, 201, 204]) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { ...(account ? { Authorization: `Bearer ${account.access_token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(expected.includes(response.status), `${method} API route returned ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function join(account, channel) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/calls`);
  const peer = { socket, frames: [], closed: false };
  sockets.add(peer);
  socket.addEventListener('message', event => peer.frames.push(JSON.parse(event.data)));
  socket.addEventListener('close', () => { peer.closed = true; clearInterval(peer.timer); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.send(JSON.stringify({ type: 'auth', token: account.access_token, channel_id: channel, screen_sfu: true }));
  await until(() => peer.frames.some(frame => frame.type === 'ready'), 'P2P registry admission');
  peer.ready = peer.frames.find(frame => frame.type === 'ready');
  peer.timer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 3000);
  return peer;
}
async function validate(token, expected, path = '/rtc/validate', extra = '') {
  const response = await fetch(`${base}${path}?access_token=${encodeURIComponent(token)}${extra}`);
  assert.ok(expected.includes(response.status), `RTC validate status ${response.status}, expected ${expected.join('/')}`);
  await response.arrayBuffer();
}
async function connect(token, path = '/rtc', extra = '') {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}?access_token=${encodeURIComponent(token)}&protocol=15&sdk=js&version=2.24.0&auto_subscribe=0${extra}`);
  socket.binaryType = 'arraybuffer';
  const peer = { socket, frames: [], closed: false };
  sockets.add(peer);
  socket.addEventListener('message', event => {
    const frame = typeof event.data === 'string' ? SignalResponse.fromJsonString(event.data) : SignalResponse.fromBinary(new Uint8Array(event.data));
    peer.frames.push(frame.message);
  });
  socket.addEventListener('close', () => { peer.closed = true; clearInterval(peer.timer); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RTC WebSocket open timeout')), 12_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('RTC WebSocket rejected')); }, { once: true });
  });
  await until(() => peer.frames.some(frame => frame.case === 'join'), 'Real LiveKit JoinResponse through Harmony');
  peer.joined = peer.frames.find(frame => frame.case === 'join').value;
  peer.timer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(new SignalRequest({ message: { case: 'ping', value: BigInt(Date.now()) } }).toBinary()); }, 2000);
  return peer;
}
async function closePeer(peer) {
  clearInterval(peer.timer);
  if (!peer.closed) peer.socket.close();
  await until(() => peer.closed, 'Owned socket close');
}
function permission(participant) { return participant.permission?.can_publish ?? participant.permission?.canPublish; }
let report;
try {
  const config = { port: lkPort, bind_addresses: ['127.0.0.1'], rtc: { tcp_port: 0, udp_port: udpPort, use_external_ip: false, node_ip: '127.0.0.1', stun_servers: [] }, keys: { [key]: secret }, logging: { level: 'warn' } };
  const configPath = `${directory}/livekit.json`;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const lk = launch(resolve(root, '.local/vendor/bin/livekit-server'), ['--config', configPath], { PATH: process.env.PATH }, 'livekit');
  await until(async () => { try { return (await fetch(lkBase)).ok; } catch { return false; } }, 'Real LiveKit startup');
  const app = launch(resolve(process.env.HARMONY_SERVER_BIN || `${root}/target/debug/harmony-server`), [], {
    PATH: process.env.PATH, DATABASE_URL: `sqlite:${directory}/harmony.db`, HARMONY_BIND: `127.0.0.1:${apiPort}`,
    HARMONY_STORAGE_BACKEND: 'local', HARMONY_STORAGE_DIR: `${directory}/files`, HARMONY_PUBLIC_API_URL: base,
    HARMONY_JWT_SECRET: randomBytes(32).toString('hex'), HARMONY_BOOTSTRAP_USERNAME: 'rtc_owner', HARMONY_BOOTSTRAP_PASSWORD: password,
    HARMONY_MEDIA_TRANSPORT: 'p2p', HARMONY_SCREEN_SFU_ENABLED: 'true', HARMONY_CALL_STUN_URLS: '', HARMONY_P2P_DIAGNOSTICS: 'false',
    LIVEKIT_URL: base.replace('http:', 'ws:'), LIVEKIT_API_URL: lkBase, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, RUST_LOG: 'warn',
  }, 'harmony');
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 'Harmony startup');
  const owner = await api('POST', '/auth/login', null, { username: 'rtc_owner', password });
  const guest = await api('POST', '/auth/register', null, { username: 'rtc_guest', password });
  const guild = await api('POST', '/guilds', owner, { name: 'Disposable real SFU signaling' });
  const channel = await api('POST', `/guilds/${guild.id}/channels`, owner, { name: 'Voice', kind: 'voice' });
  const invitation = await api('POST', `/guilds/${guild.id}/invites`, owner, { max_uses: 1, expires_hours: 1 });
  await api('POST', '/invites/accept', guest, { token: invitation.token });
  let caller = await join(guest, channel.id);
  const media = await api('POST', `/channels/${channel.id}/screen-token`, guest, { peer_id: caller.ready.peer_id });
  await validate(media.token, [200]);
  await validate('invalid', [401]);
  const forged = await fetch(`${base}/rtc/validate`, { headers: { 'X-Livekit-Query-Token': media.token } });
  check(forged.status === 401, 'Client-supplied proxy headers do not provide RTC credentials');
  const ambiguous = await fetch(`${base}/rtc/validate?access_token=${encodeURIComponent(media.token)}`, { headers: { Authorization: 'Bearer other' } });
  check(ambiguous.status === 401, 'Conflicting header/query credentials fail closed');
  const twirp = await fetch(`${base}/twirp/livekit.RoomService/ListRooms`);
  check(twirp.status === 404, 'Gateway does not expose LiveKit administration');
  const request = new WrappedJoinRequest({ joinRequest: new JoinRequest({ connectionSettings: { autoSubscribe: false } }).toBinary() }).toBinary();
  const joinRequest = `&join_request=${encodeURIComponent(Buffer.from(request).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'))}`;
  await validate(media.token, [200], '/rtc/v1/validate', joinRequest);
  check(true, 'Both validate route versions reach real LiveKit');
  const forgedRequest = new WrappedJoinRequest({ joinRequest: new JoinRequest({ metadata: '{"harmony_peer_id":"client-controlled"}' }).toBinary() }).toBinary();
  await validate(media.token, [401, 403], '/rtc/v1/validate', `&join_request=${encodeURIComponent(Buffer.from(forgedRequest).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'))}`);
  check(true, 'Real LiveKit rejects a client attempt to override signed peer metadata');
  let rtc = await connect(media.token, '/rtc/v1', joinRequest);
  const issued = claims(media.token), participant = rtc.joined.participant;
  check(participant.identity === issued.sub && JSON.parse(participant.metadata).harmony_peer_id === caller.ready.peer_id, 'JoinResponse preserves signed user/session identity and peer metadata');
  check(participant.permission.canPublish === true && participant.permission.canPublishSources.join() === '3,4' && participant.permission.canPublishData === false && participant.permission.canUpdateMetadata === false, 'Real LiveKit admits only screen sources and prohibits metadata/data publication');
  await until(() => rtc.frames.some(frame => frame.case === 'refreshToken'), 'Actual LiveKit token refresh');
  const renewed = rtc.frames.find(frame => frame.case === 'refreshToken').value;
  const refreshed = claims(renewed);
  check(refreshed.sub === issued.sub && refreshed.metadata === issued.metadata && refreshed.exp > issued.exp, 'Actual LiveKit renewal retains identity/metadata and extends expiration');
  await validate(renewed, [200]);
  check(true, 'Gateway accepts the actual renewed LiveKit token');
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'mute' });
  const mutedParticipant = await rpc('GetParticipant', media.room, { room: media.room, identity: issued.sub });
  check(permission(mutedParticipant) === false, 'Completed mute revokes publish permission in real LiveKit');
  await validate(media.token, [403]); await validate(renewed, [403]);
  check(true, 'Mute denies original and actual renewed publisher tokens');
  await closePeer(rtc);
  const receiver = await api('POST', `/channels/${channel.id}/screen-token`, guest, { peer_id: caller.ready.peer_id });
  await validate(receiver.token, [200]);
  rtc = await connect(receiver.token);
  check(rtc.joined.participant.permission.canPublish === false, 'Muted participant reconnects as receiver only');
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  const allowedParticipant = await rpc('GetParticipant', media.room, { room: media.room, identity: issued.sub });
  check(permission(allowedParticipant) === true, 'Unmute restores only currently authorized publication');
  await closePeer(caller);
  await validate(renewed, [403]); await validate(receiver.token, [403]);
  await until(() => rtc.closed, 'Leaving P2P registry removes its real LiveKit participant', 10_000);
  check(true, 'Leaving rejects renewed tokens and closes existing SFU signaling');
  caller = await join(guest, channel.id);
  const current = await api('POST', `/channels/${channel.id}/screen-token`, guest, { peer_id: caller.ready.peer_id });
  rtc = await connect(current.token);
  await validate(renewed, [403]);
  check(true, 'A new call peer cannot reuse the previous peer renewal');
  await api('POST', '/auth/logout', null, { refresh_token: guest.refresh_token });
  await validate(current.token, [401, 403]);
  await until(() => rtc.closed, 'Logout closes real SFU signaling', 10_000);
  check(true, 'Session revocation rejects entry and removes real SFU signaling');
  const ownerPeer = await join(owner, channel.id);
  const ownerMedia = await api('POST', `/channels/${channel.id}/screen-token`, owner, { peer_id: ownerPeer.ready.peer_id });
  await stop(lk);
  await validate(ownerMedia.token, [503]);
  check(true, 'An unavailable media backend yields a bounded gateway failure');
  await stop(app);
  report = { status: 'PASS', checks, services: ['Harmony', 'SQLite', 'LiveKit 1.13.11'], scope: 'Real local signaling/control plane through Harmony RTC gateway', not_run: ['RTP media negotiation', 'screen capture', 'Windows', 'eight clients', 'external networking'] };
} catch (error) {
  report = { status: 'FAIL', checks, error: error.message.replace(/[a-f0-9-]{36}/g, '<id>').replace(/eyJ[A-Za-z0-9_.-]+/g, '<token>'), scope: 'Real local signaling/control plane; no RTP media' };
  process.exitCode = 1;
} finally {
  for (const peer of sockets) { clearInterval(peer.timer); if (!peer.closed) peer.socket.close(); }
  await Promise.all([...processes].map(stop));
  await writeFile(`${directory}/result.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(`${output}/result.json`, JSON.stringify({ ...report, evidence_directory: directory }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
