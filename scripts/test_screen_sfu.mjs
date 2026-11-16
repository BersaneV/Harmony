// Real HTTP/WS/SQLite authorization, with a loopback LiveKit control-plane fixture.
// This does not test SFU media, devices, Windows performance or public networking.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const binary = resolve(process.env.HARMONY_SERVER_BIN || `${root}/target/debug/harmony-server`);
const output = resolve(root, '.local/qa-screen-sfu');
await mkdir(output, { recursive: true, mode: 0o700 });
const checks = [], sockets = new Set(), applications = new Set(), calls = [], releases = new Set();
const rooms = new Map();
let blockCreate, blockUpdate;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, label) { assert.ok(value, label); checks.push(label); }
async function until(predicate, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(20); }
  throw new Error(label);
}
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; }
const secret = randomBytes(32).toString('hex');
const key = 'screen-control-fixture';
const control = createServer(async (request, response) => {
  let text = ''; for await (const part of request) text += part;
  const body = JSON.parse(text || '{}');
  const method = request.url.split('/').at(-1);
  calls.push({ method, body });
  if (method === 'CreateRoom') {
    if (blockCreate) { const pending = blockCreate; blockCreate = undefined; pending.started(); await pending.wait; }
    if (!rooms.has(body.name)) rooms.set(body.name, new Map());
  }
  let result = {};
  if (method === 'ListRooms') result = { rooms: [...rooms.keys()].map(name => ({ name })) };
  if (method === 'ListParticipants') result = { participants: [...(rooms.get(body.room)?.values() || [])] };
  if (method === 'GetParticipant') {
    result = rooms.get(body.room)?.get(body.identity);
    if (!result) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'not_found', msg: 'participant does not exist' }));
      return;
    }
  }
  if (method === 'UpdateParticipant') {
    if (blockUpdate && body.identity === blockUpdate.identity && body.permission.canPublish === blockUpdate.canPublish) {
      const pending = blockUpdate; blockUpdate = undefined; pending.started(); await pending.wait;
    }
    const participant = rooms.get(body.room)?.get(body.identity);
    if (participant) participant.permission = body.permission;
  }
  if (method === 'RemoveParticipant') rooms.get(body.room)?.delete(body.identity);
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
});
const controlPort = await listen(control);

