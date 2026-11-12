// Real HTTP/WS/PostgreSQL ACL matrix. Optional S3/LiveKit paths use real services.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
const base=process.env.HARMONY_TEST_URL??'http://127.0.0.1:8080';
const suffix=randomBytes(4).toString('hex'), password=randomBytes(24).toString('hex');
let checks=0;
async function call(method,path,body,token,status=200){
 const r=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=r.status===204?null:await r.json();if(Array.isArray(status))assert.ok(status.includes(r.status),`${method} ${path}: ${r.status} ${data?.error?.code}`);else assert.equal(r.status,status,`${method} ${path}: ${data?.error?.code}`);checks++;return data;
}
const admin=await call('POST','/auth/login',{username:process.env.HARMONY_BOOTSTRAP_USERNAME,password:process.env.HARMONY_BOOTSTRAP_PASSWORD});
const invitation=await call('POST','/admin/invites',{max_uses:3},admin.access_token);
const sessions=[];for(const name of ['owner','member','outsider'])sessions.push(await call('POST','/auth/register',{username:`acl_${name}_${suffix}`,display_name:name,password,invite_token:invitation.token}));
const [owner,member,outsider]=sessions;const ot=owner.access_token,mt=member.access_token,xt=outsider.access_token;
const guild=await call('POST','/guilds',{name:'ACL matrix'},ot);
const join=await call('POST',`/guilds/${guild.id}/invites`,{max_uses:1},ot);await call('POST','/invites/accept',{token:join.token},mt);
const channel=await call('POST',`/guilds/${guild.id}/channels`,{name:'Restricted',kind:'text'},ot);
const other=await call('POST',`/guilds/${guild.id}/channels`,{name:'Available',kind:'text'},ot);
const voice=await call('POST',`/guilds/${guild.id}/channels`,{name:'Voice',kind:'voice'},ot);
const send=(cid,token,content,attachment_ids)=>call('POST',`/channels/${cid}/messages`,{client_nonce:randomUUID(),content,attachment_ids:attachment_ids??[]},token);
const seed=await send(channel.id,mt,`ACLsearch_${suffix}`);
let upload;
if(process.env.HARMONY_TEST_STORAGE==='1'){
 const bytes=Buffer.from('Harmony private attachment');
 upload=await call('POST',`/channels/${channel.id}/uploads`,{name:'private.txt',size:bytes.length,content_type:'text/plain'},mt);
 const oversized=await fetch(upload.url,{method:'PUT',headers:upload.headers,body:Buffer.concat([bytes,Buffer.from('extra')])});
 assert.ok(!oversized.ok,'Signed Content-Length must reject an oversized PUT before finalization');checks++;
 const put=await fetch(upload.url,{method:'PUT',headers:upload.headers,body:bytes});assert.ok(put.ok);checks++;
 await call('POST',`/uploads/${upload.id}/complete`,{},mt);
 const rewritten=await fetch(upload.url,{method:'PUT',headers:upload.headers,body:Buffer.alloc(bytes.length,65)});assert.ok(rewritten.ok);checks++;
 const ready=await call('GET',`/uploads/${upload.id}/download`,undefined,mt);
 assert.deepEqual(Buffer.from(await(await fetch(ready.url)).arrayBuffer()),bytes,'Final object must be immutable after reusing temporary PUT URL');checks++;
}
const role=await call('POST',`/guilds/${guild.id}/roles`,{name:'Writer',permissions:'63'},ot);
const denyRole=await call('POST',`/guilds/${guild.id}/roles`,{name:'Read only',permissions:'0'},ot);
await call('POST',`/guilds/${guild.id}/roles`,{name:'No',permissions:'63'},mt,403);
await call('POST',`/guilds/${guild.id}/roles`,{name:'No global bypass',permissions:'63'},admin.access_token,403);
await call('POST',`/guilds/${guild.id}/roles`,{name:'Invalid',permissions:'64'},ot,400);
await call('PATCH',`/roles/${role.id}`,{name:'Writer renamed',permissions:'63'},ot);
await call('PATCH',`/roles/${role.id}`,{name:'No'},xt,403);
const assign=(rid,add=true)=>call(add?'PUT':'DELETE',`/guilds/${guild.id}/members/${member.user.id}/roles/${rid}`,undefined,ot,204);
await assign(role.id);await assign(denyRole.id);
const members=await call('GET',`/guilds/${guild.id}/members`,undefined,ot);assert.deepEqual(new Set(members.items.find(u=>u.id===member.user.id).role_ids),new Set([role.id,denyRole.id]));checks++;
const override=(cid,role_id,allow,deny,token=ot,status=204)=>call('PUT',`/channels/${cid}/permissions`,{role_id,allow:String(allow),deny:String(deny)},token,status);
await override(channel.id,null,0,2);
await override(channel.id,role.id,2,0);
await override(channel.id,denyRole.id,0,2);
await send(channel.id,mt,'Role allow wins against another role deny');
await assign(role.id,false);
await call('POST',`/channels/${channel.id}/messages`,{client_nonce:randomUUID(),content:'Forbidden'},mt,403);
await call('PATCH',`/messages/${seed.id}`,{content:'Forbidden edit'},mt,403);
await call('DELETE',`/messages/${seed.id}`,undefined,mt,204);
await override(channel.id,null,0,4|8);
await override(channel.id,denyRole.id,0,0);
const preserved=await send(channel.id,mt,`ACLsearch_${suffix}`);
await call('PUT',`/messages/${preserved.id}/reactions/${encodeURIComponent('👍')}`,undefined,mt,403);
await call('POST',`/channels/${channel.id}/uploads`,{name:'no.txt',size:1,content_type:'text/plain'},mt,403);
if(upload)await call('POST',`/channels/${channel.id}/messages`,{client_nonce:randomUUID(),content:'',attachment_ids:[upload.id]},mt,403);
await override(channel.id,null,1,1,ot,400);
await override(channel.id,null,0,64,ot,400);
await override(channel.id,null,0,1,mt,403);
const foreignGuild=await call('POST','/guilds',{name:'Foreign ACL'},xt);
const foreignRole=await call('POST',`/guilds/${foreignGuild.id}/roles`,{name:'Foreign',permissions:'63'},xt);
await call('PUT',`/guilds/${guild.id}/members/${member.user.id}/roles/${foreignRole.id}`,undefined,ot,404);
await override(channel.id,foreignRole.id,1,0,ot,404);
await call('PUT',`/guilds/${guild.id}/members/${outsider.user.id}/roles/${role.id}`,undefined,ot,404);
const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/ws');const events=[];
ws.addEventListener('message',e=>events.push(JSON.parse(e.data)));
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;setTimeout(()=>reject(new Error('WS timeout')),5000).unref()});
ws.send(JSON.stringify({type:'auth',token:mt}));
async function until(test,label){const end=Date.now()+10000;while(!test()&&Date.now()<end)await new Promise(r=>setTimeout(r,30));assert.ok(test(),label);checks++}
await until(()=>events.some(e=>e.type==='ready'),'WS auth');
await override(channel.id,null,0,1);
await until(()=>events.some(e=>e.type==='permissions.updated'&&e.guild_id===guild.id),'ACL change notice');
const hidden=await call('GET',`/guilds/${guild.id}/channels`,undefined,mt);assert.ok(!hidden.items.some(c=>c.id===channel.id));checks++;
await call('GET',`/channels/${channel.id}/messages`,undefined,mt,403);
await call('GET',`/channels/${channel.id}/permissions`,undefined,mt,403);
const search=await call('GET',`/search?q=ACLsearch_${suffix}`,undefined,mt);assert.equal(search.items.length,0);checks++;
if(upload)await call('GET',`/uploads/${upload.id}/download`,undefined,mt,403);
const secret=await send(channel.id,ot,'Must never reach revoked reader');
const visible=await send(other.id,ot,'Other channel stays available');
await until(()=>events.some(e=>e.message_id===visible.id),'Other channel event');
assert.ok(!events.some(e=>e.message_id===secret.id),'Revoked VIEW must filter WS message content');checks++;
await override(channel.id,null,0,63);
const ownerChannels=await call('GET',`/guilds/${guild.id}/channels`,undefined,ot);assert.equal(ownerChannels.items.find(c=>c.id===channel.id).effective_permissions,'63');checks++;
await call('PATCH',`/guilds/${guild.id}/members/${member.user.id}`,{role:'admin'},ot,204);
const adminChannels=await call('GET',`/guilds/${guild.id}/channels`,undefined,mt);assert.equal(adminChannels.items.find(c=>c.id===channel.id).effective_permissions,'63');checks++;
await call('PATCH',`/guilds/${guild.id}/members/${member.user.id}`,{role:'member'},ot,204);
if(process.env.HARMONY_TEST_MEDIA==='1'){
 await override(voice.id,null,0,32);
 const spectator=await call('POST',`/channels/${voice.id}/media-token`,{},mt);
 const claims=JSON.parse(Buffer.from(spectator.token.split('.')[1],'base64url').toString());assert.equal(claims.video.canPublish,false);assert.equal(claims.video.canSubscribe,true);checks+=2;
 await override(voice.id,null,0,16);
 await call('POST',`/channels/${voice.id}/media-token`,{},mt,403);
 await call('POST',`/channels/${voice.id}/media-token`,{},ot);
 await override(voice.id,null,0,1);
 await call('POST',`/channels/${voice.id}/media-token`,{},mt,403);
}
await override(channel.id,null,0,0);await assign(role.id);
await call('DELETE',`/roles/${role.id}`,undefined,ot,204);
const afterDelete=await call('GET',`/guilds/${guild.id}/members`,undefined,ot);assert.ok(!afterDelete.items.find(m=>m.id===member.user.id).role_ids.includes(role.id));checks++;
await call('DELETE',`/roles/${denyRole.id}`,undefined,ot,204);
const restored=await call('GET',`/guilds/${guild.id}/channels`,undefined,mt);assert.equal(restored.items.find(c=>c.id===channel.id).effective_permissions,'63');checks++;
// Content writes and ACL changes share a transaction lock; completed revocation
// must reject subsequent writes, and racing writers may only commit before it or deny.
await Promise.all([
 ...Array.from({length:10},(_,i)=>call('POST',`/channels/${channel.id}/messages`,{client_nonce:randomUUID(),content:`ACL concurrent ${i}`},mt,[200,403])),
 override(channel.id,null,0,2),
]);
await call('POST',`/channels/${channel.id}/messages`,{client_nonce:randomUUID(),content:'After completed revocation'},mt,403);
await override(channel.id,null,0,0);
ws.close();
console.log(JSON.stringify({status:'PASS',checks,features:['custom roles CRUD','role membership','everyone and role override precedence','global admin has no community bypass','owner/admin bypass','unknown masks rejected','cross-guild IDs rejected','SEND edit/create denied and own delete allowed','ATTACH and REACT denied','VIEW filters history/search/channels/download/WS','ACL update event','spectator media token','CONNECT media deny','role delete cascades','concurrent ACL revoke serializes content writes'],storage:process.env.HARMONY_TEST_STORAGE==='1',media:process.env.HARMONY_TEST_MEDIA==='1'}));
