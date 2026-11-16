// Isolated QA experiment against the pinned, unmodified 0.4.4 executable.
// Only the compiled UI requests capture. This experiment varies GDM constraints
// and, in phase two, explicitly applies constraints to that same owned preview.
// It never imports product TS, invokes capture IPC, publishes or changes a sender.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {session} from './session.mjs';
import {CDP, until, delay} from './cdp.mjs';
import {guard, cohort, identity, origin, mask, ownedSession, api} from './lab.mjs';
import {assertCallRoute} from './fixture-contract.mjs';

export const diagnosticVariants = Object.freeze(['baseline', 'width_max', 'width_ideal_max', 'height_ideal_only']);
export const postFrameVariants = Object.freeze(['post_frame_max', 'post_frame_ideal_max']);

// Self-contained for injection into the owned shipped WebView and VM tests.
export function installCaptureDiagnostic() {
  if (!window.__TAURI_INTERNALS__ || location.origin !== 'http://tauri.localhost') throw Error('Owned compiled page required');
  if (window.__browserCaptureDiagnostic) throw Error('Diagnostic already installed');
  const media = navigator.mediaDevices, original = media.getDisplayMedia;
  const records = [], variants = ['baseline', 'width_max', 'width_ideal_max', 'height_ideal_only', 'post_frame_max', 'post_frame_ideal_max'];
  let selected = null, requesting = false;
  const safeValue = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return /^[a-z-]{1,40}$/.test(value) ? value : '[omitted]';
    if (Array.isArray(value)) return value.slice(0,12).map(safeValue);
    if (!value || typeof value !== 'object') return null;
    return Object.fromEntries(['ideal', 'max', 'min', 'exact'].filter(k => value[k] !== undefined).map(k => [k, safeValue(value[k])]));
  };
  const fields = value => Object.fromEntries(['width', 'height', 'frameRate', 'aspectRatio', 'resizeMode', 'cursor', 'displaySurface', 'logicalSurface']
    .filter(k => value?.[k] !== undefined).map(k => [k, safeValue(value[k])]));
  const optionsView = value => ({video: fields(value.video), audio: value.audio === true,
    ...Object.fromEntries(['selfBrowserSurface', 'systemAudio', 'surfaceSwitching'].filter(k => value[k] !== undefined).map(k => [k, safeValue(value[k])]))});
  const read = getter => {try {return fields(getter());} catch (error) {return {unavailable: true, error_name: String(error?.name || 'Error').slice(0,40)};}};
  const trackView = track => ({track_id: track.id, ready: track.readyState, muted: track.muted, enabled: track.enabled,
    settings: read(() => track.getSettings()), constraints: read(() => track.getConstraints()), capabilities: read(() => track.getCapabilities())});
  const allEnded = () => records.every(r => !r.tracks || r.tracks.every(t => t.readyState === 'ended'));
  const qa = window.__browserCaptureDiagnostic = {
    configure(variant, handle) {
      if (!variants.includes(variant)) throw Error('Unknown diagnostic variant');
      if (!Number.isSafeInteger(handle) || handle <= 0) throw Error('Owned fixture HWND required');
      if (requesting || !allEnded()) throw Error('Previous live capture must be cancelled through the UI');
      selected = {variant, handle};
    },
    snapshot() {
      return records.map(r => ({variant: r.variant, owned_window_handle: r.handle, requested_at: r.requested_at,
        returned_at: r.returned_at ?? null, options_before: r.options_before, options_effective: r.options_effective,
        pending: r.returned_at === undefined && !r.error,
        initial: r.initial ?? null, current: r.track ? trackView(r.track) : null, error: r.error ?? null,
        ...(r.post_frame ? {post_frame: r.post_frame} : {})}));
    },
    async applyObservedConstraints() {
      const row = records.at(-1);
      if (!row || !['post_frame_max', 'post_frame_ideal_max'].includes(row.variant)) throw Error('Explicit post-frame variant required');
      if (requesting || !row.track || row.track.readyState !== 'live' || row.track.label !== `window:${row.handle}:0` || row.track.getSettings().displaySurface !== 'window') throw Error('Live owned preview required');
      if (performance.now() - row.returned_at < 5000) throw Error('Observe the compiled preview for five seconds before applying constraints');
      if (row.post_frame) throw Error('Post-frame constraints already applied');
      const videos = [...document.querySelectorAll('.share-preview video')].filter(v => v.srcObject?.getVideoTracks?.().some(t => t.id === row.track.id));
      const video = videos[0];
      if (videos.length !== 1 || video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw Error('A current owned video frame is required');
      const width = Math.round(720 * video.videoWidth / video.videoHeight);
      if (!Number.isSafeInteger(width) || width <= 0 || width > 8192) throw Error('Observed frame aspect ratio is outside the diagnostic bounds');
      const constraints = row.variant === 'post_frame_max'
        ? {width: {max: width}, height: {max: 720}, frameRate: {max: 30}}
        : {width: {ideal: 1280, max: 1280}, height: {ideal: 720, max: 720}, frameRate: {max: 30}};
      const experiment = row.post_frame = {before: trackView(row.track), video_before: {width: video.videoWidth, height: video.videoHeight, ready_state: video.readyState}, constraints: fields(constraints), started_at: performance.now()};
      try {
        await row.track.applyConstraints(constraints);
        experiment.completed_at = performance.now(); experiment.after = trackView(row.track);
        return experiment;
      } catch (error) {experiment.error_name = String(error?.name || 'Error').slice(0,40); throw error;}
    },
    restore() {
      if (requesting || !allEnded()) throw Error('Previous live capture must be cancelled through the UI');
      media.getDisplayMedia = original;
      selected = null;
      return true;
    },
  };
  media.getDisplayMedia = async options => {
    if (!selected || requesting) throw Error('Diagnostic capture must be configured');
    if (options?.audio !== false || !options.video || typeof options.video !== 'object') throw Error('Compiled capture must keep audio disabled');
    if (options.video.height?.ideal !== 720 || options.video.height?.max !== 720 || options.video.frameRate?.ideal !== 30 || options.video.frameRate?.max !== 30 || options.video.width !== undefined) throw Error('Expected pinned compiled height-only 720p30 options');
    const input = structuredClone(options), effective = structuredClone(options), choice = {...selected};
    if (choice.variant === 'width_max') effective.video.width = {max: 8192};
    if (choice.variant === 'width_ideal_max') effective.video.width = {ideal: 8192, max: 8192};
    if (choice.variant === 'height_ideal_only') {
      if (effective.video.height?.ideal !== 720 || effective.video.height?.max !== 720) throw Error('Expected compiled 720p height constraints');
      delete effective.video.height.max;
    }
    const row = {variant: choice.variant, handle: choice.handle, requested_at: performance.now(), options_before: optionsView(input), options_effective: optionsView(effective)};
    records.push(row); requesting = true;
    try {
      const stream = await original.call(media, effective), videos = stream.getVideoTracks();
      row.tracks = stream.getTracks();
      const track = videos[0];
      if (videos.length !== 1 || stream.getAudioTracks().length !== 0 || track.label !== `window:${choice.handle}:0` || track.getSettings().displaySurface !== 'window') {
        for (const captured of row.tracks) captured.stop();
        row.error = 'owned_source_mismatch';
        throw Error('Owned browser source HWND mismatch or unexpected audio');
      }
      row.track = track; row.returned_at = performance.now(); row.initial = trackView(track);
      return stream;
    } catch (error) {
      if (!row.track) for (const captured of row.tracks || []) captured.stop();
      row.error ||= String(error?.name || 'Error').slice(0,40);
      throw error;
    } finally {requesting = false;}
  };
  return true;
}

