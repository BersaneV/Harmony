// Real HTTP/WebSocket protocol against a disposable API, SQLite and local files.
// No LiveKit, devices, external STUN, media capture, or production accounts.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const binary = resolve(process.env.HARMONY_SERVER_BIN || `${root}/target/debug/harmony-server`);
const databaseBinary = resolve(root, 'target/debug/harmony-db');
const output = resolve(root, '.local/qa-call-protocol');
await mkdir(output, { recursive: true, mode: 0o700 });
const folder = await mkdtemp(`${output}/instance-`);
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString('hex');
const env = { PATH: process.env.PATH, DATABASE_URL: `sqlite:${folder}/harmony.db`, HARMONY_BIND: `127.0.0.1:${port}`,
  HARMONY_STORAGE_BACKEND: 'local', HARMONY_STORAGE_DIR: `${folder}/files`, HARMONY_PUBLIC_API_URL: base,
  HARMONY_JWT_SECRET: randomBytes(32).toString('hex'), HARMONY_BOOTSTRAP_USERNAME: 'call_admin',
  HARMONY_BOOTSTRAP_PASSWORD: password, HARMONY_MEDIA_TRANSPORT: 'p2p', HARMONY_CALL_STUN_URLS: '',
  HARMONY_P2P_DIAGNOSTICS: 'false', HARMONY_MAX_ROOM_PARTICIPANTS: '3', RUST_LOG: 'warn' };
