// Production P2PCall + real Harmony HTTP/WebSocket + three isolated Chromium
// processes. This is an RTC integration harness, not a visual/UI acceptance test.
// All media is generated for this test. getDisplayMedia is restricted by a
// Chromium test switch to a uniquely named, owned fixture TAB (never a screen).
// Chromium's --disable-audio-input supplies a clocked fake audio output so
// headless RTC decoding never depends on personal audio hardware. No
// getUserMedia call is made; senders are generated WebAudio tones.
// Source for the tab-only switch:
// https://github.com/chromium/chromium/blob/main/chrome/common/chrome_switches.h
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const api = process.env.HARMONY_TEST_URL || 'http://127.0.0.1:8080';
const web = process.env.HARMONY_WEB_URL || 'http://127.0.0.1:1420';
const chrome = process.env.HARMONY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
for (const value of [api, web]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname), 'Use loopback test services only');
const directory = resolve('.local/qa-real-calls');
const reportPath = resolve(process.env.HARMONY_CALL_REPORT || join(directory, 'browser-result.json'));
const runId = randomBytes(5).toString('hex');
const captureTitle = 'Harmony Capture Fixture ' + runId;
const fixture = join(directory, `browser-fixture-${runId}.html`);
const report = {
  status: 'RUNNING', scope: 'same-machine real RTC; generated sources and actual tab capture',
  browser_processes: 3, checks: [], measurements: [],
  not_verified: ['two independent networks / NAT traversal', 'physical Windows or Tauri WebView2', 'physical microphone/camera/system-audio capture', 'TURN or guaranteed direct connectivity', 'hosted deployment availability', 'central enforcement against two cooperating modified clients'],
};
const browsers = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, label) { assert.ok(value, label); report.checks.push(label); }
async function until(predicate, label, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) { report.checks.push(label); return; }
    await delay(150);
  }
  throw new Error(label);
}
async function request(method, path, body, token, statuses = [200, 201, 204]) {
  const result = await fetch(api + '/api' + path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(statuses.includes(result.status), `${method} ${path}: HTTP ${result.status}`);
  return result.status === 204 ? null : result.json();
}

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.sequence = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = () => reject(new Error('CDP connection failed')); });
    this.socket.onmessage = event => {
      const value = JSON.parse(event.data), pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      value.error ? pending.reject(new Error(value.error.message)) : pending.resolve(value.result);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, userGesture = false) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + (result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text));
    return result.result?.value;
  }
  run(body, userGesture = false) { return this.evaluate(`(async () => { ${body} })()`, userGesture); }
  close() { this.socket.close(); }
}

