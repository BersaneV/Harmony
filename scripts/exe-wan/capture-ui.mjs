// Harness boundary: compiled UI actions plus passive observation, never product imports.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {until} from './cdp.mjs';

export function captureMode(release='0.4.1',profile){
 assert.ok(['0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.4.7','0.4.8','0.4.9','0.4.10'].includes(release),'Unsupported pinned capture release');
 return ['0.4.7','0.4.8','0.4.9','0.4.10'].includes(release)&&[15,24,30,60].includes(profile.fps)||['0.4.3','0.4.4','0.4.5','0.4.6'].includes(release)&&profile.fps===60?'native':'browser';
}
export const fixtureScript=(release,profile)=>captureMode(release,profile)==='native'?'window-layered.ps1':'window.ps1';

export function fixtureReady(output,profile,mode){
 assert.ok(['native','browser'].includes(mode),'Explicit fixture mode required');
 return new RegExp(`(?:^|\\r?\\n)WINDOW [0-9]+ ${profile.width}x${profile.height} TARGET ${profile.fps}${mode==='native'?' SOURCE native-layered-dib LIFETIME_SECONDS 600':''}(?:\\r?\\n|$)`).test(output);
}

export function assertOwnedCapture(capture,handle,profile,mode){
 assert.ok(Number.isSafeInteger(handle)&&handle>0,'Owned fixture HWND required');
 assert.equal(capture.ready,'live');
 assert.equal(capture.kind,mode);
 if(mode==='native'){
  assert.equal(capture.backend,'native-wgc','Only the real WGC bridge is accepted');
  assert.equal(capture.label,`native-window:${handle}`,'Only the owned native capture item is accepted');
  assert.equal(capture.settings_source,'native-frame-metadata');
 }else{
  assert.equal(capture.settings.displaySurface,'window');
  assert.equal(capture.label,`window:${handle}:0`,'Only the owned browser capture HWND is accepted');
 }
 assert.equal(capture.settings.width,profile.width);
 assert.equal(capture.settings.height,profile.height);
}

export function assertCaptureMeasurement(value,profile,mode){
 assert.equal(value.pixel_width,profile.width,'Pixel inspection must cover the complete native width');
 assert.equal(value.pixel_height,profile.height,'Pixel inspection must cover the complete native height');
 assert.ok(value.sampled_sizes.length&&value.sampled_sizes.every(s=>s===`${profile.width}x${profile.height}`),'Every observed source frame must preserve requested dimensions');
 const threshold=profile.fps===60?13680:5000;
 assert.ok(value.light_pixels>threshold&&value.colored_pixels>threshold,'Capture must contain the full generated frame');
 const fps=mode==='native'?value.processor_source_fps:value.processor_source_fps??value.measured_fps;
 assert.ok(Number.isFinite(fps)&&fps>=profile.min_source_fps,'Observed source frame rate is below the unchanged profile gate');
 if(mode==='native')assert.ok(Number.isFinite(value.distinct_marker_fps)&&value.distinct_marker_fps>=profile.min_source_fps,'Native source marker must advance at the unchanged source FPS gate');
}

export function summarizeNativeSource(samples,profile){
 const steady=samples.filter(s=>s.segment==='steady').map(s=>s.sample);
 const records=steady.map(s=>({at:s.at,captures:s.captures?.filter(c=>c.kind==='native'&&c.ready==='live')||[]}));
 const captures=records.map(s=>s.captures[0]),first=records[0],last=records.at(-1);
 const duration=first&&last?(last.at-first.at)/1000:0;
 const frames=captures.length&&Number.isSafeInteger(captures[0]?.processor_frames)&&Number.isSafeInteger(captures.at(-1)?.processor_frames)?captures.at(-1).processor_frames-captures[0].processor_frames:null;
 const fps=frames!==null&&duration>0?frames/duration:null;
 const distinct=captures.length&&Number.isSafeInteger(captures[0]?.distinct_marker_frames)&&Number.isSafeInteger(captures.at(-1)?.distinct_marker_frames)?captures.at(-1).distinct_marker_frames-captures[0].distinct_marker_frames:null;
 const distinctFps=distinct!==null&&duration>0?distinct/duration:null;
 const dimensions=[...new Set(captures.flatMap(c=>c?.processor_sizes||[]))];
 const healthy=records.length>=2&&records.every(r=>r.captures.length===1)&&captures.every((c,index)=>c?.backend==='native-wgc'&&c.processor_status==='running'&&!c.processor_error&&c.marker_copy_errors===0&&c.track_id===captures[0]?.track_id&&Number.isSafeInteger(c.processor_frames)&&c.processor_frames>=0&&Number.isSafeInteger(c.distinct_marker_frames)&&c.distinct_marker_frames>=0&&c.distinct_marker_frames<=c.processor_frames&&(!index||c.processor_frames>=captures[index-1]?.processor_frames&&c.distinct_marker_frames>=captures[index-1]?.distinct_marker_frames)&&c.processor_sizes?.length===1&&c.settings?.width===profile.width&&c.settings?.height===profile.height)&&dimensions.length===1&&dimensions[0]===`${profile.width}x${profile.height}`&&frames>=0&&Number.isFinite(fps)&&fps>=profile.min_source_fps&&Number.isFinite(distinctFps)&&distinctFps>=profile.min_source_fps&&duration>=180;
 return{status:healthy?'PASS':'FAIL',scope:'Passive MediaStreamTrackProcessor clone of the compiled app native track, including sustained distinct marker content',duration_seconds:duration,processor_frames:frames,source_fps:fps,distinct_marker_frames:distinct,distinct_marker_fps:distinctFps,sampled_sizes:dimensions,observer_overhead:'One native-track clone and one 1px RGBA copy per delivered frame can add overhead; there is no source replacement or geometry adjustment.'};
}

