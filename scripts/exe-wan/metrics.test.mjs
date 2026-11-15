import test from'node:test';import assert from'node:assert/strict';import{guard}from'./lab.mjs';import{quantile,summarize}from'./metrics.mjs';
test('runner guard refuses personal machines, wrong repos and self hosted runners',()=>{
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BersaneV/Harmony',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_RUN_ID:'12345678',GITHUB_RUN_ATTEMPT:'1',HARMONY_EXE_WAN_SEED:'a'.repeat(64)};
 assert.doesNotThrow(()=>guard(env,'win32'));for(const patch of[{GITHUB_ACTIONS:'false'},{GITHUB_REPOSITORY:'other/repo'},{RUNNER_ENVIRONMENT:'self-hosted'},{HARMONY_EXE_WAN_SEED:'short'}])assert.throws(()=>guard({...env,...patch},'win32'));assert.throws(()=>guard(env,'darwin'));
});
test('quantiles preserve missing values and spikes',()=>{assert.equal(quantile([NaN,null,undefined],.95),null);assert.equal(quantile([10,20,30,1000],.95),1000);assert.equal(quantile([10,20,30,1000],.5),20);});
test('missing media never passes',()=>{const x=summarize([],0,'screen');assert.equal(x.status,'FAIL');assert.equal(x.observed_steady_seconds,0)});
test('voice accounting excludes reconstructed audio and does not treat absent counters as zero',()=>{
 function sample(at,fraction,missing=false){return{segment:'steady',sample:{at,peers:Array.from({length:7},(_,i)=>({local_fingerprint:'a'+i,remote_fingerprint:'b'+i,state:'connected',local_candidate:{type:'host',protocol:'udp'},remote_candidate:{type:'srflx'},ice_rtt_ms:60,tracks:[],rtp:[{direction:'inbound',source:'microphone',codec:'audio/opus',bytesReceived:1000+at,packetsReceived:100+at,packetsLost:0,totalSamplesDuration:at/1000,totalSamplesReceived:at*48,concealedSamples:missing?undefined:at*48*fraction,totalAudioEnergy:at/1000*.04,jitter:.01}]}))}}}
 const healthy=summarize([sample(1,0),sample(180001,0)],0,'voice');assert.equal(healthy.status,'PASS');assert.equal(healthy.peers[0].rtt_p95_ms,60);assert.equal(healthy.peers[0].streams[0].decoded_rms,.2);
 assert.equal(summarize([sample(1,.2),sample(180001,.2)],0,'voice').voice_status,'FAIL');assert.equal(summarize([sample(1,0,true),sample(180001,0,true)],0,'voice').voice_status,'FAIL');
});
test('screen cannot pass on average FPS when it freezes, downscales, or omits freeze counters',()=>{
 function sample(at,{freezes=0,freezeSeconds=0,height=720,missing=false}={}){
  return{segment:'steady',sample:{at,peers:Array.from({length:7},(_,i)=>({local_fingerprint:'a'+i,remote_fingerprint:'b'+i,state:'connected',local_candidate:{type:'srflx',protocol:'udp'},remote_candidate:{type:'srflx'},ice_rtt_ms:20,
   tracks:i===0?[{source:'screen',video:{width:1280,height,total_frames:at/1000*29,dropped_frames:0}}]:[],
   rtp:[{direction:'inbound',source:'microphone',codec:'audio/opus',bytesReceived:1000+at,packetsReceived:100+at,packetsLost:0,totalSamplesDuration:at/1000,totalSamplesReceived:at*48,concealedSamples:0,totalAudioEnergy:at/1000*.04,jitter:.001},
    ...(i===0?[{direction:'inbound',source:'screen',codec:'video/H264',bytesReceived:1000+at,packetsReceived:100+at,packetsLost:0,framesDecoded:at/1000*29,frameWidth:1280,frameHeight:height,freezeCount:missing?undefined:freezes,totalFreezesDuration:missing?undefined:freezeSeconds}]:[])]
  }))}};
 }
 const first=sample(1000);
 assert.equal(summarize([first,sample(181000)],1,'screen').video_status,'PASS');
 assert.equal(summarize([first,sample(181000,{freezes:1,freezeSeconds:.5})],1,'screen').video_status,'FAIL');
 assert.equal(summarize([first,sample(181000,{height:180})],1,'screen').video_status,'FAIL');
 assert.equal(summarize([first,sample(181000,{missing:true})],1,'screen').video_status,'FAIL');
});
