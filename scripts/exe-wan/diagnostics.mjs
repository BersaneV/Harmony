// Derive encoder/receiver timelines from sanitized native getStats records.
import {readFile,writeFile} from 'node:fs/promises';
const [path,destination]=process.argv.slice(2);
if(!path||!destination)throw Error('Usage: diagnostics.mjs <run.log> <diagnostics.json>');
const samples=[];
for(const line of (await readFile(path,'utf8')).split(/\r?\n/)){
 const key='HARMONY_EXE_WAN_SAMPLE ',at=line.indexOf(key);if(at<0)continue;
 const row=JSON.parse(line.slice(at+key.length));if(row.phase==='screen')samples.push(row);
}
const receivers=[];
for(let index=1;index<8;index++){
 const received=samples.filter(s=>s.index===index&&s.segment==='steady');
 const first=received[0]?.sample;if(!first)continue;
 const peer=first.peers.find(p=>p.rtp.some(r=>r.direction==='inbound'&&r.source==='screen'&&r.bytesReceived>0));if(!peer)continue;
 const pick=(s,p,dir)=>p?.rtp.find(r=>r.direction===dir&&r.source==='screen'&&(dir==='outbound'?r.bytesSent:r.bytesReceived)>0);
 const incoming=received.map(({sample:s})=>{const p=s.peers.find(p=>p.local_fingerprint===peer.local_fingerprint),r=pick(s,p,'inbound');if(!r)return null;return{seconds:(s.at-first.at)/1000,width:r.frameWidth,height:r.frameHeight,fps:r.framesPerSecond,frames:r.framesDecoded,freezes:r.freezeCount,freeze_seconds:r.totalFreezesDuration,packets_lost:r.packetsLost,jitter_ms:r.jitter*1000,rtt_ms:p.ice_rtt_ms}}).filter(Boolean);
 const sent=samples.filter(s=>s.index===0&&s.segment==='steady'),start=sent[0]?.sample.at;let previous;
 const outgoing=sent.map(({sample:s})=>{const p=s.peers.find(p=>p.remote_fingerprint===peer.local_fingerprint),r=pick(s,p,'outbound');if(!r)return null;const frames=previous?r.framesEncoded-previous.r.framesEncoded:0,result={seconds:(s.at-start)/1000,width:r.frameWidth,height:r.frameHeight,fps:r.framesPerSecond,source_fps:r.media_source?.framesPerSecond,encoded_frames:r.framesEncoded,encode_ms_per_frame:frames>0?(r.totalEncodeTime-previous.r.totalEncodeTime)*1000/frames:null,qp_mean:frames>0&&r.qpSum!==undefined?(r.qpSum-previous.r.qpSum)/frames:null,limitation:r.quality_limitation_reason??null,limitation_seconds:r.quality_limitation_durations??null,limitation_resolution_changes:r.qualityLimitationResolutionChanges??null,encoder:r.encoder_implementation??null,parameters:r.sender_parameters??null,target_bitrate:r.targetBitrate??null,available_bitrate:p.available_outgoing_bitrate??null,rtt_ms:p.ice_rtt_ms,nacks:r.nackCount??null,plis:r.pliCount??null,remote_feedback:r.remote_feedback??null};previous={r};return result;}).filter(Boolean);
 receivers.push({index,participant:`P${index+1}`,incoming,outgoing});
}
await writeFile(destination,JSON.stringify({schema:1,receivers},null,2)+'\n');
console.log(JSON.stringify(receivers.map(r=>({participant:r.participant,sizes:[...new Set(r.incoming.map(s=>`${s.width}x${s.height}`))],last:r.incoming.at(-1),limitation_reasons:[...new Set(r.outgoing.map(s=>s.limitation))],last_encoder:r.outgoing.at(-1)})),null,2));
