import test from 'node:test';import assert from 'node:assert/strict';import {rotatingToken} from './auth.mjs';
const session=(exp,refresh_token)=>({access_token:'x.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.x',refresh_token});
test('fixture control rotates once for concurrent expiry and uses the new refresh token next time',async()=>{
 let now=0,calls=[];const first=session(100,'a'),next=session(200,'b'),last=session(300,'c');
 const token=rotatingToken(first,async value=>{calls.push(value);return value==='a'?next:last},()=>now);
 assert.equal(await token(),first.access_token);assert.deepEqual(calls,[]);
 now=60000;assert.deepEqual(await Promise.all([token(),token(),token()]),Array(3).fill(next.access_token));assert.deepEqual(calls,['a']);
 now=160000;assert.equal(await token(),last.access_token);assert.deepEqual(calls,['a','b']);
});
test('fixture refresh failure fails closed rather than returning an expired token',async()=>{
 const token=rotatingToken(session(0,'a'),async()=>{throw Error('revoked')},()=>1000);await assert.rejects(token(),/revoked/);
 assert.throws(()=>rotatingToken({access_token:'bad'},async()=>{}));
});