const server = spawn(binary, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', data => { log += data; });
server.stderr.on('data', data => { log += data; });
const sockets = new Set();
const checks = [];
const timings = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, label) => { assert.ok(condition, label); checks.push(label); };
async function until(condition, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await delay(20); }
  throw new Error(label);
}
async function api(method, path, session, body, expected = [200, 201, 204]) {
  const response = await fetch(`${base}/api${path}`, { method,
    headers: { ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  assert.ok(expected.includes(response.status), `${method} ${path.replace(/[a-f0-9-]{36}/g, '<id>')} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function join(account, channel, options = {}) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/calls');
  const peer = { socket, frames: [], closed: false, ready: null };
  sockets.add(peer);
  socket.addEventListener('message', event => { peer.frames.push(JSON.parse(event.data)); });
  socket.addEventListener('close', () => { peer.closed = true; clearInterval(peer.timer); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.send(JSON.stringify(options.frame || { type: 'auth', token: account?.access_token || '', channel_id: channel }));
  await until(() => peer.closed || peer.frames.some(v => v.type === 'ready' || v.type === 'closed'), 'Admission did not settle');
  peer.ready = peer.frames.find(v => v.type === 'ready');
  if (peer.ready && options.heartbeat !== false) peer.timer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
  }, 5000);
  return peer;
}
function send(peer, value) { peer.socket.send(JSON.stringify(value)); }
const roster = peer => peer.frames.findLast(v => v.type === 'roster')?.participants || peer.ready?.participants || [];
const self = peer => roster(peer).find(p => p.peer_id === peer.ready.peer_id);
async function stop(peer) { if (!peer.closed) peer.socket.close(); await until(() => peer.closed, 'Client did not close'); await delay(40); }
function sql(query) {
  const result = spawnSync(databaseBinary, ['query'], { env, input: query, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, 'Fixture SQL failed');
  return JSON.parse(result.stdout);
}
function uuidLiteral(id) { assert.match(id, /^[a-f0-9-]{36}$/); return `X'${id.replaceAll('-', '')}'`; }
function signed(account, changes) {
  const [header, payload] = account.access_token.split('.');
  const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), ...changes })).toString('base64url');
  return { ...account, access_token: `${header}.${modified}.${createHmac('sha256', env.HARMONY_JWT_SECRET).update(`${header}.${modified}`).digest('base64url')}` };
}
let report;
try {
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 'Disposable API did not start', 15_000);
  const admin = await api('POST', '/auth/login', null, { username: 'call_admin', password });
  const accounts = [];
  for (const name of ['owner', 'host', 'guest', 'race1', 'race2', 'idle', 'outsider', 'disabled']) {
    accounts.push(await api('POST', '/auth/register', null, { username: `call_${name}`, password }));
  }
  const [owner, host, guest, race1, race2, idle, outsider, disabled] = accounts;
  const guild = await api('POST', '/guilds', owner, { name: 'Call protocol fixtures' });
  const channel = await api('POST', `/guilds/${guild.id}/channels`, owner, { name: 'Real call', kind: 'voice' });
  const other = await api('POST', `/guilds/${guild.id}/channels`, owner, { name: 'Other call', kind: 'voice' });
  const text = await api('POST', `/guilds/${guild.id}/channels`, owner, { name: 'Not a call', kind: 'text' });
  const invitation = await api('POST', `/guilds/${guild.id}/invites`, owner, { max_uses: 6, expires_hours: 1 });
  for (const account of [host, guest, race1, race2, idle, disabled]) await api('POST', '/invites/accept', account, { token: invitation.token });
  await api('GET', `/channels/${channel.id}/call`, null, undefined, [401]);
  await api('GET', `/channels/${channel.id}/call`, outsider, undefined, [403]);
  await api('GET', `/channels/${text.id}/call`, guest, undefined, [403]);
  check(true, 'HTTP discovery requires identity, membership and a callable channel');
  const info = await api('GET', `/channels/${channel.id}/call`, guest);
  check(info.transport === 'p2p' && info.max_participants === 3 && info.ice_servers.length === 0 && info.max_video_bitrate === 32_000_000, 'Explicit call settings independent of diagnostic flag and LiveKit');
  check((await api('GET', '/instance')).media_transport === 'p2p', 'Instance metadata declares the active media transport');
  const wrongMode = await api('POST', `/channels/${channel.id}/media-token`, guest, {}, [503]);
  check(wrongMode.error.message.includes('P2P'), 'LiveKit token endpoint rejects the incompatible transport with an explanation');
  await api('GET', '/internal/media-admit', guest, undefined, [403]);
  check(true, 'LiveKit internal admission is disabled in direct-call mode');
  check(!(await join(null, channel.id)).ready, 'Anonymous WebSocket rejected');
  check(!(await join(outsider, channel.id)).ready, 'Outsider WebSocket rejected');
  check(!(await join(guest, text.id)).ready, 'Text-channel WebSocket rejected');
  check(!(await join(guest, channel.id, { frame: { type: 'auth', token: guest.access_token, channel_id: channel.id, peer_id: 'forged' } })).ready, 'Client-selected identity rejected at admission');
  check(!(await join(guest, channel.id, { frame: { type: 'ping' } })).ready, 'Authentication must be the first frame');
  for (const account of [guest, race1]) {
    const friendship = await api('POST', '/friends', host, { username: account.user.username });
    await api('POST', `/friends/${friendship.id}/accept`, account);
  }
  const dm = await api('POST', '/conversations', host, { user_ids: [guest.user.id] });
  const dmPeers = await Promise.all([join(host, dm.id), join(guest, dm.id)]);
  check(dmPeers.every(p => p.ready), 'Direct-message participants can enter a private call');
  await api('GET', `/channels/${dm.id}/call`, outsider, undefined, [403]);
  for (const peer of dmPeers) await stop(peer);
  const group = await api('POST', '/conversations', host, { user_ids: [guest.user.id, race1.user.id], name: 'Private group call' });
  const groupPeers = await Promise.all([join(host, group.id), join(guest, group.id), join(race1, group.id)]);
  await until(() => groupPeers.every(p => p.ready && roster(p).length === 3), 'Group call roster did not converge');
  check(true, 'Group conversation admits three current members with a converged roster');
  for (const peer of groupPeers) await stop(peer);
  const identityRace = await Promise.all([join(idle, channel.id), join(idle, other.id)]);
  check(identityRace.filter(p => p.ready).length === 1, 'Concurrent same-user admission reserves one global connection');
  await stop(identityRace.find(p => p.ready));

  const started = Date.now();
  const long = await join(owner, other.id);
  check(Boolean(long.ready), 'Long-running call admitted without diagnostics enabled');
  let hp = await join(host, channel.id);
  let gp = await join(guest, channel.id);
  check(hp.ready.participants.length === 1 && gp.ready.participants.length === 2, 'Authoritative ready roster includes self');
  await until(() => roster(hp).length === 2, 'Join roster not broadcast');
  assert.deepEqual(Object.keys(self(gp)).sort(), ['can_publish', 'display_name', 'media', 'peer_id', 'user_id']);
  check(self(gp).user_id === guest.user.id && Object.values(self(gp).media).every(v => v === false), 'Server-owned identity and initially disabled capture flags');
  const collision = await join(host, other.id);
  check(!collision.ready && collision.frames.some(v => v.code === 'already_connected') && !hp.closed, 'Second call rejected globally without terminating first connection');
  const race = await Promise.all([join(race1, channel.id), join(race2, channel.id)]);
  check(race.filter(p => p.ready).length === 1 && race.some(p => p.frames.some(v => v.code === 'room_full')), 'Concurrent admission reserves only one remaining room slot');
  await stop(race.find(p => p.ready));
  await until(() => roster(hp).length === 2, 'Disconnected peer remained in roster');
  check(true, 'Disconnect releases the slot and updates peers');
  const outsideStart = long.frames.length;
  const senderStart = gp.frames.length;
  send(gp, { type: 'signal', to: long.ready.peer_id, data: { candidate: null } });
  send(gp, { type: 'signal', to: race.find(p => p.ready).ready.peer_id, data: { candidate: null } });
  send(gp, { type: 'ping' });
  await until(() => gp.frames.slice(senderStart).some(v => v.type === 'pong'), 'Dropped destinations disrupted sender');
  check(!long.frames.slice(outsideStart).some(v => v.type === 'signal') && !gp.closed, 'Cross-channel and departed destinations receive no signal without a departure cascade');
  for (const data of [ { description: { type: 'offer', sdp: 'v=0\r\n' } }, { description: { type: 'answer', sdp: 'v=0\r\n' } }, { candidate: { candidate: 'candidate:fixture', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'fixture' } }, { candidate: null }, { receive: { screen_height: 720 } } ]) {
    const before = gp.frames.length;
    send(hp, { type: 'signal', to: gp.ready.peer_id, data });
    await until(() => gp.frames.slice(before).some(v => v.type === 'signal'), 'Signal not relayed');
    const event = gp.frames.slice(before).find(v => v.type === 'signal');
    assert.deepEqual(event, { type: 'signal', from: hp.ready.peer_id, data });
  }
  check(true, 'Typed SDP, ICE, end-of-candidates and receive quality relay with server identity');
  send(gp, { type: 'media', microphone: true, camera: true, screen: true, screen_audio: true });
  await until(() => self(gp).media.screen_audio, 'Media state not broadcast');
  check(true, 'Authorized media flags propagate to authoritative roster');
  send(gp, { type: 'media', microphone: false, camera: false, screen: false, screen_audio: true });
  await until(() => !self(gp).media.screen_audio, 'Screen audio survived absent screen');
  check(true, 'Screen audio requires an active screen flag');

  for (const [label, frame] of [
    ['Forged sender rejected', { type: 'signal', to: hp.ready.peer_id, from: hp.ready.peer_id, data: { candidate: null } }],
    ['Unknown signal keys rejected', { type: 'signal', to: hp.ready.peer_id, data: { candidate: null, forged: true } }],
    ['Invalid receive resolution rejected', { type: 'signal', to: hp.ready.peer_id, data: { receive: { screen_height: 999 } } }],
    ['Oversized SDP rejected', { type: 'signal', to: hp.ready.peer_id, data: { description: { type: 'offer', sdp: 'x'.repeat(49 * 1024) } } }],
  ]) {
    send(gp, frame); await until(() => gp.closed, label); check(true, label); gp = await join(guest, channel.id); assert.ok(gp.ready);
  }
  send(gp, { type: 'signal', to: gp.ready.peer_id, data: { candidate: null } });
  await until(() => gp.closed, 'Self destination was accepted'); check(true, 'Self-directed signaling rejected');
  gp = await join(guest, channel.id);

  send(gp, { type: 'media', microphone: true, camera: false, screen: false, screen_audio: false });
  await until(() => self(gp).media.microphone, 'Microphone metadata not set');
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  await delay(650);
  check(self(gp).media.microphone, 'Idempotent unmute preserves authorized media state');

  const muteStarted = Date.now();
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'mute' });
  await until(() => !self(gp).can_publish, 'Mute did not restrict peer');
  timings.mute_ms = Date.now() - muteStarted;
  send(gp, { type: 'media', microphone: true, camera: true, screen: true, screen_audio: true });
  await delay(150);
  check(!gp.closed && Object.values(self(gp).media).every(v => !v), 'Mute works without LiveKit and clamps malicious publication flags while preserving listening');
  send(hp, { type: 'signal', to: gp.ready.peer_id, data: { candidate: null } });
  await until(() => gp.frames.some(v => v.type === 'signal' && v.from === hp.ready.peer_id), 'Muted receiver cannot negotiate');
  check(true, 'Muted peers retain signaling needed for reception');
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  await until(() => self(gp).can_publish, 'Unmute did not recheck permission');
  check(Object.values(self(gp).media).every(v => !v), 'Unmute restores permission without activating capture');

  const role = await api('POST', `/guilds/${guild.id}/roles`, owner, { name: 'Restricted fixture', permissions: '63' });
  await api('PUT', `/guilds/${guild.id}/members/${guest.user.id}/roles/${role.id}`, owner, {});
  let revokedAt = Date.now();
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '32' });
  await until(() => !self(gp).can_publish, 'PUBLISH revocation not applied', 2000);
  timings.publish_revoke_ms = Date.now() - revokedAt;
  check(!gp.closed && timings.publish_revoke_ms <= 2000, 'PUBLISH revocation updates receiver-only state within two seconds');
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  await delay(650);
  check(!self(gp).can_publish, 'Unmute cannot override denied PUBLISH permission');
  revokedAt = Date.now();
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '16' });
  await until(() => gp.closed, 'CONNECT revocation not enforced', 2000);
  timings.connect_revoke_ms = Date.now() - revokedAt;
  check(timings.connect_revoke_ms <= 2000, 'CONNECT revocation closes signaling within two seconds');
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '0' });
  gp = await join(guest, channel.id);
  revokedAt = Date.now();
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '1' });
  await until(() => gp.closed, 'VIEW revocation not enforced', 2000);
  check(Date.now() - revokedAt <= 2000, 'VIEW revocation removes an admitted peer within two seconds');
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '0' });
  gp = await join(guest, channel.id);
  revokedAt = Date.now();
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'remove' });
  await until(() => gp.closed, 'Removal not enforced', 2000);
  check(!(await join(guest, channel.id)).ready, 'Removal closes the peer and active ban prevents reentry');
  await api('GET', `/channels/${channel.id}/call`, guest, undefined, [403]);
  // No production bypass: release only this disposable fixture ban using operator CLI.
  sql(`DELETE FROM media_bans WHERE channel_id=${uuidLiteral(channel.id)} AND user_id=${uuidLiteral(guest.user.id)}`);
  gp = await join(guest, channel.id);
  const refreshed = await api('POST', '/auth/refresh', null, { refresh_token: guest.refresh_token });
  await delay(1200);
  check(!gp.closed, 'Legitimate refresh rotation does not terminate an admitted session');
  const oldAdmission = await join(guest, channel.id);
  check(!oldAdmission.ready && oldAdmission.frames.some(v => v.code === 'unauthorized'), 'Rotated old token cannot admit another connection');
  send(gp, { type: 'reauth', token: refreshed.access_token });
  await until(() => gp.frames.some(v => v.type === 'authenticated'), 'Same-session reauthentication failed');
  check(true, 'Fresh token with same user and session reauthenticates');
  const nextSession = await api('POST', '/auth/login', null, { username: 'call_guest', password });
  send(gp, { type: 'reauth', token: nextSession.access_token });
  await until(() => gp.closed, 'Different session reauth allowed');
  check(true, 'Reauthentication cannot switch session identity');
  gp = await join(nextSession, channel.id);
  send(gp, { type: 'reauth', token: host.access_token });
  await until(() => gp.closed, 'Different user reauth allowed');
  check(true, 'Reauthentication cannot switch user');
  gp = await join(nextSession, channel.id);
  revokedAt = Date.now();
  await api('POST', '/auth/logout', null, { refresh_token: nextSession.refresh_token });
  await until(() => gp.closed, 'Logout did not revoke admitted session', 2000);
  check(Date.now() - revokedAt <= 2000, 'Logout revokes the admitted connection within two seconds');

  const expiring = signed(race1, { exp: Math.floor(Date.now() / 1000) + 2 });
  const ep = await join(expiring, channel.id);
  check(Boolean(ep.ready), 'Valid short-lived fixture token admitted');
  await until(() => ep.closed, 'Expired admitted access token remained active', 4000);
  check(true, 'Access-token expiry closes admitted signaling without reauth');
  const dp = await join(disabled, channel.id);
  await api('PATCH', `/admin/users/${disabled.user.id}`, admin, { disabled: true });
  await until(() => dp.closed, 'Disabled account remained active', 2000);
  check(true, 'Disabled account is removed from calls immediately');
  const rp = await join(race2, channel.id);
  await api('POST', `/admin/users/${race2.user.id}/reset`, admin, { password });
  await until(() => rp.closed, 'Reset account remained active', 2000);
  check(true, 'Administrative password reset revokes real calls');
  const mp = await join(race1, channel.id);
  await api('DELETE', `/guilds/${guild.id}/members/${race1.user.id}`, owner);
  await until(() => mp.closed, 'Removed community member remained active', 2000);
  check(true, 'Community removal revokes a matching guild call');

  const idlePeer = await join(idle, channel.id, { heartbeat: false });
  const idleStarted = Date.now();
  const flooding = await join(refreshed, other.id);
  check(Boolean(flooding.ready), 'Independent session can enter after previous session logged out');
  // A ping requires an outbound pong and can throttle itself below the incoming
  // rate through TCP backpressure. A departed destination is validly discarded
  // without a response; this burst measures the input limit independently.
  for (let i = 0; i < 400; i++) send(flooding, { type: 'signal', to: race.find(p => p.ready).ready.peer_id, data: { candidate: null } });
  await until(() => flooding.closed, 'Frame rate limit not enforced');
  check(true, 'Per-connection signaling rate is bounded');
  const huge = await join(refreshed, other.id);
  huge.socket.send('x'.repeat(65 * 1024));
  await until(() => huge.closed, 'Oversized WebSocket frame not rejected');
  check(true, 'WebSocket frame size is bounded');
  const replayPeer = await join(refreshed, channel.id);
  check(Boolean(replayPeer.ready), 'Rotated session remains usable before refresh replay');
  await api('POST', '/auth/refresh', null, { refresh_token: guest.refresh_token }, [401]);
  await until(() => replayPeer.closed, 'Replayed refresh token did not revoke call', 2000);
  check(true, 'Refresh-token reuse revokes the admitted rotated session');

  await until(() => idlePeer.closed, 'Inactive peer outlived heartbeat deadline', 37_000);
  timings.idle_ms = Date.now() - idleStarted;
  check(timings.idle_ms >= 33_000 && timings.idle_ms <= 36_500, 'Missing heartbeat removes peer within the real 35-second deadline');
  const expiredSession = await join(idle, channel.id);
  sql(`UPDATE sessions SET expires_at='2000-01-01T00:00:00Z' WHERE user_id=${uuidLiteral(idle.user.id)}`);
  await until(() => expiredSession.closed, 'Expired server session remained admitted', 2000);
  check(true, 'Server-side session expiry closes calls independently of JWT expiry');
  await until(() => Date.now() - started >= 122_000, 'Long-call observation timer failed', 125_000);
  send(long, { type: 'ping' });
  await delay(100);
  check(!long.closed && long.frames.some(v => v.type === 'pong'), 'Real call remains active beyond diagnostic 120-second lifetime');
  timings.long_call_ms = Date.now() - started;
  await stop(long);
  await stop(hp);
  const finalInfo = await api('GET', `/channels/${channel.id}/call`, owner);
  check(finalInfo.participants.length === 0, 'Closed peers leave no retained room membership');
  const versioned = await join(owner, other.id);
  sql(`UPDATE users SET auth_version=auth_version+1 WHERE id=${uuidLiteral(owner.user.id)}`);
  await until(() => versioned.closed, 'User auth version change remained admitted', 2000);
  check(true, 'User auth_version invalidates admitted calls independently of session version');
  const unavailable = await join(host, channel.id);
  const unavailableAt = Date.now();
  // This operator mutation affects only the fresh disposable fixture database.
  sql('ALTER TABLE sessions RENAME TO unavailable_sessions');
  await until(() => unavailable.closed, 'Database failure left a call admitted', 2000);
  check(Date.now() - unavailableAt <= 2000, 'Database authentication failure closes calls within two seconds');
  sql('ALTER TABLE unavailable_sessions RENAME TO sessions');
  report = { status: 'PASS', checks: checks.length, criteria: checks, timings,
    scope: 'Production API black-box HTTP/WebSocket signaling with isolated SQLite, no LiveKit or media transport; private operator fixture mutations are identified inline',
    binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex') };
} catch (error) {
  report = { status: 'FAIL', checks: checks.length, criteria: checks, error: error.message, timings };
  process.exitCode = 1;
} finally {
  for (const peer of sockets) { clearInterval(peer.timer); peer.socket.close(); }
  server.kill('SIGINT');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(5000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await writeFile(`${folder}/server.log`, log, { mode: 0o600 });
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
