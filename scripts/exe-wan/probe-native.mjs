// Pinned desktop probe: the compiled application's normal authenticated UI creates media.
// This module never invokes native capture IPC or imports application TS through CDP.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {session} from './session.mjs';
import {requestedProfile} from './profiles.mjs';
import {guard,cohort,identity,origin,mask,ownedSession,api} from './lab.mjs';
import {CDP,until} from './cdp.mjs';
import {assertCaptureMeasurement} from './capture-ui.mjs';
import {assertCallRoute} from './fixture-contract.mjs';
import {ownedUiAutomationScript} from './browser-capture-diagnostic.mjs';

const lightDom=`(()=>{const d=[...document.querySelectorAll('dialog[open]')].find(d=>d.querySelector('h2')?.textContent==='Compartilhar sua tela'),v=d?.querySelector('.share-preview video');const button=text=>{const b=d&&[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===text);return b?{present:true,disabled:b.disabled}:{present:false}};return{sharing_open:!!d,preview:v?{ready_state:v.readyState,width:v.videoWidth,height:v.videoHeight,paused:v.paused,error_code:v.error?.code??null}:null,choose:button('Escolher tela ou janela'),cancel:button('Cancelar'),publish:button('Iniciar transmissão'),alert_count:document.querySelectorAll('.error-banner,[role=alert]').length}})()`;
// Do not call captureSnapshots/getSettings here: a basic track count must stay
// independent of both the source's native settings and peer getStats promises.
const lightCaptures=`(()=>{const rows=window.__exeWan?.captures||[];return{count:rows.length,tracks:rows.slice(-8).map(c=>({kind:c.kind,ready:c.track.readyState,muted:c.track.muted,enabled:c.track.enabled}))}})()`;
const failureError=error=>({name:typeof error?.name==='string'?error.name.slice(0,40):'Error'});

