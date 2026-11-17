// Actual installed EXE + production settings component/native IPC, in an owned
// disposable Windows VM. No microphone, speakers or Bluetooth hardware is faked.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, mkdir} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {createServer} from 'node:net';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {CDP, until} from './exe-wan/cdp.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, 'BersaneV/Harmony');
const exe = resolve(process.argv[2]);
assert.ok(exe.startsWith(resolve(process.env.RUNNER_TEMP) + sep));
const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'harmony-audio-'));
const scriptRoot = resolve('.local/qa-audio');
await mkdir(scriptRoot, {recursive:true});
function ps(code) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';"+code], {encoding:'utf8',timeout:30000});
  assert.equal(result.status, 0, (result.stderr || result.stdout).slice(-1500));
  return result.stdout.trim();
}
const open = "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Multimedia\\Audio');";
const before = JSON.parse(ps(open+"try{$exists=$k.GetValueNames() -contains 'UserDuckingPreference';if($exists -and $k.GetValueKind('UserDuckingPreference') -ne 'DWord'){throw 'Unexpected preference kind'};@{exists=$exists;value=$k.GetValue('UserDuckingPreference',$null)}|ConvertTo-Json -Compress}finally{$k.Dispose()}"));
assert.ok(!before.exists || (Number.isInteger(before.value) && before.value>=0 && before.value<=0xffffffff));
function seed(value) { ps(open+`try{${value===null ? "$k.DeleteValue('UserDuckingPreference',$false)" : `$k.SetValue('UserDuckingPreference',${value},[Microsoft.Win32.RegistryValueKind]::DWord)`}}finally{$k.Dispose()}`); }
const listener = createServer();
await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port = listener.address().port;
await new Promise(r=>listener.close(r));
const checks = [];
const check = (ok,name) => { assert.ok(ok,name);checks.push({name,passed:true}); };
let app, cdp, passed=false;
try {
  seed(0);
  app=spawn(exe,[],{stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(directory,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`}});
  let target;
  await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>['http://tauri.localhost','https://tauri.localhost'].includes(new URL(t.url).origin));return !!target?.webSocketDebuggerUrl;}catch{return false;}},'Owned Windows audio settings host',60000);
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.send('Runtime.enable');
  await until(()=>cdp.evaluate('!!window.__TAURI_INTERNALS__'),'Native IPC',30000);
  const status = () => cdp.evaluate("window.__TAURI_INTERNALS__.invoke('windows_audio_status')");
  const initial=await status();
  check(initial.supported && initial.ducking_preference===0,'Starting Harmony preserves the existing Windows mute-on-communications preference');
  for(const value of [null,0,1,2,3]) {
    seed(value);const result=await status();
    check(result.ducking_preference===value,`Native read preserves the existing preference ${value}`);
  }
  seed(0);
  // Mount the production component with its real native boundary; this does not
  // simulate call membership/media and does not claim physical audio coverage.
  const entry=join(scriptRoot,'entry.tsx');
  await writeFile(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{AudioHelp}from'../../apps/desktop/src/components/AudioHelp';globalThis.mountHarmonyAudioHelp=()=>{document.body.replaceChildren();const root=document.createElement('div');document.body.append(root);createRoot(root).render(React.createElement(AudioHelp));};`);
  const bundle=await build({configFile:false,plugins:[react()],define:{"process.env.NODE_ENV":JSON.stringify("production")},build:{write:false,minify:false,lib:{entry,name:'HarmonyAudioCheck',formats:['iife']}}});
  const code=(Array.isArray(bundle)?bundle:[bundle]).flatMap(result=>result.output).find(item=>item.type==='chunk').code;
  await cdp.evaluate(code);
  await cdp.evaluate('mountHarmonyAudioHelp()');
  await until(()=>cdp.evaluate("document.body.innerText.includes('Manter os outros sons no Windows')"),'Production audio settings button');
  check((await status()).ducking_preference===0,'Opening the settings does not change the user preference');
  check(await cdp.evaluate("document.body.innerText.includes('permanente') && document.body.innerText.includes('todos os aplicativos')"),'UI explains the persistent Windows-wide effect before the action');
  await cdp.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Manter os outros sons no Windows').click()",true);
  await until(async()=> (await status()).ducking_preference===3,'Windows preference readback after explicit action');
  await until(()=>cdp.evaluate("document.body.innerText.includes('Preferência salva')"),'Production confirmation');
  check(true,'Production button invokes the native command and confirms Do nothing');
  check(await cdp.evaluate("document.body.innerText.includes('Bluetooth clássico') && document.body.innerText.includes('microfone USB')"),'Bluetooth profile limitation and separate microphone route are explained');
  await cdp.evaluate('mountHarmonyAudioHelp()');
  await until(()=>cdp.evaluate("document.body.innerText.includes('já está desativada')"),'Reopened settings reflect saved state');
  check(!await cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Manter os outros sons no Windows')"),'Already applied preference does not offer a redundant change');
  passed=true;
} finally {
  cdp?.close();
  if(app?.exitCode===null && app.signalCode===null){app.kill();await new Promise(r=>app.once('exit',r));}
  seed(before.exists ? before.value : null);
  await mkdir(resolve('.local/qa-updater'),{recursive:true});
  await writeFile(resolve('.local/qa-updater/windows-audio.json'),JSON.stringify({status:passed?'PASS':'FAIL',checks,preference_restored:true,scope:'Installed Windows EXE, production AudioHelp UI and real Windows registry/native IPC. Call media, attenuation acoustics, wired and Bluetooth hardware: NOT_RUN; requires an affected physical PC.'},null,2)+'\n');
}
console.log(JSON.stringify({status:'PASS',checks:checks.length,hardware:'NOT_RUN'}));
