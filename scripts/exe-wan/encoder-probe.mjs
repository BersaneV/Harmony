// Explicit diagnostic only: not a capacity PASS and never used by a normal run.
// On one owned P5 sender, compare a temporary 100 kb/s cap with the same native
// connection/source and restore its original 4 Mb/s cap after 30 seconds.
import assert from 'node:assert/strict';
import {postControl,controls} from './lab.mjs';
import {until,delay} from './cdp.mjs';
export async function encoderProbe(app,index,token,emit,users){
 assert.equal(process.env.HARMONY_ENCODER_PROBE,'true');
 async function wait(kind){let row;await until(async()=>{const all=(await controls(token)).filter(m=>users.some(u=>u.id===m.author_id));if(all.some(m=>m.kind==='abort'))throw Error('Owned probe aborted');row=all.find(m=>m.kind===kind&&m.author_id===users[kind==='probe-peer'?4:0].id);return!!row},kind,240000);return row;}
 if(index===4){const s=await app.sample(),p=s.peers.find(p=>p.rtp.some(r=>r.source==='screen'&&r.direction==='inbound'&&r.bytesReceived>0));assert.ok(p);await postControl(token,{kind:'probe-peer',index,key:p.local_fingerprint});}
 let pc;
 if(index===0){await until(async()=>new Set((await controls(token)).filter(m=>m.kind==='screen-ready'&&users.some(u=>u.id===m.author_id)).map(m=>m.index)).size===8,'all screen receivers ready',120000);const target=await wait('probe-peer');pc=(await app.sample()).peers.find(p=>p.remote_fingerprint===target.key)?.pc;assert.ok(Number.isInteger(pc));}
 async function parameters(bitrate,preference){
  assert.equal(index,0);assert.ok([100000,4000000].includes(bitrate));assert.ok(['maintain-framerate','maintain-resolution'].includes(preference));
  return app.cdp.evaluate(`(async()=>{const sender=__exeWan.pcs[${pc}].getTransceivers()[2].sender,p=sender.getParameters();if(p.encodings.length!==1)throw Error('One owned screen encoding required');p.encodings[0].maxBitrate=${bitrate};p.degradationPreference=${JSON.stringify(preference)};await sender.setParameters(p);const after=sender.getParameters();return{degradationPreference:after.degradationPreference,maxBitrate:after.encodings[0].maxBitrate,contentHint:sender.track.contentHint}})()`,true);
 }
 for(const [stage,preference]of[['original','maintain-framerate'],['resolution','maintain-resolution']]){
  if(index===0){const applied=await parameters(4000000,preference);assert.equal(applied.contentHint,'motion');await postControl(token,{kind:'probe-'+stage+'-clock',index,at:Date.now()+5000,parameters:applied});}
  const clock=await wait('probe-'+stage+'-clock');await delay(Math.max(0,clock.at-Date.now()));
  const started=performance.now();let limited=false,restored=false;
  while(performance.now()-started<=150000){
   const elapsed=performance.now()-started;
   if(index===0&&!limited&&elapsed>=20000){limited=true;const p=await parameters(100000,preference);emit('HARMONY_EXE_ENCODER_ACTION',{stage,seconds:elapsed/1000,action:'limit',pc,parameters:p});}
   if(index===0&&!restored&&elapsed>=50000){restored=true;const p=await parameters(4000000,preference);emit('HARMONY_EXE_ENCODER_ACTION',{stage,seconds:elapsed/1000,action:'restore',pc,parameters:p});}
   emit('HARMONY_EXE_ENCODER_SAMPLE',{index,stage,seconds:elapsed/1000,sample:await app.sample()});await delay(3000);
  }
  await postControl(token,{kind:'probe-'+stage+'-done',index});
  await until(async()=>new Set((await controls(token)).filter(m=>m.kind==='probe-'+stage+'-done'&&users.some(u=>u.id===m.author_id)).map(m=>m.index)).size===8,'all controlled probe clients done',120000);
 }
 if(index===0)await parameters(4000000,'maintain-framerate');
}