export async function collectProbeFailure(app,{fetcher=fetch,connect=url=>new CDP(url),windows=spawnSync,runId=process.env.GITHUB_RUN_ID}={}){
 const out={};
 const read=async(key,operation)=>{try{out[key]=await operation();}catch(error){out[key+'_error']=failureError(error);}};
 app.cdp.setStage('failure.dom');await read('dom',()=>app.cdp.evaluate(lightDom,false,2000));
 app.cdp.setStage('failure.captures');await read('captures',()=>app.cdp.evaluate(lightCaptures,false,2000));
 let target;
 app.cdp.setStage('failure.http');await read('debugger',async()=>{
  const response=await fetcher('http://127.0.0.1:9222/json/list',{signal:AbortSignal.timeout(2000)}),targets=await response.json();
  const owned=t=>{try{return['http://tauri.localhost','https://tauri.localhost'].includes(new URL(t.url).origin);}catch{return false;}};
  target=targets.find(owned);return{http_status:response.status,targets:targets.map(t=>({type:t.type,owned:owned(t)}))};
 });
 const freshUrl=target?.webSocketDebuggerUrl||app.cdp.url;
 if(freshUrl){
  let fresh;
  try{
   fresh=connect(freshUrl);
   fresh.setStage('failure.browser');await read('fresh_browser',async()=>{const value=await fresh.send('Browser.getVersion',{},2000);return Object.fromEntries(['product','protocolVersion','jsVersion'].filter(k=>typeof value[k]==='string').map(k=>[k,value[k].slice(0,100)]));});
   fresh.setStage('failure.renderer');await read('fresh_renderer',async()=>{const value=await fresh.send('Runtime.evaluate',{expression:'1',awaitPromise:false,returnByValue:true},2000);return{responded:value.result?.value===1};});
  }catch(error){out.fresh_connection_error=failureError(error);}finally{try{fresh?.close();}catch{out.fresh_close='FAILED';}}
 }
 app.cdp.setStage('failure.windows');await read('owned_windows',async()=>{
  const handle=Number(app.fixtureDiagnostic().output.match(/(?:^|\r?\n)WINDOW ([0-9]+) /)?.[1]??0),script=ownedUiAutomationScript(handle,'HarmonyWAN-'+runId);
  const value=windows('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:8000,maxBuffer:150000});
  return{completion:value.status===0?'COMPLETE':'PARTIAL_OR_UNAVAILABLE',records:(value.stdout||'').split(/\r?\n/).flatMap(line=>{try{const row=JSON.parse(line.trim().replace(/^\uFEFF/,''));return ['owned_native_windows','owned_uia_node'].includes(row.kind)?[row]:[];}catch{return[];}})};
 });
 // This is deliberately last, independently bounded and unable to erase DOM,
 // debugger or OS evidence if one peer's getStats never resolves.
 app.cdp.setStage('failure.stats');await read('stats',()=>app.sample(2000));
 return out;
}

// probe.mjs is the existing release-selecting launcher. Importing this module
// for its failure collector must never log in or create a capture.
if([import.meta.url,new URL('./probe.mjs',import.meta.url).href].includes(pathToFileURL(resolve(process.argv[1]||'')).href)){

const request=requestedProfile();let app;
const result={kind:'exe_probe',status:'RUNNING',scope:'One pinned published EXE on one disposable VM; normal compiled login/call/preview UI and an owned native Windows source. This is not eight-peer capacity approval.',requested_profile:request,instrumentation:'Passive application capture event and clones of actual application tracks; no injected capture or sender changes'};
const commandTrace=[];let traceDropped=0;
const onCommandTrace=row=>{commandTrace.push(row);if(commandTrace.length>512){commandTrace.shift();traceDropped++;}console.log('HARMONY_EXE_PROBE_CDP '+JSON.stringify(row));};
try{
 guard();const version=process.env.HARMONY_EXE_RELEASE;assert.ok(['0.4.3','0.4.4','0.4.5'].includes(version),'Explicit pinned desktop release required');
 for(const field of ['HARMONY_GUILD_ID','HARMONY_GUILD_NAME','HARMONY_VOICE_ID','HARMONY_COHORT_USERS'])assert.ok(process.env[field],`Compiled UI probe requires the private prepare.mjs fixture: ${field}`);
 assert.equal(process.env.HARMONY_GUILD_NAME,'EXE WAN '+cohort());
 const users=JSON.parse(process.env.HARMONY_COHORT_USERS);assert.equal(users.length,8);
 // The manifest must be supplied from the real published artifact. No candidate
 // digest or missing release is silently accepted as an expected binary hash.
 let release;try{release=JSON.parse(await readFile(new URL(`./releases/${version}.json`,import.meta.url),'utf8'));}catch{throw Error(`Real pinned ${version} release manifest is required before running this probe`);}
 assert.equal(release.version,version);assert.match(release.main_sha256,/^[a-f0-9]{64}$/);
 const executableHash=createHash('sha256').update(await readFile(process.env.HARMONY_EXE_PATH)).digest('hex');assert.equal(executableHash,release.main_sha256,'Only the pinned installed EXE may run');
 const token=await ownedSession(0),members=(await api(`/guilds/${process.env.HARMONY_GUILD_ID}/members`,token)).items;
 assert.equal(members.length,8);assert.ok(members.every(m=>users.some(u=>u.id===m.id)),'Only owned fixture members may join');
 const instance=await api('/instance'),callInfo=await api(`/channels/${process.env.HARMONY_VOICE_ID}/call`,token);assertCallRoute(instance,callInfo);result.server={version:instance.version,media_transport:instance.media_transport,screen_sfu_enabled:callInfo.screen_sfu_enabled===true};
 app=await session(0,{onCommandTrace});result.attestation=app.attestation;result.installed_sha256=executableHash;
 const who=identity(0);mask(who.password);
 await app.fill('input[type="url"]',origin);await app.fill('input[autocomplete="username"]',who.username);await app.fill('input[type="password"]',who.password);await app.click('Entrar no Harmony');
 await app.labelled('Abrir '+process.env.HARMONY_GUILD_NAME);await app.click('Sala de voz');
 app.cdp.setStage('call.ready');await until(()=>app.cdp.evaluate(`document.querySelector('.call-header small')?.textContent.trim().startsWith('Em chamada ·')`),'compiled normal call joined',60000);
 await app.labelled('Ligar microfone');
 app.cdp.setStage('call.microphone.ready');await until(()=>app.cdp.evaluate(`__exeWan.microphones.some(t=>t.readyState==='live')`),'compiled UI microphone track');
 app.cdp.setStage('call.microphone.observe');result.fake_audio=await app.cdp.evaluate('__exeWan.measureMicrophone()');assert.ok(result.fake_audio.rms>0.03,'Generated compiled microphone must carry energy');
 await app.click('Compartilhar tela');await app.select('Resolução',request.height);await app.select('Quadros por segundo',request.fps);
 await app.select('Bitrate por','manual');await app.fill('input[aria-label="Bitrate em megabits por segundo"]',String(request.bitrate_mbps));await app.select('Conteúdo','motion');
 app.cdp.setStage('share.configure.audio');await app.cdp.evaluate(`(()=>{const e=document.querySelector('.check-field input[type="checkbox"]');if(e?.checked)e.click();return true})()`,true);
 result.capture_selection=await app.chooseScreen();result.owned_window_handle=result.capture_selection.owned_window_handle;
 app.cdp.setStage('capture.measure');result.capture=await app.measureCapture(result.capture_selection.captures[0].index);
 assertCaptureMeasurement(result.capture,request,result.capture_selection.mode);
 result.status='PASS';
}catch(error){
 result.status='FAIL';result.error=String(error.message).slice(0,700);
 result.last_command=commandTrace.at(-1);result.failure_stage=app?.cdp.stage;
 if(app){result.failure_diagnostics=await collectProbeFailure(app,{connect:url=>new CDP(url,{trace:onCommandTrace})});if(result.failure_diagnostics.stats)result.final_sample=result.failure_diagnostics.stats;}
}finally{
 result.command_trace=commandTrace;result.command_trace_dropped=traceDropped;
 if(app){result.fixture_diagnostic=app.fixtureDiagnostic();try{app.close();}catch{result.cleanup_policy='FAIL';result.status='FAIL';}await writeFile(join(app.root,'probe.json'),JSON.stringify(result,null,2)+'\n');}
 console.log('HARMONY_EXE_PROBE '+JSON.stringify(result));
}
if(result.status!=='PASS')process.exitCode=1;
}
