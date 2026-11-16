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

{

const clean=value=>JSON.parse(JSON.stringify(value));
const source=patch=>({id:'SV7',type:'media-source',kind:'video',trackIdentifier:'capture-7',timestamp:1234.5,width:2560,height:1440,frames:600,framesPerSecond:59.8,...patch});
const outbound=patch=>({id:'OUT7',type:'outbound-rtp',kind:'video',mediaSourceId:'SV7',codecId:'VP8',timestamp:1234.5,framesEncoded:599,totalEncodeTime:9,contentType:'screenshare',...patch});
async function sample(rows,implementation=observe){
 let calls=0;
 const track={id:'capture-7',kind:'video',readyState:'live',contentHint:'motion',getSettings:()=>({width:2560,height:1440})};
 const stats=[{id:'VP8',type:'codec',mimeType:'video/VP8'},...rows];
 for(const row of stats)Object.freeze(row);
 class Peer{
  constructor(){this.connectionState='connected';this.localDescription={sdp:'m=video 9 UDP/TLS/RTP/SAVPF 96\r\n'};}
  addEventListener(){}
  getTransceivers(){return[{mid:'0',receiver:{track:{id:'remote-video',kind:'video'}},sender:{track,getParameters:()=>({encodings:[{active:true,maxBitrate:16000000}]})}}];}
  async getStats(){calls++;return new Map(stats.map(row=>[row.id,row]));}
 }
 const context={location:{origin:'http://tauri.localhost'},performance:{now:()=>1000},document:{querySelectorAll:()=>[]},navigator:{mediaDevices:{getUserMedia:async()=>({getAudioTracks:()=>[]}),getDisplayMedia:async()=>({getVideoTracks:()=>[],getAudioTracks:()=>[]})}},window:{__TAURI_INTERNALS__:{},RTCPeerConnection:Peer,addEventListener(){}},setInterval(){throw Error('No new observer timer expected');},setTimeout(){throw Error('No new observer timer expected');}};
 vm.runInNewContext(`(${implementation.toString()})()`,context);
 const qa=context.window.__exeWan;
 qa.captures.push({kind:'native',track,getSettings:track.getSettings});
 new context.window.RTCPeerConnection();
 const value=await qa.sample();assert.equal(calls,1,'existing report only, no second getStats');
 return clean(value.peers[0].rtp);
}

test('real observer projects only official content types and the exactly linked local video source',async()=>{
 for(const contentType of ['screenshare','unspecified']){
  const [r]=await sample([outbound({contentType}),source({secret:'DO_NOT_PROJECT',deviceId:'DO_NOT_PROJECT'})]);
  assert.equal(r.content_type,contentType);
  assert.deepEqual(r.media_source,{stats_id:'SV7',kind:'video',track_id:'capture-7',timestamp:1234.5,framesPerSecond:59.8,width:2560,height:1440,frames:600});
  assert.equal(r.framesEncoded,599);assert.equal(r.totalEncodeTime,9);
  assert.ok(!JSON.stringify(r).includes('DO_NOT_PROJECT'));
 }
});
test('missing content type remains absent and no unrelated media source is substituted',async()=>{
 const r=outbound();delete r.contentType;delete r.mediaSourceId;
 const [projected]=await sample([r,source()]);assert.ok(!('content_type'in projected));assert.ok(!('media_source'in projected));
 for(const mediaSourceId of ['missing',null,42,false,'SV7?token=SECRET','SV7\n','á'.repeat(5),'x'.repeat(129)]){
  const [row]=await sample([outbound({mediaSourceId}),source()]);assert.ok(!('media_source'in row));
 }
});
test('invalid and oversized content type values cannot become a classification by coercion',async()=>{
 for(const contentType of [undefined,null,false,7,{},new String('screenshare'),'SCREENSHARE','screenshare ',' screenshare','camera','x'.repeat(10000)]){
  const [r]=await sample([outbound({contentType}),source()]);assert.ok(!('content_type'in r));
 }
});
test('media source requires a local matching ID, media-source type and video kind',async()=>{
 for(const patch of [{type:'inbound-rtp'},{type:undefined},{kind:'audio'},{kind:undefined},{kind:'VIDEO'}]){
  const [r]=await sample([outbound(),source(patch)]);assert.ok(!('media_source'in r));
 }
 for(const id of ['x'.repeat(128),'SV7:._-']){
  const [r]=await sample([outbound({mediaSourceId:id}),source({id})]);assert.equal(r.media_source.stats_id,id);
 }
});
test('invalid video counters and identifiers are omitted independently; observed zero is retained',async()=>{
 for(const value of [undefined,null,true,'600',NaN,Infinity,-Infinity,-1,1.5,2**32]){
  const [r]=await sample([outbound(),source({width:value,height:value,frames:value})]);
  for(const key of ['width','height','frames'])assert.ok(!(key in r.media_source));
 }
 for(const value of [undefined,null,true,'0',NaN,Infinity,-Infinity,-1]){
  const [r]=await sample([outbound(),source({timestamp:value,framesPerSecond:value,trackIdentifier:'SECRET?token=value'})]);
  for(const key of ['timestamp','framesPerSecond','track_id'])assert.ok(!(key in r.media_source));
 }
 const [r]=await sample([outbound(),source({width:0,height:0,frames:0,timestamp:0,framesPerSecond:0})]);
 assert.deepEqual(r.media_source,{stats_id:'SV7',kind:'video',track_id:'capture-7',timestamp:0,framesPerSecond:0,width:0,height:0,frames:0});
});
// Literal serialized outputs independently captured from baseline edf9ee1b4584ba780aa4262b54e35827e5a6c64c9bbb02b4ec790d1359060f73.
// Legacy audio NaN/Infinity intentionally remain null after the existing JSON serialization.
test('audio projection remains byte-for-byte equivalent to the frozen observer, without content type',async()=>{
 const rows=[{id:'OUTA',type:'outbound-rtp',kind:'audio',codecId:'OPUS',mediaSourceId:'SA',contentType:'screenshare',totalAudioEnergy:2,totalSamplesDuration:10,bytesSent:1234},{id:'SA',type:'media-source',kind:'audio',timestamp:1234.5,totalAudioEnergy:2,totalSamplesDuration:10},{id:'OPUS',type:'codec',mimeType:'audio/opus'}];
 assert.deepEqual(await sample(rows),[
  {
    "route": "sfu",
    "direction": "outbound",
    "source": "unknown_audio",
    "kind": "audio",
    "track_id": null,
    "codec": "audio/opus",
    "stats_id": "OUTA",
    "bytesSent": 1234,
    "totalAudioEnergy": 2,
    "totalSamplesDuration": 10,
    "media_source": {
      "timestamp": 1234.5,
      "totalAudioEnergy": 2,
      "totalSamplesDuration": 10
    }
  }
]);
 assert.ok(!('content_type'in (await sample(rows))[0]));
 const legacyInvalid=[rows[0],{...rows[1],timestamp:NaN,totalAudioEnergy:Infinity,totalSamplesDuration:-1},rows[2]];
 assert.deepEqual(await sample(legacyInvalid),[
  {
    "route": "sfu",
    "direction": "outbound",
    "source": "unknown_audio",
    "kind": "audio",
    "track_id": null,
    "codec": "audio/opus",
    "stats_id": "OUTA",
    "bytesSent": 1234,
    "totalAudioEnergy": 2,
    "totalSamplesDuration": 10,
    "media_source": {
      "timestamp": null,
      "totalAudioEnergy": null,
      "totalSamplesDuration": -1
    }
  }
]);
});
test('inbound video and unlinked audio preserve their original projection',async()=>{
 const rows=[{...outbound(),type:'inbound-rtp',bytesReceived:1234},source(),{id:'OUTA',type:'outbound-rtp',kind:'audio',contentType:'screenshare',bytesSent:12}];
 assert.deepEqual(await sample(rows),[
  {
    "route": "sfu",
    "direction": "inbound",
    "source": "unknown_video",
    "kind": "video",
    "track_id": "capture-7",
    "codec": "video/VP8",
    "stats_id": "OUT7",
    "timestamp": 1234.5,
    "bytesReceived": 1234,
    "framesEncoded": 599,
    "totalEncodeTime": 9,
    "media_source": {
      "timestamp": 1234.5,
      "width": 2560,
      "height": 1440,
      "frames": 600,
      "framesPerSecond": 59.8
    }
  },
  {
    "route": "sfu",
    "direction": "outbound",
    "source": "unknown_audio",
    "kind": "audio",
    "track_id": null,
    "codec": null,
    "stats_id": "OUTA",
    "bytesSent": 12
  }
]);
});

}
