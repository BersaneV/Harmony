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
  await writeFile(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{AudioHelp}from'../../apps/desktop/src/components/AudioHelp';import{AudioTests}from'../../apps/desktop/src/components/AudioTests';import{CallKeysSettings}from'../../apps/desktop/src/components/CallKeys';import{useCallShortcuts}from'../../apps/desktop/src/lib/useCallShortcuts';globalThis.audioKeyEvents=[];function Controls(){const[ptt,setPtt]=React.useState(false);globalThis.setTestPtt=setPtt;useCallShortcuts({active:true,ptt,canTalk:true,onPtt:pressed=>audioKeyEvents.push({action:'ptt',pressed}),microphone:()=>audioKeyEvents.push({action:'microphone',pressed:true}),deafen:()=>audioKeyEvents.push({action:'deafen',pressed:true}),error:()=>audioKeyEvents.push({action:'error'})});return React.createElement(React.Fragment,null,React.createElement(AudioTests),React.createElement(CallKeysSettings));}globalThis.mountHarmonyAudioControls=()=>{document.body.replaceChildren();const div=document.createElement('div');document.body.append(div);const root=createRoot(div);root.render(React.createElement(Controls));globalThis.unmountAudioControls=()=>root.unmount();};globalThis.mountHarmonyAudioHelp=()=>{document.body.replaceChildren();const root=document.createElement('div');document.body.append(root);createRoot(root).render(React.createElement(AudioHelp));};`);
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
  await cdp.evaluate('mountHarmonyAudioControls()');
  await until(()=>cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Testar microfone')"),'Production audio test and keybind controls');
  check(await cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Testar saída de som')"),'Microphone and output tests are available without joining a call');
  await cdp.evaluate("navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('fixture-permission-denied','NotAllowedError')};Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Testar microfone').click()",true);
  await until(()=>cdp.evaluate("document.body.innerText.includes('Permita o microfone')"),'Microphone permission failure is explained');
  check(!await cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Parar teste de áudio')"),'Denied microphone test leaves no active local test');
  async function record(label,code,vk,modifiers=0){
    await cdp.evaluate(`(()=>{const l=Array.from(document.querySelectorAll('label.field')).find(l=>l.querySelector('span')?.textContent===${JSON.stringify(label)});l.querySelector('input').focus();return true})()`);
    await new Promise(r=>setTimeout(r,350));
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',code,key:code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',code,key:code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers});
    await new Promise(r=>setTimeout(r,500));
  }
  function realKey(vk,modifiers=[]){ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HarmonyKeyTest{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);}';${modifiers.map(n=>`[HarmonyKeyTest]::keybd_event(${n},0,0,[UIntPtr]::Zero);`).join('')}[HarmonyKeyTest]::keybd_event(${vk},0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80;[HarmonyKeyTest]::keybd_event(${vk},0,2,[UIntPtr]::Zero);${[...modifiers].reverse().map(n=>`[HarmonyKeyTest]::keybd_event(${n},0,2,[UIntPtr]::Zero);`).join('')}`);}
  await record('Atalho para ligar/desligar microfone','ScrollLock',145);
  await record('Atalho para parar/voltar a ouvir','F7',118);
  const saved=await cdp.evaluate("JSON.parse(localStorage.getItem('harmony.call-keys.v1'))");
  check(saved.microphone==='ScrollLock'&&saved.deafen==='F7','Actual recorder persists user-selected Scroll Lock and listening keybinds');
  await cdp.evaluate('audioKeyEvents.length=0');realKey(145);
  await until(()=>cdp.evaluate("audioKeyEvents.filter(e=>e.action==='microphone').length===1"),'Real Windows Scroll Lock reaches the microphone action');
  realKey(118);await until(()=>cdp.evaluate("audioKeyEvents.filter(e=>e.action==='deafen').length===1"),'Real Windows F7 reaches the listening action');
  check(true,'Real Windows key presses dispatch the configured microphone and listening actions');
  await record('Atalho para ligar/desligar microfone','KeyM',77,10);
  await cdp.evaluate('audioKeyEvents.length=0');realKey(77,[17,16]);
  await until(()=>cdp.evaluate("audioKeyEvents.filter(e=>e.action==='microphone').length===1"),'Real modifier combination reaches microphone action');
  check(true,'Ctrl+Shift+M works through the Windows global shortcut boundary');
  await record('Atalho para segurar e falar','F8',119);await cdp.evaluate('setTestPtt(true)');await new Promise(r=>setTimeout(r,600));await cdp.evaluate('audioKeyEvents.length=0');realKey(119);
  await until(()=>cdp.evaluate("audioKeyEvents.some(e=>e.action==='ptt'&&e.pressed===true)&&audioKeyEvents.some(e=>e.action==='ptt'&&e.pressed===false)"),'Custom PTT press and release');
  check(true,'Custom push-to-talk delivers both press and release');
  await cdp.evaluate('unmountAudioControls()');await new Promise(r=>setTimeout(r,500));
  const free=ps("Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HarmonyFreeKey{[DllImport(\"user32.dll\")]public static extern bool RegisterHotKey(IntPtr h,int id,uint m,uint k);[DllImport(\"user32.dll\")]public static extern bool UnregisterHotKey(IntPtr h,int id);}';$ok=[HarmonyFreeKey]::RegisterHotKey([IntPtr]::Zero,27341,0,119);if($ok){$null=[HarmonyFreeKey]::UnregisterHotKey([IntPtr]::Zero,27341)};$ok.ToString()");
  check(free==='True','Leaving the controls releases the global PTT key for another process');
  passed=true;
} finally {
  cdp?.close();
  if(app?.exitCode===null && app.signalCode===null){app.kill();await new Promise(r=>app.once('exit',r));}
  seed(before.exists ? before.value : null);
  await mkdir(resolve('.local/qa-updater'),{recursive:true});
  await writeFile(resolve('.local/qa-updater/windows-audio.json'),JSON.stringify({status:passed?'PASS':'FAIL',checks,preference_restored:true,scope:'Installed Windows EXE, production AudioHelp UI and real Windows registry/native IPC. Call media, attenuation acoustics, wired and Bluetooth hardware: NOT_RUN; requires an affected physical PC.'},null,2)+'\n');
}
console.log(JSON.stringify({status:'PASS',checks:checks.length,hardware:'NOT_RUN'}));