function confirmNative(title){
 const result=spawnSync('powershell.exe',['-NoProfile','-File',resolve('scripts/exe-wan/native-consent.ps1'),'-Title',title],{encoding:'utf8',timeout:50000});
 assert.equal(result.status,0,'Owned native confirmation failed: '+((result.stdout||'').slice(-2000)+' '+(result.stderr||'').slice(-500)));
 return{status:result.status,message:(result.stdout||'').trim()};
}

export async function chooseScreenUi(app,profile,{release=process.env.HARMONY_EXE_RELEASE||'0.4.1',title='HarmonyWAN-'+process.env.GITHUB_RUN_ID,confirm=confirmNative,wait=until}={}){
 assert.match(title,/^HarmonyWAN-[0-9]+$/,'Exact disposable fixture title required');
 const mode=captureMode(release,profile);
 app.cdp.setStage?.('capture.fixture');
 await app.ensureFixture();
 if(mode==='native'){
  app.cdp.setStage?.('capture.method.detect');
  await wait(()=>app.cdp.evaluate(`Array.from(document.querySelectorAll('label.field')).some(l=>l.querySelector('span')?.textContent==='Método de captura')`),'compiled native capture method');
  await app.select('Método de captura','auto');
 }else if(['0.4.3','0.4.4','0.4.5','0.4.6','0.4.7','0.4.8','0.4.9','0.4.10'].includes(release)){
  app.cdp.setStage?.('capture.method.detect');
  const method=await app.cdp.evaluate(`Array.from(document.querySelectorAll('label.field')).some(l=>l.querySelector('span')?.textContent==='Método de captura')`);
  if(method)await app.select('Método de captura','browser');
 }
 await app.click('Escolher tela ou janela');
 let confirmation=null;
 if(mode==='native'){
  app.cdp.setStage?.('capture.native_picker.wait');
  await wait(()=>app.cdp.evaluate(`Array.from(document.querySelectorAll('dialog[open]')).some(d=>d.querySelector('h2')?.textContent==='Escolher janela do Windows'&&Array.from(d.querySelectorAll('option')).filter(o=>o.textContent.trim()===${JSON.stringify(title)}).length===1)`),'exact owned option in compiled native picker',30000);
  app.cdp.setStage?.('capture.native_picker.select');await app.cdp.evaluate(`(()=>{const d=Array.from(document.querySelectorAll('dialog[open]')).find(d=>d.querySelector('h2')?.textContent==='Escolher janela do Windows');const s=d?.querySelector('select');const options=s&&Array.from(s.options).filter(o=>o.textContent.trim()===${JSON.stringify(title)});if(!s||options.length!==1)throw Error('Exact owned source missing or ambiguous');s.value=options[0].value;s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,true);
  await app.click('Confirmar janela');
  app.cdp.setStage?.('capture.native_consent');confirmation=await confirm(title);
 }
 app.cdp.setStage?.('capture.preview.wait');
 await wait(()=>app.cdp.evaluate(`(()=>{const v=document.querySelector('.share-preview video');return !!v&&v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0})()&&__exeWan.captureSnapshots().some(c=>c.ready==='live'&&c.kind===${JSON.stringify(mode)})`),'compiled preview with current frame and observed real capture track',60000);
 app.cdp.setStage?.('capture.snapshot');const captures=await app.cdp.evaluate(`__exeWan.captureSnapshots().filter(c=>c.ready==='live')`);
 assert.equal(captures.length,1,'Exactly one live owned preview source required');
 app.cdp.setStage?.('capture.owner');const handle=await app.ownedWindow();
 assertOwnedCapture(captures[0],handle,profile,mode);
 return{mode,captures,owned_window_handle:handle,confirmation};
}
