import test from 'node:test';
import assert from 'node:assert/strict';
import {collectProbeFailure} from './probe-native.mjs';

test('failure evidence is independent, bounded and collected before any peer stats',async()=>{
 const calls=[],app={cdp:{url:'ws://127.0.0.1/devtools/page/owned',setStage(stage){calls.push(stage);},async evaluate(expression,_gesture,timeout){assert.equal(timeout,2000);assert.equal(expression.includes('getSettings'),false);assert.equal(expression.includes('getStats'),false);throw Error('blocked original renderer');}},fixtureDiagnostic:()=>({output:'WINDOW 42 1280x720 TARGET 30\r\n'}),async sample(timeout){calls.push('stats-read');assert.equal(timeout,2000);throw Error('pending stats');}};
 let closed=false;
 const result=await collectProbeFailure(app,{
  runId:'12345',
  fetcher:async(url,options)=>{assert.equal(url,'http://127.0.0.1:9222/json/list');assert.ok(options.signal);throw Error('HTTP blocked');},
  connect:url=>{assert.equal(url,app.cdp.url);return{setStage(stage){calls.push(stage);},async send(method,params,timeout){assert.equal(timeout,2000);if(method==='Browser.getVersion')throw Error('browser blocked');assert.deepEqual(params,{expression:'1',awaitPromise:false,returnByValue:true});return{result:{value:1}};},close(){closed=true;}};},
  windows:(exe,args,options)=>{calls.push('windows-read');assert.equal(exe,'powershell.exe');assert.equal(options.timeout,8000);assert.equal(options.maxBuffer,150000);assert.equal(args[1],'-EncodedCommand');return{status:null,stdout:'{"kind":"owned_native_windows","windows":[{"handle":42,"enabled":false}]}\r\n'};},
 });
 assert.ok(result.dom_error&&result.captures_error&&result.debugger_error&&result.fresh_browser_error&&result.stats_error);
 assert.deepEqual(result.fresh_renderer,{responded:true});assert.equal(closed,true);
 assert.equal(result.owned_windows.completion,'PARTIAL_OR_UNAVAILABLE');assert.equal(result.owned_windows.records[0].windows[0].handle,42);
 assert.ok(calls.indexOf('windows-read')<calls.indexOf('stats-read'));assert.equal(calls.at(-1),'stats-read');
});
test('successfully collected metadata omits target URLs and browser command lines while using the fresh target',async()=>{
 const secret='DO_NOT_RECORD_PRIVATE_VALUE',app={cdp:{setStage(){},async evaluate(_expression,_gesture,timeout){assert.equal(timeout,2000);return{count:0};}},fixtureDiagnostic:()=>({output:'WINDOW 42 1280x720 TARGET 30\n'}),sample:async()=>({peers:[]})};
 const result=await collectProbeFailure(app,{
  runId:'12345',
  fetcher:async()=>({status:200,json:async()=>[{type:'page',url:'http://tauri.localhost/?token='+secret,webSocketDebuggerUrl:'ws://127.0.0.1/devtools/page/owned'},{type:'other',url:'https://unrelated.example/'+secret}]}),
  connect:url=>{assert.equal(url,'ws://127.0.0.1/devtools/page/owned');return{setStage(){},send:async method=>method==='Browser.getVersion'?{product:'Edg/131',protocolVersion:'1.3',jsVersion:'13',commandLine:secret}:({result:{value:1}}),close(){}};},
  windows:()=>({status:0,stdout:'{"kind":"owned_native_windows","windows":[]}\nnot-json\n{"kind":"unexpected","secret":"'+secret+'"}\n'}),
 });
 assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(result.debugger.targets.length,2);assert.deepEqual(result.stats,{peers:[]});
});
