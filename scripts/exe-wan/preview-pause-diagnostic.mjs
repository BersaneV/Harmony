// Diagnostic of the immutable public EXE: pause only the owned local preview.
// No capture/sender/frame/writer/ACK replacement. Never a capacity approval.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export const VERSION='0.4.10', MAIN_SHA='378332754b2d89775a4b9d55c70ef1bfc58da63403b0d8904a2457aaabf16021';
export const INSTALLER_SHA='cedea228dd87d72d3d7c1cec07b093e87372078151c3dd012649d8ff77906f58';

// Self-contained in the compiled owned WebView. All references remain private.
export function installPreviewPause(index,operationToken){
 const owned=()=>!!window.__TAURI_INTERNALS__&&['http://tauri.localhost','https://tauri.localhost'].includes(location.origin);
 if(typeof operationToken!=='string'||!new RegExp('^[a-f0-9]{32}$').test(operationToken)||!owned()||window.__ownedPreviewPause)throw Error('OWNED_CONTEXT_REQUIRED');
 const qa=window.__exeWan,capture=qa?.captures[index],track=capture?.track;
 const videos=[...document.querySelectorAll('.share-preview video')];
 if(!Number.isSafeInteger(index)||index<0||capture?.kind!=='native'||videos.length!==1)throw Error('OWNED_PREVIEW_REQUIRED');
 const video=videos[0],stream=video.srcObject,count=qa.captures.length,hint=track.contentHint;let active=true,control;
 const videoSenders=()=>qa.pcs.reduce((n,p)=>n+p.getSenders().filter(s=>s.track?.kind==='video'&&s.track.readyState==='live').length,0);
 const same=()=>{
  if(!active||!owned()||window.__ownedPreviewPause!==control||qa!==window.__exeWan||qa.captures.length!==count||qa.captures[index]!==capture||capture.track!==track||track.contentHint!==hint||track.readyState!=='live'||track.enabled!==true||capture.processor_status!=='running'||capture.processor_error||capture.marker_copy_errors!==0||!video.isConnected||video.srcObject!==stream||stream?.getVideoTracks().length!==1||stream.getVideoTracks()[0]!==track||document.querySelectorAll('.share-preview video').length!==1||document.querySelector('.share-preview video')!==video||videoSenders()!==0)throw Error('CAPTURE_OR_PREVIEW_CHANGED');
 };
 const snapshot=()=>{same();return{same_reference:true,track_live:track.readyState==='live',track_enabled:track.enabled,preview_paused:video.paused,preview_ready:video.readyState,source_content_hint:hint===''?'unspecified':['detail','motion','text'].includes(hint)?hint:'unknown',preview_width:video.videoWidth,preview_height:video.videoHeight,active_video_senders:videoSenders(),source_observer_running:capture.processor_status==='running'};};
 const baselinePlaying=!video.paused&&video.readyState>=2;
 control={snapshot,pause(){same();video.pause();same();if(!video.paused)throw Error('PAUSE_UNVERIFIED');return snapshot();},async resume(){same();await video.play();same();if(video.paused)throw Error('PLAY_UNVERIFIED');return snapshot();},async finish(){try{same();if(baselinePlaying&&video.paused)await video.play();same();if(baselinePlaying&&video.paused)throw Error('PLAY_UNVERIFIED');return{status:'RESTORED',preview_paused:video.paused,same_reference:true};}catch{return{status:'NOT_VERIFIED'};}finally{active=false;if(window.__ownedPreviewPause===control)delete window.__ownedPreviewPause;}}};
 Object.defineProperty(control,'operationToken',{value:operationToken});window.__ownedPreviewPause=control;same();if(!baselinePlaying)throw Error('PREVIEW_NOT_PLAYING');return snapshot();
}
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
export function projectCapture(c){return{observation_ms:finite(c.observation_ms),width:finite(c.pixel_width),height:finite(c.pixel_height),source_frames:finite(c.processor_frames),source_fps:finite(c.processor_source_fps),distinct_frames:finite(c.distinct_marker_frames),distinct_fps:finite(c.distinct_marker_fps),local_playback_fps:finite(c.measured_fps),native_producer_fps:finite(c.settings?.frameRate),marker_copy_calls:finite(c.marker_copy_calls_delta),marker_copy_mean_ms:c.marker_copy_calls_delta>0?finite(c.marker_copy_total_ms_delta/c.marker_copy_calls_delta):null};}

