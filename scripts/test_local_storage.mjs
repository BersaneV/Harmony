// Real HTTP/API + SQLite + private local files. No network service or S3 needed.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {request} from 'node:http';
const root=resolve(import.meta.dirname,'..');
const serverBinary=resolve(process.env.HARMONY_SERVER_BIN??join(root,'target/debug/harmony-server'));
const dir=mkdtempSync(join(tmpdir(),'harmony-files-'));
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,password=`Test-${randomBytes(24).toString('hex')}`,secret=randomBytes(32).toString('hex');
const env={...process.env,DATABASE_URL:`sqlite:${join(dir,'harmony.db')}`,HARMONY_STORAGE_BACKEND:'local',HARMONY_STORAGE_DIR:join(dir,'files'),HARMONY_BIND:`127.0.0.1:${port}`,HARMONY_PUBLIC_API_URL:base,HARMONY_PUBLIC_ORIGIN:base,HARMONY_JWT_SECRET:secret,HARMONY_BOOTSTRAP_USERNAME:'storage_admin',HARMONY_BOOTSTRAP_PASSWORD:password,HARMONY_STORAGE_QUOTA_BYTES:String(1024*1024*1024),HARMONY_TEST_URL:base,WORKER_TEMP_DIR:join(dir,'worker'),RUST_LOG:'warn'};
for(const key of Object.keys(env))if(key.startsWith('S3_')||key.startsWith('LIVEKIT_')||key==='HARMONY_WEB_DIR')delete env[key];
mkdirSync(env.WORKER_TEMP_DIR,{mode:0o700});
let child,logs='';const checks=[];
function check(name,value){assert.ok(value,name);checks.push(name);}
async function start(extra={}){child=spawn(serverBinary,[],{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});for(const stream of[child.stdout,child.stderr])stream.on('data',d=>{logs=(logs+d).slice(-10000)});for(let n=0;n<200;n++){try{if((await fetch(`${base}/health`)).ok)return}catch{}if(child.exitCode!=null)throw new Error(`API failed: ${logs}`);await new Promise(r=>setTimeout(r,50));}throw new Error('API start timeout');}
async function stop(){if(!child||child.exitCode!=null)return;child.kill('SIGINT');await new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('API stop timeout'))},15000);child.once('exit',()=>{clearTimeout(t);resolve()})});}
async function api(method,path,token,body,expected=200){const r=await fetch(`${base}/api${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await r.text();let data;try{data=text?JSON.parse(text):null}catch{throw new Error(`Non JSON ${path}: ${r.status}`)}assert.ok([expected].flat().includes(r.status),`${method} ${path}: ${r.status} ${data?.error?.code??''}`);return data;}
function altered(url,change){const parsed=new URL(url);const [head,body]=parsed.searchParams.get('token').split('.');const payload=JSON.parse(Buffer.from(body,'base64url'));change(payload);const next=`${head}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;parsed.searchParams.set('token',`${next}.${createHmac('sha256',secret).update(next).digest('base64url')}`);return parsed.href;}
try{
 await start();
 // Prove the real API's shared maintenance lease blocks an offline importer.
 const legacyEnv=join(dir,'source.env'), migrationOutput=join(dir,'migration-attempt');
 writeFileSync(legacyEnv,'S3_ENDPOINT=http://127.0.0.1:1\nS3_BUCKET=fixture\nS3_ACCESS_KEY=fixture\nS3_SECRET_KEY=fixture\n',{mode:0o600});
 const migration=spawnSync('python3',[join(root,'scripts/migrate-s3-to-local.py'),'--database',join(dir,'harmony.db'),'--source-env',legacyEnv,'--output',migrationOutput,'--snapshot-only'],{cwd:root,encoding:'utf8',timeout:10000});
 check('Running API blocks offline object migration',migration.status!==0&&migration.stderr.includes('database_is_running')&&!existsSync(migrationOutput));
 const admin=await api('POST','/auth/login',null,{username:'storage_admin',password});
 const invite=await api('POST','/admin/invites',admin.access_token,{max_uses:3,expires_hours:1},[200,201]);
 const accounts=[];for(const name of['owner','reader','outsider'])accounts.push(await api('POST','/auth/register',null,{username:`storage_${name}`,display_name:name,password,invite_token:invite.token},[200,201]));
 const[owner,reader,outsider]=accounts;
 const guild=await api('POST','/guilds',owner.access_token,{name:'Local files'},[200,201]);
 const channel=await api('POST',`/guilds/${guild.id}/channels`,owner.access_token,{name:'files',kind:'text'},[200,201]);
 const invitation=await api('POST',`/guilds/${guild.id}/invites`,owner.access_token,{max_uses:1,expires_hours:1},[200,201]);
 await api('POST','/invites/accept',reader.access_token,{token:invitation.token},[200,201]);
 const bytes=Buffer.alloc(256*1024,0x61);
 async function reserve(bytes,name='sample.txt',mime='text/plain',person=owner){return api('POST',`/channels/${channel.id}/uploads`,person.access_token,{name,size:bytes.length,content_type:mime},[200,201]);}
 const original=await reserve(bytes);
 check('Upload capability uses same API origin',new URL(original.url).origin===base);
 check('PUT streams more than JSON body limit',(await fetch(original.url,{method:'PUT',headers:original.headers,body:bytes})).status===204);
 const unsigned=new URL(original.url);unsigned.search='';check('Unsigned PUT denied',!(await fetch(unsigned,{method:'PUT',headers:original.headers,body:bytes})).ok);
 check('Wrong declared size denied',(await fetch(original.url,{method:'PUT',headers:original.headers,body:Buffer.from('wrong')})).status===400);
 check('Wrong content type denied',(await fetch(original.url,{method:'PUT',headers:{'Content-Type':'image/png'},body:bytes})).status===400);
 const tampered=new URL(original.url);tampered.searchParams.set('token',tampered.searchParams.get('token').slice(0,-8)+'abcdefgh');check('Tampered signature denied',(await fetch(tampered,{method:'PUT',headers:original.headers,body:bytes})).status===401);
 const expired=altered(original.url,p=>p.exp=Math.floor(Date.now()/1000)-1);check('Expired capability denied',(await fetch(expired,{method:'PUT',headers:original.headers,body:bytes})).status===401);
 const cross=new URL(original.url);cross.pathname=cross.pathname.replace(original.id,randomUUID());check('Capability bound to upload',(await fetch(cross,{method:'PUT',headers:original.headers,body:bytes})).status===403);
 // Hold a PUT body open while completing the already-received upload.
 let finishLate;const late=new Promise((resolve,reject)=>{const req=request(original.url,{method:'PUT',headers:{...original.headers,'Content-Length':bytes.length}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))});req.on('error',reject);req.write(bytes.subarray(0,1));finishLate=()=>req.end(bytes.subarray(1));});
 await new Promise(r=>setTimeout(r,100));
 await api('POST',`/uploads/${original.id}/complete`,owner.access_token);
 finishLate();check('In-flight PUT cannot overwrite finalized object',(await late)===409);
 check('Post-complete PUT denied',(await fetch(original.url,{method:'PUT',headers:original.headers,body:bytes})).status===409);
 await api('POST',`/uploads/${original.id}/complete`,owner.access_token);check('Complete is idempotent',true);
 await api('GET',`/uploads/${original.id}/download`,reader.access_token,undefined,403);check('Unattached original remains owner-only',true);
 const message=await api('POST',`/channels/${channel.id}/messages`,owner.access_token,{client_nonce:randomUUID(),content:'',attachment_ids:[original.id]},[200,201]);
 const signed=await api('GET',`/uploads/${original.id}/download`,reader.access_token);
 const response=await fetch(signed.url);check('Private original bytes preserved',Buffer.from(await response.arrayBuffer()).equals(bytes));
 check('Private response is not cacheable',response.headers.get('cache-control').includes('no-store'));
 const part=await fetch(signed.url,{headers:{Range:'bytes=10-19'}});check('Byte seeking returns 206 and correct size',part.status===206&&part.headers.get('content-range')===`bytes 10-19/${bytes.length}`&&Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10,20)));
 const tail=await fetch(signed.url,{headers:{Range:'bytes=-11'}});check('Suffix range supported',tail.status===206&&(await tail.arrayBuffer()).byteLength===11);
 check('Invalid range bounded',(await fetch(signed.url,{headers:{Range:'bytes=999999999-'}})).status===416);
 await api('GET',`/uploads/${original.id}/download`,outsider.access_token,undefined,403);check('Non-member denied',true);
 check('File token cannot authenticate API',(await fetch(`${base}/api/me`,{headers:{Authorization:`Bearer ${new URL(signed.url).searchParams.get('token')}`}})).status===401);
 await api('PUT',`/channels/${channel.id}/permissions`,owner.access_token,{role_id:null,allow:'0',deny:'1'},204);
 check('Already-issued URL respects VIEW revocation',(await fetch(signed.url)).status===403);
 await api('PUT',`/channels/${channel.id}/permissions`,owner.access_token,{role_id:null,allow:'0',deny:'0'},204);
 const pendingReader=await reserve(Buffer.from('reader'),'reader.txt','text/plain',reader);
 await api('PUT',`/channels/${channel.id}/permissions`,owner.access_token,{role_id:null,allow:'0',deny:'4'},204);
 check('Already-issued upload respects ATTACH revocation',(await fetch(pendingReader.url,{method:'PUT',headers:pendingReader.headers,body:Buffer.from('reader')})).status===403);
 await api('PUT',`/channels/${channel.id}/permissions`,owner.access_token,{role_id:null,allow:'0',deny:'0'},204);
 const spoof=await reserve(Buffer.from('<html>invalid</html>'),'spoof.png','image/png');await fetch(spoof.url,{method:'PUT',headers:spoof.headers,body:Buffer.from('<html>invalid</html>')});
 await api('POST',`/uploads/${spoof.id}/complete`,owner.access_token,undefined,400);check('MIME mismatch rejected',true);
 await api('GET',`/uploads/${spoof.id}/download`,owner.access_token,undefined,404);check('Rejected objects never exposed',true);
 await stop();await start();
 const persisted=await api('GET',`/uploads/${original.id}/download`,owner.access_token);check('Database and objects survive restart',Buffer.from(await(await fetch(persisted.url)).arrayBuffer()).equals(bytes));
 await api('POST',`/admin/users/${reader.user.id}/reset`,admin.access_token,{password});
 check('Already-issued download revoked by password reset',(await fetch(signed.url)).status===401);
 check('Already-issued upload revoked by password reset',(await fetch(pendingReader.url,{method:'PUT',headers:pendingReader.headers,body:Buffer.from('reader')})).status===401);
 const ownerSigned=await api('GET',`/uploads/${original.id}/download`,owner.access_token);
 await api('DELETE',`/messages/${message.id}`,owner.access_token,undefined,204);check('Already-issued URL denied after message deletion',(await fetch(ownerSigned.url)).status===403);
 check('No abandoned staging remains',readdirSync(env.HARMONY_STORAGE_DIR).every(name=>!name.startsWith('.stage-')));
 if(process.env.HARMONY_TEST_WORKER==='true'){
  const r=spawnSync(process.execPath,[join(root,'scripts/test_worker.mjs')],{cwd:root,env:{...env,FFMPEG_PATH:process.env.FFMPEG_PATH,FFPROBE_PATH:process.env.FFPROBE_PATH},encoding:'utf8',timeout:240000,maxBuffer:2*1024*1024});assert.equal(r.status,0,`Worker integration: ${r.stderr}\n${r.stdout}`);check('Worker regressions pass against local files',true);
 }
 await stop();
 const report={status:'PASS',checks:checks.length,criteria:checks,server_sha256:createHash('sha256').update(readFileSync(serverBinary)).digest('hex')};mkdirSync(join(root,'.local/qa-local-storage'),{recursive:true});writeFileSync(join(root,'.local/qa-local-storage/result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
