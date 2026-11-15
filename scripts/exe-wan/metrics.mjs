import{getProfile}from'./profiles.mjs';
export function quantile(values,p){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;return a[Math.min(a.length-1,Math.max(0,Math.ceil(p*a.length)-1))];}
const delta=(a,b,key)=>typeof a?.[key]==='number'&&typeof b?.[key]==='number'&&b[key]>=a[key]?b[key]-a[key]:null;
export function summarize(samples,index,phase,profile=getProfile()){
 const steady=samples.filter(s=>s.segment==='steady');const groups=new Map();
 for(const {sample}of steady)for(const peer of sample.peers){const k=peer.local_fingerprint+':'+peer.remote_fingerprint;if(!groups.has(k))groups.set(k,[]);groups.get(k).push({at:sample.at,peer});}
 const peers=[];
 for(const [key,rows]of groups){const first=rows[0],last=rows.at(-1),duration=(last.at-first.at)/1000;
  const streams=[];for(const source of ['microphone','screen']){
   const get=r=>r.peer.rtp.find(t=>t.direction==='inbound'&&t.source===source&&t.bytesReceived>0),a=get(first),b=get(last);if(!a||!b)continue;
   const bytes=delta(a,b,'bytesReceived'),packets=delta(a,b,'packetsReceived'),lost=delta(a,b,'packetsLost'),decodedDuration=delta(a,b,'totalSamplesDuration'),receivedSamples=delta(a,b,'totalSamplesReceived'),concealed=delta(a,b,'concealedSamples'),energy=delta(a,b,'totalAudioEnergy'),concealment=receivedSamples>0&&concealed!==null?concealed/receivedSamples:null;
   const analysed=rows.map(r=>r.peer.tracks.find(t=>t.source===source));
   const stream={source,codec:b.codec,duration_seconds:duration,bitrate_mbps:bytes!==null&&duration>0?bytes*8/duration/1e6:null,packets_received:packets,packets_lost:lost,loss_ratio:packets!==null&&lost!==null&&packets+lost>0?lost/(packets+lost):null,jitter_p50_ms:quantile(rows.map(r=>get(r)?.jitter*1000),.5),jitter_p95_ms:quantile(rows.map(r=>get(r)?.jitter*1000),.95)};
   if(source==='microphone')Object.assign(stream,{concealment_ratio:concealment,nonconcealed_audio_wall_ratio:decodedDuration!==null&&duration>0&&concealment!==null?decodedDuration/duration*(1-concealment):null,decoded_rms:decodedDuration>0&&energy!==null?Math.sqrt(energy/decodedDuration):null,analysis_rms_p50:quantile(analysed.map(t=>t?.rms),.5)});
   else {const va=first.peer.tracks.find(t=>t.source==='screen')?.video,vb=last.peer.tracks.find(t=>t.source==='screen')?.video,frames=delta(va,vb,'total_frames'),dropped=delta(va,vb,'dropped_frames');Object.assign(stream,{width:b.frameWidth??null,height:b.frameHeight??null,displayed_fps:frames!==null&&dropped!==null&&duration>0?(frames-dropped)/duration:null,decoded_fps:delta(a,b,'framesDecoded')!==null&&duration>0?delta(a,b,'framesDecoded')/duration:null,dropped_frames:dropped,freeze_count:delta(a,b,'freezeCount'),freeze_seconds:delta(a,b,'totalFreezesDuration'),sampled_sizes:[...new Set(analysed.map(t=>t?.video?`${t.video.width}x${t.video.height}`:'unavailable'))]});}
   streams.push(stream);
  }
  peers.push({local_fingerprint:first.peer.local_fingerprint,remote_fingerprint:first.peer.remote_fingerprint,connection_samples:rows.length,all_samples_connected:rows.every(r=>r.peer.state==='connected'),route:{local:first.peer.local_candidate.type,remote:first.peer.remote_candidate.type,protocol:first.peer.local_candidate.protocol},rtt_p50_ms:quantile(rows.map(r=>r.peer.ice_rtt_ms),.5),rtt_p95_ms:quantile(rows.map(r=>r.peer.ice_rtt_ms),.95),rtt_max_ms:quantile(rows.map(r=>r.peer.ice_rtt_ms),1),streams});
 }
 const audio=peers.flatMap(p=>p.streams.filter(s=>s.source==='microphone')),video=peers.flatMap(p=>p.streams.filter(s=>s.source==='screen'));
 const functional=peers.length===7&&peers.every(p=>p.all_samples_connected)&&audio.length===7;
 const voice=audio.length===7&&audio.every(s=>s.nonconcealed_audio_wall_ratio>=.8&&s.concealment_ratio!==null&&s.concealment_ratio<=.02&&s.decoded_rms>=.03);
 const screen=phase!=='screen'||index===0||video.length===1&&video.every(s=>s.width===profile.width&&s.height===profile.height&&s.displayed_fps>=profile.min_displayed_fps&&s.freeze_count===0&&s.freeze_seconds===0&&!s.sampled_sizes.some(size=>size!==`${profile.width}x${profile.height}`));
 const duration=steady.length?(steady.at(-1).sample.at-steady[0].sample.at)/1000:0;
 return{phase,index,requested_profile:profile,observed_steady_seconds:duration,samples:steady.length,functional_status:functional?'PASS':'FAIL',voice_status:voice?'PASS':'FAIL',video_status:phase==='screen'?(screen?'PASS':'FAIL'):'NOT_APPLICABLE',status:functional&&voice&&screen&&duration>=180?'PASS':'FAIL',peers};
}
