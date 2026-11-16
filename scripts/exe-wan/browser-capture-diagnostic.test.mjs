import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {installCaptureDiagnostic, diagnosticVariants, postFrameVariants, selectDiagnosticVariants, selectDiagnosticFixture, ownedResizeScript, ownedUiAutomationScript} from './browser-capture-diagnostic.mjs';
import {diagnosticFixtureProfile,diagnosticWindowScript} from './session.mjs';
import {getProfile} from './profiles.mjs';

test('phase selection defaults to historical plus post-frame variants and restricts post-frame to exactly its two experiments',()=>{
 assert.deepEqual(selectDiagnosticVariants(),[...diagnosticVariants,...postFrameVariants]);
 assert.deepEqual(selectDiagnosticVariants('full'),[...diagnosticVariants,...postFrameVariants]);
 assert.deepEqual(selectDiagnosticVariants('post-frame'),[...postFrameVariants]);
 for(const bad of ['',null,'post_frame','baseline','post-frame;whoami',true])assert.throws(()=>selectDiagnosticVariants(bad),/phase/);
});
test('small source explicitly selects only post-frame experiments and does not alter the normal profile',()=>{
 assert.equal(selectDiagnosticFixture(),undefined);assert.deepEqual(selectDiagnosticFixture('small640'),{width:640,height:360});
 assert.deepEqual(selectDiagnosticVariants('full','small640'),[...postFrameVariants]);
 for(const bad of ['',null,'640x360','native',false])assert.throws(()=>selectDiagnosticFixture(bad),/source size/);
 const profile=getProfile('720p30'),env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BersaneV/Harmony',RUNNER_ENVIRONMENT:'github-hosted',HARMONY_COHORT:'12345_1',HARMONY_EXE_WAN_SEED:'x'.repeat(40)};
 assert.equal(diagnosticFixtureProfile(0,'0.4.4',profile,undefined),profile);
 assert.deepEqual(diagnosticFixtureProfile(0,'0.4.4',profile,{width:640,height:360},env,'win32'),{...profile,width:640,height:360});
 for(const args of [[1,'0.4.4',profile,{width:640,height:360},env,'win32'],[0,'0.4.3',profile,{width:640,height:360},env,'win32'],[0,'0.4.4',getProfile('1080p60'),{width:640,height:360},env,'win32'],[0,'0.4.4',profile,{width:1280,height:720},env,'win32'],[0,'0.4.4',profile,{width:640,height:360},env,'darwin'],[0,'0.4.4',profile,{width:640,height:360},{...env,RUNNER_ENVIRONMENT:'self-hosted'},'win32']])assert.throws(()=>diagnosticFixtureProfile(...args));
 assert.equal(profile.width,1280);assert.equal(profile.height,720);
});
test('the private small fixture differs only in allowed ValidateSet values; original defaults and rendering remain byte-identical',()=>{
 const source=readFileSync(new URL('./window.ps1',import.meta.url),'utf8'),derived=diagnosticWindowScript(source);
 assert.equal(derived.replace('[ValidateSet(640,1280,1920,2560)]','[ValidateSet(1280,1920,2560)]').replace('[ValidateSet(360,720,1080,1440)]','[ValidateSet(720,1080,1440)]'),source);
 assert.match(derived,/\[int\]\$Width=1280/);assert.match(derived,/\[int\]\$Height=720/);
 assert.throws(()=>diagnosticWindowScript(source.replace('[ValidateSet(720,1080,1440)]','[ValidateSet(1,2)]')),/declaration/);
});
test('UI Automation diagnostic is bound to the installed executable tree and fixture without reading values or invoking controls',()=>{
 const script=ownedUiAutomationScript(42,'HarmonyWAN-12345');
 assert.match(script,/HARMONY_EXE_PATH/);assert.match(script,/EnumWindows/);assert.match(script,/TreeWalker/);assert.match(script,/ControlType\]::Edit/);
 for(const forbidden of ['ValuePattern','GetCurrentPattern','InvokePattern','SendMessage','SetForegroundWindow','SetValue','Invoke()'])assert.equal(script.includes(forbidden),false);
 for(const args of [[-1,'HarmonyWAN-12345'],[42,"HarmonyWAN-1';whoami"]])assert.throws(()=>ownedUiAutomationScript(...args));
});