// Restricts SetWindowPos to the same fixture handle/title and the two authorized
// sizes. Native rectangles are returned even when the OS declines the resize.
export function ownedResizeScript(handle, width, height, title, resize = true) {
  assert.ok(Number.isSafeInteger(handle) && handle > 0, 'Exact owned HWND required');
  assert.ok((width === 640 && height === 360) || (width === 1280 && height === 720), 'Only diagnostic shrink and restore sizes are authorized');
  assert.match(title, /^HarmonyWAN-[0-9]+$/, 'Exact owned fixture title required');
  assert.equal(typeof resize,'boolean','Explicit native resize or read-only geometry required');
  return `$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony') { throw 'Owned disposable runner required' }
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class HarmonyBrowserDiagnosticWindow {
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
 public class Geometry { public long handle; public bool resize_requested,set_window_pos; public int win32_error; public int window_width,window_height,dwm_width,dwm_height; }
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder title,int count);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attribute,out Rect rect,int size);
 public static Geometry Resize(long id,int width,int height,string expectedTitle,bool apply) {
  var hwnd=new IntPtr(id); var title=new StringBuilder(256); GetWindowText(hwnd,title,title.Capacity);
  if(!IsWindow(hwnd)||!String.Equals(title.ToString(),expectedTitle,StringComparison.Ordinal)) throw new InvalidOperationException("Owned HWND/title mismatch");
  var dpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
  if(dpi==IntPtr.Zero) throw new InvalidOperationException("Physical DPI context unavailable");
  try {
   bool changed=apply&&SetWindowPos(hwnd,IntPtr.Zero,0,0,width,height,0x0016); int error=apply&&!changed?Marshal.GetLastWin32Error():0; Rect actual,dwm;
   var clock=System.Diagnostics.Stopwatch.StartNew();
   while(true) {
    if(!GetWindowRect(hwnd,out actual)||DwmGetWindowAttribute(hwnd,9,out dwm,Marshal.SizeOf(typeof(Rect)))<0) throw new InvalidOperationException("Native source geometry unavailable");
    if(!apply||!changed||clock.ElapsedMilliseconds>=2000||(actual.Right-actual.Left==width&&actual.Bottom-actual.Top==height&&dwm.Right-dwm.Left==width&&dwm.Bottom-dwm.Top==height)) break;
    System.Threading.Thread.Sleep(40);
   }
   return new Geometry {handle=id,resize_requested=apply,set_window_pos=changed,win32_error=error,window_width=actual.Right-actual.Left,window_height=actual.Bottom-actual.Top,dwm_width=dwm.Right-dwm.Left,dwm_height=dwm.Bottom-dwm.Top};
  } finally {SetThreadDpiAwarenessContext(dpi);}
 }
}
'@
[HarmonyBrowserDiagnosticWindow]::Resize(${handle},${width},${height},'${title}',$${resize ? 'true' : 'false'}) | ConvertTo-Json -Compress`;
}

