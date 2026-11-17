// Published EXE, real WASAPI capture/render, own disposable accounts and a
// browser peer with generated voice. No fake-device/audio-disable flags in EXE.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve,sep} from 'node:path';
import {CDP,until,delay} from '../exe-wan/cdp.mjs';
import {summarize,assertCoexistence} from './measurements.mjs';

assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.GITHUB_REPOSITORY,'BersaneV/Harmony');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
const origin='https://harmony.go.altare.global',area=resolve('.local/qa-audio-coexistence');
const exe=resolve(process.env.HARMONY_AUDIO_EXE),dll=resolve('tools/windows-audio-lab/bin/Release/net8.0-windows/WindowsAudioLab.dll');
assert.ok(exe.startsWith(resolve(process.env.RUNNER_TEMP)+sep));
assert.equal(createHash('sha256').update(await readFile(exe)).digest('hex'),'58ea36ebcd72fc63ce9a9e6d2c5b59fa103fea9ee7327b01ae03a7cb71f77de7');
const directory=await mkdtemp(join(process.env.RUNNER_TEMP,'harmony-coexist-'));await mkdir(area,{recursive:true});
const report={status:'RUNNING',version:'0.4.13',scope:'One Windows VM, published EXE, second browser participant, generated voice and actual Windows virtual endpoint/PCM. No physical wired/Bluetooth headset.',physical_wired:'NOT_RUN',physical_bluetooth:'NOT_RUN',phases:[],checks:[]};
const children=[],sessions=[],intervals=[];let native,peer,player,meter;
const check=(ok,name)=>{assert.ok(ok,name);report.checks.push({name,passed:true});};
const mask=v=>console.log('::add-mask::'+v);
function start(file,args,options={}) {const p=spawn(file,args,{stdio:['ignore','pipe','pipe'],...options});children.push(p);return p;}
function lines(p,onLine){let tail='';p.stdout.on('data',b=>{tail+=b;const rows=tail.split(/\r?\n/);tail=rows.pop();for(const r of rows)if(r)onLine(r);});let error='';p.stderr.on('data',b=>error=(error+b).slice(-1500));p.lastError=()=>error;}
async function api(path,body,token) {
  assert.ok(path.startsWith('/')&&!path.includes('://'));
  const response=await fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  assert.ok(response.ok,'Owned test API failed: '+response.status);return response.status===204?null:response.json();
}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function attach(p,allowed) {
  let target;await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find(t=>allowed.includes(new URL(t.url).origin));return !!target?.webSocketDebuggerUrl;}catch{return false;}},'Owned audio-test renderer',60000);
  const c=new CDP(target.webSocketDebuggerUrl);await c.send('Runtime.enable');await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});return c;
}
async function click(c,text,label=false) {
  const expression=label?`Array.from(document.querySelectorAll('button')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(text)}&&!e.disabled)`:`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`;
  await until(()=>c.evaluate(`!!(${expression})`),'UI button '+text);await c.evaluate(`(${expression}).click();true`,true);
}
async function fill(c,selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();return true})()`);await c.send('Input.insertText',{text:value});}
async function select(c,label,value) {await c.evaluate(`(()=>{const l=Array.from(document.querySelectorAll('label.field')).find(l=>l.querySelector('span')?.textContent.startsWith(${JSON.stringify(label)}));const s=l?.querySelector('select');if(!s)throw Error('Select unavailable');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,true);}
async function login(c,user,name) {
  await until(()=>c.evaluate(`!!document.querySelector('[autocomplete=username]')`),'Shipped login form');
  await fill(c,'[autocomplete=username]',user.username);await fill(c,'[autocomplete=current-password]',user.password);await click(c,'Entrar no Harmony');
  await until(()=>c.evaluate(`!!document.querySelector('[aria-label='+JSON.stringify(${JSON.stringify('Abrir '+name)})+']')`),'Own private community');
  await click(c,'Abrir '+name,true);
}
function observe(generated=false) {
  const q=window.__audioCoexist={pcs:[],local:[],display:[],received:[],generated};
  const Native=window.RTCPeerConnection;
  window.RTCPeerConnection=class extends Native {constructor(...args){super(...args);q.pcs.push(this);this.addEventListener('track',e=>q.received.push({track:e.track,mid:e.transceiver.mid}));}};
  const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async options=>{
    if(generated&&options.audio){const c=new AudioContext({sampleRate:48000});await c.resume();const o=c.createOscillator(),g=c.createGain(),d=c.createMediaStreamDestination();o.frequency.value=880;g.gain.value=0.12;o.connect(g).connect(d);o.start();q.voice={c,o,d};q.local.push(...d.stream.getTracks());return d.stream;}
    const stream=await getUserMedia(options);q.local.push(...stream.getTracks());return stream;
  };
  if(navigator.mediaDevices.getDisplayMedia){const get=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=async options=>{const s=await get(options);q.display.push(...s.getTracks());return s;};}
}
async function phase(name,{baseline,voice=false,diagnostic=false}={}) {
  console.log(JSON.stringify({phase:name,status:'MEASURING'}));await delay(2500);const begin=intervals.length;await delay(10000);
  const measured=summarize(intervals.slice(begin));const result={name,...measured,diagnostic};
  if(baseline&&!diagnostic)Object.assign(result,assertCoexistence(measured,baseline,{voice}));
  if(baseline&&diagnostic)result.mean_ratio=measured.external_mean/baseline.external_mean;
  report.phases.push(result);await writeFile(join(area,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(result));return result;
}
async function call(c){await click(c,'Sala de voz');await until(()=>c.evaluate("!!document.querySelector('[aria-label=\"Ligar microfone\"]:not(:disabled)')"),'Connected call UI',60000);}
async function stats(c){return c.run(`const rows=[];for(const pc of __audioCoexist.pcs){const s=await pc.getStats();for(const r of s.values())if(['inbound-rtp','outbound-rtp'].includes(r.type))rows.push({type:r.type,kind:r.kind,mid:r.mid,bytesReceived:r.bytesReceived,bytesSent:r.bytesSent,framesDecoded:r.framesDecoded,frameWidth:r.frameWidth,frameHeight:r.frameHeight});}return rows;`);}
try {
  // Windows policy preset is an explicit diagnostic control in this disposable VM.
  const set=spawnSync('pwsh',['-NoProfile','-Command',"$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Multimedia\\Audio');$k.SetValue('UserDuckingPreference',0,[Microsoft.Win32.RegistryValueKind]::DWord);$k.Dispose()"],{encoding:'utf8'});assert.equal(set.status,0);
  meter=start('dotnet',[dll,'meter','600']);lines(meter,line=>{const r=JSON.parse(line);r.observed_at=Date.now();intervals.push(r);});
  player=start('dotnet',[dll,'play','600']);lines(player,line=>{report.external_player=JSON.parse(line);});
  const baseline=await phase('external_audio_only');check(baseline.external_mean>0.02,'Independent external process reaches actual WASAPI loopback');
  const suffix=process.env.GITHUB_RUN_ID+'_'+process.env.GITHUB_RUN_ATTEMPT;
  const users=[0,1].map(i=>({username:'ac_'+suffix+'_'+i,password:randomBytes(24).toString('hex')}));users.forEach(u=>mask(u.password));
  const owner=await api('/auth/register',{...users[0],display_name:'Audio lab sender'});sessions.push(owner);mask(owner.access_token);mask(owner.refresh_token);
  const guild=await api('/guilds',{name:'Audio lab '+suffix},owner.access_token);report.test_community='Own disposable community';
  const invite=await api(`/guilds/${guild.id}/invites`,{expires_hours:1,max_uses:1},owner.access_token);mask(invite.token);
  const other=await api('/auth/register',{...users[1],display_name:'Audio lab receiver',invite_token:invite.token});sessions.push(other);mask(other.access_token);mask(other.refresh_token);
  const p1=await port(),p2=await port();
  const flags=`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${p1} --enable-automation --autoplay-policy=no-user-gesture-required --auto-select-desktop-capture-source=Entire screen`;
  const policy=spawnSync('pwsh',['-NoProfile','-File',resolve('scripts/exe-wan/webview-policy.ps1'),'-ExePath',exe,'-Profile',join(directory,'native')],{encoding:'utf8',env:{...process.env,HARMONY_WAN_BROWSER_ARGUMENTS:flags}});assert.equal(policy.status,0,'Scoped owned EXE WebView policy');
  const app=start(exe,[],{env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(directory,'native'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:flags}});
  native=await attach(p1,['http://tauri.localhost','https://tauri.localhost']);
  const argumentsList=(await native.send('Browser.getBrowserCommandLine')).arguments;
  check(!argumentsList.some(a=>/disable-audio|use-fake-device|use-file-for-fake-audio|^--mute-audio/.test(a)),'Published EXE uses real Windows input and output, without fake/audio-disable switches');
  report.native_pid=app.pid;check(report.external_player.pid!==app.pid,'Background player is a different process from Harmony');
  await native.send('Browser.grantPermissions',{origin:'http://tauri.localhost',permissions:['audioCapture']});
  await login(native,users[0],guild.name);await native.evaluate(`(${observe.toString()})(false)`);
  await phase('harmony_open_outside_call',{baseline});
  const edge=join(process.env['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe');
  start(edge,['--headless=new','--no-first-run',`--user-data-dir=${join(directory,'peer')}`,`--remote-debugging-port=${p2}`,'--remote-debugging-address=127.0.0.1','--mute-audio','--autoplay-policy=no-user-gesture-required',origin]);
  peer=await attach(p2,[origin]);await login(peer,users[1],guild.name);await peer.evaluate(`(${observe.toString()})(true)`);
  await call(peer);await click(peer,'Ligar microfone',true);await call(native);
  await phase('joined_call_microphone_off',{baseline,diagnostic:true});
  await click(native,'Ligar microfone',true);
  await until(()=>native.evaluate("__audioCoexist.local.some(t=>t.kind==='audio'&&t.readyState==='live')"),'Actual virtual microphone opens');
  report.microphone=await native.evaluate("__audioCoexist.local.filter(t=>t.kind==='audio').map(t=>({label:t.label,settings:t.getSettings(),state:t.readyState}))");
  await phase('microphone_with_windows_mute_preference',{baseline,diagnostic:true});
  await click(native,'Dispositivos e voz',true);await click(native,'Manter os outros sons no Windows');
  await until(()=>native.evaluate("document.body.innerText.includes('Preferência salva')"),'Production audio preference confirmation');
  check((await native.evaluate("window.__TAURI_INTERNALS__.invoke('windows_audio_status')")).ducking_preference===3,'Production settings action changes the actual Windows preference');
  await click(native,'Fechar',true);await click(native,'Sair da chamada',true);await delay(1500);
  await phase('left_call_after_preference_change',{baseline});
  await call(native);await click(native,'Ligar microfone',true);
  await phase('call_with_preference_disabled',{baseline,voice:true});
  await click(native,'Compartilhar tela',true);await select(native,'Resolução','720');await select(native,'Quadros por segundo','30');await select(native,'Bitrate por','manual');await fill(native,'input[aria-label="Bitrate em megabits por segundo"]','2');
  await click(native,'Escolher tela ou janela');
  await until(()=>native.evaluate("__audioCoexist.display.some(t=>t.kind==='video'&&t.readyState==='live')"),'Real screen and system-audio selection',45000);
  const capture=await native.evaluate("__audioCoexist.display.map(t=>({kind:t.kind,label:t.label,settings:t.getSettings(),state:t.readyState}))");report.capture=capture;
  check(capture.some(t=>t.kind==='audio'&&t.state==='live'),'Real system-audio track is captured; silence/video-only capture cannot pass');
  await click(native,'Iniciar transmissão');
  await until(async()=> (await stats(peer)).some(r=>r.type==='inbound-rtp'&&r.kind==='video'&&r.framesDecoded>10),'Peer decodes actual shared video',60000);
  report.received_before=await stats(peer);
  await phase('voice_and_screen_with_system_audio',{baseline,voice:true});
  report.received_after=await stats(peer);check(report.received_after.some(r=>r.kind==='video'&&r.framesDecoded>25),'Remote video continues decoding while background audio plays');
  report.peer_audio=await peer.run(`
    const c=new AudioContext({sampleRate:48000});await c.resume();
    const entries=__audioCoexist.received.filter(r=>r.track.kind==='audio'&&r.track.readyState==='live').map(r=>{const a=c.createAnalyser();a.fftSize=8192;const source=c.createMediaStreamSource(new MediaStream([r.track]));source.connect(a);return{a,source,mid:r.mid};});
    await new Promise(r=>setTimeout(r,500));
    const rows=entries.map(({a,mid})=>{const v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);let re=0,im=0;for(let i=0;i<v.length;i++){const angle=2*Math.PI*440*i/c.sampleRate;re+=v[i]*Math.cos(angle);im+=v[i]*Math.sin(angle);}return{mid,external_440:2*Math.hypot(re,im)/v.length};});await c.close();return rows;`,true);
  check(report.peer_audio.some(r=>r.external_440>0.01),'The remote participant actually decodes the other application audio from the screen stream');
  player.kill();await delay(1500);const noPlayer=await phase('external_player_stopped_negative_control');
  check(noPlayer.external_mean<baseline.external_mean*0.1&&noPlayer.voice_mean>0.01,'Stopping the other process removes only its tone while Harmony voice remains audible in measured PCM');
  player=start('dotnet',[dll,'play','120']);lines(player,()=>{});
  await phase('external_player_restored',{baseline,voice:true});

  await click(native,'Parar tela');await click(native,'Sair da chamada',true);await click(peer,'Sair da chamada',true);
  await phase('after_call_and_screen_stop',{baseline});
  report.status='PASS';
} catch(error) {
  report.status='FAIL';report.error=String(error.message).slice(0,600);
  for(const [name,c]of [['native',native],['peer',peer]])if(c)report[name+'_diagnostic']=await c.evaluate('document.body.innerText.slice(-2500)').catch(()=> 'unavailable');
  throw error;
} finally {
  for(const c of [native,peer])if(c){try{if(await c.evaluate("!!document.querySelector('[aria-label=\"Sair da chamada\"]')"))await click(c,'Sair da chamada',true);await click(c,'Preferências',true);await click(c,'Sair da conta');}catch{}c.close();}
  for(const s of sessions)try{await api('/auth/logout',{refresh_token:s.refresh_token});}catch{}
  for(const p of children)if(p.exitCode===null)spawnSync('taskkill',['/PID',String(p.pid),'/T','/F'],{stdio:'ignore'});
  spawnSync('pwsh',['-NoProfile','-File',resolve('scripts/exe-wan/webview-policy.ps1'),'-ExePath',exe,'-Remove'],{stdio:'ignore'});
  report.loopback_intervals=intervals.filter(r=>r.kind==='loopback_interval').length;
  await writeFile(join(area,'result.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(area,'loopback.jsonl'),intervals.map(r=>JSON.stringify(r)).join('\n')+'\n');
  console.log(JSON.stringify(report));
}