async function newTarget(browser, url) {
  const target = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const client = new CDP(target.webSocketDebuggerUrl);
  browser.clients.push(client);
  await client.send('Runtime.enable');
  return client;
}
async function makeBrowser() {
  const profile = await mkdtemp(join(tmpdir(), 'harmony-real-call-'));
  const child = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
    '--disable-audio-output', '--disable-audio-input', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--auto-select-tab-capture-source-by-title=' + captureTitle, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  const browser = { child, profile, clients: [], port: null };
  browsers.push(browser);
  await until(async () => {
    try { browser.port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!browser.port; } catch { return false; }
  }, 'isolated Chromium process started');
  const client = await newTarget(browser, web + '/@fs' + fixture);
  await until(async () => {
    try { return await client.evaluate(`location.origin === ${JSON.stringify(new URL(web).origin)} && document.readyState === 'complete'`); } catch { return false; }
  }, 'test fixture served from the authorized Vite origin');
  await client.run(`
    window.qa = { peers: [], sockets: [], resources: [], playback: new Map(), errors: [], history: [] };
    const NativePC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePC { constructor(...args) { super(...args); qa.peers.push(this); } };
    const NativeWS = window.WebSocket;
    window.WebSocket = class extends NativeWS { constructor(...args) { super(...args); if (String(args[0]).endsWith('/api/calls')) qa.sockets.push(this); } };
    window.addEventListener('unhandledrejection', event => qa.errors.push(String(event.reason?.message || event.reason)));
    window.callApi = await import('/src/lib/api.ts');
    window.P2PCall = (await import('/src/lib/call.ts')).P2PCall;
    qa.audio = new AudioContext({sinkId:{type:"none"}}); await qa.audio.resume();
    qa.render = snapshot => {
      const current = new Set();
      for (const peer of snapshot.participants) for (const [source, track] of Object.entries(peer.tracks)) {
        if (!track || track.readyState !== 'live') continue;
        const key = peer.user_id + ':' + source; current.add(key);
        let entry = qa.playback.get(key);
        if (entry?.track === track) continue;
        if (entry) { entry.node?.disconnect(); entry.element?.remove(); entry.audioElement?.remove(); }
        entry = { track, source, user: peer.user_id }; qa.playback.set(key, entry);
        if (track.kind === 'video') {
          const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
          video.srcObject = new MediaStream([track]); video.width = 240; document.body.append(video);
          video.play().catch(() => {}); entry.element = video;
        } else {
          const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = new MediaStream([track]); document.body.append(audio); audio.play().catch(e => qa.errors.push(e.message)); entry.audioElement = audio;
          const node = qa.audio.createMediaStreamSource(new MediaStream([track]));
          const analyser = qa.audio.createAnalyser(); analyser.fftSize = 4096; node.connect(analyser);
          const silent = qa.audio.createGain(); silent.gain.value = 0; analyser.connect(silent).connect(qa.audio.destination);
          entry.node = node; entry.analyser = analyser;
        }
      }
      for (const [key, entry] of qa.playback) if (!current.has(key)) { entry.node?.disconnect(); entry.element?.remove(); entry.audioElement?.remove(); qa.playback.delete(key); }
      qa.latest = snapshot; qa.history.push({ at: performance.now(), state: snapshot.state, peers: snapshot.participants.length });
      if (qa.history.length > 300) qa.history.shift();
    };
    qa.serial = () => {
      const s = window.rtcCall?.snapshot;
      if (!s) return null;
      const track = t => ({ kind: t.kind, readyState: t.readyState, enabled: t.enabled });
      return { state: s.state, reason: s.reason, self: s.self,
        participants: s.participants.map(p => ({ ...p, tracks: Object.fromEntries(Object.entries(p.tracks).filter(([, t]) => t).map(([k, t]) => [k, track(t)])) })),
        localTracks: Object.fromEntries(Object.entries(s.localTracks).filter(([, t]) => t).map(([k, t]) => [k, track(t)])), profile: s.profile };
    };
    qa.observed = (user, source) => {
      const e = qa.playback.get(user + ':' + source);
      if (!e) return null;
      if (e.element) {
        const v = e.element, canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
        let pixel = null; if (v.videoWidth && v.readyState >= 2) { const c = canvas.getContext('2d'); c.drawImage(v, 0, 0, 8, 8); pixel = [...c.getImageData(4, 4, 1, 1).data]; }
        return { width: v.videoWidth, height: v.videoHeight, frames: v.getVideoPlaybackQuality().totalVideoFrames, pixel };
      }
      const waveform = new Float32Array(e.analyser.fftSize); e.analyser.getFloatTimeDomainData(waveform);
      const rms = Math.sqrt(waveform.reduce((sum, n) => sum + n * n, 0) / waveform.length);
      const bins = new Float32Array(e.analyser.frequencyBinCount); e.analyser.getFloatFrequencyData(bins);
      let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      return { rms, frequency: peak * qa.audio.sampleRate / e.analyser.fftSize, muted:e.track.muted, enabled:e.track.enabled, audioTime:e.audioElement?.currentTime }; 
    };
    qa.tone = frequency => {
      const context = qa.audio, oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      oscillator.frequency.value = frequency; gain.gain.value = 0.2; oscillator.connect(gain).connect(destination); oscillator.start(); context.resume();
      const track = destination.stream.getAudioTracks()[0]; qa.resources.push({ track, close: () => { oscillator.stop(); } }); return track;
    };
    qa.video = (height, color) => {
      const canvas = document.createElement('canvas'); canvas.width = Math.round(height * 16 / 9); canvas.height = height;
      const context = canvas.getContext('2d'); let frame = 0;
      const draw = () => { context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#ffffff'; context.fillRect((frame++ * 13) % canvas.width, 10, 90, 60); };
      draw(); const timer = setInterval(draw, 33); const track = canvas.captureStream(30).getVideoTracks()[0];
      qa.resources.push({ track, close: () => clearInterval(timer) }); return track;
    };
    true;
  `, true);
  browser.client = client;
  return browser;
}
async function start(browser, session, channelId) {
  await browser.client.run(`await callApi.setServer(${JSON.stringify(api)}); await callApi.saveSession(${JSON.stringify(session)});
    window.rtcCall?.close(); window.rtcCall = new P2PCall({channelId:${JSON.stringify(channelId)}});
    rtcCall.subscribe(qa.render); await rtcCall.connect(); true;`, true);
}
const snapshot = browser => browser.client.evaluate('qa.serial()');
const observed = (browser, user, source) => browser.client.evaluate(`qa.observed(${JSON.stringify(user)},${JSON.stringify(source)})`);
const publishTone = (browser, frequency, source = 'microphone') => browser.client.run(`await rtcCall.setTrack(${JSON.stringify(source)}, qa.tone(${frequency})); true`, true);
const mediaPresent = (s, user, source) => !!s?.participants.find(p => p.user_id === user)?.tracks[source];