function resizeOwnedFixture(handle, width, height, resize = true) {
  const script = ownedResizeScript(handle,width,height,'HarmonyWAN-'+process.env.GITHUB_RUN_ID,resize);
  const result = spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:8000});
  assert.equal(result.status,0,'Owned fixture SetWindowPos/geometry diagnostic failed');
  return JSON.parse(result.stdout.trim());
}

const exactGeometry = (value,width,height) => (value?.resize_requested === false || value?.set_window_pos === true) && value.window_width === width && value.window_height === height && value.dwm_width === width && value.dwm_height === height;

const domExpression = `(()=>{const d=[...document.querySelectorAll('dialog[open]')].find(d=>d.querySelector('h2')?.textContent==='Compartilhar sua tela');const v=d?.querySelector('.share-preview video');return{sharing_open:!!d,preview:v?{ready_state:v.readyState,width:v.videoWidth,height:v.videoHeight,paused:v.paused,error_code:v.error?.code??null}:null,buttons:d?[...d.querySelectorAll('button')].map(b=>({text:b.textContent.trim().slice(0,80),disabled:b.disabled})):[],alerts:[...document.querySelectorAll('.error-banner,[role=alert]')].map(e=>e.textContent.slice(0,180))}})()`;
const errorView = error => ({name: String(error?.name || 'Error').slice(0,40), message: String(error?.message || error).slice(0,500)
  .replace(/(?:https?|wss?):\/\/\S+/g,'[url]').replace(/\beyJ[A-Za-z0-9_.-]+/g,'[token]')});

