import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
export const origin='https://harmony.go.altare.global';
export function guard(env=process.env,platform=process.platform,windows=true){
 assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.GITHUB_REPOSITORY,'BersaneV/Harmony');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
 if(windows)assert.equal(platform,'win32');
 assert.match(env.HARMONY_COHORT||`${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}`,/^\d{5,16}_\d{1,3}$/);
 assert.ok((env.HARMONY_EXE_WAN_SEED||'').length>=40,'Private test seed required');
}
export const cohort=()=>process.env.HARMONY_COHORT||`${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}`;
export function identity(index){assert.ok(Number.isInteger(index)&&index>=0&&index<8);return{username:`xw_${cohort()}_${index}`,password:createHmac('sha256',process.env.HARMONY_EXE_WAN_SEED.trim()).update(`${cohort()}:${index}`).digest('hex')};}
export function opaque(value){return createHmac('sha256',process.env.HARMONY_EXE_WAN_SEED.trim()).update(cohort()+':'+value).digest('hex').slice(0,32);}
export function mask(value){if(value)console.log('::add-mask::'+value);}
export async function api(path,token,body){
 assert.ok(path.startsWith('/')&&!path.includes('://'));
 const r=await fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 assert.ok(r.ok,`Owned API ${path.split('?')[0]} returned ${r.status}`);return r.status===204?null:r.json();
}
export async function login(index){const i=identity(index);mask(i.password);const s=await api('/auth/login',null,i);mask(s.access_token);mask(s.refresh_token);assert.equal(s.user.username,i.username);assert.equal(s.user.is_admin,false);return s;}
export async function postControl(token,message){return api(`/channels/${process.env.HARMONY_CONTROL_ID}/messages`,token,{client_nonce:randomUUID(),content:JSON.stringify({lab:'exe-wan',cohort:cohort(),...message})});}
export async function controls(token){const r=await api(`/channels/${process.env.HARMONY_CONTROL_ID}/messages?limit=100`,token);return r.items.flatMap(m=>{try{const p=JSON.parse(m.content);return p.lab==='exe-wan'&&p.cohort===cohort()?[{...p,author_id:m.author.id}]:[]}catch{return[]}});}
