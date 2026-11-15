import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {CDP,until,delay} from './cdp.mjs';
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REPOSITORY,'BersaneV/Harmony');
const root=process.env.HARMONY_EXE_ROOT,exe=process.env.HARMONY_EXE_PATH;assert.ok(root&&exe&&exe.startsWith(root)&&!/[\s"\r\n]/.test(root));
const profile=join(root,'webview'),wav=join(root,'microphone.wav'),title='HarmonyWAN-'+process.env.GITHUB_RUN_ID,port=9222;
await mkdir(profile);const rate=48000,n=rate*10,buf=Buffer.alloc(44+n*2);buf.write('RIFF');buf.writeUInt32LE(buf.length-8,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(rate,24);buf.writeUInt32LE(rate*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)buf.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*9000),44+i*2);await writeFile(wav,buf);
const flags=['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--enable-automation','--disable-audio-input','--disable-audio-output','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+wav,'--autoplay-policy=no-user-gesture-required','--auto-select-desktop-capture-source='+title];
const policy=resolve('scripts/exe-wan/webview-policy.ps1');
function powershell(args){const r=spawnSync('pwsh',['-NoProfile','-File',policy,...args],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,'Scoped WebView test policy failed: '+(r.stderr||'').slice(-300));}
let app,fixture,cdp;const result={kind:'exe_probe',status:'RUNNING',scope:'Published Windows EXE on one disposable VM; generated mic and native capture of our own test window only'};
try{
 powershell(['-ExePath',exe,'-Profile',profile,'-BrowserArguments',flags.join(' ')]);
 fixture=spawn('pwsh',['-NoProfile','-File',resolve('scripts/exe-wan/window.ps1'),'-Title',title],{stdio:['ignore','ignore','pipe']});let fixtureError='';fixture.stderr.on('data',b=>fixtureError=(fixtureError+b).slice(-3000));
 app=spawn(exe,[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:flags.join(' '),WEBVIEW2_USER_DATA_FOLDER:profile},stdio:'ignore'});
 let target;await until(async()=>{try{const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();target=targets.find(t=>['http://tauri.localhost','https://tauri.localhost'].includes(new URL(t.url).origin));return !!target?.webSocketDebuggerUrl}catch{return false}},'owned EXE WebView CDP',60000);
 cdp=new CDP(target.webSocketDebuggerUrl);await cdp.send('Runtime.enable');
 const command=await cdp.send('Browser.getBrowserCommandLine');for(const flag of flags)assert.ok(command.arguments.includes(flag),'Required fake/loopback flag missing: '+flag.split('=')[0]);
 const userData=command.arguments.find(a=>a.startsWith('--user-data-dir='));assert.ok(userData?.slice(16).toLowerCase()===profile.toLowerCase(),'Private WebView profile mismatch');
 const listening=spawnSync('pwsh',['-NoProfile','-Command',`@(Get-NetTCPConnection -State Listen -LocalPort ${port}).LocalAddress | ConvertTo-Json -Compress`],{encoding:'utf8'});const addresses=[JSON.parse(listening.stdout)].flat();assert.ok(addresses.length&&addresses.every(a=>['127.0.0.1','::1'].includes(a)),'Debugger must not listen publicly');
 await until(()=>cdp.evaluate(`document.querySelector('input[autocomplete="username"]')!==null`),'compiled login UI');
 result.webview=await cdp.evaluate('({origin:location.origin,agent:navigator.userAgent,tauri:!!window.__TAURI_INTERNALS__})');assert.equal(result.webview.tauri,true);
 result.fake_audio=await cdp.run(`const s=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});const t=s.getAudioTracks()[0];const c=new AudioContext();await c.resume();const a=c.createAnalyser();a.fftSize=4096;c.createMediaStreamSource(s).connect(a);await new Promise(r=>setTimeout(r,1200));const v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);const rms=Math.sqrt(v.reduce((n,x)=>n+x*x,0)/v.length);const settings=t.getSettings();s.getTracks().forEach(t=>t.stop());await c.close();return {rms,settings};`,true);assert.ok(result.fake_audio.rms>0.03,'Generated microphone has energy');
 await delay(1500);assert.equal(fixture.exitCode,null,'Owned capture window exited: '+fixtureError);
 result.capture=await cdp.run(`const s=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}},audio:false});const t=s.getVideoTracks()[0];const v=document.createElement('video');v.muted=true;v.srcObject=s;await v.play();await new Promise(r=>setTimeout(r,1200));const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;canvas.getContext('2d').drawImage(v,0,0,160,90);const pixels=canvas.getContext('2d').getImageData(0,0,160,90).data;let light=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>30)light++;const settings=t.getSettings(),label=t.label;s.getTracks().forEach(t=>t.stop());return {settings,label,light_pixels:light,frames:v.getVideoPlaybackQuality().totalVideoFrames};`,true,45000);
 assert.equal(result.capture.settings.displaySurface,'window');assert.ok(result.capture.label.includes(title),'Only the owned capture window is accepted');assert.ok(result.capture.light_pixels>5000&&result.capture.frames>5,'Native capture must contain decoded generated content');
 result.flags_verified=true;result.debugger_loopback=true;result.profile_private=true;result.installed_sha256=createHash('sha256').update(await readFile(exe)).digest('hex');result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.message).slice(0,600);result.fixture_running=fixture?.exitCode===null;}
finally{cdp?.close();for(const child of [app,fixture])if(child?.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});try{powershell(['-ExePath',exe,'-Remove'])}catch{result.cleanup_policy='FAIL'};await writeFile(join(root,'probe.json'),JSON.stringify(result,null,2)+'\n');console.log('HARMONY_EXE_PROBE '+JSON.stringify(result));}
if(result.status!=='PASS')process.exitCode=1;