export async function measurePreviewPhases(app,selection,request,result,{checkOwned,checkQuality}={}){
 const selected=selection.captures[0],index=selected.index,operationToken=randomBytes(16).toString('hex');
 const same=c=>{checkOwned(c,selection.owned_window_handle,request,'native');assert.equal(c.track_id,selected.track_id);assert.equal(c.index,index);};
 const operation=(name)=>app.cdp.evaluate(`(()=>{const c=window.__ownedPreviewPause;if(!c||c.operationToken!==${JSON.stringify(operationToken)}){${name==='finish'?"return{status:'NOT_VERIFIED'};":"throw Error('PREVIEW_OWNER_CHANGED');"}}return c.${name}();})()`,false,3000);
 try{
  await app.cdp.evaluate(`(${installPreviewPause.toString()})(${JSON.stringify(index)},${JSON.stringify(operationToken)})`,false,3000);
  for(const name of ['play_before','paused','play_after']){
   app.cdp.setStage('preview.'+name);
   same(await app.cdp.evaluate(`window.__exeWan.captureSnapshots()[${index}]`,false,3000));
   if(name==='paused')await operation('pause');
   if(name==='play_after')await operation('resume');
   const before=await operation('snapshot');assert.equal(before.preview_paused,name==='paused');
   const capture=await app.measureCapture(index,10000);same(capture);
   const after=await operation('snapshot');assert.equal(after.preview_paused,name==='paused');
   let quality='PASS';try{checkQuality(capture,request,'native');}catch{quality='FAIL';}
   result.phases.push({name,capacity_approval:false,before,after,capture:projectCapture(capture),original_quality_gate:quality});
  }
 }finally{
  app.cdp.setStage('preview.restore');
  try{result.restoration=await operation('finish');}catch{result.restoration={status:'NOT_VERIFIED'};}
 }
 assert.equal(result.restoration.status,'RESTORED');
 const[a,b,c]=result.phases.map(p=>p.capture.distinct_fps);
 const playback=result.phases.map(p=>p.capture.local_playback_fps);
 result.comparison={controls_consumed_frames:[playback[0],playback[2]].every(Number.isFinite)?playback[0]>0&&playback[2]>0:null,b_minus_before:Number.isFinite(a)&&Number.isFinite(b)?b-a:null,b_minus_after:Number.isFinite(c)&&Number.isFinite(b)?b-c:null,b_at_least_54:Number.isFinite(b)?b>=54:null,b_exceeds_both_controls:[a,b,c].every(Number.isFinite)?b>Math.max(a,c):null};
}

