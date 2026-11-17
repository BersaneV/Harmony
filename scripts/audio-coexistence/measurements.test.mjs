import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarize,assertCoexistence} from './measurements.mjs';
const row=(value,voice=0)=>({kind:'loopback_interval',samples:48000,external_440:value,voice_880:voice,rms:value,clipping_samples:0});
test('empty, nonfinite or absent PCM cannot be presented as successful audio',()=>{
  for(const values of [[],Array(6).fill({...row(0.1),samples:0}),Array(6).fill(row(NaN))])assert.throws(()=>summarize(values));
});
test('detects Windows-style attenuation, a muted external app and a missing received voice',()=>{
  const baseline=summarize(Array(8).fill(row(0.1)));
  for(const v of [0,0.02,0.05])assert.throws(()=>assertCoexistence(summarize(Array(8).fill(row(v))),baseline));
  assert.throws(()=>assertCoexistence(summarize(Array(8).fill(row(0.1))),baseline,{voice:true}));
  assert.throws(()=>assertCoexistence(summarize([...Array(7).fill(row(0.1)),row(0)]),baseline));
  assert.doesNotThrow(()=>assertCoexistence(summarize(Array(8).fill(row(0.1,0.04))),baseline,{voice:true}));
});
