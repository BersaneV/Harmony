import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installCaptureDiagnostic, diagnosticVariants} from './browser-capture-diagnostic.mjs';

function fixture({label='window:42:0',surface='window',audio=false}={}){
 const calls=[];let stopped=0;
 const track={id:'compiled-track',label,readyState:'live',muted:false,enabled:true,getSettings:()=>({width:960,height:720,frameRate:30,displaySurface:surface,deviceId:'SECRET'}),getConstraints:()=>({height:{ideal:720,max:720},frameRate:{ideal:30,max:30},deviceId:'SECRET'}),getCapabilities:()=>({width:{min:1,max:8192},height:{min:1,max:8192},deviceId:'SECRET'}),stop(){this.readyState='ended';stopped++;}};
 const audioTrack={stop(){stopped++;}};
 const media={getDisplayMedia:async opts=>{calls.push(opts);return{getTracks:()=>audio?[track,audioTrack]:[track],getVideoTracks:()=>[track],getAudioTracks:()=>audio?[audioTrack]:[]};}};
 const original=media.getDisplayMedia;
 const window={__TAURI_INTERNALS__:{}};
 const context={window,location:{origin:'http://tauri.localhost'},navigator:{mediaDevices:media},structuredClone,performance:{now:()=>123},document:{querySelectorAll:()=>[]}};
 vm.runInNewContext(`(${installCaptureDiagnostic.toString()})()`,context);
 return{qa:window.__browserCaptureDiagnostic,media,track,calls,original,stopped:()=>stopped};
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