let ownerBrowser, bobBrowser, carolBrowser;
try {
  await mkdir(directory, { recursive: true });
  await writeFile(fixture, '<!doctype html><html><head><title>Harmony RTC harness</title></head><body><p>Generated RTC test content only.</p></body></html>');
  await until(async () => { try { return (await fetch(api + '/health')).ok; } catch { return false; } }, 'real API is ready');
  for (const [name, file] of [['client_sha256', 'apps/desktop/src/lib/call.ts'], ['signaling_sha256', 'crates/server/src/calls.rs'], ['test_sha256', 'scripts/call-browser-test.mjs']]) {
    report[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  const admin = await request('POST', '/auth/login', { username: process.env.HARMONY_BOOTSTRAP_USERNAME, password: process.env.HARMONY_BOOTSTRAP_PASSWORD });
  const password = randomBytes(24).toString('hex');
  const people = [];
  for (const name of ['owner', 'bob', 'carol']) people.push(await request('POST', '/auth/register', { username: `call_${name}_${runId}`, display_name: `RTC ${name}`, password }));
  let [owner, bob, carol] = people;
  const guild = await request('POST', '/guilds', { name: `RTC integration ${runId}` }, owner.access_token);
  const channel = await request('POST', `/guilds/${guild.id}/channels`, { name: 'Real call', kind: 'voice' }, owner.access_token);
  const configuration = await request('GET', `/channels/${channel.id}/call`, undefined, owner.access_token);
  check(configuration.transport === 'p2p', 'real call uses the explicit P2P transport without LiveKit');
  report.configured_stun_entries = configuration.ice_servers.length;
  await request('POST', `/channels/${channel.id}/media-token`, {}, owner.access_token, [503]);
  check(true, 'incompatible LiveKit token endpoint is disabled in P2P mode');
  const invite = await request('POST', `/guilds/${guild.id}/invites`, { max_uses: 2, expires_hours: 1 }, owner.access_token);
  for (const person of [bob, carol]) await request('POST', '/invites/accept', { token: invite.token }, person.access_token);
  const role = await request('POST', `/guilds/${guild.id}/roles`, { name: 'Participant test', permissions: '63' }, owner.access_token);
  await request('PUT', `/guilds/${guild.id}/members/${carol.user.id}/roles/${role.id}`, {}, owner.access_token);
  [ownerBrowser, bobBrowser, carolBrowser] = await Promise.all([makeBrowser(), makeBrowser(), makeBrowser()]);
  const ordered = [ownerBrowser, bobBrowser, carolBrowser];
  report.browser = await ownerBrowser.client.send('Browser.getVersion');
  const connectedAt = Date.now();
  await Promise.all(ordered.map((browser, i) => start(browser, people[i], channel.id)));
  await until(async () => (await Promise.all(browsers.map(snapshot))).every(s => s?.state === 'connected' && s.participants.length === 2 && s.participants.every(p => p.connection === 'connected')), 'three simultaneous peers negotiate all pairwise RTC connections', 35);
  check((await Promise.all(browsers.map(snapshot))).every(s => Object.keys(s.localTracks).length === 0), 'joining never captures or publishes a device automatically');
  await Promise.all(ordered.map((browser, i) => publishTone(browser, [440, 620, 800][i])));
  for (const [receiver, sender, frequency] of [[bobBrowser, owner, 440], [carolBrowser, bob, 620], [ownerBrowser, carol, 800]]) {
    await until(async () => { const value = await observed(receiver, sender.user.id, 'microphone'); return value?.rms > 0.03 && Math.abs(value.frequency - frequency) < 35; }, `decoded microphone source carries the expected ${frequency} Hz tone`);
  }
  await ownerBrowser.client.run(`await rtcCall.setScreenProfile({height:720,fps:30,bitrate:2,content:'motion',audio:true});
    await rtcCall.setTrack('camera',qa.video(180,'#16b822')); await rtcCall.setTrack('screen',qa.video(1440,'#9124db')); true`, true);
  await publishTone(ownerBrowser, 980, 'screen_audio');
  for (const receiver of [bobBrowser, carolBrowser]) {
    await until(async () => { const camera = await observed(receiver, owner.user.id, 'camera'), screen = await observed(receiver, owner.user.id, 'screen'), audio = await observed(receiver, owner.user.id, 'screen_audio');
      return camera?.frames > 10 && camera.pixel?.[1] > camera.pixel?.[0] * 2 && screen?.height === 720 && screen.frames > 10 && screen.pixel?.[2] > screen.pixel?.[1] * 2 && audio?.rms > 0.03 && Math.abs(audio.frequency - 980) < 35;
    }, 'camera, screen and screen audio arrive in distinct fixed source slots', 30);
  }
  const caps = await ownerBrowser.client.evaluate(`qa.peers.filter(pc=>pc.connectionState==='connected').flatMap(pc=>pc.getSenders().filter(s=>s.track===rtcCall.snapshot.localTracks.screen).map(s=>s.getParameters().encodings.map(e=>({maxBitrate:e.maxBitrate,maxFramerate:e.maxFramerate}))))`);
  check(caps.length === 2 && caps.every(values => values.length === 1 && values[0].maxBitrate === 2000000 && values[0].maxFramerate === 30), 'screen bitrate and FPS caps are applied to each actual RTCRtpSender');
  report.measurements.push({ label: 'three peers, 720p screen and separate microphone/camera/screen-audio', peers: await Promise.all(browsers.map(snapshot)) });
  await bobBrowser.client.run(`await rtcCall.setScreenProfile({height:360,fps:24,bitrate:1,content:'motion',audio:false}); await rtcCall.setTrack('screen',qa.video(360,'#16b8b8'));`, true);
  await carolBrowser.client.run(`await rtcCall.setScreenProfile({height:480,fps:15,bitrate:1,content:'motion',audio:false}); await rtcCall.setTrack('screen',qa.video(480,'#daca20'));`, true);
  await until(async () => { const b = await observed(ownerBrowser, bob.user.id, 'screen'), c = await observed(ownerBrowser, carol.user.id, 'screen');
    return b?.height === 360 && b.frames > 10 && c?.height === 480 && c.frames > 10;
  }, 'three simultaneous screen publishers remain distinct from voice sources', 30);

  await ownerBrowser.client.run(`await rtcCall.setScreenProfile({height:1440,fps:15,bitrate:1,content:'text',audio:true}); true`);
  await until(async () => (await observed(bobBrowser, owner.user.id, 'screen'))?.height === 1440, 'live profile change reaches 1440p without dropping the voice call', 30);
  const changedCaps = await ownerBrowser.client.evaluate(`qa.peers.filter(pc=>pc.connectionState==='connected').flatMap(pc=>pc.getSenders().filter(s=>s.track===rtcCall.snapshot.localTracks.screen).map(s=>s.getParameters().encodings.map(e=>({maxBitrate:e.maxBitrate,maxFramerate:e.maxFramerate}))))`);
  check(changedCaps.length === 2 && changedCaps.every(values => values[0].maxBitrate === 1000000 && values[0].maxFramerate === 15), 'updated bitrate/FPS caps reach both screen senders');
  const fpsStart = Date.now(), beforeFrames = (await observed(bobBrowser, owner.user.id, 'screen')).frames;
  await delay(2000);
  const decodedFps = ((await observed(bobBrowser, owner.user.id, 'screen')).frames - beforeFrames) * 1000 / (Date.now() - fpsStart);
  check(decodedFps > 0 && decodedFps <= 16, 'decoded 1440p frame cadence respects the requested 15 FPS ceiling');
  report.measurements.push({ label: 'decoded frame cadence after live profile change', requested_fps: 15, decoded_fps: decodedFps });

  await bobBrowser.client.evaluate(`rtcCall.setReceiveHeight(rtcCall.snapshot.participants.find(p=>p.user_id===${JSON.stringify(owner.user.id)}).peer_id,360); true`);
  await until(async () => { const b = await observed(bobBrowser, owner.user.id, 'screen'), c = await observed(carolBrowser, owner.user.id, 'screen');
    return b?.height === 360 && c?.height === 1440;
  }, 'one receiver requests 360p while another keeps the same publisher at 1440p', 30);
  await bobBrowser.client.evaluate(`rtcCall.setReceiveHeight(rtcCall.snapshot.participants.find(p=>p.user_id===${JSON.stringify(owner.user.id)}).peer_id,0); true`);
  await until(async () => (await observed(bobBrowser, owner.user.id, 'screen'))?.height === 1440, 'receiver automatic quality restores the published resolution', 30);
  await ownerBrowser.client.run(`await rtcCall.setTrack('screen_audio',null); await rtcCall.setTrack('screen',null);`);
  await until(async () => { const values = await Promise.all([bobBrowser, carolBrowser].map(snapshot));
    return values.every(s => !mediaPresent(s, owner.user.id, 'screen') && !mediaPresent(s, owner.user.id, 'screen_audio') && mediaPresent(s, owner.user.id, 'microphone') && mediaPresent(s, owner.user.id, 'camera'));
  }, 'stopping screen and its audio removes only those sources while microphone and camera continue');


  // Real browser capture of an owned tab. The source selector is limited to
  // this unique title; no desktop/window auto-selection switch is enabled.
  const capture = await newTarget(ownerBrowser, web + '/@fs' + fixture);
  await capture.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await until(async () => { try { return await capture.evaluate(`document.readyState==='complete'`); } catch { return false; } }, 'owned tab capture fixture loaded');
  await capture.evaluate(`document.title=${JSON.stringify(captureTitle)}; document.body.innerHTML='<canvas id="picture"></canvas>'; document.body.style.margin='0';
    const canvas=document.querySelector('canvas'); canvas.width=1280; canvas.height=720; canvas.style.width='100vw'; canvas.style.height='100vh';
    const ctx=canvas.getContext('2d'); window.frame=0; function draw(){ctx.fillStyle=(frame++%60)<30?'#e02030':'#2040df';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#ffffff';ctx.fillRect((frame*17)%1100,15,100,60);} draw();window.drawing=setInterval(draw,33); true;`);
  await ownerBrowser.client.send('Page.bringToFront');
  const captureSettings = await ownerBrowser.client.run(`window.tabCapture = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30},audio:false});
    const t=tabCapture.getVideoTracks()[0]; if(t.getSettings().displaySurface!=='browser'){tabCapture.getTracks().forEach(t=>t.stop()); throw new Error('Only an owned browser tab may be captured');}
    qa.resources.push({track:t,close:()=>tabCapture.getTracks().forEach(t=>t.stop())});
    await rtcCall.setScreenProfile({height:720,fps:30,bitrate:2,content:'motion',audio:false}); await rtcCall.setTrack('screen',t); return t.getSettings();`, true);
  check(captureSettings.displaySurface === 'browser', 'actual getDisplayMedia captures an owned browser tab, not a synthetic canvas stream or desktop');
  const colors = new Set();
  await until(async () => {
    const value = await observed(bobBrowser, owner.user.id, 'screen');
    if (value?.pixel?.[0] > 150 && value.pixel[2] < 110) colors.add('red');
    if (value?.pixel?.[2] > 150 && value.pixel[0] < 110) colors.add('blue');
    return colors.size === 2;
  }, 'receiver decodes both changing colors from the actual captured tab', 25);
  report.actual_tab_capture = { display_surface: captureSettings.displaySurface, received_colors: [...colors], receiver: await observed(bobBrowser, owner.user.id, 'screen') };

  // A legitimate refresh rotates the server session version without becoming
  // a new participant or silently reopening a microphone after a disconnect.
  const oldPeer = (await snapshot(ownerBrowser)).self.peer_id;
  owner = await ownerBrowser.client.run('return await callApi.refreshSession()');
  await delay(3000);
  check((await snapshot(ownerBrowser)).state === 'connected' && (await snapshot(ownerBrowser)).self.peer_id === oldPeer, 'session refresh preserves the admitted call and connection identity');
  await request('POST', `/channels/${channel.id}/moderate`, { user_id: bob.user.id, action: 'mute' }, owner.access_token);
  await until(async () => { const s = await snapshot(bobBrowser); return s.self?.can_publish === false && Object.keys(s.localTracks).length === 0; }, 'server mute stops all owned capture tracks but retains listening');
  await until(async () => !mediaPresent(await snapshot(ownerBrowser), bob.user.id, 'microphone') && !mediaPresent(await snapshot(carolBrowser), bob.user.id, 'microphone'), 'other official clients remove muted participant media');
  await request('POST', `/channels/${channel.id}/moderate`, { user_id: bob.user.id, action: 'unmute' }, owner.access_token);
  await until(async () => (await snapshot(bobBrowser)).self?.can_publish === true, 'server unmute restores permission');
  check(Object.keys((await snapshot(bobBrowser)).localTracks).length === 0, 'unmute does not reactivate a stopped microphone');
  await publishTone(bobBrowser, 620);
  await until(async () => (await observed(carolBrowser, bob.user.id, 'microphone'))?.rms > 0.03, 'explicit publication after unmute resumes decoded audio');

  await request('PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '32' }, owner.access_token);
  await until(async () => { const s = await snapshot(carolBrowser); return s.state === 'connected' && s.self?.can_publish === false && Object.keys(s.localTracks).length === 0; }, 'PUBLISH revocation keeps receiver access and stops owned media');
  await request('PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '0' }, owner.access_token);
  await until(async () => (await snapshot(carolBrowser)).self?.can_publish === true, 'PUBLISH permission recovery reaches the existing call');
  check(Object.keys((await snapshot(carolBrowser)).localTracks).length === 0, 'permission recovery never captures automatically');
  await request('PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '16' }, owner.access_token);
  await until(async () => ['closed','failed'].includes((await snapshot(carolBrowser)).state), 'CONNECT revocation terminates the affected call');
  await until(async () => (await snapshot(ownerBrowser)).participants.length === 1 && (await snapshot(bobBrowser)).participants.length === 1, 'other peers close the removed connection after CONNECT revocation');
  await request('PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '0' }, owner.access_token);
  await carolBrowser.client.run('await rtcCall.reconnect(); return true');
  await until(async () => (await Promise.all(browsers.map(snapshot))).every(s => s.state === 'connected' && s.participants.length === 2 && s.participants.every(p => p.connection === 'connected')), 'explicit re-entry after restored CONNECT rebuilds the mesh');
  check(Object.keys((await snapshot(carolBrowser)).localTracks).length === 0, 're-entry starts with capture off');

  while (Date.now() - connectedAt < 125000) await delay(Math.min(5000, 125000 - (Date.now() - connectedAt)));
  check((await snapshot(ownerBrowser)).state === 'connected' && (await snapshot(ownerBrowser)).self.peer_id === oldPeer && (await snapshot(bobBrowser)).state === 'connected', 'real call survives beyond the diagnostic 120-second lifetime');
  report.continuous_call_elapsed_ms = Date.now() - connectedAt;

  const ownerPeer = (await snapshot(ownerBrowser)).self.peer_id;
  await bobBrowser.client.evaluate(`{ const pc=qa.peers.find(pc=>pc.connectionState==='connected' && pc.localDescription); qa.sockets.at(-1).send(JSON.stringify({type:'signal',to:${JSON.stringify(ownerPeer)},data:{description:{type:'offer',sdp:pc.localDescription.sdp.replace('a=mid:0','a=mid:99')}}})); true; }`);
  await until(async () => { const s = await snapshot(ownerBrowser); return s.state === 'connected' && s.participants.find(p=>p.user_id===bob.user.id)?.connection === 'failed' && s.participants.find(p=>p.user_id===carol.user.id)?.connection === 'connected' && s.localTracks.microphone?.readyState === 'live'; }, 'an invalid SDP offer isolates its sender without terminating the other connection or microphone');
  await until(async () => (await observed(carolBrowser, owner.user.id, 'microphone'))?.rms > 0.03, 'unaffected participant still decodes audio after another peer sends invalid SDP');

  await request('POST', `/admin/users/${bob.user.id}/reset`, { password: process.env.HARMONY_BOOTSTRAP_PASSWORD }, admin.access_token);
  await until(async () => ['closed','failed'].includes((await snapshot(bobBrowser)).state), 'password reset terminates the affected real call');
  await until(async () => !(await snapshot(ownerBrowser)).participants.some(p => p.user_id === bob.user.id), 'remaining peer stops receiving the revoked session');
  await request('GET', `/channels/${channel.id}/call`, undefined, bob.access_token, [401]);
  check(true, 'revoked access token cannot re-enter the real call');

  await publishTone(carolBrowser, 800);
  await until(async () => (await observed(ownerBrowser, carol.user.id, 'microphone'))?.rms > 0.03, 'remaining participants still exchange real audio');
  await carolBrowser.client.evaluate(`qa.sockets.at(-1).close(); true`);
  await until(async () => ['closed','failed'].includes((await snapshot(carolBrowser)).state) && Object.keys((await snapshot(carolBrowser)).localTracks).length === 0, 'loss of signaling closes peer connections and local tracks');
  await until(async () => (await snapshot(ownerBrowser)).participants.length === 0, 'signaling disconnect is removed from the authoritative roster');
  await ownerBrowser.client.evaluate(`rtcCall.close(); true`);
  for (const browser of browsers) {
    check(await browser.client.evaluate(`qa.peers.every(pc=>pc.connectionState==='closed') && qa.resources.every(r=>r.track.readyState==='ended')`), 'all created peer connections and owned media tracks are closed');
  }
  report.browser_errors = (await Promise.all(browsers.map(b => b.client.evaluate('qa.errors')))).flat();
  check(report.browser_errors.length === 0, 'no unhandled browser promise failures');
  report.final_client_sha256 = createHash('sha256').update(await readFile('apps/desktop/src/lib/call.ts')).digest('hex');
  check(report.final_client_sha256 === report.client_sha256, 'transport source did not change during this browser run');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.message; process.exitCode = 1;
  report.failure_snapshots = await Promise.all(browsers.filter(b => b.client).map(b => snapshot(b).catch(() => null)));
  report.browser_errors = (await Promise.all(browsers.filter(b => b.client).map(b => b.client.evaluate('qa.errors').catch(() => [])))).flat();
  report.failure_media = await Promise.all(browsers.filter(b => b.client).map(b => b.client.evaluate(`({audioState:qa.audio.state,audioTime:qa.audio.currentTime,observed:[...qa.playback.values()].map(e=>({source:e.source,...qa.observed(e.user,e.source)})),transceivers:qa.peers.map(pc=>pc.getTransceivers().map(t=>({mid:t.mid,direction:t.direction,currentDirection:t.currentDirection,track:t.sender.track&&{kind:t.sender.track.kind,state:t.sender.track.readyState}})))})`).catch(() => null)));
} finally {
  for (const browser of browsers) {
    await browser.client?.evaluate(`window.rtcCall?.close(); for(const resource of window.qa?.resources||[]) { resource.track.stop(); try{resource.close()}catch{} } window.qa?.audio?.close(); true`).catch(() => {});
    for (const client of browser.clients) client.close();
    browser.child.kill('SIGTERM'); await delay(250);
    if (browser.child.exitCode === null) browser.child.kill('SIGKILL');
    await rm(browser.profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
  await rm(fixture, { force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, scope: report.scope, error: report.error, actual_tab_capture: report.actual_tab_capture, evidence: reportPath }));
  process.exit(process.exitCode || 0);
}
