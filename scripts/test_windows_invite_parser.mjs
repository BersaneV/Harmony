// Pure production parser in a known verified WebView host; no new app publication.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {createServer} from 'node:net';
import {build} from 'vite';
import {CDP, until} from './exe-wan/cdp.mjs';
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REPOSITORY,'BersaneV/Harmony');
const exe=resolve(process.argv[2]);assert.ok(exe.startsWith(resolve(process.env.RUNNER_TEMP)+sep));
const directory=await mkdtemp(join(process.env.RUNNER_TEMP,'harmony-invite-parser-'));
await build({root:resolve('apps/desktop'),configFile:false,build:{
  outDir:join(directory,'library'),emptyOutDir:true,minify:false,
  lib:{entry:resolve('apps/desktop/src/lib/invites.ts'),name:'HarmonyInviteParser',formats:['iife'],fileName:()=> 'parser.js'},
}});
const library=await readFile(join(directory,'library/parser.js'),'utf8');
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const child=spawn(exe,[],{env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(directory,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},stdio:'ignore'});
let client;
try {
  let target;await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>['http://tauri.localhost','https://tauri.localhost'].includes(new URL(t.url).origin));return !!target?.webSocketDebuggerUrl}catch{return false}},'owned Tauri origin',60000);
  client=new CDP(target.webSocketDebuggerUrl);
  await until(()=>client.evaluate("!!document.querySelector('[autocomplete=username]')").catch(()=>false),'compiled login UI',30000);
  const result=await client.run(`${library}
    const token='b2'.repeat(32),server='https://harmony.go.altare.global';
    const text=HarmonyInviteParser.nativeInviteLink({server,token});
    const u=new URL(text),s=u.searchParams.get('server');let serverFields;
    try {const v=new URL(s);serverFields={protocol:v.protocol,hostname:v.hostname,pathname:v.pathname,username:v.username,password:v.password,search:v.search,hash:v.hash,origin:v.origin}}catch(e){serverFields={error:String(e)}}
    return {uri:text,parsed:HarmonyInviteParser.parseInvite(text),protocol:u.protocol,hostname:u.hostname,port:u.port,pathname:u.pathname,hash:u.hash,username:u.username,password:u.password,keys:[...u.searchParams.keys()],server:s,tokenLength:u.searchParams.get('code')?.length,serverFields};
  `);
  console.log(JSON.stringify({kind:'production_parser',result}).replace(/[a-f0-9]{64}/g,'<fixture>'));
  assert.ok(result.parsed,'Production parser must accept its own native link in WebView2');
} finally {
  client?.close();
  if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
}