async function independentDiagnostics(app) {
  const out = {};
  // Never await getStats before collecting basic DOM evidence.
  try {out.dom = await app.cdp.evaluate(domExpression, false, 2000);} catch (error) {out.dom_error = errorView(error);}
  try {out.capture_records = await app.cdp.evaluate('__browserCaptureDiagnostic?.snapshot()', false, 2000);} catch (error) {out.capture_error = errorView(error);}
  try {
    const response = await fetch('http://127.0.0.1:9222/json/list', {signal: AbortSignal.timeout(2000)});
    const targets = await response.json();
    out.debugger = {status: response.status, targets: targets.map(t => ({type: t.type, owned: /^https?:\/\/tauri\.localhost(?:\/|$)/.test(t.url)}))};
    const target = targets.find(t => /^https?:\/\/tauri\.localhost(?:\/|$)/.test(t.url));
    if (target?.webSocketDebuggerUrl) {
      const fresh = new CDP(target.webSocketDebuggerUrl);
      try {
        const bounded = (work, label) => Promise.race([work, delay(2200).then(() => {throw Error(label);})]);
        try {out.browser = await bounded(fresh.send('Browser.getVersion', {}, 2000), 'fresh browser timeout');} catch (error) {out.browser_error = errorView(error);}
        try {out.renderer = await bounded(fresh.send('Runtime.evaluate', {expression: '1', awaitPromise: false, returnByValue: true}, 2000), 'fresh renderer timeout');} catch (error) {out.renderer_error = errorView(error);}
      } finally {fresh.close();}
    }
  } catch (error) {out.debugger_error = errorView(error);}
  const processes = spawnSync('powershell.exe', ['-NoProfile','-Command', `Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('harmony-desktop.exe','msedgewebview2.exe')} | ForEach-Object {$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [ordered]@{name=$_.Name;pid=$_.ProcessId;parent=$_.ParentProcessId;responding=$p.Responding;cpu_seconds=$p.CPU;working_set=$p.WorkingSet64}} | ConvertTo-Json -Compress`], {encoding:'utf8', timeout:5000});
  try {out.processes = JSON.parse(processes.stdout);} catch {out.process_snapshot = 'unavailable';}
  return out;
}

