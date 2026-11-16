import assert from 'node:assert/strict';
// Voice remains the direct 28-pair/56-microphone mesh. The new release can
// explicitly enable a separate screen SFU, whose route is measured independently.
export function assertDirectInstance(instance){
 assert.ok(['0.4.1','0.4.3'].includes(instance.version),'Only the validated direct-call server versions may prepare this fixture');
 assert.equal(instance.media_transport,'p2p','This fixture requires the direct-call transport');
}
export function assertCallRoute(instance,call){
 assertDirectInstance(instance);assert.equal(call.transport,'p2p');
 if(instance.version==='0.4.3')assert.equal(typeof call.screen_sfu_enabled,'boolean','The mixed-route fixture requires an explicit server screen SFU flag');
 else assert.notEqual(call.screen_sfu_enabled,true,'Screen SFU requires separate integration evidence');
 assert.ok(call.max_participants>=8);
}
export function assertDirectCall(instance,call){
 assertCallRoute(instance,call);assert.equal(call.participants.length,0);
}
