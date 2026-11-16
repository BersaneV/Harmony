import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {summarize,screenReady,screenRouteSummary} from './metrics.mjs';
import {getProfile} from './profiles.mjs';import {observe} from './observe.mjs';
const profile=getProfile('1440p60');
function sample(at,index=1,fps=54){
 const peers=Array.from({length:7},(_,i)=>({pc:i,route:'p2p',state:'connected',local_fingerprint:'local'+i,remote_fingerprint:'remote'+i,local_candidate:{type:'srflx',protocol:'udp'},remote_candidate:{type:'srflx'},ice_rtt_ms:40,tracks:[],rtp:[{direction:'inbound',kind:'audio',source:'microphone',codec:'audio/opus',bytesReceived:1000+at,packetsReceived:100+at,packetsLost:0,totalSamplesDuration:at/1000,totalSamplesReceived:at*48,concealedSamples:0,totalAudioEnergy:at/1000*.04},{direction:'outbound',kind:'video',source:'screen',sender_active:false,bytesSent:1000}]}));
 const direction=index===0?'outbound':'inbound';
 peers.push({pc:7,route:'sfu',state:'connected',local_fingerprint:'client-sfu',remote_fingerprint:'server-sfu',local_candidate:{type:'host',protocol:'udp'},remote_candidate:{type:'host'},ice_rtt_ms:20,tracks:index===0?[]:[{source:'screen',kind:'video',ready:'live',video:{width:2560,height:1440,total_frames:at/1000*fps,dropped_frames:0}}],rtp:[{direction,kind:'video',source:'screen',codec:'video/VP8',sender_active:index===0,bytesSent:index===0?1000+at:undefined,bytesReceived:index!==0?1000+at:undefined,packetsReceived:100+at,packetsLost:0,frameWidth:2560,frameHeight:1440,framesDecoded:at/1000*fps,freezeCount:0,totalFreezesDuration:0}]});
 return{segment:'steady',sample:{at,peers}};
}
test('SFU receiver keeps seven direct voice connections and one separate real screen stream',()=>{
 const rows=[sample(1000),sample(181000)],result=summarize(rows,1,'screen',profile,{screenSfu:true});
 assert.equal(result.status,'PASS');assert.equal(result.peers.length,7);assert.equal(result.peers.flatMap(p=>p.streams.filter(s=>s.source==='microphone')).length,7);assert.equal(result.sfu_peers.length,1);assert.equal(result.sfu_peers[0].streams[0].source,'screen');assert.equal(result.screen_route.sfu_certificates.length,2);
});
test('SFU microphone or unknown SDK audio cannot be renamed to screen audio or counted among direct microphones',()=>{
 for(const source of ['microphone','unknown_audio','screen_audio']){
  const rows=[sample(1000),sample(181000)];for(const r of rows)r.sample.peers.at(-1).rtp.push({direction:'inbound',kind:'audio',source,codec:'audio/opus',bytesReceived:500});
  const result=summarize(rows,1,'screen',profile,{screenSfu:true});assert.equal(result.voice_status,'FAIL');assert.equal(result.status,'FAIL');assert.equal(result.peers.length,7);
 }
});
test('unidentified SDK video and an unexpected relay on a declared mesh run fail closed',()=>{
 const rows=[sample(1000),sample(181000)];rows[1].sample.peers.at(-1).rtp[0].source='unknown_video';
 assert.equal(summarize(rows,1,'screen',profile,{screenSfu:true}).status,'FAIL');
 assert.equal(summarize([sample(1000),sample(181000)],1,'screen',profile,{screenSfu:false}).status,'FAIL');
});
test('SFU retains exact dimensions, 54 displayed FPS and zero freeze gates',()=>{
 for(const mutate of [rows=>rows[1].sample.peers.at(-1).rtp[0].freezeCount=1,rows=>rows[1].sample.peers.at(-1).rtp[0].totalFreezesDuration=.01,rows=>rows[1].sample.peers.at(-1).tracks[0].video.width=1280,rows=>rows[1].sample.peers.at(-1).state='disconnected',rows=>rows[1].sample.peers.at(-1).tracks[0].ready='ended']){const rows=[sample(1000),sample(181000)];mutate(rows);assert.equal(summarize(rows,1,'screen',profile,{screenSfu:true}).status,'FAIL');}
 assert.equal(summarize([sample(1000,1,53.9),sample(181000,1,53.9)],1,'screen',profile,{screenSfu:true}).status,'FAIL');
});
test('optimized publisher requires one SFU sender and zero live mesh screen senders despite stale mesh byte counters',()=>{
 const rows=[sample(1000,0),sample(181000,0)];assert.equal(screenReady(rows[0].sample,0,true),true);assert.equal(screenRouteSummary(rows,0,true).status,'PASS');
 for(const change of [p=>p[0].rtp[1].sender_active=true,p=>p.at(-1).rtp[0].sender_active=false,p=>p.push({...p.at(-1),pc:8})]){const changed=[sample(1000,0),sample(181000,0)];change(changed[1].sample.peers);assert.equal(screenRouteSummary(changed,0,true).status,'FAIL');}
});
test('SDK mid zero is classified from real sender identity or UI receiver binding, never as a mesh microphone',async()=>{
 const handlers=new Map(),videos=[];class Track{constructor(id,kind){this.id=id;this.kind=kind;this.readyState='live';this.muted=false;this.label='';}getSettings(){return{};}}
 const source=new Track('native-source','video'),receiver=new Track('sdk-receiver','video'),audio=new Track('sdk-audio','audio');
 class Peer{
  constructor(){this.connectionState='connected';this.localDescription={sdp:'m=video 9 UDP/TLS/RTP/SAVPF 96\r\n'};this.transceivers=[{mid:'0',receiver:{track:receiver},sender:{track:source,getParameters:()=>({encodings:[{active:true}],codecs:[]})}}];this.events=new Map();}
  addEventListener(n,f){this.events.set(n,f);}getTransceivers(){return this.transceivers;}
  async getStats(){return new Map([['codec',{id:'codec',type:'codec',mimeType:'video/VP8'}],['src',{id:'src',type:'media-source',trackIdentifier:source.id}],['out',{id:'out',type:'outbound-rtp',kind:'video',mid:'0',codecId:'codec',mediaSourceId:'src',bytesSent:100}],['in',{id:'in',type:'inbound-rtp',kind:'video',mid:'0',trackIdentifier:receiver.id,codecId:'codec',bytesReceived:100}],['audioCodec',{id:'audioCodec',type:'codec',mimeType:'audio/opus'}],['a',{id:'a',type:'inbound-rtp',kind:'audio',mid:'1',trackIdentifier:audio.id,codecId:'audioCodec',bytesReceived:500}]]);}
 }
 const context={location:{origin:'http://tauri.localhost'},performance:{now:()=>1000},document:{querySelectorAll:()=>videos},navigator:{mediaDevices:{getUserMedia:async()=>({getAudioTracks:()=>[]}),getDisplayMedia:async()=>({getVideoTracks:()=>[],getAudioTracks:()=>[]})}},window:{__TAURI_INTERNALS__:{},RTCPeerConnection:Peer,addEventListener:(n,f)=>handlers.set(n,f)}};
 vm.runInNewContext(`(${observe.toString()})()`,context);
 handlers.get('harmony-native-screen')({detail:{track:source,label:'native-window:42',backend:'native-wgc',settings:()=>({width:2560,height:1440})}});
 const pc=new context.window.RTCPeerConnection();pc.events.get('track')({track:receiver,transceiver:pc.transceivers[0]});
 let captured=await context.window.__exeWan.sample();assert.equal(captured.peers[0].rtp.find(r=>r.direction==='inbound'&&r.kind==='video').source,'unknown_video');
 videos.push({srcObject:{getVideoTracks:()=>[receiver]},getVideoPlaybackQuality:()=>({totalVideoFrames:60,droppedVideoFrames:0}),videoWidth:2560,videoHeight:1440,currentTime:1,paused:false,readyState:4});
 captured=await context.window.__exeWan.sample();assert.equal(captured.peers[0].route,'sfu');assert.equal(captured.peers[0].rtp.find(r=>r.direction==='outbound').source,'screen');assert.equal(captured.peers[0].rtp.find(r=>r.direction==='inbound'&&r.kind==='video').source,'screen');assert.equal(captured.peers[0].rtp.find(r=>r.kind==='audio').source,'unknown_audio');
});