function fixture({label='window:42:0',surface='window',audio=false}={}){
 const calls=[],applied=[];let stopped=0,now=123;
 const track={id:'compiled-track',label,readyState:'live',muted:false,enabled:true,getSettings:()=>({width:960,height:720,frameRate:30,displaySurface:surface,deviceId:'SECRET'}),getConstraints:()=>({height:{ideal:720,max:720},frameRate:{ideal:30,max:30},deviceId:'SECRET'}),getCapabilities:()=>({width:{min:1,max:8192},height:{min:1,max:8192},deviceId:'SECRET'}),applyConstraints:async c=>applied.push(c),stop(){this.readyState='ended';stopped++;}};
 const audioTrack={stop(){stopped++;}};
 const media={getDisplayMedia:async opts=>{calls.push(opts);return{getTracks:()=>audio?[track,audioTrack]:[track],getVideoTracks:()=>[track],getAudioTracks:()=>audio?[audioTrack]:[]};}};
 const original=media.getDisplayMedia;
 const window={__TAURI_INTERNALS__:{}};
 const video={videoWidth:960,videoHeight:540,readyState:2,srcObject:{getVideoTracks:()=>[track]}};
 const context={window,location:{origin:'http://tauri.localhost'},navigator:{mediaDevices:media},structuredClone,performance:{now:()=>now},document:{querySelectorAll:()=>[video]}};
 vm.runInNewContext(`(${installCaptureDiagnostic.toString()})()`,context);
 return{qa:window.__browserCaptureDiagnostic,media,track,calls,original,video,applied,advance:ms=>{now+=ms;},stopped:()=>stopped};
}
const options=()=>({video:{height:{ideal:720,max:720},frameRate:{ideal:30,max:30}},audio:false,selfBrowserSurface:'exclude',systemAudio:'include',surfaceSwitching:'include'});
for(const variant of diagnosticVariants)test(`GDM diagnostic ${variant} changes only its specified constraints and preserves the compiled options`,async()=>{
 const f=fixture(),input=options(),before=structuredClone(input);f.qa.configure(variant,42);
 const stream=await f.media.getDisplayMedia(input);assert.equal(stream.getVideoTracks()[0],f.track);assert.deepEqual(input,before);assert.equal(f.calls.length,1);
 const actual=f.calls[0],expected=options();
 if(variant==='width_max')expected.video.width={max:8192};
 if(variant==='width_ideal_max')expected.video.width={ideal:8192,max:8192};
 if(variant==='height_ideal_only')delete expected.video.height.max;
 assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected);
 const row=JSON.parse(JSON.stringify(f.qa.snapshot()))[0];assert.equal(row.initial.settings.width,960);assert.equal(row.current.settings.displaySurface,'window');assert.equal(JSON.stringify(row).includes('SECRET'),false);
 assert.throws(()=>f.qa.configure('baseline',42),/live capture/);assert.throws(()=>f.qa.restore(),/live capture/);
 f.track.stop();f.qa.restore();assert.equal(f.media.getDisplayMedia,f.original);
});
test('the wrapper never returns an unexpected HWND, desktop source or screen audio to the compiled UI',async()=>{
 for(const bad of [{label:'window:43:0'},{surface:'monitor'},{audio:true}]){
  const f=fixture(bad);f.qa.configure('baseline',42);await assert.rejects(f.media.getDisplayMedia(options()),/Owned browser source/);assert.ok(f.stopped()>=1);assert.equal(f.qa.snapshot()[0].error,'owned_source_mismatch');
 }
});
test('configuration and unsupported options fail before requesting any source',async()=>{
 const f=fixture();await assert.rejects(f.media.getDisplayMedia(options()),/configured/);
 for(const bad of ['unknown','native'])assert.throws(()=>f.qa.configure(bad,42),/variant/);
 for(const bad of [0,-1,NaN,'42'])assert.throws(()=>f.qa.configure('baseline',bad),/HWND/);
 f.qa.configure('baseline',42);await assert.rejects(f.media.getDisplayMedia({...options(),audio:true}),/audio disabled/);assert.equal(f.calls.length,0);
});
test('a pending capture cannot be reconfigured, restored or mistaken for an ended preview',async()=>{
 let resolveCapture;
 const media={getDisplayMedia:()=>new Promise(resolve=>{resolveCapture=resolve;})},window={__TAURI_INTERNALS__:{}};
 vm.runInNewContext(`(${installCaptureDiagnostic.toString()})()`,{window,location:{origin:'http://tauri.localhost'},navigator:{mediaDevices:media},structuredClone,performance:{now:()=>123}});
 const qa=window.__browserCaptureDiagnostic;qa.configure('baseline',42);const pending=media.getDisplayMedia(options());
 assert.equal(qa.snapshot()[0].pending,true);assert.throws(()=>qa.configure('width_max',42),/live capture/);assert.throws(()=>qa.restore(),/live capture/);
 const track={id:'actual',label:'window:42:0',readyState:'live',getSettings:()=>({displaySurface:'window'}),getConstraints:()=>({}),getCapabilities:()=>({})};
 resolveCapture({getVideoTracks:()=>[track],getAudioTracks:()=>[],getTracks:()=>[track]});await pending;assert.equal(qa.snapshot()[0].pending,false);
 track.readyState='ended';qa.restore();
});
for(const variant of postFrameVariants)test(`post-frame diagnostic ${variant} keeps baseline GDM and derives dimensions only from a current owned video`,async()=>{
 const f=fixture();f.qa.configure(variant,42);await f.media.getDisplayMedia(options());assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),options());
 await assert.rejects(f.qa.applyObservedConstraints(),/five seconds/);f.advance(5000);
 f.video.readyState=1;await assert.rejects(f.qa.applyObservedConstraints(),/current owned video/);assert.equal(f.applied.length,0);f.video.readyState=2;
 const value=await f.qa.applyObservedConstraints();
 const expected=variant==='post_frame_max'?{width:{max:1280},height:{max:720},frameRate:{max:30}}:{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{max:30}};
 assert.deepEqual(JSON.parse(JSON.stringify(f.applied[0])),expected);assert.equal(value.video_before.width,960);assert.equal(value.video_before.height,540);assert.equal(value.before.settings.height,720);
 await assert.rejects(f.qa.applyObservedConstraints(),/already applied/);
});
test('post-frame constraints reject another source binding and are forbidden for the four historical variants',async()=>{
 const f=fixture();f.qa.configure('post_frame_max',42);await f.media.getDisplayMedia(options());f.advance(5000);
 f.video.srcObject={getVideoTracks:()=>[{id:'another'}]};await assert.rejects(f.qa.applyObservedConstraints(),/current owned video/);assert.equal(f.applied.length,0);
 const baseline=fixture();baseline.qa.configure('baseline',42);await baseline.media.getDisplayMedia(options());baseline.advance(5000);await assert.rejects(baseline.qa.applyObservedConstraints(),/post-frame variant/);
});
test('native fixture resize accepts only the exact owned diagnostic handle, title and two authorized geometries',()=>{
 for(const size of [[640,360],[1280,720]]){const script=ownedResizeScript(42,...size,'HarmonyWAN-12345');assert.match(script,/SetWindowPos/);assert.match(script,/GetWindowRect/);assert.match(script,/DwmGetWindowAttribute/);assert.match(script,/GetWindowText/);assert.match(script,/SetThreadDpiAwarenessContext/);}
 assert.match(ownedResizeScript(42,640,360,'HarmonyWAN-12345',false),/Resize\(42,640,360,'HarmonyWAN-12345',\$false\)/);
 for(const args of [[0,640,360,'HarmonyWAN-12345'],[42,641,360,'HarmonyWAN-12345'],[42,1280,720,"HarmonyWAN-1';whoami"],[42,1920,1080,'HarmonyWAN-12345']])assert.throws(()=>ownedResizeScript(...args));
});
