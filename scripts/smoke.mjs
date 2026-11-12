import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

const base = process.env.HARMONY_TEST_URL ?? 'http://127.0.0.1:8080';
const password = `Harmony-test-${randomBytes(16).toString('hex')}`;
const suffix = randomBytes(4).toString('hex');
let checks = 0;
async function call(method, path, body, token, expected = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`Non-JSON response: ${method} ${path} (${response.status})`); }
  if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${method} ${path}: ${response.status} ${data?.error?.code ?? ''}`);
  else assert.equal(response.status, expected, `${method} ${path}: ${data?.error?.code ?? ''}`);
  checks++;
  return data;
}
const list = result => result.items;
const admin = await call('POST', '/auth/login', {
  username: process.env.HARMONY_BOOTSTRAP_USERNAME,
  password: process.env.HARMONY_BOOTSTRAP_PASSWORD,
});
assert.equal(admin.user.is_admin, true);
const invite = await call('POST', '/admin/invites', { max_uses: 3, expires_hours: 1 }, admin.access_token, [200, 201]);
const sessions = [];
for (const name of ['alice', 'bob', 'eve']) {
  sessions.push(await call('POST', '/auth/register', {
    username: `${name}_${suffix}`, display_name: name, password, invite_token: invite.token,
  }, null, [200, 201]));
}
let [alice, bob, eve] = sessions;
await call('POST', '/auth/register', { username: `over_${suffix}`, display_name: 'Over', password, invite_token: invite.token }, null, [400, 403, 409, 410]);
await call('GET', '/admin/users', null, alice.access_token, 403);
const guild = await call('POST', '/guilds', { name: `Integration ${suffix}` }, alice.access_token, [200, 201]);
const channel = await call('POST', `/guilds/${guild.id}/channels`, { name: 'general', kind: 'text' }, alice.access_token, [200, 201]);
await call('GET', `/guilds/${guild.id}/channels`, null, eve.access_token, [403, 404]);
const join = await call('POST', `/guilds/${guild.id}/invites`, { max_uses: 1, expires_hours: 1 }, alice.access_token, [200, 201]);
await call('POST', '/invites/accept', { token: join.token }, bob.access_token, [200, 201]);
await call('POST', '/invites/accept', { token: join.token }, eve.access_token, [400, 403, 404, 409, 410]);
await call('POST', `/guilds/${guild.id}/channels`, { name: 'forbidden', kind: 'text' }, bob.access_token, 403);
const content = `Persistence needle ${suffix}`;
const nonce = randomUUID();
const first = await call('POST', `/channels/${channel.id}/messages`, { client_nonce: nonce, content }, alice.access_token, [200, 201]);
const retry = await call('POST', `/channels/${channel.id}/messages`, { client_nonce: nonce, content }, alice.access_token, [200, 201]);
assert.equal(first.id, retry.id, 'Idempotent retry must return the same committed message');
await call('POST', `/channels/${channel.id}/messages`, { client_nonce: nonce, content: 'conflicting retry' }, alice.access_token, 409);
const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', `/channels/${channel.id}/messages`, { client_nonce: randomUUID(), content: `Concurrent ${i}` }, bob.access_token, [200, 201])));
assert.equal(new Set(parallel.map(m => m.seq)).size, 6, 'Concurrent commits must have distinct conversation sequences');
const history = await call('GET', `/channels/${channel.id}/messages?limit=100`, null, bob.access_token);
assert.equal(list(history).filter(m => m.id === first.id).length, 1);
for (let i = 1; i < history.items.length; i++) assert.ok(BigInt(history.items[i].seq) > BigInt(history.items[i - 1].seq));
await call('GET', `/channels/${channel.id}/messages`, null, eve.access_token, [403, 404]);
await call('PATCH', `/messages/${first.id}`, { content: 'forbidden edit' }, bob.access_token, 403);
await call('PUT', `/messages/${first.id}/reactions/${encodeURIComponent('👍')}`, null, bob.access_token, [200, 204]);
await call('PUT', `/messages/${first.id}/reactions/${encodeURIComponent('👍')}`, null, bob.access_token, [200, 204]);
const reacted = list(await call('GET', `/channels/${channel.id}/messages`, null, bob.access_token)).find(m => m.id === first.id);
assert.equal(reacted.reactions.find(r => r.emoji === '👍').count, 1);
assert.ok(list(await call('GET', `/search?q=${encodeURIComponent(suffix)}`, null, bob.access_token)).some(m => m.id === first.id));
assert.equal(list(await call('GET', `/search?q=${encodeURIComponent(suffix)}`, null, eve.access_token)).length, 0);
await call('POST', `/channels/${channel.id}/read`, { seq: first.seq }, bob.access_token, [200, 204]);
await call('POST', `/channels/${channel.id}/read`, { seq: '9223372036854775807' }, bob.access_token, [400, 409, 422]);
const friend = await call('POST', '/friends', { username: bob.user.username }, alice.access_token, [200, 201]);
await call('POST', `/friends/${friend.id}/accept`, null, eve.access_token, [403, 404]);
await call('POST', `/friends/${friend.id}/accept`, null, bob.access_token, [200, 204]);
const dm = await call('POST', '/conversations', { user_ids: [bob.user.id] }, alice.access_token, [200, 201]);
const dmRetry = await call('POST', '/conversations', { user_ids: [bob.user.id] }, alice.access_token, [200, 201]);
assert.equal(dm.id, dmRetry.id, 'Repeated direct conversation must reuse the same conversation');
await call('GET', `/channels/${dm.id}/messages`, null, eve.access_token, [403, 404]);

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws`);
const received = [];
ws.addEventListener('message', event => { received.push(JSON.parse(event.data)); });
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; setTimeout(() => reject(new Error('WebSocket open timeout')), 5000).unref(); });
ws.send(JSON.stringify({ type: 'auth', token: bob.access_token }));
async function until(predicate, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}
await until(() => received.some(e => e.type === 'ready'), 'WS auth did not become ready');
const published = await call('POST', `/channels/${channel.id}/messages`, { client_nonce: randomUUID(), content: 'Realtime integration' }, alice.access_token, [200, 201]);
await until(() => received.some(e => e.channel_id === channel.id && e.type === 'message.created'), 'Committed message not delivered through WS');
const recovery = list(await call('GET', `/channels/${channel.id}/messages?after_seq=${first.seq}`, null, bob.access_token));
assert.ok(recovery.some(m => m.id === published.id));

