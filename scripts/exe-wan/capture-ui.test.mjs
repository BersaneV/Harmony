import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {captureMode,fixtureScript,fixtureReady,assertOwnedCapture,assertCaptureMeasurement,summarizeNativeSource,chooseScreenUi} from './capture-ui.mjs';
import {getProfile} from './profiles.mjs';
import {observe} from './observe.mjs';
const profile=getProfile('1440p60');
const native=()=>({index:0,kind:'native',ready:'live',label:'native-window:42',backend:'native-wgc',settings_source:'native-frame-metadata',settings:{width:2560,height:1440},track_settings:{},track_id:'actual-generator'});

test('legacy releases retain browser capture, while only the explicit new 60 FPS release uses layered WGC',()=>{
 for(const release of ['0.4.1','0.4.2']){assert.equal(captureMode(release,profile),'browser');assert.equal(fixtureScript(release,profile),'window.ps1');}
 assert.equal(captureMode('0.4.3',getProfile('720p30')),'browser');
 assert.equal(captureMode('0.4.3',profile),'native');assert.equal(fixtureScript('0.4.3',profile),'window-layered.ps1');
 assert.equal(captureMode('0.4.4',profile),'native');
 assert.equal(captureMode('0.4.4',getProfile('720p30')),'browser');
 assert.equal(captureMode('0.4.5',profile),'native');
 assert.equal(captureMode('0.4.5',getProfile('720p30')),'browser');
 assert.throws(()=>captureMode('0.4.6',profile),/Unsupported pinned/);
});
test('capture identity rejects another HWND, backend, missing live track and reduced dimensions',()=>{
 assertOwnedCapture(native(),42,profile,'native');
 for(const bad of [{label:'native-window:43'},{backend:'native-gdi'},{kind:'browser'},{ready:'ended'},{settings:{width:1280,height:720}}])assert.throws(()=>assertOwnedCapture({...native(),...bad},42,profile,'native'));
 assert.throws(()=>assertOwnedCapture(native(),0,profile,'native'));
});
test('measurement cannot round up FPS, fall back to display FPS, or compare a cropped intersection',()=>{
 const value={pixel_width:2560,pixel_height:1440,sampled_sizes:['2560x1440'],light_pixels:14341,colored_pixels:14341,processor_source_fps:54,distinct_marker_fps:54,measured_fps:120};
 assertCaptureMeasurement(value,profile,'native');
 for(const bad of [{processor_source_fps:53.999},{distinct_marker_fps:53.732},{processor_source_fps:null},{pixel_width:1024},{pixel_height:768},{sampled_sizes:['2560x1440','1280x720']},{colored_pixels:13680}])assert.throws(()=>assertCaptureMeasurement({...value,...bad},profile,'native'));
});
function samples(){return Array.from({length:61},(_,i)=>({segment:'steady',sample:{at:i*3000,captures:[{...native(),processor_status:'running',processor_frames:i*3*54,distinct_marker_frames:i*3*54,marker_copy_errors:0,processor_error:null,processor_sizes:['2560x1440']}]}}));}
test('180-second source gate requires actual counters, one stable native track, exact size and the unchanged 54 FPS gate',()=>{
 assert.equal(summarizeNativeSource(samples(),profile).status,'PASS');
 const low=samples();low.at(-1).sample.captures[0].processor_frames--;assert.equal(summarizeNativeSource(low,profile).status,'FAIL');
 for(const mutate of [s=>s[5].sample.captures.push(native()),s=>s[5].sample.captures[0].processor_status='error',s=>s[5].sample.captures[0].processor_sizes.push('1280x720'),s=>s[5].sample.captures[0].track_id='replaced',s=>s[0].sample.captures[0].processor_frames=null,s=>s[5].sample.captures[0].processor_frames=null,s=>s[5].sample.captures[0].processor_frames=1]){const rows=samples();mutate(rows);assert.equal(summarizeNativeSource(rows,profile).status,'FAIL');}
 assert.equal(summarizeNativeSource(samples().slice(1),profile).status,'FAIL');
});
test('60 delivered FPS with only 30 distinct marker FPS fails the sustained source gate',()=>{
 const rows=samples();for(const row of rows){const c=row.sample.captures[0];c.processor_frames=row.sample.at/1000*60;c.distinct_marker_frames=row.sample.at/1000*30;}
 const result=summarizeNativeSource(rows,profile);assert.equal(result.source_fps,60);assert.equal(result.distinct_marker_fps,30);assert.equal(result.status,'FAIL');
 for(const bad of [{distinct_marker_frames:null},{marker_copy_errors:1},{processor_error:'pixel copy failed'},{distinct_marker_frames:1}]){const broken=samples();Object.assign(broken[5].sample.captures[0],bad);assert.equal(summarizeNativeSource(broken,profile).status,'FAIL');}
});
function fakeApp(mode='native',ownedOption=true){
 const actions=[],expressions=[];const capture=mode==='native'?native():{...native(),kind:'browser',backend:'browser-getDisplayMedia',label:'window:42:0',settings_source:'browser-track',settings:{width:2560,height:1440,displaySurface:'window'}};
 return{actions,expressions,ensureFixture:async()=>actions.push('fixture'),select:async(...args)=>actions.push(args),click:async text=>actions.push(text),ownedWindow:async()=>42,cdp:{evaluate:async expression=>{expressions.push(expression);if(expression.includes('captureSnapshots().filter'))return[capture];if(expression.includes("'dialog[open]'")&&expression.includes('.some('))return ownedOption;return true;}}};
}
const immediate=async(predicate,label)=>{if(!await predicate())throw Error(label);};
test('native UI helper chooses the exact option before confirming, without invoking product IPC or capture APIs',async()=>{
 const app=fakeApp();let consent;
 const value=await chooseScreenUi(app,profile,{release:'0.4.3',title:'HarmonyWAN-12345',wait:immediate,confirm:async title=>{consent=title;app.actions.push('native consent');return{status:0};}});
 assert.equal(value.mode,'native');assert.equal(consent,'HarmonyWAN-12345');assert.deepEqual(app.actions,['fixture',['Método de captura','auto'],'Escolher tela ou janela','Confirmar janela','native consent']);
 assert.ok(app.expressions.every(s=>!s.includes('native_capture_start')&&!s.includes('getDisplayMedia(')&&!s.includes('import(')));
});
test('missing exact owned option fails before native consent and never picks another source',async()=>{
 const app=fakeApp('native',false);let consent=false;
 await assert.rejects(chooseScreenUi(app,profile,{release:'0.4.3',title:'HarmonyWAN-12345',wait:immediate,confirm:async()=>{consent=true;}}),/exact owned option/);
 assert.equal(consent,false);assert.ok(!app.actions.includes('Confirmar janela'));
});
test('0.4.2 helper retains the browser button path without native confirmation',async()=>{
 const app=fakeApp('browser');await chooseScreenUi(app,profile,{release:'0.4.2',title:'HarmonyWAN-12345',wait:immediate,confirm:async()=>assert.fail('native confirmation forbidden')});
 assert.deepEqual(app.actions,['fixture','Escolher tela ou janela']);
});
test('passive native observation preserves raw track settings separately from frame metadata and refuses to fabricate source counters',()=>{
 const listeners=new Map();const context={location:{origin:'http://tauri.localhost'},performance:{now:()=>0},navigator:{mediaDevices:{getUserMedia:async()=>({getAudioTracks:()=>[]}),getDisplayMedia:async()=>({getVideoTracks:()=>[]})}},window:{__TAURI_INTERNALS__:{},RTCPeerConnection:class{},addEventListener:(name,listener)=>listeners.set(name,listener)}};
 vm.runInNewContext(`(${observe.toString()})()`,context);
 let width=2560;const track={kind:'video',id:'actual-track',label:'',readyState:'live',getSettings:()=>({})};
 listeners.get('harmony-native-screen')({detail:{track,label:'native-window:42',backend:'native-wgc',settings:()=>({width,height:1440})}});
 const read=()=>context.window.__exeWan.captureSnapshots()[0];assert.equal(read().settings.width,2560);width=1920;assert.equal(read().settings.width,1920);assert.equal(Object.keys(read().track_settings).length,0);assert.equal(read().processor_status,'unsupported');assert.equal(read().processor_frames,0);
});

test('fixture readiness accepts the real native lifetime suffix and preserves exact dimensions and FPS',()=>{
 const line='WINDOW 66186 1920x1080 TARGET 60 SOURCE native-layered-dib LIFETIME_SECONDS 600\r\nPAINT 300 ELAPSED_MS 5055\r\n',p=getProfile('1080p60');
 assert.equal(fixtureReady(line,p,'native'),true);
 for(const bad of [line.replace('1920x1080','960x540'),line.replace('TARGET 60','TARGET 30'),line.replace('LIFETIME_SECONDS 600','LIFETIME_SECONDS 60'),line.replace(' SOURCE native-layered-dib',' SOURCE other')])assert.equal(fixtureReady(bad,p,'native'),false);
 assert.equal(fixtureReady('PHYSICAL_WINDOW 1280x720 DWM 1280x720\r\nWINDOW 197048 1280x720 TARGET 30\r\n',getProfile('720p30'),'browser'),true);
});
