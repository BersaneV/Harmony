// Real SQLite + private object storage + FFmpeg + HTTP ACL, disposable test accounts.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const base=process.env.HARMONY_TEST_URL??'http://127.0.0.1:8080';
const worker=resolve(process.env.HARMONY_WORKER_BIN??'target/debug/harmony-media-worker');
const ffmpeg=process.env.FFMPEG_PATH??'/usr/bin/ffmpeg';
const ffprobe=process.env.FFPROBE_PATH??'/usr/bin/ffprobe';
const dbCli=resolve(process.env.HARMONY_DB_BIN??'target/debug/harmony-db');
const uuidHex=value=>{assert.match(value,/^[0-9a-f-]{36}$/i);return value.replaceAll('-','')};
const dir=mkdtempSync(join(tmpdir(),'harmony-worker-test-'));
const suffix=randomBytes(4).toString('hex'),password=`Worker-${randomBytes(20).toString('hex')}`;
const results=[];
function check(name,predicate){assert.ok(predicate,name);results.push(name);}
async function call(method,path,token,body,expected=200){
 const r=await fetch(`${base}/api${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const text=await r.text();let data;try{data=text?JSON.parse(text):null}catch{throw new Error(`Non JSON ${path}: ${r.status}`)}
 assert.ok([expected].flat().includes(r.status),`${method} ${path}: ${r.status} ${data?.error?.code??''}`);return data;
}
function sql(query){const r=spawnSync(dbCli,['query'],{input:query,encoding:'utf8',env:process.env,maxBuffer:1024*1024});assert.equal(r.status,0,`SQL test failed: ${r.stderr?.slice(0,500)}`);return JSON.parse(r.stdout).map(row=>row.map(v=>v??'').join('|')).join('\n');}
function make(name,args){const path=join(dir,name);const r=spawnSync(ffmpeg,['-v','error','-nostdin','-y',...args,path],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,`Fixture ${name}: ${r.stderr?.slice(0,1000)}`);return readFileSync(path);}
function runWorker(extra={},mode='--drain'){return new Promise((resolve,reject)=>{const p=spawn(worker,[mode],{env:{...process.env,FFMPEG_PATH:ffmpeg,FFPROBE_PATH:ffprobe,...extra},stdio:['ignore','pipe','pipe']});let logs='';for(const stream of[p.stdout,p.stderr])stream.on('data',d=>{logs=(logs+d).slice(-64000)});const t=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('Worker test timeout'))},240000);p.on('error',reject);p.on('exit',code=>{clearTimeout(t);if(code===0)resolve(logs);else reject(new Error(`Worker exit ${code}: ${logs.slice(-3000)}`))});});}
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Timed out waiting for worker state')}
try{
 const admin=await call('POST','/auth/login',null,{username:process.env.HARMONY_BOOTSTRAP_USERNAME,password:process.env.HARMONY_BOOTSTRAP_PASSWORD});
 const invite=await call('POST','/admin/invites',admin.access_token,{max_uses:3,expires_hours:1},[200,201]);
 const people=[];for(const name of['owner','reader','outsider'])people.push(await call('POST','/auth/register',null,{username:`wk_${name}_${suffix}`,display_name:name,password,invite_token:invite.token},[200,201]));
 const [owner,reader,outsider]=people;
 const guild=await call('POST','/guilds',owner.access_token,{name:`Worker ${suffix}`},[200,201]);
 const channel=await call('POST',`/guilds/${guild.id}/channels`,owner.access_token,{name:'media',kind:'text'},[200,201]);
 const invitation=await call('POST',`/guilds/${guild.id}/invites`,owner.access_token,{max_uses:1,expires_hours:1},[200,201]);
 await call('POST','/invites/accept',reader.access_token,{token:invitation.token},[200,201]);
 const png=make('image.png',['-f','lavfi','-i','color=c=purple:s=96x64','-frames:v','1','-threads','1']);
 const gif=make('animation.gif',['-f','lavfi','-i','testsrc2=s=96x64:r=5','-t','1','-threads','1']);
 const video=make('video.mp4',['-f','lavfi','-i','testsrc2=s=160x96:r=10','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','mpeg4','-c:a','aac','-threads','1']);
 const audio=make('audio.wav',['-f','lavfi','-i','sine=frequency=440','-t','1','-c:a','pcm_s16le']);
 async function upload(name,mime,bytes,attach=true){const u=await call('POST',`/channels/${channel.id}/uploads`,owner.access_token,{name,size:bytes.length,content_type:mime},[200,201]);const put=await fetch(u.url,{method:'PUT',headers:u.headers,body:bytes});assert.ok(put.ok);await call('POST',`/uploads/${u.id}/complete`,owner.access_token);if(attach)u.message=await call('POST',`/channels/${channel.id}/messages`,owner.access_token,{client_nonce:randomUUID(),content:'',attachment_ids:[u.id]},[200,201]);return u;}
 const image=await upload('image.png','image/png',png,false);
 await call('GET',`/uploads/${image.id}/media`,reader.access_token,undefined,403);
 check('Unattached preview remains owner-only',true);
 const animated=await upload('animation.gif','image/gif',gif);
 const movie=await upload('video.mp4','video/mp4',video);
 const sound=await upload('audio.wav','audio/wav',audio);
 const text=await upload('plain.txt','text/plain',Buffer.from('No preview required'));
 check('Unsupported files explicitly classified',(await call('GET',`/uploads/${text.id}/media`,reader.access_token)).status==='unsupported');
 const malformed=await upload('broken.png','image/png',Buffer.concat([png.subarray(0,24),Buffer.from('deliberately truncated image')]));
 await Promise.all([runWorker(),runWorker()]);
 for(const [u,kind]of[[image,'image'],[animated,'image'],[movie,'video'],[sound,'audio']]){
  const media=await call('GET',`/uploads/${u.id}/media`,owner.access_token);
  check(`${kind} ${u.id}: ready`,media.status==='ready');check(`${kind}: metadata`,media.metadata.kind===kind);
  const thumb=media.derivatives.find(d=>d.kind==='thumbnail');check(`${kind}: thumbnail exists`,thumb?.size>0&&thumb.content_type==='image/jpeg');
  const signed=await call('GET',`/uploads/${u.id}/derivatives/thumbnail`,owner.access_token);const r=await fetch(signed.url);const bytes=Buffer.from(await r.arrayBuffer());check(`${kind}: real private JPEG`,r.ok&&bytes[0]===255&&bytes[1]===216&&bytes.length===thumb.size);
  const publicUrl=new URL(signed.url);publicUrl.search='';check('Unsigned derivative denied',!(await fetch(publicUrl)).ok);
  check('Exclusive claim across two workers',sql(`SELECT attempts FROM media_jobs WHERE upload_id=X'${uuidHex(u.id)}'`)==='1');
 }
 check('Malformed media fails boundedly',(await call('GET',`/uploads/${malformed.id}/media`,owner.access_token)).status==='failed');
 const fast=await call('GET',`/uploads/${movie.id}/derivatives/faststart`,reader.access_token);const fastr=await fetch(fast.url);const fastbytes=Buffer.from(await fastr.arrayBuffer());check('MP4 faststart moov precedes mdat',fastr.ok&&fastbytes.indexOf('moov')>0&&fastbytes.indexOf('moov')<fastbytes.indexOf('mdat'));
 for(const[u,bytes]of[[image,png],[animated,gif],[movie,video],[sound,audio]]){const original=await call('GET',`/uploads/${u.id}/download`,owner.access_token);const got=Buffer.from(await(await fetch(original.url)).arrayBuffer());check('Original bytes preserved',createHash('sha256').update(got).digest('hex')===createHash('sha256').update(bytes).digest('hex'));}
 await call('GET',`/uploads/${movie.id}/media`,outsider.access_token,undefined,403);await call('GET',`/uploads/${movie.id}/derivatives/thumbnail`,outsider.access_token,undefined,403);check('Outsider cannot inspect metadata or derivatives',true);
 await call('PUT',`/channels/${channel.id}/permissions`,owner.access_token,{role_id:null,allow:'0',deny:'1'},204);
 await call('GET',`/uploads/${movie.id}/media`,reader.access_token,undefined,403);await call('GET',`/uploads/${movie.id}/derivatives/faststart`,reader.access_token,undefined,403);check('VIEW revocation covers metadata and derivative signing',true);
 await call('PUT',`/channels/${channel.id}/permissions`,owner.access_token,{role_id:null,allow:'0',deny:'0'},204);
 const storage=Number(sql('SELECT used_bytes FROM harmony_storage_usage'));
 const derived=Number(sql('SELECT COALESCE(sum(d.size),0) FROM media_derivatives d JOIN media_attempts a ON a.id=d.attempt_id WHERE a.state=\'published\''));
 const originals=Number(sql("SELECT COALESCE(sum(size),0) FROM uploads WHERE status='ready' OR (status='pending' AND julianday(expires_at)>julianday('now'))"));
 const reserved=Number(sql('SELECT COALESCE(sum(reserved_bytes),0) FROM media_attempts'));
 check('Quota counts originals plus derivatives and all reservations',storage===originals+derived+reserved&&derived>0);
 const stats=await call('GET','/admin/stats',admin.access_token);check('Admin reports same inclusive storage',stats.storage_bytes===storage);
 const deferred=await upload('quota.png','image/png',png);
 await runWorker({HARMONY_STORAGE_QUOTA_BYTES:String(storage+png.length+1)});
 const waiting=await call('GET',`/uploads/${deferred.id}/media`,owner.access_token);check('Insufficient derivative quota defers without charge or attempt',waiting.status==='queued'&&waiting.error_code==='quota_wait'&&sql(`SELECT attempts FROM media_jobs WHERE upload_id=X'${uuidHex(deferred.id)}'`)==='0');
 sql(`UPDATE media_jobs SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=X'${uuidHex(deferred.id)}'`);await runWorker();check('Deferred work resumes after quota available',(await call('GET',`/uploads/${deferred.id}/media`,owner.access_token)).status==='ready');
 const retry=await upload('retry.png','image/png',png);
 for(let n=1;n<=3;n++){sql(`UPDATE media_jobs SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=X'${uuidHex(retry.id)}'`);await runWorker({HARMONY_STORAGE_BACKEND:'local',HARMONY_STORAGE_DIR:join(dir,'missing-originals')},'--once');check(`Transient retry attempt ${n}`,sql(`SELECT attempts FROM media_jobs WHERE upload_id=X'${uuidHex(retry.id)}'`)===String(n));sql(`UPDATE media_jobs SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE upload_id=X'${uuidHex(retry.id)}'`);await runWorker();}
 check('Three failures are terminal',(await call('GET',`/uploads/${retry.id}/media`,owner.access_token)).status==='failed');await runWorker();check('Failure cleanup releases reservations',sql(`SELECT count(*) FROM media_attempts WHERE upload_id=X'${uuidHex(retry.id)}'`)==='0');
 // A controlled ffprobe barrier lets the test kill or supersede a real worker
 // after claim/download. FFmpeg still renders the actual bytes with its sandbox.
 const barrier=join(dir,'probe-barrier');const source=join(dir,'probe-barrier.c');
 writeFileSync(source,'#include <string.h>\n#include <stdio.h>\n#include <unistd.h>\nint main(int argc,char**argv){if(argc==2 && !strcmp(argv[1],"-version"))return 0;sleep(2);puts("{\\\"streams\\\":[{\\\"codec_type\\\":\\\"video\\\",\\\"width\\\":96,\\\"height\\\":64}],\\\"format\\\":{\\\"format_name\\\":\\\"png_pipe\\\"}}");return 0;}');
 const compile=spawnSync(process.env.CC??'cc',[source,'-o',barrier],{encoding:'utf8'});assert.equal(compile.status,0,compile.stderr);
 const crashed=await upload('restart.png','image/png',png);
 const killed=spawn(worker,['--once'],{env:{...process.env,FFMPEG_PATH:ffmpeg,FFPROBE_PATH:barrier},stdio:'ignore'});
 await until(()=>sql(`SELECT status FROM media_jobs WHERE upload_id=X'${uuidHex(crashed.id)}'`)==='processing');
 const attempt=sql(`SELECT attempt_id FROM media_jobs WHERE upload_id=X'${uuidHex(crashed.id)}'`);
 killed.kill('SIGKILL');await new Promise(r=>killed.once('exit',r));
 sql(`UPDATE media_jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE upload_id=X'${uuidHex(crashed.id)}'`);
 await runWorker();check('Killed worker lease is recovered',(await call('GET',`/uploads/${crashed.id}/media`,owner.access_token)).status==='ready'&&sql(`SELECT attempts FROM media_jobs WHERE upload_id=X'${uuidHex(crashed.id)}'`)==='2');check('Obsolete attempt removed without touching winner',sql(`SELECT count(*) FROM media_attempts WHERE id=X'${uuidHex(attempt)}'`)==='0');
 const fenced=await upload('fencing.png','image/png',png);
 const oldRun=runWorker({FFPROBE_PATH:barrier},'--once');
 await until(()=>sql(`SELECT status FROM media_jobs WHERE upload_id=X'${uuidHex(fenced.id)}'`)==='processing');
 const oldAttempt=sql(`SELECT attempt_id FROM media_jobs WHERE upload_id=X'${uuidHex(fenced.id)}'`);
 sql(`UPDATE media_jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE upload_id=X'${uuidHex(fenced.id)}'`);
 await runWorker();await oldRun;await runWorker();
 check('Live stale worker cannot publish over replacement',(await call('GET',`/uploads/${fenced.id}/media`,owner.access_token)).status==='ready'&&sql(`SELECT attempt_id FROM media_jobs WHERE upload_id=X'${uuidHex(fenced.id)}'`)!==oldAttempt&&sql(`SELECT count(*) FROM media_attempts WHERE upload_id=X'${uuidHex(fenced.id)}'`)==='1');
 const pixels=await upload('pixel-limit.png','image/png',png);await runWorker({WORKER_MAX_PIXELS:'1000'});check('Pixel limit rejects before derivative publication',(await call('GET',`/uploads/${pixels.id}/media`,owner.access_token)).status==='failed'&&sql(`SELECT count(*) FROM media_derivatives d JOIN media_jobs j ON j.attempt_id=d.attempt_id WHERE j.upload_id=X'${uuidHex(pixels.id)}' AND d.ready`)==='0');
 const inputLimited=await upload('input-limit.png','image/png',png);await runWorker({WORKER_MAX_INPUT_BYTES:'1'});check('Input byte limit is enforced',(await call('GET',`/uploads/${inputLimited.id}/media`,owner.access_token)).error_code==='input_limit');
 const removedDuring=await upload('delete-during.png','image/png',png);const deletingRun=runWorker({FFPROBE_PATH:barrier},'--once');await until(()=>sql(`SELECT status FROM media_jobs WHERE upload_id=X'${uuidHex(removedDuring.id)}'`)==='processing');await call('DELETE',`/messages/${removedDuring.message.id}`,owner.access_token,undefined,204);await deletingRun;await runWorker();check('Deletion during processing never publishes output',sql(`SELECT status||':'||error_code FROM media_jobs WHERE upload_id=X'${uuidHex(removedDuring.id)}'`)==='failed:source_deleted'&&sql(`SELECT count(*) FROM media_attempts WHERE upload_id=X'${uuidHex(removedDuring.id)}'`)==='0');
 const deleteUrl=(await call('GET',`/uploads/${animated.id}/derivatives/thumbnail`,reader.access_token)).url;
 await call('DELETE',`/messages/${animated.message.id}`,owner.access_token,undefined,204);
 await call('GET',`/uploads/${animated.id}/media`,reader.access_token,undefined,403);await call('GET',`/uploads/${animated.id}/derivatives/thumbnail`,reader.access_token,undefined,403);await runWorker();check('Deleted message derivatives collected',!(await fetch(deleteUrl)).ok&&sql(`SELECT count(*) FROM media_attempts WHERE upload_id=X'${uuidHex(animated.id)}'`)==='0');
 const idempotent=sql(`SELECT attempt_id FROM media_jobs WHERE upload_id=X'${uuidHex(movie.id)}'`);await runWorker();check('Ready job never reruns or duplicates derivatives',sql(`SELECT attempt_id FROM media_jobs WHERE upload_id=X'${uuidHex(movie.id)}'`)===idempotent);
 const report={status:'PASS',checks:results.length,criteria:results,worker_sha256:createHash('sha256').update(readFileSync(worker)).digest('hex')};mkdirSync('.local/qa-worker',{recursive:true});writeFileSync('.local/qa-worker/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{rmSync(dir,{recursive:true,force:true})}
