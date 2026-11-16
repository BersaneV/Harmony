import test from 'node:test';import assert from 'node:assert/strict';
import {assertDirectInstance,assertDirectCall} from './fixture-contract.mjs';
const call={transport:'p2p',screen_sfu_enabled:false,max_participants:8,participants:[]};
test('legacy 0.4.1 preserves direct voice while 0.4.3 explicitly declares either screen route',()=>{
 assertDirectCall({version:'0.4.1',media_transport:'p2p'},{...call,screen_sfu_enabled:undefined});
 assertDirectCall({version:'0.4.3',media_transport:'p2p'},call);
 assertDirectCall({version:'0.4.3',media_transport:'p2p'},{...call,screen_sfu_enabled:true});
});
test('unknown server versions and relay transport cannot inherit direct-call acceptance',()=>{
 for(const version of ['0.4.2','0.4.4','other'])assert.throws(()=>assertDirectInstance({version,media_transport:'p2p'}));
 assert.throws(()=>assertDirectInstance({version:'0.4.3',media_transport:'livekit'}));
});
test('0.4.3 requires an explicit boolean SFU flag and an empty room for eight participants',()=>{
 const server={version:'0.4.3',media_transport:'p2p'};
 for(const bad of [{screen_sfu_enabled:'true'},{screen_sfu_enabled:undefined},{transport:'livekit'},{max_participants:7},{participants:[{id:'another'}]}])assert.throws(()=>assertDirectCall(server,{...call,...bad}));
});
