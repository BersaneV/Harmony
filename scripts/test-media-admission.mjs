// Integration against a real Harmony API, Caddy admission gateway and LiveKit.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const api = process.env.HARMONY_TEST_URL ?? 'http://127.0.0.1:8080';
const gateway = process.env.HARMONY_MEDIA_GATEWAY ?? 'http://127.0.0.1:18082';
async function post(path, body, token) {
  const response = await fetch(api + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  assert.ok(response.ok, `API ${path}: HTTP ${response.status}`);
  return response.json();
}
const admin = await post('/auth/login', { username: process.env.HARMONY_BOOTSTRAP_USERNAME, password: process.env.HARMONY_BOOTSTRAP_PASSWORD });
const invite = await post('/admin/invites', { max_uses: 1, expires_hours: 1 }, admin.access_token);
const suffix = randomBytes(4).toString('hex');
const user = await post('/auth/register', { username: `media_${suffix}`, display_name: 'Media admission test', password: randomBytes(20).toString('hex'), invite_token: invite.token });
const guild = await post('/guilds', { name: 'Media admission integration' }, user.access_token);
const channel = await post(`/guilds/${guild.id}/channels`, { name: 'Voice admission', kind: 'voice' }, user.access_token);
const media = await post(`/channels/${channel.id}/media-token`, {}, user.access_token);
async function validate(query, authorization, expected) {
  const response = await fetch(`${gateway}/rtc/validate?access_token=${encodeURIComponent(query)}`, { headers: authorization ? { Authorization: authorization } : {} });
  assert.ok(expected.includes(response.status), `Media admission HTTP ${response.status}, expected ${expected.join('/')}`);
  await response.arrayBuffer();
}
await validate(media.token, null, [200]);
await validate(media.token, 'Bearer invalid', [401, 403]);
await validate('invalid', 'Bearer ' + media.token, [200]);
await validate(media.token, 'Basic invalid', [401, 403]);
const forged = await fetch(gateway + '/rtc/validate', { headers: { 'X-Livekit-Query-Token': media.token } });
assert.ok([401, 403].includes(forged.status), 'Client cannot forge the query-token header');
assert.equal((await fetch(gateway + '/twirp/livekit.RoomService/ListRooms')).status, 404);
const socket = new WebSocket(gateway.replace(/^http/, 'ws') + `/rtc?access_token=${encodeURIComponent(media.token)}&protocol=15&sdk=js&version=2.24.0&auto_subscribe=0`);
let received = false;
let disconnected = false;
let closeCode = null;
socket.addEventListener('message', () => { received = true; });
socket.addEventListener('close', event => { disconnected = true; closeCode = event.code; });
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error('Real LiveKit signaling connection failed'));
  setTimeout(() => reject(new Error('LiveKit open timeout')), 10000).unref();
});
const until = async (predicate, label) => {
  const end = Date.now() + 20000;
  while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.ok(predicate(), label);
};
await until(() => received, 'LiveKit must return a real signaling frame');
await post(`/admin/users/${user.user.id}/reset`, { password: process.env.HARMONY_BOOTSTRAP_PASSWORD }, admin.access_token);
await validate(media.token, null, [401, 403]);
// Node26's native WebSocket was observed reporting CLOSING after emitting close.
// The close event is the transport observation; this raw peer does not answer SDP.
await until(() => disconnected, 'Reset must close an existing LiveKit signaling connection');
console.log(JSON.stringify({ status: 'PASS', checks: 9, close_code: closeCode, actual_services: ['Harmony', 'PostgreSQL', 'Caddy', 'LiveKit'], covered: ['header/query precedence', 'forged header rejected', 'admin surface hidden', 'RTC signaling', 'reset rejects old media token', 'signaling close event'], not_covered: ['full RTC negotiation', 'Windows capture', 'media packets', 'external TURN/TLS'] }));
