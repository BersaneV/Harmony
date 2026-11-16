import assert from 'node:assert/strict';
import{appendFile}from'node:fs/promises';
import{guard,cohort,identity,api,mask}from'./lab.mjs';
import{assertDirectInstance,assertDirectCall}from'./fixture-contract.mjs';
guard(process.env,process.platform,false);
const instance=await api('/instance');assertDirectInstance(instance);
const ownerIdentity=identity(0);mask(ownerIdentity.password);
const owner=await api('/auth/register',null,{...ownerIdentity,display_name:'EXE WAN 0'});assert.equal(owner.user.is_admin,false);mask(owner.access_token);
const name='EXE WAN '+cohort(),guild=await api('/guilds',owner.access_token,{name});
const channels=(await api(`/guilds/${guild.id}/channels`,owner.access_token)).items;
const voice=channels.find(c=>c.kind==='voice'),control=channels.find(c=>c.kind==='text');assert.ok(voice&&control);
const call=await api(`/channels/${voice.id}/call`,owner.access_token);assertDirectCall(instance,call);
const invitation=await api(`/guilds/${guild.id}/invites`,owner.access_token,{expires_hours:1,max_uses:7});mask(invitation.token);
const users=[{index:0,id:owner.user.id}];
for(let index=1;index<8;index++){const i=identity(index);mask(i.password);const s=await api('/auth/register',null,{...i,display_name:'EXE WAN '+index,invite_token:invitation.token});assert.equal(s.user.is_admin,false);users.push({index,id:s.user.id});}
assert.equal((await api(`/guilds/${guild.id}/members`,owner.access_token)).items.length,8);
await appendFile(process.env.GITHUB_OUTPUT,`cohort=${cohort()}\nguild=${guild.id}\nguild_name=${name}\nvoice=${voice.id}\ncontrol=${control.id}\nusers=${JSON.stringify(users)}\nscreen_sfu_enabled=${call.screen_sfu_enabled===true}\n`);
console.log('HARMONY_EXE_WAN_PREP '+JSON.stringify({cohort:cohort(),users:8,version:instance.version,transport:call.transport,screen_sfu_enabled:call.screen_sfu_enabled===true,scope:'Own private synthetic accounts/community; no administrator credentials or personal data'}));
