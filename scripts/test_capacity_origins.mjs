import test from 'node:test';
import assert from 'node:assert/strict';
import {capacityOrigins, acceptanceInstance, acceptanceOrigin, acceptanceName} from './capacity_origins.mjs';
const web = 'http://127.0.0.1:1420';
test('loopback defaults remain valid', () => assert.equal(capacityOrigins('http://127.0.0.1:8080',web).remote,false));
test('external instance requires an exact operator opt-in', () => {
  assert.throws(() => capacityOrigins(acceptanceOrigin,web));
  assert.equal(capacityOrigins(acceptanceOrigin,web,'harmony.go.altare.global').remote,true);
});
test('media/browser origin never becomes remote', () => assert.throws(() => capacityOrigins(acceptanceOrigin,acceptanceOrigin,'harmony.go.altare.global')));
test('other hosts, downgrade and private backend addresses are refused', () => {
  for (const api of ['https://other.go.altare.global','http://harmony.go.altare.global','http://100.80.6.45:25094']) {
    assert.throws(() => capacityOrigins(api,web,'harmony.go.altare.global'));
  }
});
test('credentials, paths, query and fragment are refused', () => {
  for (const api of ['https://user:password@harmony.go.altare.global',acceptanceOrigin+'/api',acceptanceOrigin+'?x=1',acceptanceOrigin+'#x']) {
    assert.throws(() => capacityOrigins(api,web,'harmony.go.altare.global'));
  }
});
test('production name, transport or version cannot pass the mutation gate', () => {
  const good={name:acceptanceName,version:'0.4.1',media_transport:'p2p'};
  acceptanceInstance(good);
  for(const bad of [{...good,name:'Harmony'},{...good,version:'0.4.0'},{...good,media_transport:'livekit'}])assert.throws(()=>acceptanceInstance(bad));
});
