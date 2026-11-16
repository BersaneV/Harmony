// Isolated QA experiment against the pinned, unmodified 0.4.4 executable.
// Only the compiled UI requests capture. This wrapper varies GDM constraints;
// it never imports product TS, invokes capture IPC, publishes or changes a sender.
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

// Self-contained for injection into the owned shipped WebView and VM tests.
export function installCaptureDiagnostic() {
  if (!window.__TAURI_INTERNALS__ || location.origin !== 'http://tauri.localhost') throw Error('Owned compiled page required');
  if (window.__browserCaptureDiagnostic) throw Error('Diagnostic already installed');
  const media = navigator.mediaDevices, original = media.getDisplayMedia;
  const records = [], variants = ['baseline', 'width_max', 'width_ideal_max', 'height_ideal_only'];
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
        initial: r.initial ?? null, current: r.track ? trackView(r.track) : null, error: r.error ?? null}));
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
    scope: 'Same pinned published EXE 0.4.4, VM and owned physical 1280x720 HWND; compiled preview UI only. GDM constraint variants are an experiment, not a product fix or media capacity PASS.', stages: [], variants: []};
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
    for (const variant of diagnosticVariants) {
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
        row.after_5s = await app.cdp.evaluate(`({capture:__browserCaptureDiagnostic.snapshot().at(-1),dom:${domExpression}})`,false,2000);
        assert.equal(row.after_5s.capture.variant,variant); assert.equal(row.after_5s.capture.current.settings.displaySurface,'window');
        const index = await app.cdp.evaluate(`__exeWan.captures.findIndex(c=>c.track.id===${JSON.stringify(row.after_5s.capture.current.track_id)})`,false,2000); assert.ok(index>=0);
        row.measurement = await stage(variant+':observe_10s', () => app.measureCapture(index,10000));
        row.after_measurement = await app.cdp.evaluate(`({capture:__browserCaptureDiagnostic.snapshot().at(-1),dom:${domExpression}})`,false,2000);
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