if (process.env.HARMONY_TEST_STORAGE === '1') {
  // Small valid PNG. The content is disposable test data, never a user attachment.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6t8AAAAASUVORK5CYII=', 'base64');
  const upload = await call('POST', `/channels/${channel.id}/uploads`, { name: 'pixel.png', size: png.length, content_type: 'image/png' }, alice.access_token, [200, 201]);
  const put = await fetch(upload.url, { method: 'PUT', body: png, headers: upload.headers });
  assert.ok(put.ok, `Signed upload PUT: ${put.status}`);
  await call('POST', `/uploads/${upload.id}/complete`, null, eve.access_token, [403, 404]);
  await call('POST', `/uploads/${upload.id}/complete`, null, alice.access_token, [200, 201]);
  await call('POST', `/channels/${channel.id}/messages`, { client_nonce: randomUUID(), content: '', attachment_ids: [upload.id] }, alice.access_token, [200, 201]);
  const download = await call('GET', `/uploads/${upload.id}/download`, null, bob.access_token);
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), png);
  await call('GET', `/uploads/${upload.id}/download`, null, eve.access_token, [403, 404]);
}
if (process.env.HARMONY_TEST_MEDIA === '1') {
  const voice = await call('POST', `/guilds/${guild.id}/channels`, { name: 'Voice', kind: 'voice' }, alice.access_token, [200, 201]);
  const media = await call('POST', `/channels/${voice.id}/media-token`, null, bob.access_token);
  assert.ok(media.token && media.url && media.max_video_bitrate > 0);
  await call('POST', `/channels/${voice.id}/media-token`, null, eve.access_token, [403, 404]);
}

const oldRefresh = eve.refresh_token;
eve = await call('POST', '/auth/refresh', { refresh_token: oldRefresh });
await call('POST', '/auth/refresh', { refresh_token: oldRefresh }, null, 401);
const reset = await call('POST', `/admin/users/${bob.user.id}/reset`, { password: process.env.HARMONY_BOOTSTRAP_PASSWORD }, admin.access_token, [200, 201]);
await call('GET', '/me', null, bob.access_token, 401);
await call('POST', '/auth/refresh', { refresh_token: bob.refresh_token }, null, 401);
await until(() => ws.readyState === WebSocket.CLOSED, 'Revoked session left WebSocket open');
const newPassword = password + '-reset';
await call('POST', '/auth/reset', { token: reset.token, password: newPassword }, null, [200, 204]);
await call('POST', '/auth/reset', { token: reset.token, password: newPassword }, null, [400, 401, 403, 409, 410]);
await call('POST', '/auth/login', { username: bob.user.username, password }, null, 401);
bob = await call('POST', '/auth/login', { username: bob.user.username, password: newPassword });
await call('DELETE', `/guilds/${guild.id}/members/${bob.user.id}`, null, alice.access_token, [200, 204]);
await call('GET', `/channels/${channel.id}/messages`, null, bob.access_token, [403, 404]);
await call('POST', '/auth/logout', { refresh_token: bob.refresh_token }, bob.access_token, [200, 204]);
await call('GET', '/me', null, bob.access_token, 401);
console.log(JSON.stringify({ status: 'PASS', http_checks: checks, websocket: 'auth, commit delivery, reset disconnect', suites: ['idempotency', 'concurrency', 'ACL', 'search', 'reactions', 'friendship', 'DM uniqueness', 'refresh rotation', 'reset', 'logout'], storage: process.env.HARMONY_TEST_STORAGE === '1', media_token: process.env.HARMONY_TEST_MEDIA === '1' }));