export function assertContext(env,platform,request){
 assert.equal(platform,'win32');for(const[k,v]of Object.entries({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BersaneV/Harmony',GITHUB_REF:'refs/heads/main',RUNNER_ENVIRONMENT:'github-hosted',HARMONY_PREVIEW_PAUSE_PUBLIC_REPOSITORY:'true',HARMONY_EXE_RELEASE:VERSION}))assert.equal(env[k],v);
 assert.equal(request.id,'1080p60');assert.equal(request.fps,60);
}
async function main(){
 const{session}=await import('./session.mjs'),{requestedProfile}=await import('./profiles.mjs');
 const{guard,cohort,identity,origin,mask,ownedSession,api}=await import('./lab.mjs');
 const{until}=await import('./cdp.mjs');const{assertOwnedCapture,assertCaptureMeasurement}=await import('./capture-ui.mjs');const{assertCallRoute}=await import('./fixture-contract.mjs');
 const request=requestedProfile(),result={kind:'exe_preview_pause',release:VERSION,completion:'RUNNING',capacity_approval:false,requested_profile:request,phases:[],restoration:{status:'NOT_RUN'},scope:'One immutable public EXE0410 and one owned native window; encoder OFF; same permanent source observer. Pause/play affects only the owned preview video. Not eight-client capacity or proof of GPU/compositor attribution.'};let app;
 try{
  guard();assertContext(process.env,process.platform,request);
  for(const k of ['HARMONY_GUILD_ID','HARMONY_GUILD_NAME','HARMONY_VOICE_ID','HARMONY_COHORT_USERS'])assert.ok(process.env[k]);
  assert.equal(process.env.HARMONY_GUILD_NAME,'EXE WAN '+cohort());const users=JSON.parse(process.env.HARMONY_COHORT_USERS);assert.equal(users.length,8);
  const manifest=JSON.parse(await readFile(new URL('./releases/0.4.10.json',import.meta.url),'utf8'));assert.equal(manifest.version,VERSION);assert.equal(manifest.main_sha256,MAIN_SHA);assert.equal(manifest.installer_sha256,INSTALLER_SHA);
  assert.equal(createHash('sha256').update(await readFile(process.env.HARMONY_EXE_PATH)).digest('hex'),MAIN_SHA);
  const token=await ownedSession(0),members=(await api(`/guilds/${process.env.HARMONY_GUILD_ID}/members`,token)).items;assert.equal(members.length,8);assert.ok(members.every(m=>users.some(u=>u.id===m.id)));
  const instance=await api('/instance'),call=await api(`/channels/${process.env.HARMONY_VOICE_ID}/call`,token);assertCallRoute(instance,call);
  app=await session(0);result.installed_sha256=MAIN_SHA;result.browser=app.attestation.browser.product;
  const who=identity(0);mask(who.password);await app.fill('input[type="url"]',origin);await app.fill('input[autocomplete="username"]',who.username);await app.fill('input[type="password"]',who.password);await app.click('Entrar no Harmony');await app.labelled('Abrir '+process.env.HARMONY_GUILD_NAME);await app.click('Sala de voz');
  app.cdp.setStage('call.ready');await until(()=>app.cdp.evaluate(`document.querySelector('.call-header small')?.textContent.trim().startsWith('Em chamada ·')`),'Owned normal call joined',60000);
  await app.labelled('Ligar microfone');await until(()=>app.cdp.evaluate(`__exeWan.microphones.some(t=>t.readyState==='live')`),'Owned microphone live');
  await app.click('Compartilhar tela');await app.select('Resolução',request.height);await app.select('Quadros por segundo',request.fps);await app.select('Bitrate por','manual');await app.fill('input[aria-label="Bitrate em megabits por segundo"]',String(request.bitrate_mbps));await app.select('Conteúdo','text');
  await app.cdp.evaluate(`(()=>{const c=document.querySelector('.check-field input[type="checkbox"]');if(c?.checked)c.click();return true})()`,true);
  const selection=await app.chooseScreen();await measurePreviewPhases(app,selection,request,result,{checkOwned:assertOwnedCapture,checkQuality:assertCaptureMeasurement});result.completion='COMPLETE';
 }catch{result.completion='NOT_VERIFIED';result.failure_code='DIAGNOSTIC_UNVERIFIED';result.failure_stage=app?.cdp.stage??'setup';}
 finally{if(app){try{app.close();result.cleanup='REQUESTED';}catch{result.cleanup='NOT_VERIFIED';result.completion='NOT_VERIFIED';}await writeFile(join(app.root,'preview-pause.json'),JSON.stringify(result,null,2)+'\n');}console.log('HARMONY_EXE_PREVIEW_PAUSE '+JSON.stringify(result));}
 if(result.completion!=='COMPLETE')process.exitCode=1;
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]||'')).href)await main();
