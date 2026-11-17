// Disposable CI-only protocol delivery. No account, network call, camera or mic.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join, dirname, sep} from 'node:path';
import {createServer} from 'node:net';
import {CDP, until} from './exe-wan/cdp.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, 'BersaneV/Harmony');
const exe = resolve(process.argv[2]);
assert.ok(exe.startsWith(resolve(process.env.RUNNER_TEMP) + sep));
const output = resolve('.local/qa-updater/windows-invite.json');
const profile = await mkdtemp(join(process.env.RUNNER_TEMP, 'harmony-invite-webview-'));
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const env = {...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`};
const token1 = randomBytes(32).toString('hex'), token2 = randomBytes(32).toString('hex');
const url = token => 'harmony://invite?' + new URLSearchParams({server:'https://harmony.go.altare.global',code:token});
const checks = [], children = [];
const check = (value, name) => { assert.ok(value, name); checks.push({name,passed:true}); };
let client, passed = false;
try {
  const first = spawn(exe, [url(token1)], {env,stdio:'ignore'}); children.push(first);
  let target;
  await until(async () => {
    if (first.exitCode !== null) throw Error('Owned app exited before readiness');
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type==='page' && t.webSocketDebuggerUrl); return !!target; }
    catch { return false; }
  }, 'Owned installed WebView starts', 60000);
  client = new CDP(target.webSocketDebuggerUrl);
  await until(async () => await client.evaluate("!!window.__TAURI_INTERNALS__ && !!document.querySelector('.invite-banner')").catch(() => false), 'Cold-start invite banner', 30000);
  check((await client.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:deep-link|get_current')")).includes(url(token1)), 'installed app receives the cold-start URL');
  check(await client.evaluate(`JSON.parse(sessionStorage.getItem('harmony.pending-invite')).token===${JSON.stringify(token1)}`), 'cold-start invite reaches the application pending state');
  const second = spawn(exe, [url(token2)], {env,stdio:'ignore'}); children.push(second);
  await until(async () => (await client.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:deep-link|get_current')")).includes(url(token2)), 'Warm URL delivered', 30000);
  check(true, 'already-running app receives the second URL');
  await until(async () => await client.evaluate(`JSON.parse(sessionStorage.getItem('harmony.pending-invite')).token===${JSON.stringify(token2)}`), 'Warm invite replaces pending state', 10000);
  check(true, 'warm URL reaches the application without copying a code');
  await until(() => second.exitCode !== null, 'Secondary process exits', 10000);
  check(second.exitCode===0 && first.exitCode===null, 'single-instance keeps the original process and closes the second');
  check(await client.evaluate("!!document.querySelector('[autocomplete=username]') && !document.querySelector('dialog[open]')"), 'login remains available with the pending invitation');
  passed = true;
} finally {
  client?.close();
  for (const child of children) if (child.exitCode===null && child.signalCode===null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  await mkdir(dirname(output), {recursive:true});
  await writeFile(output, JSON.stringify({passed,commit:process.env.GITHUB_SHA,
    version:'0.4.12',checks,scope:'Installed Windows EXE, native cold/warm URL delivery and single-instance; no login, API acceptance, media or physical-device test'},null,2)+'\n');
}
assert.ok(passed);
console.log(JSON.stringify({status:'PASS',checks:checks.length,scope:'Windows installed EXE cold/warm invitation'}));