async function application(enabled) {
  const directory = await mkdtemp(`${output}/instance-`);
  const reservation = createServer(); const port = await listen(reservation);
  await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`, password = randomBytes(24).toString('hex');
  const env = { PATH: process.env.PATH, DATABASE_URL: `sqlite:${directory}/harmony.db`, HARMONY_BIND: `127.0.0.1:${port}`,
    HARMONY_STORAGE_BACKEND: 'local', HARMONY_STORAGE_DIR: `${directory}/files`, HARMONY_PUBLIC_API_URL: base,
    HARMONY_JWT_SECRET: randomBytes(32).toString('hex'), HARMONY_BOOTSTRAP_USERNAME: 'screen_admin', HARMONY_BOOTSTRAP_PASSWORD: password,
    HARMONY_MEDIA_TRANSPORT: 'p2p', HARMONY_CALL_STUN_URLS: '', HARMONY_P2P_DIAGNOSTICS: 'false', HARMONY_MAX_ROOM_PARTICIPANTS: '3',
    HARMONY_TRUST_PROXY: 'true', LIVEKIT_URL: `ws://127.0.0.1:${controlPort}`, LIVEKIT_API_URL: `http://127.0.0.1:${controlPort}`,
    LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, ...(enabled ? { HARMONY_SCREEN_SFU_ENABLED: 'true' } : {}), RUST_LOG: 'warn' };
  const child = spawn(binary, [], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; }); applications.add(child);
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'Disposable API startup', 15_000);
  async function api(method, path, account, body, expected = [200, 201, 204]) {
    const response = await fetch(`${base}/api${path}`, { method,
      headers: { ...(account ? { Authorization: `Bearer ${account.access_token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(expected.includes(response.status), `${method} ${path.replace(/[a-f0-9-]{36}/g, '<id>')}: ${response.status}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return null; }
  }
  return { base, password, process: child, api, directory, errors };
}
async function stopApp(app) { app.process.kill('SIGINT'); await new Promise(r => app.process.once('exit', r)); applications.delete(app.process); }
async function join(app, account, channel, capable = true) {
  const socket = new WebSocket(app.base.replace('http:', 'ws:') + '/api/calls');
  const peer = { socket, frames: [], closed: false };
  sockets.add(peer);
  socket.addEventListener('message', event => peer.frames.push(JSON.parse(event.data)));
  socket.addEventListener('close', () => { peer.closed = true; clearInterval(peer.timer); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.send(JSON.stringify({ type: 'auth', token: account.access_token, channel_id: channel, ...(capable ? { screen_sfu: true } : {}) }));
  await until(() => peer.frames.some(frame => frame.type === 'ready' || frame.type === 'closed'), 'P2P admission');
  peer.ready = peer.frames.find(frame => frame.type === 'ready');
  assert.ok(peer.ready, 'Expected admitted P2P peer');
  peer.timer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'ping' })), 5000);
  return peer;
}
async function leave(peer) { if (!peer.closed) peer.socket.close(); await until(() => peer.closed, 'Peer close'); await delay(60); }
const roster = peer => peer.frames.findLast(frame => frame.type === 'roster')?.participants || peer.ready.participants;
function sign(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
function claims(token) {
  const [header, payload, signature] = token.split('.');
  assert.equal(signature, createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'));
  return JSON.parse(Buffer.from(payload, 'base64url'));
}
async function admit(app, token, expected = 204) {
  const response = await fetch(app.base + '/api/internal/media-admit', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, expected, 'Current screen admission verdict');
}
function pauseCreate() {
  let started, release;
  const start = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  releases.add(release);
  blockCreate = { started, wait };
  return { start, release };
}
function pauseUpdate(identity, canPublish) {
  let started, release;
  const start = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  releases.add(release);
  blockUpdate = { identity, canPublish, started, wait };
  return { start, release };
}

let report;
try {
  const off = await application(false);
  const account = await off.api('POST', '/auth/login', null, { username: 'screen_admin', password: off.password });
  const guildOff = await off.api('POST', '/guilds', account, { name: 'Screen disabled' });
  const channelOff = await off.api('POST', `/guilds/${guildOff.id}/channels`, account, { name: 'Voice', kind: 'voice' });
  const peerOff = await join(off, account, channelOff.id);
  check((await off.api('GET', `/channels/${channelOff.id}/call`, account)).screen_sfu_enabled === false && peerOff.ready.screen_sfu_enabled === false, 'SFU disabled by default in discovery and signaling');
  check(!('screen_sfu' in roster(peerOff)[0]), 'Disabled capability preserves legacy roster shape');
  await off.api('POST', `/channels/${channelOff.id}/screen-token`, account, { peer_id: peerOff.ready.peer_id }, [503]);
  await delay(100);
  check(calls.length === 0, 'Disabled flag issues no LiveKit control RPC');
  await leave(peerOff); await stopApp(off);

  const app = await application(true), api = app.api;
  const owner = await api('POST', '/auth/login', null, { username: 'screen_admin', password: app.password });
  const guest = await api('POST', '/auth/register', null, { username: 'screen_guest', password: app.password });
  const legacy = await api('POST', '/auth/register', null, { username: 'screen_legacy', password: app.password });
  const outsider = await api('POST', '/auth/register', null, { username: 'screen_outside', password: app.password });
  const guild = await api('POST', '/guilds', owner, { name: 'Screen SFU protocol' });
  const channel = await api('POST', `/guilds/${guild.id}/channels`, owner, { name: 'Voice', kind: 'voice' });
  const other = await api('POST', `/guilds/${guild.id}/channels`, owner, { name: 'Other', kind: 'voice' });
  const invitation = await api('POST', `/guilds/${guild.id}/invites`, owner, { max_uses: 2, expires_hours: 1 });
  for (const user of [guest, legacy]) await api('POST', '/invites/accept', user, { token: invitation.token });
  let publisher = await join(app, owner, channel.id), watcher = await join(app, guest, channel.id);
  let old = await join(app, legacy, channel.id, false);
  await until(() => roster(publisher).length === 3, 'Roster converged');
  check((await api('GET', `/channels/${channel.id}/call`, guest)).screen_sfu_enabled === true && publisher.ready.screen_sfu_enabled === true, 'Explicit optional SFU capability advertised');
  check(roster(publisher).filter(peer => peer.screen_sfu === true).length === 2 && !('screen_sfu' in roster(old).find(peer => peer.peer_id === old.ready.peer_id)), 'Only negotiated clients have authoritative SFU capability');
  const endpoint = `/channels/${channel.id}/screen-token`;
  await api('POST', endpoint, null, { peer_id: publisher.ready.peer_id }, [401]);
  await api('POST', endpoint, outsider, { peer_id: publisher.ready.peer_id }, [403]);
  await api('POST', endpoint, guest, { peer_id: publisher.ready.peer_id }, [403]);
  await api('POST', `/channels/${other.id}/screen-token`, owner, { peer_id: publisher.ready.peer_id }, [403]);
  await api('POST', endpoint, legacy, { peer_id: old.ready.peer_id }, [403]);
  await api('POST', endpoint, owner, { peer_id: publisher.ready.peer_id, user_id: guest.user.id }, [422]);
  const otherSession = await api('POST', '/auth/login', null, { username: 'screen_admin', password: app.password });
  await api('POST', endpoint, otherSession, { peer_id: publisher.ready.peer_id }, [403]);
  check(true, 'Token requires exact active capable peer, channel, user and session with strict body');
  let media = await api('POST', endpoint, owner, { peer_id: publisher.ready.peer_id });
  const decoded = claims(media.token);
  assert.deepEqual(JSON.parse(decoded.metadata), { harmony_peer_id: publisher.ready.peer_id });
  assert.equal(decoded.sub.split(':')[0], owner.user.id);
  assert.equal(decoded.video.room, `harmony-${channel.id}`);
  assert.deepEqual(decoded.video.canPublishSources, ['screen_share', 'screen_share_audio']);
  check(decoded.video.canPublish === true && decoded.video.canSubscribe === true && decoded.video.canPublishData === false && decoded.video.canUpdateOwnMetadata === false && media.peer_id === publisher.ready.peer_id, 'Signed screen-only token uses authoritative metadata and existing room namespace');
  await admit(app, media.token);
  const renewed = sign({ ...decoded, exp: decoded.exp + 86400 });
  await admit(app, renewed);
  await admit(app, sign({ ...decoded, metadata: '{}' }), 403);
  await admit(app, sign({ ...decoded, metadata: JSON.stringify({ harmony_peer_id: watcher.ready.peer_id }) }), 403);
  await admit(app, sign({ ...decoded, video: { ...decoded.video, canPublishSources: ['microphone'] } }), 403);
  await admit(app, media.token + 'invalid', 401);
  check(true, 'Gateway validates renewed token, bound peer, sources and signature');
  const ack = { receive: { screen_height: 1440, screen_sfu: { track_sid: 'TR_fixture', generation: 'generation-1' } } };
  let before = publisher.frames.length;
  watcher.socket.send(JSON.stringify({ type: 'signal', to: publisher.ready.peer_id, data: ack }));
  await until(() => publisher.frames.slice(before).some(frame => frame.type === 'signal'), 'SFU ACK relay');
  assert.deepEqual(publisher.frames.slice(before).find(frame => frame.type === 'signal'), { type: 'signal', from: watcher.ready.peer_id, data: ack });
  old.socket.send(JSON.stringify({ type: 'signal', to: publisher.ready.peer_id, data: ack }));
  await until(() => old.closed, 'Legacy client cannot ACK SFU');
  check(true, 'Bounded ACK relays with server identity only between negotiated clients');
  old = await join(app, legacy, channel.id, false);

  let watcherMedia = await api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id });
  const watcherClaims = claims(watcherMedia.token);
  rooms.get(media.room).set(watcherClaims.sub, { identity: watcherClaims.sub, metadata: watcherClaims.metadata, permission: { canPublish: true, canSubscribe: true, canPublishSources: ['MICROPHONE'], canPublishData: true, canUpdateMetadata: true } });
  await until(() => calls.some(call => call.method === 'UpdateParticipant' && call.body.identity === watcherClaims.sub && call.body.permission.canPublishSources?.join() === 'SCREEN_SHARE,SCREEN_SHARE_AUDIO'), 'Reconcile restricted sources', 8000);
  check(true, 'Reconciliation repairs sources, metadata and data permissions for linked peers');
  const serialization = pauseUpdate(watcherClaims.sub, true);
  rooms.get(media.room).get(watcherClaims.sub).permission.canPublish = false;
  await Promise.race([serialization.start, delay(8000).then(() => { throw new Error('Reconciliation grant did not reach the race gate'); })]);
  let muteFinished = false;
  const pendingMute = api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'mute' }).then(() => { muteFinished = true; });
  await until(() => roster(publisher).find(peer => peer.peer_id === watcher.ready.peer_id)?.can_publish === false, 'Mute persisted and P2P publication revoked');
  await delay(80);
  check(!muteFinished, 'Mute waits for the preceding grant on the same SFU identity');
  await Promise.race([admit(app, media.token), delay(1000).then(() => { throw new Error('An unrelated identity was blocked by an SFU operation'); })]);
  check(true, 'An unrelated SFU identity remains admissible while the grant is blocked');
  serialization.release(); await pendingMute;
  check(rooms.get(media.room).get(watcherClaims.sub).permission.canPublish === false, 'A completed mute cannot be overwritten by the stale reconciliation grant');
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  before = calls.length;
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'mute' });
  const mutedPermission = calls.slice(before).find(call => call.method === 'UpdateParticipant').body.permission;
  check(mutedPermission.canPublish === false && mutedPermission.canPublishData === false && mutedPermission.canUpdateMetadata === false && mutedPermission.canPublishSources.join() === 'SCREEN_SHARE,SCREEN_SHARE_AUDIO', 'Mute preserves native screen-source restrictions');
  await admit(app, watcherMedia.token, 403);
  const muted = await api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id });
  check(claims(muted.token).video.canPublish === false && muted.muted === true, 'Muted participant may receive but cannot publish');
  await admit(app, muted.token);
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  watcherMedia = await api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id });

  const role = await api('POST', `/guilds/${guild.id}/roles`, owner, { name: 'Screen ACL fixture', permissions: '63' });
  await api('PUT', `/guilds/${guild.id}/members/${guest.user.id}/roles/${role.id}`, owner, {});
  const aclPause = pauseCreate();
  const pendingPermission = api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id });
  await aclPause.start;
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '32' });
  aclPause.release();
  const receiverOnly = await pendingPermission;
  check(claims(receiverOnly.token).video.canPublish === false, 'PUBLISH revoked during CreateRoom is rechecked before signing');
  await admit(app, watcherMedia.token, 403);
  await admit(app, receiverOnly.token);
  await api('POST', `/channels/${channel.id}/moderate`, owner, { user_id: guest.user.id, action: 'unmute' });
  check(claims((await api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id })).token).video.canPublish === false, 'Unmute cannot override current denied PUBLISH in SFU token');
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '0' });
  watcherMedia = await api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id });
  const connectPause = pauseCreate();
  const pendingConnection = api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id }, [403]);
  await connectPause.start;
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '16' });
  connectPause.release(); await pendingConnection;
  await until(() => watcher.closed, 'CONNECT revokes P2P peer', 2000);
  await admit(app, watcherMedia.token, 403);
  check(true, 'CONNECT revoked during CreateRoom blocks token and existing SFU reentry');
  await api('PUT', `/channels/${channel.id}/permissions`, owner, { role_id: role.id, allow: '0', deny: '0' });
  watcher = await join(app, guest, channel.id);
  watcherMedia = await api('POST', endpoint, guest, { peer_id: watcher.ready.peer_id });
  rooms.get(media.room).set(watcherClaims.sub, { identity: watcherClaims.sub, metadata: claims(watcherMedia.token).metadata, permission: { canPublish: true, canSubscribe: true, canPublishSources: ['SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'] } });

  const paused = pauseCreate();
  const pending = api('POST', endpoint, owner, { peer_id: publisher.ready.peer_id }, [403]);
  await paused.start; await leave(publisher); paused.release(); await pending;
  await admit(app, renewed, 403);
  check(true, 'Leaving during CreateRoom cannot issue a token and renewed token cannot rejoin');
  publisher = await join(app, owner, channel.id);
  await api('POST', endpoint, owner, { peer_id: decoded.metadata && JSON.parse(decoded.metadata).harmony_peer_id }, [403]);
  check(true, 'Reentry allocates a new peer and rejects the obsolete peer token request');
  const logoutStart = calls.length;
  await api('POST', '/auth/logout', null, { refresh_token: guest.refresh_token });
  await until(() => watcher.closed, 'Logout closes P2P peer', 2000);
  await admit(app, watcherMedia.token, 403);
  await until(() => calls.slice(logoutStart).some(call => call.method === 'RemoveParticipant' && call.body.identity === watcherClaims.sub), 'Logout SFU reconciliation', 8000);
  check(true, 'Logout rejects reentry and the existing reconciliation removes the linked SFU participant');

  report = { status: 'PASS', checks, scope: 'Disposable HTTP/WS/SQLite; simulated LiveKit control-plane only; no media/performance or external deployment validation' };
} catch (error) {
  report = { status: 'FAIL', checks, error: error.message.replace(/[a-f0-9-]{36}/g, '<id>'), scope: 'Disposable local control-plane test' };
  process.exitCode = 1;
} finally {
  for (const release of releases) release();
  for (const peer of sockets) { clearInterval(peer.timer); if (!peer.closed) peer.socket.close(); }
  for (const app of applications) app.kill('SIGINT');
  await new Promise(resolve => control.close(resolve));
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