export async function runDiagnostic() {
  const result = {kind: 'browser_capture_diagnostic', status: 'DIAGNOSTIC', completion: 'RUNNING', capacity_approval: false,
    scope: 'Same pinned published EXE 0.4.4, VM and owned physical 1280x720 HWND; compiled preview UI only. GDM and explicit owned post-frame constraint variants are an experiment, not a product fix or media capacity PASS. Optional 640x360 shrink retains the same constraints and restores 1280x720.', stages: [], variants: []};
  let app, currentStage = 'guard';
  const stage = async (label, operation) => {
    currentStage = label;
    const row = {label, started_utc: new Date().toISOString(), started_ms: performance.now()}; result.stages.push(row);
    console.log('HARMONY_BROWSER_CAPTURE_STAGE '+JSON.stringify({label,state:'started',at:row.started_utc}));
    try {const value = await operation(); row.elapsed_ms = performance.now()-row.started_ms; row.state = 'completed'; return value;}
    catch (error) {row.elapsed_ms = performance.now()-row.started_ms; row.state = 'failed'; throw error;}
  };
  const cancelPreview = async () => {
    await app.cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog[open]')].find(d=>d.querySelector('h2')?.textContent==='Compartilhar sua tela');const b=d&&[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancelar');if(!b)throw Error('Compiled cancel button missing');b.click();return true})()`, true, 5000);
    await until(() => app.cdp.evaluate(`!document.querySelector('.share-preview video')&&__browserCaptureDiagnostic.snapshot().every(r=>!r.pending&&(!r.current||r.current.ready==='ended'))`, false, 2000), 'compiled UI released every preview track', 6000);
  };
  const captureAndDom = () => app.cdp.evaluate(`({capture:__browserCaptureDiagnostic.snapshot().at(-1),dom:${domExpression}})`,false,2000);
  const checkResize = async (row,index,handle) => {
    const experiment = row.resize_experiment = {status:'DIAGNOSTIC',completion:'RUNNING',constraints_before:row.after_measurement.capture.current.constraints};
    try {
      assert.equal(await app.ownedWindow(),handle,'Owned fixture handle changed before resize');
      experiment.shrink_geometry = await stage(row.variant+':shrink_owned_640x360',async()=>resizeOwnedFixture(handle,640,360));
      assert.ok(exactGeometry(experiment.shrink_geometry,640,360),'OS did not establish exact 640x360 window and DWM rectangles');
      await stage(row.variant+':shrink_settle_5s',()=>delay(5000));
      experiment.after_shrink_5s = await captureAndDom();
      experiment.geometry_after_shrink_5s = resizeOwnedFixture(handle,640,360,false);
      experiment.measurement = await stage(row.variant+':shrink_observe_10s',()=>app.measureCapture(index,10000));
      experiment.after_measurement = await captureAndDom();
      experiment.geometry_after_measurement = resizeOwnedFixture(handle,640,360,false);
      const video = experiment.after_shrink_5s.dom.preview, pixels = experiment.measurement;
      const sourceStayedSmall = exactGeometry(experiment.geometry_after_shrink_5s,640,360) && exactGeometry(experiment.geometry_after_measurement,640,360);
      experiment.observed_no_upscale = sourceStayedSmall ? video?.width===640 && video?.height===360 && pixels.pixel_width===640 && pixels.pixel_height===360 && pixels.sampled_sizes.length>0 && pixels.sampled_sizes.every(s=>s==='640x360') : null;
      experiment.source_geometry_held = sourceStayedSmall;
      experiment.completion='COMPLETE';
    } catch(error) {
      experiment.completion='NOT_VERIFIED';experiment.error=errorView(error);experiment.diagnostics=await independentDiagnostics(app);
    } finally {
      experiment.restore_geometry = await stage(row.variant+':restore_owned_1280x720',async()=>resizeOwnedFixture(handle,1280,720));
      assert.ok(exactGeometry(experiment.restore_geometry,1280,720),'Owned source must be restored to exact 1280x720 window and DWM rectangles');
      await stage(row.variant+':restore_settle_5s',()=>delay(5000));
      experiment.after_restore_5s = await captureAndDom();
      experiment.geometry_after_restore_5s = resizeOwnedFixture(handle,1280,720,false);
      assert.ok(exactGeometry(experiment.geometry_after_restore_5s,1280,720),'Restored owned source did not remain at 1280x720');
    }
  };
  try {
    guard(); assert.equal(process.env.HARMONY_EXE_RELEASE, '0.4.4'); assert.equal(process.env.HARMONY_EXE_PROFILE, '720p30');
    const manifest = JSON.parse(await readFile(new URL('./releases/0.4.4.json',import.meta.url),'utf8'));
    assert.equal(manifest.version, '0.4.4'); assert.match(manifest.main_sha256, /^[a-f0-9]{64}$/);
    const hash = createHash('sha256').update(await readFile(process.env.HARMONY_EXE_PATH)).digest('hex'); assert.equal(hash, manifest.main_sha256);
    result.installed_sha256 = hash;
    assert.equal(process.env.HARMONY_GUILD_NAME, 'EXE WAN '+cohort());
    const users = JSON.parse(process.env.HARMONY_COHORT_USERS); assert.equal(users.length, 8);
    const token = await stage('owned_session', () => ownedSession(0));
    const members = (await api(`/guilds/${process.env.HARMONY_GUILD_ID}/members`,token)).items;
    assert.equal(members.length,8); assert.ok(members.every(m=>users.some(u=>u.id===m.id)));
    const instance = await api('/instance'), call = await api(`/channels/${process.env.HARMONY_VOICE_ID}/call`,token); assertCallRoute(instance,call);
    assert.equal(call.participants.length,0, 'Only this owned publisher may join the diagnostic');
    result.server = {version:instance.version, screen_sfu_enabled:call.screen_sfu_enabled===true};
    app = await stage('start_verified_exe', () => session(0)); result.attestation = app.attestation;
    const who = identity(0); mask(who.password);
    await stage('compiled_login', async () => {await app.fill('input[type="url"]',origin);await app.fill('input[autocomplete="username"]',who.username);await app.fill('input[type="password"]',who.password);await app.click('Entrar no Harmony');});
    await stage('compiled_call', async () => {await app.labelled('Abrir '+process.env.HARMONY_GUILD_NAME);await app.click('Sala de voz');await until(()=>app.cdp.evaluate(`document.querySelector('.call-header small')?.textContent.trim()==='Em chamada · 1 na chamada'`,false,2000),'one owned compiled call participant',30000);});
    await stage('compiled_fake_microphone', async () => {await app.labelled('Ligar microfone');await until(()=>app.cdp.evaluate(`__exeWan.microphones.some(t=>t.readyState==='live')`,false,2000),'compiled synthetic microphone');result.fake_audio=await app.cdp.evaluate('__exeWan.measureMicrophone()',false,6000);assert.ok(result.fake_audio.rms>0.03);});
    await app.ensureFixture();
    const fixture = app.fixtureDiagnostic();
    assert.match(fixture.output, /(?:^|\r?\n)PHYSICAL_WINDOW 1280x720 DWM 1280x720(?:\r?\n|$)/);
    const fixtureHandle = Number(fixture.output.match(/(?:^|\r?\n)WINDOW ([0-9]+) 1280x720 TARGET 30(?:\r?\n|$)/)?.[1]);
    const handle = await app.ownedWindow(); assert.ok(Number.isSafeInteger(handle)&&handle>0); assert.equal(handle,fixtureHandle,'UIA HWND must be the exact handle emitted by the owned fixture'); result.owned_window_handle=handle;
    await stage('install_diagnostic_wrapper', () => app.cdp.evaluate(`(${installCaptureDiagnostic.toString()})()`, false, 5000));
    for (const variant of [...diagnosticVariants,...postFrameVariants]) {
      const row = {variant, status:'DIAGNOSTIC', completion:'RUNNING'}; result.variants.push(row);
      try {
        assert.equal(await app.ownedWindow(),handle,'The source HWND must stay identical across variants');
        await stage(variant+':open_profile', () => app.click('Compartilhar tela'));
        for (const [label,value] of [['Método de captura','browser'],['Resolução',720],['Quadros por segundo',30],['Bitrate por','manual'],['Conteúdo','motion']]) await stage(variant+':'+label, () => app.select(label,value));
        await stage(variant+':bitrate', () => app.fill('input[aria-label="Bitrate em megabits por segundo"]','4'));
        await stage(variant+':screen_audio_off', () => app.cdp.evaluate(`(()=>{const e=document.querySelector('.check-field input[type="checkbox"]');if(!e)throw Error('Compiled screen audio control missing');if(e.checked)e.click();return true})()`,true,2000));
        await app.cdp.evaluate(`__browserCaptureDiagnostic.configure(${JSON.stringify(variant)},${handle})`,false,2000);
        await stage(variant+':compiled_choose', () => app.click('Escolher tela ou janela'));
        await stage(variant+':preview_current_frame', () => until(()=>app.cdp.evaluate(`(()=>{const v=document.querySelector('.share-preview video');return !!v&&v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0})()`,false,2000),'compiled preview current frame',30000));
        await stage(variant+':settle_5s', () => delay(5000));
        row.after_5s = await captureAndDom();
        assert.equal(row.after_5s.capture.variant,variant); assert.equal(row.after_5s.capture.current.settings.displaySurface,'window');
        if (postFrameVariants.includes(variant)) {
          row.post_frame = await stage(variant+':apply_owned_post_frame_constraints',()=>app.cdp.evaluate('__browserCaptureDiagnostic.applyObservedConstraints()',false,10000));
          await stage(variant+':post_frame_settle_5s',()=>delay(5000));
          row.after_post_frame_5s = await captureAndDom();
        }
        const index = await app.cdp.evaluate(`__exeWan.captures.findIndex(c=>c.track.id===${JSON.stringify(row.after_5s.capture.current.track_id)})`,false,2000); assert.ok(index>=0);
        row.measurement = await stage(variant+':observe_10s', () => app.measureCapture(index,10000));
        row.after_measurement = await captureAndDom();
        if (postFrameVariants.includes(variant)) {
          if (row.measurement.pixel_width===1280 && row.measurement.pixel_height===720 && row.measurement.sampled_sizes.length>0 && row.measurement.sampled_sizes.every(s=>s==='1280x720')) await checkResize(row,index,handle);
          else row.resize_experiment={status:'DIAGNOSTIC',completion:'NOT_RUN',reason:'Post-frame constraints did not deliver complete 1280x720 frames; no resize attempted'};
        }
        row.completion='COMPLETE';
      } catch (error) {
        row.completion='FAILED'; row.failed_stage=currentStage; row.error=errorView(error); row.diagnostics=await independentDiagnostics(app);
      } finally {
        try {await stage(variant+':compiled_cancel',cancelPreview);row.cleanup='RELEASED_BY_UI';}
        catch (error) {row.cleanup='FAILED';row.cleanup_error=errorView(error);throw error;}
      }
    }
    await stage('restore_observation_only_gdm', () => app.cdp.evaluate('__browserCaptureDiagnostic.restore()',false,2000));
    result.completion=result.variants.every(r=>r.completion==='COMPLETE')?'COMPLETE':'INCOMPLETE';
  } catch (error) {
    result.completion='FAILED'; result.failed_stage=currentStage; result.error=errorView(error);
    if(app)result.diagnostics=await independentDiagnostics(app);
  } finally {
    if(app) {
      result.fixture_diagnostic=app.fixtureDiagnostic();
      try {app.close();result.process_cleanup='COMPLETE';} catch(error) {result.process_cleanup='FAILED';result.cleanup_error=errorView(error);result.completion='FAILED';}
      await writeFile(join(app.root,'browser-capture-diagnostic.json'),JSON.stringify(result,null,2)+'\n');
    }
    console.log('HARMONY_BROWSER_CAPTURE_DIAGNOSTIC '+JSON.stringify(result));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runDiagnostic();
  if(result.completion!=='COMPLETE')process.exitCode=1;
}
