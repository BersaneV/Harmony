// Pinned desktop probe: the compiled application's normal authenticated UI creates media.
// This module never invokes native capture IPC or imports application TS through CDP.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {session} from './session.mjs';
import {requestedProfile} from './profiles.mjs';
import {guard,cohort,identity,origin,mask,ownedSession,api} from './lab.mjs';
import {until} from './cdp.mjs';
import {assertCaptureMeasurement} from './capture-ui.mjs';
import {assertCallRoute} from './fixture-contract.mjs';

const request=requestedProfile();let app;
const result={kind:'exe_probe',status:'RUNNING',scope:'One pinned published EXE on one disposable VM; normal compiled login/call/preview UI and an owned native Windows source. This is not eight-peer capacity approval.',requested_profile:request,instrumentation:'Passive application capture event and clones of actual application tracks; no injected capture or sender changes'};
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
 app=await session(0);result.attestation=app.attestation;result.installed_sha256=executableHash;
 const who=identity(0);mask(who.password);
 await app.fill('input[type="url"]',origin);await app.fill('input[autocomplete="username"]',who.username);await app.fill('input[type="password"]',who.password);await app.click('Entrar no Harmony');
 await app.labelled('Abrir '+process.env.HARMONY_GUILD_NAME);await app.click('Sala de voz');
 await until(()=>app.cdp.evaluate(`document.querySelector('.call-header small')?.textContent.trim().startsWith('Em chamada ·')`),'compiled normal call joined',60000);
 await app.labelled('Ligar microfone');
 await until(()=>app.cdp.evaluate(`__exeWan.microphones.some(t=>t.readyState==='live')`),'compiled UI microphone track');
 result.fake_audio=await app.cdp.evaluate('__exeWan.measureMicrophone()');assert.ok(result.fake_audio.rms>0.03,'Generated compiled microphone must carry energy');
 await app.click('Compartilhar tela');await app.select('Resolução',request.height);await app.select('Quadros por segundo',request.fps);
 await app.select('Bitrate por','manual');await app.fill('input[aria-label="Bitrate em megabits por segundo"]',String(request.bitrate_mbps));await app.select('Conteúdo','motion');
 await app.cdp.evaluate(`(()=>{const e=document.querySelector('.check-field input[type="checkbox"]');if(e?.checked)e.click();return true})()`,true);
 result.capture_selection=await app.chooseScreen();result.owned_window_handle=result.capture_selection.owned_window_handle;
 result.capture=await app.measureCapture(result.capture_selection.captures[0].index);
 assertCaptureMeasurement(result.capture,request,result.capture_selection.mode);
 result.status='PASS';
}catch(error){
 result.status='FAIL';result.error=String(error.message).slice(0,700);
 if(app)try{result.final_sample=await app.sample();result.visible_errors=await app.cdp.evaluate(`Array.from(document.querySelectorAll('.error-banner,[role=alert]')).map(e=>e.textContent.slice(0,300))`);result.visible_capture_ui=await app.cdp.evaluate(`({panel:document.querySelector('.call-panel')?.innerText.slice(-4500),buttons:Array.from(document.querySelectorAll('.call-panel button')).map(b=>({text:b.textContent.trim(),disabled:b.disabled})),dialogs:Array.from(document.querySelectorAll('dialog[open]')).map(d=>d.innerText.slice(0,1500))})`);}catch{}
}finally{
 if(app){result.fixture_diagnostic=app.fixtureDiagnostic();try{app.close();}catch{result.cleanup_policy='FAIL';result.status='FAIL';}await writeFile(join(app.root,'probe.json'),JSON.stringify(result,null,2)+'\n');}
 console.log('HARMONY_EXE_PROBE '+JSON.stringify(result));
}
if(result.status!=='PASS')process.exitCode=1;
