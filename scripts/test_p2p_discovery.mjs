// Independent black-box discovery/admission regression against a running API.
// Uses new disposable accounts. Does not alter server configuration/processes.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = process.env.HARMONY_TEST_URL || 'http://127.0.0.1:8080';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use the authorized local API endpoint');
const checks = [];
const sockets = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, label) => { assert.ok(value, label); checks.push(label); };
async function until(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(label);
}
async function api(method, path, token, body, expected = [200, 201, 204]) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(expected.includes(response.status), `${method} request returned HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}
async function connection(path, frame) {
  const socket = new WebSocket(base.replace(/^http/, 'ws') + path);
  sockets.add(socket);
  const peer = { socket, frames: [], closed: false };
  socket.addEventListener('message', event => peer.frames.push(JSON.parse(event.data)));
  socket.addEventListener('close', () => { peer.closed = true; sockets.delete(socket); });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
  socket.send(JSON.stringify(frame));
  await until(() => peer.closed || peer.frames.some(v => ['ready', 'closed'].includes(v.type)), 'WebSocket admission did not settle');
  peer.ready = peer.frames.find(v => v.type === 'ready');
  return peer;
}
const observe = session => connection('/api/ws', { type: 'auth', token: session.access_token });
const join = (session, id, channel) => connection('/api/p2p/ws', {
  type: 'auth', token: session.access_token, probe_id: id, channel_id: channel,
});
const info = (session, channel) => api('GET', `/channels/${channel}/p2p-probes`, session.access_token);
const create = (session, channel) => api('POST', `/channels/${channel}/p2p-probes`, session.access_token, {});
const contains = (value, id) => value.available.some(entry => entry.id === id);
async function stop(peer) {
  if (!peer.closed) peer.socket.close();
  await until(() => peer.closed, 'WebSocket did not close');
}

try {
  const admin = await api('POST', '/auth/login', null, {
    username: process.env.HARMONY_BOOTSTRAP_USERNAME,
    password: process.env.HARMONY_BOOTSTRAP_PASSWORD,
  });
  const invitation = await api('POST', '/admin/invites', admin.access_token, { max_uses: 5, expires_hours: 1 });
  const suffix = randomBytes(5).toString('hex');
  const password = randomBytes(24).toString('hex');
  const accounts = [];
  for (const name of ['owner', 'host', 'guest', 'contender', 'outsider']) {
    accounts.push(await api('POST', '/auth/register', null, {
      username: `discovery_${name}_${suffix}`, display_name: `Discovery ${name}`, password, invite_token: invitation.token,
    }));
  }
  const [owner, host, guest, contender, outsider] = accounts;
  const guild = await api('POST', '/guilds', owner.access_token, { name: `Discovery ${suffix}` });
  const channel = await api('POST', `/guilds/${guild.id}/channels`, owner.access_token, { name: 'Discovery', kind: 'voice' });
  const second = await api('POST', `/guilds/${guild.id}/channels`, owner.access_token, { name: 'Other channel', kind: 'voice' });
  const text = await api('POST', `/guilds/${guild.id}/channels`, owner.access_token, { name: 'Text only', kind: 'text' });
  const membership = await api('POST', `/guilds/${guild.id}/invites`, owner.access_token, { max_uses: 3, expires_hours: 1 });
  for (const member of [host, guest, contender]) await api('POST', '/invites/accept', member.access_token, { token: membership.token });
  const watcher = await observe(guest);
  const outsideWatcher = await observe(outsider);
  await api('GET', `/channels/${channel.id}/p2p-probes`, null, undefined, [401]);
  await api('GET', `/channels/${channel.id}/p2p-probes`, outsider.access_token, undefined, [403]);
  await api('GET', `/channels/${text.id}/p2p-probes`, guest.access_token, undefined, [403]);
  check(true, 'Anonymous, outsider and text-channel discovery denied');
  const reservation = await create(owner, channel.id);
  check(!contains(await info(guest, channel.id), reservation.probe_id), 'Unconnected reservation is not discoverable');
  const hostSocket = await join(owner, reservation.probe_id, channel.id);
  check(hostSocket.ready?.role === 'offerer', 'Owner WebSocket becomes ready');
  const visible = await info(guest, channel.id);
  check(contains(visible, reservation.probe_id), 'Ready owner is discovered automatically');
  const entry = visible.available.find(value => value.id === reservation.probe_id);
  assert.deepEqual(Object.keys(entry).sort(), ['expires_in', 'host_name', 'id']);
  check(entry.host_name === owner.user.display_name && entry.expires_in > 0 && entry.expires_in <= 120, 'Discovery contains bounded lifetime and public host name only');
  check(!contains(await info(owner, channel.id), reservation.probe_id), 'Own invitation is excluded');
  check(!contains(await info(guest, second.id), reservation.probe_id), 'Invitation is scoped to its channel');
  check(!(await join(outsider, reservation.probe_id, channel.id)).ready, 'Outsider cannot join a discovered identifier');
  check(!(await join(guest, reservation.probe_id, second.id)).ready, 'Identifier cannot be joined through a different channel');
  await until(() => watcher.frames.some(v => v.type === 'p2p.changed' && v.channel_id === channel.id), 'Discovery event was not delivered');

  const secondReservation = await create(host, second.id);
  const secondSocket = await join(host, secondReservation.probe_id, second.id);
  const race = await Promise.all([join(guest, reservation.probe_id, channel.id), join(contender, reservation.probe_id, channel.id)]);
  check(race.filter(peer => peer.ready?.role === 'answerer').length === 1, 'Concurrent guests reserve exactly one seat');
  const winnerIndex = race.findIndex(peer => peer.ready);
  const winner = [guest, contender][winnerIndex];
  const loser = [guest, contender][1 - winnerIndex];
  check(!contains(await info(loser, channel.id), reservation.probe_id), 'Occupied probe is removed from discovery');
  check(!(await join(winner, secondReservation.probe_id, second.id)).ready, 'A guest cannot join a second simultaneous probe');
  check(contains(await info(loser, second.id), secondReservation.probe_id), 'Rejected busy guest does not consume another probe seat');
  await stop(hostSocket);
  await until(() => race[winnerIndex].closed, 'Owner disconnection did not terminate the guest');
  check(!contains(await info(loser, channel.id), reservation.probe_id), 'Owner disconnect removes discovery and closes guest');
  await stop(secondSocket);

  // Let the real fixed deadline elapse while the independent revocation gates
  // below run. No configuration hook or shortened timeout replaces this proof.
  const expiryStarted = Date.now();
  const expiration = await create(owner, second.id);
  const expirySocket = await join(owner, expiration.probe_id, second.id);
  check(contains(await info(guest, second.id), expiration.probe_id), 'Expiring probe begins discoverable');

  const role = await api('POST', `/guilds/${guild.id}/roles`, owner.access_token, { name: 'Probe host', permissions: '63' });
  await api('PUT', `/guilds/${guild.id}/members/${host.user.id}/roles/${role.id}`, owner.access_token, {});
  const permissionProbe = await create(host, channel.id);
  const permissionSocket = await join(host, permissionProbe.probe_id, channel.id);
  check(contains(await info(guest, channel.id), permissionProbe.probe_id), 'Member owner is initially discoverable');
  await api('PUT', `/channels/${channel.id}/permissions`, owner.access_token, { role_id: role.id, allow: '0', deny: '32' });
  check(!contains(await info(guest, channel.id), permissionProbe.probe_id), 'Fresh discovery hides an owner after PUBLISH revocation');
  check(!(await join(guest, permissionProbe.probe_id, channel.id)).ready, 'Stale invitation is rejected after owner PUBLISH revocation');
  await api('GET', `/channels/${channel.id}/p2p-probes`, host.access_token, undefined, [403]);
  check(true, 'Requester without PUBLISH cannot discover invitations');
  await until(() => permissionSocket.closed, 'Permission revocation did not close the host');
  await api('PUT', `/channels/${channel.id}/permissions`, owner.access_token, { role_id: role.id, allow: '0', deny: '0' });

  const muted = await create(host, channel.id);
  const mutedSocket = await join(host, muted.probe_id, channel.id);
  await api('POST', `/channels/${channel.id}/moderate`, owner.access_token, { user_id: host.user.id, action: 'mute' });
  check(!contains(await info(guest, channel.id), muted.probe_id), 'Server-muted owner disappears from fresh discovery');
  check(!(await join(guest, muted.probe_id, channel.id)).ready, 'Stale muted-owner invitation is rejected');
  await until(() => mutedSocket.closed, 'Mute did not close the host');
  await api('POST', `/channels/${channel.id}/moderate`, owner.access_token, { user_id: host.user.id, action: 'unmute' });

  const reset = await create(host, channel.id);
  const resetSocket = await join(host, reset.probe_id, channel.id);
  check(contains(await info(guest, channel.id), reset.probe_id), 'Owner awaiting reset is discoverable');
  // This field reauthenticates the administrator issuing a one-time reset token;
  // it does not set the host's password. Fixture passwords remain random above.
  await api('POST', `/admin/users/${host.user.id}/reset`, admin.access_token, { password: process.env.HARMONY_BOOTSTRAP_PASSWORD });
  check(!contains(await info(guest, channel.id), reset.probe_id), 'Password reset removes owner from fresh discovery');
  check(!(await join(guest, reset.probe_id, channel.id)).ready, 'Stale invitation cannot bypass owner session reset');
  await until(() => resetSocket.closed, 'Reset did not close host probe');

  await until(() => expirySocket.closed, 'Fixed 120-second deadline did not close the probe', 125_000);
  const expiryMs = Date.now() - expiryStarted;
  check(expiryMs >= 118_000 && expiryMs <= 128_000, 'Probe closes at the real fixed 120-second deadline');
  check(!contains(await info(guest, second.id), expiration.probe_id), 'Expired probe is absent from discovery');
  check(!(await join(guest, expiration.probe_id, second.id)).ready, 'Expired invitation cannot be reused');
  const changes = watcher.frames.filter(value => value.type === 'p2p.changed');
  check(changes.length >= 8, 'Availability transitions emit discovery invalidations');
  for (const event of changes) {
    assert.deepEqual(Object.keys(event).sort(), ['channel_id', 'type']);
    assert.ok([channel.id, second.id].includes(event.channel_id));
  }
  check(true, 'Discovery events carry no probe identifier, token, claims or SDP');
  check(!outsideWatcher.frames.some(value => value.type === 'p2p.changed'), 'Non-member receives no channel discovery event');
  const report = {
    status: 'PASS', checks: checks.length, criteria: checks, expiry_ms: expiryMs,
    scope: 'Black-box HTTP/WebSocket discovery and authorization; no media or UI measurement',
    server_source_sha256: createHash('sha256').update(await readFile('crates/server/src/p2p.rs')).digest('hex'),
    test_sha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
  };
  await mkdir('.local/qa-p2p-discovery', { recursive: true });
  await writeFile('.local/qa-p2p-discovery/result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  for (const socket of sockets) socket.close();
}
