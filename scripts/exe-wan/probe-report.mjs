import {readFile,writeFile} from 'node:fs/promises';
const [path,destination]=process.argv.slice(2);if(!path||!destination)throw Error('Usage: probe-report.mjs <run.log> <probe.json>');
const samples=[],actions=[];
for(const line of (await readFile(path,'utf8')).split(/\r?\n/))for(const [prefix,into]of[['HARMONY_EXE_ENCODER_SAMPLE ',samples],['HARMONY_EXE_ENCODER_ACTION ',actions]]){const at=line.indexOf(prefix);if(at>=0)into.push(JSON.parse(line.slice(at+prefix.length)));}
const stages=[];
for(const stage of['original','resolution']){
 const received=samples.filter(s=>s.stage===stage&&s.index===4),first=received[0],last=received.at(-1);
 if(!first||!last)throw Error('Incomplete owned receiver stage');
 const peer=first.sample.peers.find(p=>p.rtp.some(r=>r.direction==='inbound'&&r.source==='screen'&&r.bytesReceived>0));if(!peer)throw Error('Missing received screen');
 const records=received.map(s=>{const p=s.sample.peers.find(p=>p.local_fingerprint===peer.local_fingerprint),r=p?.rtp.find(r=>r.direction==='inbound'&&r.source==='screen'&&r.bytesReceived>0),v=p?.tracks.find(t=>t.source==='screen')?.video;return{seconds:s.seconds,width:r?.frameWidth,height:r?.frameHeight,fps:r?.framesPerSecond,frames:r?.framesDecoded,freezes:r?.freezeCount,freeze_seconds:r?.totalFreezesDuration,displayed_frames:v?v.total_frames-v.dropped_frames:null};});
 const sender=samples.filter(s=>s.stage===stage&&s.index===0).map(s=>{const p=s.sample.peers.find(p=>p.remote_fingerprint===peer.local_fingerprint),r=p?.rtp.find(r=>r.direction==='outbound'&&r.source==='screen'&&r.bytesSent>0);return{seconds:s.seconds,width:r?.frameWidth,height:r?.frameHeight,fps:r?.framesPerSecond,source_fps:r?.media_source?.framesPerSecond,limitation:r?.quality_limitation_reason,limitation_seconds:r?.quality_limitation_durations,encoder:r?.encoder_implementation,parameters:r?.sender_parameters,target_bitrate:r?.targetBitrate,available_bitrate:p?.available_outgoing_bitrate};});
 const after=records.filter(r=>r.seconds>=80),a=after[0],b=after.at(-1),baseline=records[0],end=records.at(-1);
 const recovery={sampled_sizes:[...new Set(after.map(r=>`${r.width}x${r.height}`))],displayed_fps:(b.displayed_frames-a.displayed_frames)/(b.seconds-a.seconds),additional_freezes:b.freezes-a.freezes,additional_freeze_seconds:b.freeze_seconds-a.freeze_seconds};
 stages.push({stage,actions:actions.filter(a=>a.stage===stage),observed_seconds:end.seconds-baseline.seconds,sampled_sizes:[...new Set(records.map(r=>`${r.width}x${r.height}`))],additional_freezes:end.freezes-baseline.freezes,additional_freeze_seconds:end.freeze_seconds-baseline.freeze_seconds,recovery_after_30s:recovery,received:records,sent:sender});
}
const result={schema:1,status:'DIAGNOSTIC',scope:'Intentional native encoder bitrate cap on one owned P5 connection: 4 Mb/s -> the recorded lower cap for 30s -> 4 Mb/s; same connection, source and motion hint. Only adaptation preference differs between stages. Not normal-call capacity approval.',stages};
await writeFile(destination,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(stages.map(({received,sent,...s})=>s),null,2));
