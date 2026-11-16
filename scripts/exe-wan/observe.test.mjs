import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {observe} from './observe.mjs';
import {assertCaptureMeasurement} from './capture-ui.mjs';
const source=`(${observe.toString()})()`;
function fixture(){
 let now=0,clones=0,processors=0,pixelCopies=0,handleClones=0,closedHandles=0;
 const handlers=new Map(),timers=new Map();let serial=0;const readers=[];
 const track={id:'capture',kind:'video',label:'',readyState:'live',getSettings:()=>({width:2560,height:1440}),clone(){clones++;return{...this,stop(){}};}};
 class Processor{constructor(){processors++;let next;const reader={read:()=>new Promise(resolve=>{next=resolve;}),cancel:async()=>{next?.({done:true});},releaseLock(){},emit(frame){assert.ok(next,'source reader must request next frame');const resolve=next;next=null;resolve({done:false,value:frame});}};readers.push(reader);this.readable={getReader:()=>reader};}}
 const rgba=new Proxy({}, {get(_t,index){return [230,40,10,255][Number(index)%4];}}),draws=[];
 class Canvas{getContext(){return {drawImage:(...args)=>draws.push(args),getImageData:()=>({data:rgba})};}}
 const context={location:{origin:'http://tauri.localhost'},performance:{now:()=>now},document:{querySelectorAll:()=>[]},navigator:{mediaDevices:{getUserMedia:async()=>({getAudioTracks:()=>[]}),getDisplayMedia:async()=>({getVideoTracks:()=>[],getAudioTracks:()=>[]})}},MediaStreamTrackProcessor:Processor,OffscreenCanvas:Canvas,setInterval:()=>999,clearInterval(){},setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),window:{__TAURI_INTERNALS__:{},RTCPeerConnection:class{},addEventListener:(name,fn)=>handlers.set(name,fn)}};
 vm.runInNewContext(source,context);
 handlers.get('harmony-native-screen')({detail:{track,label:'native-window:42',backend:'native-wgc',settings:()=>({width:2560,height:1440,frameRate:60})}});
 const qa=context.window.__exeWan;
 const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
 async function frame(marker,fail=false){const value={format:'BGRX',displayWidth:2560,displayHeight:1440,async copyTo(pixel){pixelCopies++;now+=1;if(fail)throw Error('copy failed');pixel[0]=marker;pixel[1]=30;pixel[2]=10;},clone(){handleClones++;return{...this,close(){closedHandles++;}};},close(){}};for(const reader of readers)reader.emit(value);await settle();}
 async function end(at){now=at;for(const[id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}await settle();}
 return{qa,track,frame,end,settle,draws,counts:()=>({clones,processors,pixelCopies,handleClones,closedHandles}),read:()=>qa.captureSnapshots()[0]};
}
test('native preflight reuses the permanent reader and counters; one full frame clone only after the timed window',async()=>{
 const f=fixture();await f.frame(0);const measuring=f.qa.measureCapture(0,1000);assert.equal(f.counts().processors,1);assert.equal(f.counts().clones,1);
 for(let i=1;i<=60;i++)await f.frame(i);assert.equal(f.counts().handleClones,0);await f.end(1001);assert.equal(f.counts().processors,1);assert.equal(f.counts().handleClones,0);
 await f.frame(61);const measured=await measuring;
 assert.equal(measured.processor_frames,60);assert.equal(measured.distinct_marker_frames,60);assert.equal(measured.processor_source_fps,60);assert.equal(measured.distinct_marker_fps,60);
 assert.equal(measured.marker_copy_calls_delta,60);assert.equal(measured.marker_copy_total_ms_delta,60);assert.equal(measured.marker_copy_max_ms,1);assert.deepEqual(Array.from(measured.processor_formats),['BGRX']);
 assert.equal(measured.pixel_width,2560);assert.equal(measured.pixel_height,1440);assert.equal(measured.colored_pixels,14400);assert.equal(measured.light_pixels,14400);assert.deepEqual(f.draws[0].slice(1),[0,0,2560,1440]);
 assert.equal(f.counts().pixelCopies,62);assert.equal(f.counts().handleClones,1);assert.equal(f.counts().closedHandles,1);assertCaptureMeasurement(measured,{width:2560,height:1440,fps:60,min_source_fps:54},'native');
});
test('unchanged content still fails the unchanged distinct marker FPS gate',async()=>{
 const f=fixture();await f.frame(7);const measuring=f.qa.measureCapture(0,1000);
 for(let i=0;i<60;i++)await f.frame(7);await f.end(1001);await f.frame(7);const measured=await measuring;
 assert.equal(measured.processor_frames,60);assert.equal(measured.distinct_marker_frames,0);
 assert.throws(()=>assertCaptureMeasurement(measured,{width:2560,height:1440,fps:60,min_source_fps:54},'native'),/marker/);
});
test('observer copy failure remains visible and prevents capture measurement',async()=>{
 const f=fixture();await f.frame(1,true);assert.equal(f.read().processor_status,'error');assert.equal(f.read().marker_copy_errors,1);assert.equal(f.read().marker_copy_calls,1);assert.match(f.read().processor_error,/copy failed/);
 await assert.rejects(f.qa.measureCapture(0,1000),/permanent/);
});
test('a source that stops after the counter window rejects the bounded one-frame inspection',async()=>{
 const f=fixture();await f.frame(0);const measuring=f.qa.measureCapture(0,1000),rejected=assert.rejects(measuring,/inspection timed out/);
 await f.end(1001);await f.end(4001);await rejected;
});
