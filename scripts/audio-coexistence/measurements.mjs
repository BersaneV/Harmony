import assert from 'node:assert/strict';

export function summarize(intervals) {
  const rows=intervals.filter(r=>r.kind==='loopback_interval');
  assert.ok(rows.length>=6,'At least six complete measured mixer intervals required');
  for(const row of rows) {
    assert.ok(Number.isInteger(row.samples)&&row.samples>=30000,'Real loopback frames required in every interval');
    for(const k of ['external_440','voice_880','rms']) assert.ok(Number.isFinite(row[k])&&row[k]>=0,'Finite measured amplitudes required');
  }
  const external=rows.map(r=>r.external_440),voice=rows.map(r=>r.voice_880);
  return {intervals:rows.length,external_mean:external.reduce((a,b)=>a+b,0)/rows.length,
    external_min:Math.min(...external),voice_mean:voice.reduce((a,b)=>a+b,0)/rows.length,
    min_samples:Math.min(...rows.map(r=>r.samples)),clipping_samples:rows.reduce((n,r)=>n+r.clipping_samples,0)};
}
export function assertCoexistence(measured,baseline,{voice=false}={}) {
  assert.ok(baseline.external_mean>0.02,'Calibrated external audio must be audible before Harmony');
  const mean=measured.external_mean/baseline.external_mean,min=measured.external_min/baseline.external_mean;
  assert.ok(mean>=0.85&&min>=0.65,'External audio attenuated or interrupted during the scenario');
  if(voice)assert.ok(measured.voice_mean>0.01,'Received Harmony voice must reach the Windows mixer');
  return {mean_ratio:mean,min_ratio:min};
}
