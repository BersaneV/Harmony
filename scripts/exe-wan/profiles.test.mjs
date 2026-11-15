import test from 'node:test';import assert from 'node:assert/strict';
import {getProfile} from './profiles.mjs';import {summarize} from './metrics.mjs';
function sample(at,width,height,fps){return{segment:'steady',sample:{at,peers:Array.from({length:7},(_,i)=>({local_fingerprint:'a'+i,remote_fingerprint:'b'+i,state:'connected',local_candidate:{type:'srflx',protocol:'udp'},remote_candidate:{type:'srflx'},ice_rtt_ms:10,
 tracks:i===0?[{source:'screen',video:{width,height,total_frames:at/1000*fps,dropped_frames:0}}]:[],
 rtp:[{direction:'inbound',source:'microphone',bytesReceived:1000+at,packetsReceived:100+at,packetsLost:0,totalSamplesDuration:at/1000,totalSamplesReceived:at*48,concealedSamples:0,totalAudioEnergy:at/1000*.04},...(i===0?[{direction:'inbound',source:'screen',bytesReceived:1000+at,packetsReceived:100+at,packetsLost:0,framesDecoded:at/1000*fps,frameWidth:width,frameHeight:height,freezeCount:0,totalFreezesDuration:0}]:[])]
 }))}};}
test('high resolution gates cannot accept a 720p stream, 30 FPS, or a missing screen',()=>{
 for(const id of ['1080p60','1440p60']){
  const p=getProfile(id),measure=(w,h,fps)=>summarize([sample(1000,w,h,fps),sample(181000,w,h,fps)],1,'screen',p);
  assert.equal(measure(p.width,p.height,58).status,'PASS');
  assert.equal(measure(1280,720,58).video_status,'FAIL');
  assert.equal(measure(p.width,p.height,30).video_status,'FAIL');
  assert.equal(measure(p.width,p.height,53.9).video_status,'FAIL');
  assert.equal(summarize([],1,'screen',p).status,'FAIL');
 }
});
test('profile names are a fixed allowlist and cannot alter bitrate or frame gates',()=>{
 assert.equal(getProfile().id,'720p30');assert.throws(()=>getProfile('../../other'));assert.throws(()=>getProfile('1080p30'));
 assert.throws(()=>{getProfile('1440p60').min_displayed_fps=1});assert.equal(getProfile('1440p60').min_displayed_fps,54);
});
