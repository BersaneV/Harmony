// The browser/media fixture always stays on an owned loopback origin.
// A single owned external acceptance instance is an explicit, temporary opt-in.
import assert from 'node:assert/strict';
export const acceptanceOrigin = 'https://harmony.go.altare.global';
export const acceptanceName = 'Harmony — validação externa';
const loopback = url => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
const clean = url => ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  && !url.search && !url.hash && url.pathname === '/';
export function capacityOrigins(api, web, optIn = '') {
  const a = new URL(api), w = new URL(web);
  assert.ok(clean(w) && loopback(w), 'The generated browser/media fixture must stay on loopback');
  const remote = a.origin === acceptanceOrigin && optIn === 'harmony.go.altare.global';
  assert.ok(clean(a) && (loopback(a) || remote), 'API must be loopback or the explicitly opted-in owned HTTPS acceptance origin');
  return {remote};
}
export function acceptanceInstance(instance) {
  assert.ok(instance?.name === acceptanceName && instance?.version === '0.4.1'
    && instance?.media_transport === 'p2p', 'External capacity mutations require the disposable acceptance instance; production is refused');
}
