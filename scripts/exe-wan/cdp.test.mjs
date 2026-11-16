import test from 'node:test';
import assert from 'node:assert/strict';
import {CDP,delay} from './cdp.mjs';

const secret='DO_NOT_RECORD_PRIVATE_VALUE';
function socketFixture(){
 const previous=globalThis.WebSocket,instances=[];
 class Socket{
  readyState=0;sent=[];
  constructor(){instances.push(this);}
  open(){this.readyState=1;this.onopen?.();}
  send(text){this.sent.push(JSON.parse(text));}
  reply(id,result){this.onmessage?.({data:JSON.stringify({id,result})});}
  close(){this.readyState=3;this.onclose?.();}
  error(){this.onerror?.();}
 }
 globalThis.WebSocket=Socket;
 return{instances,restore(){globalThis.WebSocket=previous;}};
}
test('connection readiness is inside the command deadline and late open cannot send a timed-out command',async()=>{
 const f=socketFixture();try{
  const rows=[],cdp=new CDP('ws://127.0.0.1/devtools/page/owned',{trace:r=>rows.push(r)});
  const pending=cdp.send('Runtime.evaluate',{expression:secret},20);
  await assert.rejects(Promise.race([pending,delay(150).then(()=>{throw Error('unbounded ready');})]),/CDP timeout/);
  assert.equal(cdp.pending.size,0);f.instances[0].open();await delay(0);assert.equal(f.instances[0].sent.length,0);
  assert.equal(rows.at(-1).state,'timeout');cdp.close();
 }finally{f.restore();}
});
test('optional tracing captures only safe command metadata, freezes the stage at send and never records inserted text',async()=>{
 const f=socketFixture();try{
  const rows=[],cdp=new CDP('ws://127.0.0.1/devtools/page/owned',{trace:r=>rows.push(r)}),socket=f.instances[0];socket.open();
  cdp.setStage('capture.choose.click');const pending=cdp.evaluate(secret,true);await delay(0);
  cdp.setStage('capture.preview.wait');socket.reply(socket.sent[0].id,{result:{value:secret}});assert.equal(await pending,secret);
  assert.deepEqual([...new Set(rows.map(r=>r.stage))],['capture.choose.click']);
  assert.deepEqual(rows.map(r=>r.state),['waiting','sent','completed']);
  for(const row of rows){assert.equal(row.method,'Runtime.evaluate');assert.match(row.utc,/^\d{4}-/);assert.ok(Number.isSafeInteger(row.id));assert.ok(['connecting','open','closing','closed'].includes(row.socket_state));}
  const before=rows.length,input=cdp.send('Input.insertText',{text:secret});await delay(0);socket.reply(socket.sent.at(-1).id,{});await input;assert.equal(rows.length,before);
  assert.throws(()=>cdp.setStage(secret),/stage/);assert.equal(JSON.stringify(rows).includes(secret),false);cdp.close();
 }finally{f.restore();}
});
test('tracing is absent by default and a failing observer cannot change command results',async()=>{
 const f=socketFixture();try{
  for(const options of [undefined,{trace(){throw Error(secret);}}]){
   const cdp=new CDP('ws://127.0.0.1/devtools/page/owned',options),socket=f.instances.at(-1);socket.open();
   const pending=cdp.send('Browser.getVersion');await delay(0);socket.reply(socket.sent[0].id,{product:'owned'});assert.equal((await pending).product,'owned');cdp.close();
  }
 }finally{f.restore();}
});
test('close and connection failure reject queued commands and remove pending state',async()=>{
 const f=socketFixture();try{
  for(const event of ['close','error']){
   const cdp=new CDP('ws://127.0.0.1/devtools/page/owned'),pending=assert.rejects(cdp.send('Runtime.evaluate',{},100),/CDP (closed|connection failed)/);
   f.instances.at(-1)[event]();await pending;assert.equal(cdp.pending.size,0);cdp.close();
  }
 }finally{f.restore();}
});
