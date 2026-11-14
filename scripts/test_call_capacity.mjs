// Eight real P2PCall clients, HTTP/WS signaling and generated RTC media.
// This is a loopback integration/capacity test, not physical-device or UI QA.
// Run only against a disposable instance; never uses physical capture devices.
// Defaults: 180 s stable media, native 720p30 canvas, 4 Mb/s per spectator.
// Optional profiles are explicit: HARMONY_CAPACITY_HEIGHT=360|720|1080|1440,
// HARMONY_CAPACITY_FPS=15|24|30|60. Minimum average rendered FPS is 0.8*FPS.
// HARMONY_SERVER_BINARY/SOURCE identify the externally started server for A/B.
// HARMONY_CAPACITY_BROWSER_MODE=contexts optionally uses one Chrome with eight
// isolated BrowserContexts. It shares GPU/audio services, not application sessions;
// compare both A/B arms in the same mode and preserve separate-process failures.
// HARMONY_CAPACITY_AUDIO_MODE=split optionally separates generated-source and
// received-audio analysis clocks. Default shared preserves the original control.
// HARMONY_CAPACITY_MEDIA_SOURCE=native-fake optionally uses guarded Chromium
// fake-device getUserMedia with generated WAV/Y4M files, in processes mode only.
// Its "screen" is a fake camera track, NOT getDisplayMedia or system audio.
// On macOS, WAV data uses a new temporary subdirectory inside the audio
// sandbox's existing readable ~/Library/Audio/Plug-Ins path. No plugin/bundle
// is installed; only our generated WAV files are created, then removed.
// HARMONY_CAPACITY_NATIVE_AUDIO_DIR overrides this existing parent directory;
// other platforms default to the OS temp directory. Video stays in OS temp.
// Chromium documents these test flags in media/base/media_switches.cc:
// https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/media_switches.cc
// HARMONY_ENGINE_ROOT=/@fs/absolute/baseline-lib/ selects an unchanged baseline.
// Its api.ts and call.ts MUST share a module instance; no injected fake transport.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, getPriority, homedir, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const api = (process.env.HARMONY_TEST_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const web = (process.env.HARMONY_WEB_URL || 'http://127.0.0.1:1420').replace(/\/$/, '');
for (const value of [api, web]) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === '/', 'Use loopback origins without credentials or paths');
}
const seconds = Number(process.env.HARMONY_CAPACITY_SECONDS || 180);
assert.ok(Number.isInteger(seconds) && seconds >= 120 && seconds <= 1800, 'HARMONY_CAPACITY_SECONDS must be 120..1800');
const height = Number(process.env.HARMONY_CAPACITY_HEIGHT || 720);
const fps = Number(process.env.HARMONY_CAPACITY_FPS || 30);
assert.ok([360, 720, 1080, 1440].includes(height), 'HARMONY_CAPACITY_HEIGHT must be 360, 720, 1080 or 1440');
assert.ok([15, 24, 30, 60].includes(fps), 'HARMONY_CAPACITY_FPS must be 15, 24, 30 or 60');
const width = height * 16 / 9, minimumFps = fps * 0.8;
const serverBinary = resolve(process.env.HARMONY_SERVER_BINARY || 'target/debug/harmony-server');
const serverSource = resolve(process.env.HARMONY_SERVER_SOURCE || 'crates/server/src/calls.rs');
const engineRoot = process.env.HARMONY_ENGINE_ROOT || '/src/lib/';
assert.ok(engineRoot.startsWith('/') && engineRoot.endsWith('/') && !engineRoot.startsWith('//')
  && !/[?#\\]/.test(engineRoot), 'HARMONY_ENGINE_ROOT must be an absolute Vite path ending in /');
const engineDirectory = engineRoot === '/src/lib/' ? resolve('apps/desktop/src/lib')
  : engineRoot.startsWith('/@fs/') ? engineRoot.slice('/@fs'.length) : null;
assert.ok(engineDirectory, 'Use /src/lib/ or /@fs/absolute/path/ for auditable source hashes');
const chrome = process.env.HARMONY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const directory = resolve('.local/qa-call-capacity');
const reportPath = resolve(process.env.HARMONY_CALL_REPORT || join(directory, 'eight-client-result.json'));
const runId = randomBytes(6).toString('hex');
const fixture = join(directory, `eight-fixture-${runId}.html`);
const frequencies = Array.from({ length: 8 }, (_, i) => 330 + i * 110);
const startConcurrency = 2;
const browserMode = process.env.HARMONY_CAPACITY_BROWSER_MODE || 'processes';
assert.ok(['processes', 'contexts'].includes(browserMode), 'HARMONY_CAPACITY_BROWSER_MODE must be processes or contexts');
const mediaSource = process.env.HARMONY_CAPACITY_MEDIA_SOURCE || 'webaudio-canvas';
assert.ok(['webaudio-canvas', 'native-fake'].includes(mediaSource), 'HARMONY_CAPACITY_MEDIA_SOURCE must be webaudio-canvas or native-fake');
const nativeFake = mediaSource === 'native-fake';
assert.ok(!nativeFake || browserMode === 'processes', 'native-fake requires eight separate processes so each microphone has its own file');
const nativeAudioParent = resolve(process.env.HARMONY_CAPACITY_NATIVE_AUDIO_DIR
  || (process.platform === 'darwin' ? join(homedir(), 'Library/Audio/Plug-Ins') : tmpdir()));
const screenFrequency = nativeFake ? frequencies[0] : 1980;
const audioMode = process.env.HARMONY_CAPACITY_AUDIO_MODE || 'shared';
assert.ok(['shared', 'split'].includes(audioMode), 'HARMONY_CAPACITY_AUDIO_MODE must be shared or split');
const browsers = new Array(8); // Indexed BEFORE any await: never completion order.
const browserHosts = [];
let sharedHost, mediaDirectory, audioMediaDirectory;
const mediaFiles = [];
const people = [];
const report = {
  started_at: new Date().toISOString(),
  status: 'RUNNING', functional_status: 'NOT_RUN', quality_status: 'NOT_RUN', moderation_status: 'NOT_RUN',
  scope: browserMode === 'contexts'
    ? 'Eight isolated BrowserContexts in one Chrome on one machine; shared GPU/audio services; production P2PCall and real loopback API/WS; generated media only'
    : 'Eight separate Chrome processes on one machine; production P2PCall and real loopback API/WS; generated media only',
  browser_mode: browserMode, browser_processes: browserMode === 'contexts' ? 1 : 8, browser_contexts: 8,
  media_source: mediaSource, requested_audio_graph_mode: audioMode,
  audio_graph_mode: nativeFake ? 'native-capture-with-analysis-context' : audioMode,
  audio_contexts_per_client: !nativeFake && audioMode === 'split' ? 2 : 1,
  audio_graph_scope: nativeFake
    ? 'Native fake microphones read distinct generated WAVs. WebAudio only analyses received tracks; its clock is not the native source clock. Received audio also plays through HTMLAudioElement.'
    : 'Generated tones feed MediaStreamDestination; received audio also plays through HTMLAudioElement and is measured through analyser→silent gain→context destination. Split mode uses distinct sender and analyser contexts.',
  media_source_scope: nativeFake
    ? 'Verified fake-device flags in private Chrome processes; generated WAV and Y4M via getUserMedia, never physical devices. Fake camera video is published in the screen slot; screen_audio and owner microphone share the 330 Hz file, so this mode proves slot routing, not distinct audio content for these two sources.'
    : 'Oscillator tones and canvas captureStream; no getUserMedia/getDisplayMedia calls',
  native_audio_path_scope: !nativeFake ? null : process.env.HARMONY_CAPACITY_NATIVE_AUDIO_DIR
    ? 'New owned temporary subdirectory inside an existing coordinator-selected directory; actual path omitted'
    : process.platform === 'darwin' ? 'New owned temporary subdirectory in the macOS audio sandbox-readable user audio data path; generated WAV data only, no plugin installation or sandbox changes'
      : 'New owned temporary subdirectory in the OS temporary directory',
  microphone_frequencies_hz: frequencies, screen_audio_frequency_hz: screenFrequency,
  process_count_scope: 'Top-level launched Chrome browser processes; excludes their renderer/GPU/audio helper processes',
  start_concurrency: startConcurrency, setup_timeout_ms: 90_000, runtime_cdp_timeout_ms: 30_000,
  requested: { seconds, height, width, fps, minimum_average_fps: minimumFps, bitrate_per_viewer: 4_000_000,
    minimum_nonconcealed_audio_wall_ratio: 0.8, maximum_audio_concealment_ratio: 0.02, minimum_audio_rms: 0.03 },
  engine_root: engineRoot, checks: [], samples: [], intervals: [], moderation: [],
  not_verified: ['WAN / independent networks / NAT', 'physical Windows / WebView2', 'physical microphone, camera or system audio',
    'actual screen capture', 'TURN', 'unbounded host saturation', 'central enforcement against cooperating modified peers'],
};
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function prepareNativeMedia() {
  mediaDirectory = await mkdtemp(join(tmpdir(), 'harmony-capacity-media-'));
  await chmod(mediaDirectory, 0o700);
  // Do not create, chmod or replace the parent directory or any existing audio
  // plugins. The mkdtemp result is the only directory we own and later remove.
  audioMediaDirectory = await mkdtemp(join(nativeAudioParent, 'HarmonyRtcFixture-'));
  await chmod(audioMediaDirectory, 0o700);
  const sampleRate = 48_000, duration = 2, samples = sampleRate * duration;
  for (let i = 0; i < 8; i++) {
    // Standard RIFF/WAVE PCM16LE mono. Integer-Hz tones loop seamlessly at 2 s.
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    for (let n = 0; n < samples; n++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequencies[i] * n / sampleRate) * 0.2 * 32767), 44 + n * 2);
    const path = join(audioMediaDirectory, `microphone-${i}.wav`);
    await writeFile(path, wav, { mode: 0o600, flag: 'wx' });
    mediaFiles[i] = { audio: { path, sha256: hash(wav), bytes: wav.length, format: 'RIFF/WAVE PCM16LE', channels: 1, sample_rate: sampleRate, duration_seconds: duration, frequency_hz: frequencies[i], loop: true } };
  }
  // Pure generated I420 Y4M, no external encoder, camera or downloaded content.
  // The two tiles move over a mostly static grid, rather than random full frames.
  const path = join(mediaDirectory, 'screen.y4m'), output = await open(path, 'wx', 0o600);
  const digest = createHash('sha256'), frames = fps * duration, ySize = width * height;
  let bytes = 0;
  const write = async buffer => { await output.writeFile(buffer); digest.update(buffer); bytes += buffer.length; };
  const rectangle = (frame, x, y, w, h, luma, u, v) => {
    x = Math.floor(x * width / 1280 / 2) * 2; y = Math.floor(y * height / 720 / 2) * 2;
    w = Math.floor(w * width / 1280 / 2) * 2; h = Math.floor(h * height / 720 / 2) * 2;
    for (let row = y; row < y + h; row++) frame.fill(luma, row * width + x, row * width + x + w);
    for (let row = y / 2; row < (y + h) / 2; row++) {
      const start = row * width / 2 + x / 2;
      frame.fill(u, ySize + start, ySize + start + w / 2);
      frame.fill(v, ySize + ySize / 4 + start, ySize + ySize / 4 + start + w / 2);
    }
  };
  try {
    await write(Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`));
    const background = Buffer.alloc(ySize * 3 / 2);
    background.fill(34, 0, ySize); background.fill(135, ySize, ySize * 5 / 4); background.fill(115, ySize * 5 / 4);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) rectangle(background, 12 + x * 126, 12 + y * 116, 110, 100, 64, 135, 115);
    for (let n = 0; n < frames; n++) {
      const frame = Buffer.from(background);
      rectangle(frame, (n * 7) % 1160, 190, 120, 90, 169, 80, 100);
      rectangle(frame, 800, 280 + Math.sin(n / 20) * 130, 90, 90, 210, 90, 155);
      // Small frame-code bars make every frame observably different.
      for (let bit = 0; bit < 8; bit++) rectangle(frame, 40 + bit * 28, 666, 20, 20, (n & (1 << bit)) ? 235 : 16, 128, 128);
      await write(Buffer.from('FRAME\n')); await write(frame);
    }
  } finally { await output.close(); }
  mediaFiles[0].video = { path, sha256: digest.digest('hex'), bytes, format: 'YUV4MPEG2 I420 progressive', width, height, fps, frames, duration_seconds: duration, loop: true };
  report.native_media_files = mediaFiles.map((files, index) => ({ client: index,
    ...Object.fromEntries(Object.entries(files).map(([kind, { path: _path, ...metadata }]) => [kind, metadata])) }));
  report.native_capture_guards = [];
}
function check(value, label) { assert.ok(value, label); report.checks.push(label); }
async function until(predicate, label, timeout = 30_000, interval = 150) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (stopping) throw new Error('Capacity run interrupted');
    if (await predicate()) { report.checks.push(label); return performance.now() - start; }
    await delay(interval);
  }
  throw new Error(label);
}
async function all(tasks) {
  // Wait for every launched operation before cleanup, including browser creation.
  const settled = await Promise.allSettled(tasks);
  const failure = settled.find(x => x.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map(x => x.value);
}
async function request(method, path, body, token, statuses = [200, 201, 204]) {
  const result = await fetch(api + '/api' + path, {
    method, redirect: 'error', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
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
    this.socket.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('CDP closed')); this.pending.clear(); };
  }
  async send(method, params = {}, timeout = 30_000) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout after ${timeout} ms: ${method}`)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, userGesture = false, timeout = 30_000) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, timeout);
    // Never persist evaluated source (which can contain a fixture session).
    if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + (result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text));
    return result.result?.value;
  }
  run(body, userGesture = false) { return this.evaluate(`(async () => { ${body} })()`, userGesture); }
  close() { this.socket.close(); }
}

async function installBrowserHarness(root, sourceProfile, audioGraphMode, capture) {
  const qa = window.qa = { pcs: [], sockets: [], resources: [], playback: new Map(), errors: [], history: [], closures: [], peerTransitions: [], setup: [], audioContexts: [], nativeCaptures: [], captureErrors: [] };
  const native = capture.mode === 'native-fake';
  if (native && capture.verified !== true) throw new Error('Native capture requires verified private fake-device command line');
  const stage = name => qa.setup.push({ stage: name, at: performance.now() });
  stage('bootstrap');
  const NativePC = window.RTCPeerConnection, NativeWS = window.WebSocket;
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) {
      super(...args); qa.pcs.push(this);
      this.addEventListener('connectionstatechange', () => qa.peerTransitions.push({ at: performance.now(), pc: qa.pcs.indexOf(this), state: this.connectionState }));
    }
  };
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args);
      if (new URL(String(args[0])).pathname !== '/api/calls') return;
      qa.sockets.push(this);
      this.addEventListener('message', event => {
        try {
          const value = JSON.parse(event.data);
          if (value.type === 'closed') qa.closures.push({ at: performance.now(), type: 'server', code: value.code || null, reason: value.reason });
        } catch { /* Engine owns protocol validation. */ }
      });
      this.addEventListener('close', event => qa.closures.push({ at: performance.now(), type: 'socket', code: event.code }));
    }
  };
  window.addEventListener('unhandledrejection', event => qa.errors.push(String(event.reason?.message || event.reason)));
  // Exactly the same canonical api.ts URL that call.ts imports relatively.
  stage('loading modules');
  qa.api = await import(root + 'api.ts');
  qa.P2PCall = (await import(root + 'call.ts')).P2PCall;
  stage('modules loaded');
  const audioContext = async label => {
    const context = new AudioContext({ sinkId: { type: 'none' } }); qa.audioContexts.push(context);
    stage('resuming ' + label + ' AudioContext');
    let audioTimer;
    try {
      await Promise.race([context.resume(), new Promise((_, reject) => {
        audioTimer = setTimeout(() => reject(new Error(label + ' AudioContext resume exceeded 15000 ms; state=' + context.state)), 15_000);
      })]);
    } finally { clearTimeout(audioTimer); }
    if (context.state !== 'running') throw new Error(label + ' AudioContext did not start; state=' + context.state);
    stage(label + ' AudioContext running'); return context;
  };
  qa.analysisAudio = await audioContext(native || audioGraphMode === 'split' ? 'analysis' : 'shared');
  qa.sendAudio = native ? null : audioGraphMode === 'split' ? await audioContext('sender') : qa.analysisAudio;
  if (!native && (qa.sendAudio === qa.analysisAudio) !== (audioGraphMode === 'shared')) throw new Error('Audio graph isolation mismatch');
  const dispose = e => { e.node?.disconnect(); e.analyser?.disconnect(); e.silent?.disconnect(); e.element?.pause(); e.element?.remove(); };
  qa.render = snapshot => {
    const present = new Set();
    for (const peer of snapshot.participants) for (const [source, track] of Object.entries(peer.tracks)) {
      if (!track || track.readyState !== 'live') continue;
      const key = peer.user_id + ':' + source; present.add(key);
      let entry = qa.playback.get(key);
      if (entry?.track === track) continue;
      if (entry) dispose(entry);
      entry = { track, source, user: peer.user_id }; qa.playback.set(key, entry);
      const element = document.createElement(track.kind === 'video' ? 'video' : 'audio');
      element.autoplay = true; element.srcObject = new MediaStream([track]); document.body.append(element); entry.element = element;
      if (track.kind === 'video') { element.muted = true; element.playsInline = true; element.width = 240; }
      else {
        entry.node = qa.analysisAudio.createMediaStreamSource(new MediaStream([track]));
        entry.analyser = qa.analysisAudio.createAnalyser(); entry.analyser.fftSize = 4096;
        entry.waveform = new Float32Array(entry.analyser.fftSize); entry.bins = new Float32Array(entry.analyser.frequencyBinCount);
        entry.silent = qa.analysisAudio.createGain(); entry.silent.gain.value = 0;
        entry.node.connect(entry.analyser).connect(entry.silent).connect(qa.analysisAudio.destination);
      }
      element.play().catch(error => { if (track.readyState === 'live' && error.name !== 'AbortError') qa.errors.push(error.message); });
    }
    for (const [key, entry] of qa.playback) if (!present.has(key)) { dispose(entry); qa.playback.delete(key); }
    qa.latest = snapshot;
    const previous = qa.history.at(-1);
    if (!previous || previous.state !== snapshot.state || previous.peers !== snapshot.participants.length || previous.reason !== snapshot.reason)
      qa.history.push({ at: performance.now(), state: snapshot.state, peers: snapshot.participants.length, reason: snapshot.reason });
  };
  qa.serial = () => {
    const s = qa.call?.snapshot;
    if (!s) return null;
    const track = t => ({ kind: t.kind, readyState: t.readyState, enabled: t.enabled });
    return { state: s.state, reason: s.reason, self: s.self, profile: s.profile,
      participants: s.participants.map(p => ({ user_id: p.user_id, peer_id: p.peer_id, can_publish: p.can_publish, media: p.media, connection: p.connection, error: p.error, stats: p.stats,
        tracks: Object.fromEntries(Object.entries(p.tracks).filter(([, t]) => t).map(([k, t]) => [k, track(t)])) })),
      localTracks: Object.fromEntries(Object.entries(s.localTracks).filter(([, t]) => t).map(([k, t]) => [k, track(t)])) };
  };
  qa.observed = () => [...qa.playback.values()].map(e => {
    const base = { user: e.user, source: e.source, enabled: e.track.enabled, muted: e.track.muted, time: e.element.currentTime };
    if (e.track.kind === 'video') {
      const q = e.element.getVideoPlaybackQuality();
      return { ...base, width: e.element.videoWidth, height: e.element.videoHeight, frames: q.totalVideoFrames, rendered: q.totalVideoFrames - q.droppedVideoFrames, dropped: q.droppedVideoFrames, readyState: e.element.readyState };
    }
    e.analyser.getFloatTimeDomainData(e.waveform); e.analyser.getFloatFrequencyData(e.bins);
    let peak = 0; for (let i = 1; i < e.bins.length; i++) if (e.bins[i] > e.bins[peak]) peak = i;
    return { ...base, rms: Math.sqrt(e.waveform.reduce((sum, n) => sum + n * n, 0) / e.waveform.length), frequency: peak * qa.analysisAudio.sampleRate / e.analyser.fftSize };
  });
  const sources = ['microphone', 'camera', 'screen', 'screen_audio'];
  qa.rtp = async () => Promise.all(qa.pcs.filter(pc => pc.connectionState !== 'closed').map(async pc => {
    const transceivers = pc.getTransceivers();
    const member = qa.call.snapshot.participants.find(p => Object.values(p.tracks).some(t => transceivers.some(x => x.receiver.track === t)));
    const result = await pc.getStats(), rows = [...result.values()], byId = new Map(rows.map(r => [r.id, r]));
    const transport = rows.find(r => r.type === 'transport' && r.selectedCandidatePairId);
    const pair = transport ? byId.get(transport.selectedCandidatePairId) : rows.find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
    const local = pair && byId.get(pair.localCandidateId), remote = pair && byId.get(pair.remoteCandidateId);
    const route = !local || !remote ? 'unknown' : [local.candidateType, remote.candidateType].includes('relay') ? 'relay' : 'direct';
    // Explicit whitelist: no candidate addresses, ports, SDP, credentials or codec identifiers.
    const rtp = rows.filter(r => ['inbound-rtp', 'outbound-rtp'].includes(r.type) && !r.isRemote
      && !/\/(rtx|red|ulpfec)$/i.test(byId.get(r.codecId)?.mimeType || '')).map(r => {
      const row = { direction: r.type === 'outbound-rtp' ? 'outbound' : 'inbound', source: sources[Number(r.mid)] || 'unknown', codec_mime_type: byId.get(r.codecId)?.mimeType || null };
      for (const k of ['timestamp', 'bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'packetsLost', 'jitter', 'framesEncoded', 'framesDecoded', 'framesPerSecond', 'frameWidth', 'frameHeight', 'totalEncodeTime', 'totalDecodeTime', 'totalAudioEnergy', 'totalSamplesDuration', 'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'packetsDiscarded', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'freezeCount', 'totalFreezesDuration', 'qualityLimitationReason', 'qualityLimitationDurations', 'scalabilityMode', 'encoderImplementation', 'powerEfficientEncoder'])
        if (r[k] !== undefined) row[k] = r[k];
      const media = byId.get(r.mediaSourceId);
      if (media) row.media_source = Object.fromEntries(['kind', 'timestamp', 'width', 'height', 'frames', 'framesPerSecond', 'audioLevel', 'totalAudioEnergy', 'totalSamplesDuration'].filter(k => media[k] !== undefined).map(k => [k, media[k]]));
      return row;
    });
    const encoderSettings = transceivers.flatMap((t, i) => {
      if (!t.sender.track) return [];
      const p = t.sender.getParameters();
      return [{ source: sources[i], degradationPreference: p.degradationPreference || null,
        encodings: p.encodings.map(e => Object.fromEntries(['active', 'maxBitrate', 'maxFramerate', 'scaleResolutionDownBy', 'scalabilityMode'].filter(k => e[k] !== undefined).map(k => [k, e[k]]))) }];
    });
    return { user: member?.user_id || null, connection: pc.connectionState, route, localCandidateType: local?.candidateType || null, remoteCandidateType: remote?.candidateType || null, encoder_settings: encoderSettings,
      iceRttMs: typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null, rtp };
  }));
  qa.sample = async (stats = true) => {
    const started = performance.now(), snapshot = qa.serial();
    const settings = qa.call?.snapshot.localTracks.screen?.getSettings();
    return { at: started, setup: [...qa.setup], snapshot, audioState: qa.analysisAudio.state,
      audioClocks: { sender: { currentTime: qa.sendAudio?.currentTime ?? null, state: qa.sendAudio?.state || 'native-capture', sampleRate: qa.sendAudio?.sampleRate ?? null },
        analyser: { currentTime: qa.analysisAudio.currentTime, state: qa.analysisAudio.state, sampleRate: qa.analysisAudio.sampleRate }, separate: qa.sendAudio !== qa.analysisAudio,
        sender_clock_scope: native ? 'No WebAudio sender clock; native capture duration is exposed by RTP media_source totalSamplesDuration when available' : 'WebAudio generated-source context' },
      observed: qa.observed(), rtp: stats ? await qa.rtp() : [],
      sourceSettings: settings ? Object.fromEntries(['width', 'height', 'frameRate', 'aspectRatio'].filter(k => settings[k] !== undefined).map(k => [k, settings[k]])) : null,
      captureTicks: native ? null : qa.captureTicks || 0,
      nativeCaptures: qa.nativeCaptures.map(({ track, ...record }) => ({ ...record, readyState: track.readyState, enabled: track.enabled, muted: track.muted })), captureErrors: [...qa.captureErrors],
      sourcePreview: qa.sourceVideo ? { frames: qa.sourceVideo.getVideoPlaybackQuality().totalVideoFrames, time: qa.sourceVideo.currentTime, width: qa.sourceVideo.videoWidth, height: qa.sourceVideo.videoHeight } : null,
      errors: [...qa.errors], closures: [...qa.closures], history: [...qa.history],
      peerTransitions: [...qa.peerTransitions], sampling_ms: performance.now() - started };
  };
  const captureFake = async (constraints, kind) => {
    if (!native || capture.verified !== true || (kind === 'video' && !capture.video)) throw new Error('Fake capture guard rejected request');
    let expired = false, timer;
    const pending = navigator.mediaDevices.getUserMedia(constraints).then(stream => {
      // Late completion after a timeout never leaves an unowned live track.
      if (expired) { for (const track of stream.getTracks()) track.stop(); throw new Error('Fake capture completed after its deadline'); }
      for (const track of stream.getTracks()) {
        const record = { track, index: qa.nativeCaptures.length, kind: track.kind, at: performance.now(), initial_ready_state: track.readyState,
          ownership: 'Registered in qa.resources immediately after getUserMedia resolved', events: [], settings: {} };
        qa.nativeCaptures.push(record);
        for (const type of ['ended', 'mute', 'unmute']) track.addEventListener(type, () => {
          const at = performance.now(); record.events.push({ type, at, readyState: track.readyState, muted: track.muted });
          if (type === 'ended') record.ended_event_at = at;
        });
        // Native stop() does not emit ended. Distinguish a stop requested by the
        // client/cleanup from a device ending a track, while invoking native stop.
        const stop = track.stop.bind(track);
        track.stop = () => { record.events.push({ type: 'stop_called', at: performance.now(), phase: qa.cleaningUp ? 'fixture_cleanup' : 'client_or_capture_validation' }); stop(); };
        qa.resources.push({ track, close: () => {} });
      }
      return stream;
    });
    let stream;
    try { stream = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Fake ' + kind + ' capture exceeded 20000 ms')); }, 20_000); })]); }
    catch (error) { qa.captureErrors.push({ at: performance.now(), kind, phase: 'getUserMedia', name: error.name, message: error.message }); throw error; }
    finally { clearTimeout(timer); }
    const tracks = stream.getTracks(), track = tracks[0];
    try {
      if (tracks.length !== 1 || track.kind !== kind) throw new Error('Fake capture returned unexpected tracks');
      const settings = track.getSettings();
      if (kind === 'audio') for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'])
        if (settings[key] !== undefined && settings[key] !== false) throw new Error('Fake audio processing remained enabled: ' + key);
      qa.nativeCaptures.find(record => record.track === track).settings = Object.fromEntries(['width', 'height', 'frameRate', 'sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(k => settings[k] !== undefined).map(k => [k, settings[k]]));
      return track;
    } catch (error) { qa.captureErrors.push({ at: performance.now(), kind, phase: 'capture_validation', name: error.name, message: error.message }); for (const t of tracks) t.stop(); throw error; }
  };
  qa.tone = async frequency => {
    if (native) {
      if (frequency !== capture.frequency) throw new Error('Requested tone does not match the verified fake microphone file');
      return captureFake({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000 }, video: false }, 'audio');
    }
    const oscillator = qa.sendAudio.createOscillator(), gain = qa.sendAudio.createGain(), destination = qa.sendAudio.createMediaStreamDestination();
    oscillator.frequency.value = frequency; gain.gain.value = 0.2; oscillator.connect(gain).connect(destination); oscillator.start();
    const track = destination.stream.getAudioTracks()[0];
    qa.resources.push({ track, close: () => { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); } });
    return track;
  };
  qa.screen = async () => {
    if (native) {
      const track = await captureFake({ video: { width: { exact: sourceProfile.width }, height: { exact: sourceProfile.height }, frameRate: { ideal: sourceProfile.fps, max: sourceProfile.fps } }, audio: false }, 'video');
      const element = qa.sourceVideo = document.createElement('video');
      element.muted = true; element.playsInline = true; element.width = 240; element.srcObject = new MediaStream([track]); document.body.append(element);
      qa.resources.push({ track, close: () => { element.pause(); element.remove(); } });
      await element.play(); return track;
    }
    const canvas = document.createElement('canvas'); canvas.width = sourceProfile.width; canvas.height = sourceProfile.height;
    const context = canvas.getContext('2d'); let frame = 0;
    const draw = () => {
      context.setTransform(canvas.width / 1280, 0, 0, canvas.height / 720, 0, 0);
      context.fillStyle = '#15243b'; context.fillRect(0, 0, 1280, 720);
      context.fillStyle = '#253b5b'; for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) context.fillRect(12 + x * 126, 12 + y * 116, 110, 100);
      context.fillStyle = '#7adeca'; context.fillRect((frame * 7) % 1160, 190, 120, 90);
      context.fillStyle = '#f7bd66'; context.fillRect(800, 280 + Math.sin(frame / 20) * 130, 90, 90);
      context.fillStyle = '#ffffff'; context.font = '36px sans-serif'; context.fillText('Harmony generated ' + sourceProfile.height + 'p' + sourceProfile.fps + ' frame ' + frame, 40, 670);
      frame++; qa.captureTicks = frame;
    };
    draw(); const timer = setInterval(draw, 1000 / sourceProfile.fps), track = canvas.captureStream(sourceProfile.fps).getVideoTracks()[0];
    qa.resources.push({ track, close: () => clearInterval(timer) }); return track;
  };
  qa.cleanup = async () => { qa.cleaningUp = true; qa.call?.close(); for (const e of qa.playback.values()) dispose(e); qa.playback.clear(); for (const r of qa.resources) { r.track.stop(); try { r.close(); } catch {} } await Promise.all(qa.audioContexts.filter(c => c.state !== 'closed').map(c => c.close())); };
  stage('harness ready');
  return true;
}

async function launchBrowser(label) {
  const host = { label, profile: null, child: null, control: null, port: null, fakeArgs: [], stderr: Buffer.alloc(0), stderrBytes: 0 };
  browserHosts.push(host);
  host.profile = await mkdtemp(join(tmpdir(), 'harmony-capacity-'));
  await chmod(host.profile, 0o700);
  if (nativeFake) {
    const files = mediaFiles[label];
    assert.ok(Number.isInteger(label) && files?.audio && (label !== 0 || files.video), 'Native fake fixtures must exist before Chrome starts');
    for (const file of Object.values(files)) assert.equal(await hashFile(file.path), file.sha256, 'Generated fake fixture integrity before launch');
    host.fakeArgs = ['--enable-automation', '--disable-audio-input', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + files.audio.path];
    if (files.video) host.fakeArgs.push('--use-file-for-fake-video-capture=' + files.video.path);
  }
  host.child = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
    '--disable-audio-output', ...(nativeFake ? [...host.fakeArgs, '--enable-logging=stderr', '--vmodule=*audio*=2'] : ['--disable-audio-input']),
    '--remote-debugging-port=0', '--user-data-dir=' + host.profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  host.child.stderr.on('data', bytes => {
    host.stderrBytes += bytes.length;
    // Private bounded diagnostics; never include raw Chromium stderr in the
    // publishable report. It may contain local paths or service identifiers.
    host.stderr = Buffer.concat([host.stderr, bytes]);
    if (host.stderr.length > 262_144) host.stderr = host.stderr.subarray(host.stderr.length - 262_144);
  });
  host.child.on('error', () => { host.spawnFailed = true; });
  await until(async () => {
    if (host.spawnFailed || host.child.exitCode !== null) throw new Error(`Chrome ${label} exited before readiness`);
    try { host.port = Number((await readFile(join(host.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!host.port; } catch { return false; }
  }, `Chrome ${label} has an isolated process/profile`);
  return host;
}
async function makeBrowser(index) {
  const browser = browsers[index] = { index, client: null, host: null, contextId: null };
  const host = browser.host = browserMode === 'contexts' ? sharedHost : await launchBrowser(index);
  let target;
  if (browserMode === 'contexts') {
    // Official CDP Target domain; no shared default-context tabs or disabled
    // web security. Each app has its own storage partition and JS module realm.
    const created = await host.control.send('Target.createBrowserContext', { disposeOnDetach: true });
    browser.contextId = created.browserContextId;
    const { targetId } = await host.control.send('Target.createTarget', { url: web + '/@fs' + fixture, browserContextId: browser.contextId });
    const { targetInfo } = await host.control.send('Target.getTargetInfo', { targetId });
    check(targetInfo.browserContextId === browser.contextId, `Participant ${index} target belongs to its distinct BrowserContext`);
    await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${host.port}/json/list`)).json();
      target = targets.find(t => t.id === targetId); return !!target?.webSocketDebuggerUrl;
    }, `Participant ${index} has an addressable isolated target`, 10_000);
  } else {
    target = await (await fetch(`http://127.0.0.1:${host.port}/json/new?${encodeURIComponent(web + '/@fs' + fixture)}`, { method: 'PUT' })).json();
  }
  browser.client = new CDP(target.webSocketDebuggerUrl);
  await browser.client.send('Runtime.enable');
  if (nativeFake) {
    // Verify the actual owned browser process, not just our intended spawn args.
    // This command requires --enable-automation. Failure aborts before any gUM.
    const command = await browser.client.send('Browser.getBrowserCommandLine');
    const expected = [...host.fakeArgs, '--user-data-dir=' + host.profile];
    for (const flag of expected) {
      const key = flag.split('=')[0];
      check(command.arguments.filter(arg => arg.split('=')[0] === key).length === 1 && command.arguments.includes(flag), `Chrome ${index} verifies ${key} before fake capture`);
    }
    browser.nativeVerified = true;
    report.native_capture_guards.push({ client: index, command_line_verified: true, fixture_hash_verified: true, private_profile: true,
      fake_devices: true, force_fake_audio_input: true, fake_permissions: true, file_audio: true, file_video: index === 0, physical_capture: false });
  }
  await until(async () => browser.client.evaluate(`location.origin === ${JSON.stringify(new URL(web).origin)} && document.readyState === 'complete'`), `Chrome ${index} loaded loopback fixture`);
  await browser.client.evaluate(`localStorage.setItem('harmony.capacity.isolation',${JSON.stringify(runId + ':' + index)});true`);
  await browser.client.evaluate(`(${installBrowserHarness.toString()})(${JSON.stringify(engineRoot)},${JSON.stringify({ width, height, fps })},${JSON.stringify(audioMode)},${JSON.stringify({ mode: mediaSource, verified: browser.nativeVerified === true, frequency: frequencies[index], video: nativeFake && index === 0 })})`, true, 90_000);
  report.checks.push(`Chrome ${index} loaded modules and has a running AudioContext`);
  return browser;
}
async function start(index, channelId) {
  await browsers[index].client.run(`qa.call?.close(); await qa.api.setServer(${JSON.stringify(api)}); await qa.api.saveSession(${JSON.stringify(people[index])});
    qa.call = new qa.P2PCall({channelId:${JSON.stringify(channelId)}}); qa.call.subscribe(qa.render); await qa.call.connect();
    if(qa.call.snapshot.self?.user_id!==${JSON.stringify(people[index].user.id)})throw new Error('Browser account identity mismatch'); return true;`, true);
}
const snapshots = () => all(browsers.map(b => b.client.evaluate('qa.serial()')));
const sample = async (stats = true) => ({ at: performance.now(), observed_at: new Date().toISOString(), host_load: loadavg(), clients: await all(browsers.map(b => b.client.evaluate(`qa.sample(${stats})`))) });
const publishVoice = index => browsers[index].client.run(`await qa.call.setTrack('microphone',await qa.tone(${frequencies[index]}));return true;`, true);
const voice = (client, uid, source = 'microphone') => client.observed.find(o => o.user === uid && o.source === source);
function voicesValid(frame, excluded = new Set()) {
  return frame.clients.every((c, i) => people.every((p, j) => i === j || excluded.has(j)
    || (() => { const o = voice(c, p.user.id); return o?.enabled && o.rms > 0.03 && Math.abs(o.frequency - frequencies[j]) < 35; })()));
}
function meshValid(states, excluded = new Set()) {
  const expected = people.filter((_, i) => !excluded.has(i)).map(p => p.user.id);
  return states.every((s, i) => excluded.has(i) || (s?.state === 'connected' && s.self?.user_id === people[i].user.id
    && s.participants.length === expected.length - 1 && new Set(s.participants.map(p => p.user_id)).size === expected.length - 1
    && s.participants.every(p => p.user_id !== people[i].user.id && expected.includes(p.user_id) && p.connection === 'connected' && !p.error)));
}
function screensValid(frame) {
  return frame.clients.slice(1).every(c => {
    const v = voice(c, people[0].user.id, 'screen'), a = voice(c, people[0].user.id, 'screen_audio');
    return v?.width > 0 && v.height > 0 && v.frames > 10 && v.readyState >= 2 && a?.rms > 0.03 && Math.abs(a.frequency - screenFrequency) < 35;
  });
}
function rtpBytes(client, source) {
  return client.rtp.flatMap(p => p.rtp).filter(r => r.direction === 'outbound' && (!source || r.source === source))
    .reduce((sum, r) => sum + (typeof r.bytesSent === 'number' ? r.bytesSent : 0), 0);
}
function audioProgress(before, after, uid, source, elapsed) {
  const find = client => {
    const rows = client.rtp.filter(p => p.user === uid).flatMap(p => p.rtp).filter(r => r.direction === 'inbound' && r.source === source);
    return rows.length === 1 ? rows[0] : null;
  };
  const a = find(before), b = find(after);
  const delta = key => Number.isFinite(a?.[key]) && Number.isFinite(b?.[key]) ? b[key] - a[key] : null;
  const timestampDelta = delta('timestamp'), statsSeconds = timestampDelta > 0 ? timestampDelta / 1000 : null;
  const duration = delta('totalSamplesDuration'), samples = delta('totalSamplesReceived'), concealed = delta('concealedSamples'), energy = delta('totalAudioEnergy');
  const concealmentRatio = samples > 0 && concealed !== null && concealed >= 0 ? concealed / samples : null;
  const durationRatio = duration > 0 && statsSeconds > 0 ? duration / statsSeconds : null;
  // W3C totalSamplesReceived includes PLC. Discount it rather than accepting
  // synthetic concealment as successfully received audio. Thresholds are this
  // test's explicit budgets, not quality guarantees from the specification.
  // https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-concealedsamples
  const nonconcealedRatio = durationRatio !== null && concealmentRatio !== null ? durationRatio * (1 - concealmentRatio) : null;
  const rms = duration > 0 && energy !== null && energy >= 0 ? Math.sqrt(energy / duration) : null;
  const bytes = delta('bytesReceived'), packets = delta('packetsReceived');
  return { source, wall_seconds: elapsed, stats_seconds: statsSeconds, duration_seconds: duration, samples, concealed_samples: concealed,
    duration_wall_ratio: durationRatio, concealment_ratio: concealmentRatio, nonconcealed_wall_ratio: nonconcealedRatio, rms,
    bytes_received: bytes, packets_received: packets,
    pass: Number.isFinite(nonconcealedRatio) && nonconcealedRatio >= report.requested.minimum_nonconcealed_audio_wall_ratio
      && concealmentRatio <= report.requested.maximum_audio_concealment_ratio && rms > report.requested.minimum_audio_rms && bytes > 0 && packets > 0 };
}
function safeProgress(label) { console.log(JSON.stringify({ stage: label, checks: report.checks.length, status: report.status })); }
async function stableMeasurement() {
  await until(async () => { const f = await sample(false); return voicesValid(f) && screensValid(f); }, 'All 56 voices and seven screens/screen-audio tracks decode before measurement', 60_000);
  const first = await sample(); report.samples.push(first);
  const started = performance.now(); let previous = first;
  const voiceAdvances = [], audioIntervals = [], quality = [], functional = [];
  while (performance.now() - started < seconds * 1000) {
    if (stopping) throw new Error('Capacity run interrupted');
    await delay(3000);
    const current = await sample(); report.samples.push(current);
    const dt = (current.at - previous.at) / 1000;
    const ownerDt = (current.clients[0].at - previous.clients[0].at) / 1000;
    const interval = { completed: false, seconds: dt, elapsed_seconds: (current.at - first.at) / 1000, voices_decoded: 0, voice_progress_failures: [], audio: [], screens: [],
      owner_upload_rtp_bps: (rtpBytes(current.clients[0]) - rtpBytes(previous.clients[0])) * 8 / ownerDt,
      owner_screen_rtp_bps: (rtpBytes(current.clients[0], 'screen') - rtpBytes(previous.clients[0], 'screen')) * 8 / ownerDt,
      source_draw_fps: nativeFake ? null : (current.clients[0].captureTicks - previous.clients[0].captureTicks) / ownerDt,
      native_source_preview_fps: nativeFake ? (current.clients[0].sourcePreview.frames - previous.clients[0].sourcePreview.frames) / ownerDt : null,
      audio_clock_progress: current.clients.map((c, i) => {
        const before = previous.clients[i], elapsed = (c.at - before.at) / 1000;
        const sender = nativeFake ? null : c.audioClocks.sender.currentTime - before.audioClocks.sender.currentTime;
        const analyser = c.audioClocks.analyser.currentTime - before.audioClocks.analyser.currentTime;
        return { client: i, wall_seconds: elapsed, sender_seconds: sender, analyser_seconds: analyser,
          sender_ratio: sender === null ? null : sender / elapsed, analyser_ratio: analyser / elapsed,
          sender_state: c.audioClocks.sender.state, analyser_state: c.audioClocks.analyser.state };
      }) };
    // Keep the failing interval's clocks as well as successful intervals.
    report.intervals.push(interval);
    check(meshValid(current.clients.map(c => c.snapshot)), 'Eight clients retain the complete connected mesh during sampling');
    check(current.clients.every(c => c.errors.length === 0 && c.closures.length === 0), 'No browser error or signaling close during stable sampling');
    check(current.clients.every(c => !c.peerTransitions.some(t => ['failed', 'closed', 'disconnected'].includes(t.state))), 'No peer failure, closure or disconnect during stable sampling');
    check(voicesValid(current), 'All 56 distinct microphone tones remain decoded');
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if (i !== j) {
      const before = voice(previous.clients[i], people[j].user.id), after = voice(current.clients[i], people[j].user.id);
      const clientDt = (current.clients[i].at - previous.clients[i].at) / 1000;
      const advance = (after?.time || 0) - (before?.time || 0); voiceAdvances.push(advance / clientDt);
      const audio = { receiver: i, sender: j, ...audioProgress(previous.clients[i], current.clients[i], people[j].user.id, 'microphone', clientDt) };
      interval.audio.push(audio); audioIntervals.push(audio);
      if (advance > clientDt * 0.5 && audio.pass) interval.voices_decoded++; else interval.voice_progress_failures.push({ receiver: i, sender: j, advance_seconds: advance, rtp_pass: audio.pass });
    }
    functional.push(interval.voice_progress_failures.length === 0 && screensValid(current));
    for (let i = 1; i < 8; i++) {
      const before = voice(previous.clients[i], people[0].user.id, 'screen'), after = voice(current.clients[i], people[0].user.id, 'screen');
      const clientDt = (current.clients[i].at - previous.clients[i].at) / 1000;
      const audio = { receiver: i, sender: 0, ...audioProgress(previous.clients[i], current.clients[i], people[0].user.id, 'screen_audio', clientDt) };
      interval.audio.push(audio); audioIntervals.push(audio); functional.push(audio.pass);
      const renderedFps = before && after ? (after.rendered - before.rendered) / clientDt : 0;
      interval.screens.push({ receiver: i, fps: renderedFps, received_fps: before && after ? (after.frames - before.frames) / clientDt : 0,
        dropped_frames: before && after ? after.dropped - before.dropped : null, width: after?.width || 0, height: after?.height || 0,
        size_zero: !after?.width || !after?.height, frozen: renderedFps <= 0 });
      functional.push(renderedFps > 0 && !!after?.width && !!after?.height);
      quality.push(after?.width === width && after?.height === height);
    }
    interval.completed = true; previous = current;
    if (report.intervals.length % 10 === 0) safeProgress(`stable ${Math.round(interval.elapsed_seconds)} s`);
  }
  const last = report.samples.at(-1), duration = (last.at - first.at) / 1000;
  const viewers = last.clients.slice(1).map((c, i) => {
    const before = voice(first.clients[i + 1], people[0].user.id, 'screen'), after = voice(c, people[0].user.id, 'screen');
    const clientDuration = (c.at - first.clients[i + 1].at) / 1000;
    const renderedFps = (after.rendered - before.rendered) / clientDuration;
    return { receiver: i + 1, average_fps: renderedFps, average_received_fps: (after.frames - before.frames) / clientDuration,
      dropped_frames: after.dropped - before.dropped, measurement_seconds: clientDuration, final_width: after.width, final_height: after.height };
  });
  report.stability = { duration_seconds: duration, directed_voice_streams: 56, pairwise_connections: 28, spectators: 7, viewers,
    source_average_draw_fps: nativeFake ? null : (last.clients[0].captureTicks - first.clients[0].captureTicks) / ((last.clients[0].at - first.clients[0].at) / 1000),
    native_source_average_preview_fps: nativeFake ? (last.clients[0].sourcePreview.frames - first.clients[0].sourcePreview.frames) / ((last.clients[0].at - first.clients[0].at) / 1000) : null,
    source_rate_scope: nativeFake
      ? 'Local preview frame deltas from the generated native camera track; capture media-source stats and encoded/decoded RTP frames are separately recorded. Not physical display capture.'
      : 'Canvas draw ticks; actual encoded/decoded frames are separately recorded in RTP stats and displayed-frame measurements',
    upload_scope: 'Difference of primary outbound RTP bytesSent counters; excludes RTX/RED/FEC, other protocol overhead and interface traffic',
    min_audio_playback_advance_ratio: Math.min(...voiceAdvances), zero_size_intervals: report.intervals.flatMap(i => i.screens).filter(s => s.size_zero).length,
    min_nonconcealed_audio_wall_ratio: Math.min(...audioIntervals.map(a => a.nonconcealed_wall_ratio ?? 0)),
    max_audio_concealment_ratio: Math.max(...audioIntervals.map(a => a.concealment_ratio ?? 1)),
    min_audio_rms: Math.min(...audioIntervals.map(a => a.rms ?? 0)),
    audio_interval_failures: audioIntervals.filter(a => !a.pass).length,
    audio_gate_scope: 'Per-interval inbound RTP duration and energy deltas for 56 microphone and seven screen-audio streams; PLC discounted, concealment bounded by the declared budget. FFT tone identity and HTMLAudio playback also checked. Generated media, not physical acoustic quality.',
    frozen_intervals: report.intervals.flatMap(i => i.screens).filter(s => s.frozen).length };
  report.functional_status = functional.every(Boolean) ? 'PASS' : 'FAIL';
  report.quality_status = quality.every(Boolean) && viewers.every(v => v.average_fps >= minimumFps) ? 'PASS' : 'FAIL';
  // Quality is recorded independently; never skip the security gates because of it.
  check(report.functional_status === 'PASS', '56 audio streams and seven videos progress throughout the stable interval');
  safeProgress('stable media measured; moderation follows');
}

async function moderation(admin, guild, channel, role) {
  const target = 7, uid = people[target].user.id;
  const ownerToken = () => browsers[0].client.evaluate('qa.api.getSession().access_token');
  const change = async (name, method, path, body, predicate) => {
    const token = await ownerToken(), started = performance.now();
    await request(method, path, body, token);
    await until(async () => predicate(await snapshots()), name, Math.max(1, 2000 - (performance.now() - started)), 50);
    const elapsed = performance.now() - started;
    report.moderation.push({ name, elapsed_ms: elapsed }); check(elapsed <= 2000, `${name} completes within two seconds including the HTTP request`);
  };
  const stopped = states => states[target].state === 'connected' && states[target].self?.can_publish === false && !Object.keys(states[target].localTracks).length
    && states.every((s, i) => i === target || !s.participants.find(p => p.user_id === uid)?.tracks.microphone);
  const allowed = states => states[target].state === 'connected' && states[target].self?.can_publish === true;
  const restoreVoice = async label => {
    check(!Object.keys((await snapshots())[target].localTracks).length, `${label} does not automatically restart capture`);
    await publishVoice(target);
    await until(async () => { const f = await sample(false); return meshValid(f.clients.map(c => c.snapshot)) && voicesValid(f) && screensValid(f); }, `${label}: all eight clients, 56 voices and seven screens recover`);
  };
  const listenersRetainMedia = async label => {
    await until(async () => { const f = await sample(false); return meshValid(f.clients.map(c => c.snapshot)) && voicesValid(f, new Set([target])) && screensValid(f); },
      `${label}: eight listeners retain the other 49 microphone streams and seven screens`);
  };
  await change('Mute stops the target media on all eight clients', 'POST', `/channels/${channel.id}/moderate`, { user_id: uid, action: 'mute' }, stopped);
  await listenersRetainMedia('Mute');
  await change('Unmute restores publication permission', 'POST', `/channels/${channel.id}/moderate`, { user_id: uid, action: 'unmute' }, allowed);
  await restoreVoice('Unmute');
  await change('PUBLISH deny stops publication without removing listener', 'PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '32' }, stopped);
  await listenersRetainMedia('PUBLISH deny');
  await change('PUBLISH restore reaches the existing call', 'PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '0' }, allowed);
  await restoreVoice('PUBLISH restore');
  const excluded = new Set([target]);
  await change('CONNECT deny closes target and removes it from seven peers', 'PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '16' }, states =>
    ['closed', 'failed'].includes(states[target].state) && !Object.keys(states[target].localTracks).length && meshValid(states, excluded));
  await request('PUT', `/channels/${channel.id}/permissions`, { role_id: role.id, allow: '0', deny: '0' }, await ownerToken());
  await browsers[target].client.run('await qa.call.reconnect();return true;', true);
  await until(async () => meshValid(await snapshots()), 'Explicit CONNECT re-entry rebuilds the eight-client mesh');
  await restoreVoice('CONNECT re-entry');
  // Admin is a separate disposable login; long capacity runs must not mistake
  // its expired access token for a failed moderation capability.
  admin = await request('POST', '/auth/refresh', { refresh_token: admin.refresh_token });
  // Read the current token from the same module after any automatic refresh.
  const oldToken = await browsers[target].client.evaluate('qa.api.getSession().access_token');
  const started = performance.now();
  await request('POST', `/admin/users/${uid}/reset`, { password: randomBytes(24).toString('hex') }, admin.access_token);
  await until(async () => { const s = await snapshots(); return ['closed', 'failed'].includes(s[target].state) && !Object.keys(s[target].localTracks).length && meshValid(s, excluded); },
    'Administrative reset closes target and preserves seven connected peers', Math.max(1, 2000 - (performance.now() - started)), 50);
  const elapsed = performance.now() - started; report.moderation.push({ name: 'password reset', elapsed_ms: elapsed });
  check(elapsed <= 2000, 'Reset reaches official clients within two seconds including the HTTP request');
  await request('GET', `/channels/${channel.id}/call`, undefined, oldToken, [401]);
  check(true, 'Reset access token cannot fetch call information');
  const rejected = await browsers[target].client.run(`
    const url=new URL('/api/calls',${JSON.stringify(api)});url.protocol=url.protocol==='https:'?'wss:':'ws:';
    return await new Promise((resolve,reject)=>{const ws=new WebSocket(url);const timer=setTimeout(()=>{ws.close();reject(new Error('Revoked-token WS did not close'))},5000);let admitted=false,code=null;
      ws.onopen=()=>ws.send(JSON.stringify({type:'auth',token:${JSON.stringify(oldToken)},channel_id:${JSON.stringify(channel.id)}}));
      ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.type==='ready')admitted=true;if(v.type==='closed')code=v.code};
      ws.onclose=()=>{clearTimeout(timer);resolve({admitted,code})};ws.onerror=()=>{};});`);
  check(!rejected.admitted && rejected.code === 'unauthorized', 'Reset access token is also rejected by WebSocket admission');
  const final = await sample(); report.after_moderation = final;
  check(final.clients.every(c => c.errors.length === 0), 'No unhandled browser error after moderation');
  check(final.clients.slice(0, target).every(c => c.closures.length === 0), 'Moderating one participant does not close unaffected signaling');
  report.moderation_status = 'PASS';
}

try {
  assert.ok(process.env.HARMONY_BOOTSTRAP_USERNAME && process.env.HARMONY_BOOTSTRAP_PASSWORD, 'Disposable instance bootstrap credentials are required for the fixture reset gate');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(fixture, '<!doctype html><title>Harmony generated capacity fixture</title><p>Eight-client generated media test.</p>', { mode: 0o600 });
  report.sources = { engine_sha256: hash(await readFile(join(engineDirectory, 'call.ts'))), api_sha256: hash(await readFile(join(engineDirectory, 'api.ts'))),
    server_source_sha256: hash(await readFile(serverSource)), server_binary_sha256: hash(await readFile(serverBinary)),
    server_binary_file: serverBinary, server_source_file: serverSource, server_identity_scope: 'Caller-declared binary/source paths; process identity must be verified by the run coordinator',
    harness_sha256: hash(await readFile(import.meta.filename)) };
  report.host = { logical_cpus: cpus().length, load_at_start: loadavg(), harness_process_priority: getPriority(), priority_scope: 'Observed Node harness priority; harness never invokes nice or renice' };
  if (nativeFake) {
    const started = performance.now(); await prepareNativeMedia();
    report.native_media_preparation_ms = performance.now() - started;
  }
  const admin = await request('POST', '/auth/login', { username: process.env.HARMONY_BOOTSTRAP_USERNAME, password: process.env.HARMONY_BOOTSTRAP_PASSWORD });
  const password = randomBytes(24).toString('hex');
  for (let i = 0; i < 8; i++) people.push(await request('POST', '/auth/register', { username: `capacity_${i}_${runId}`, display_name: `Capacity ${i + 1}`, password }));
  const owner = people[0], guild = await request('POST', '/guilds', { name: `Capacity ${runId}` }, owner.access_token);
  const channel = await request('POST', `/guilds/${guild.id}/channels`, { name: 'Eight generated peers', kind: 'voice' }, owner.access_token);
  const cfg = await request('GET', `/channels/${channel.id}/call`, undefined, owner.access_token);
  check(cfg.transport === 'p2p' && cfg.ice_servers.length === 0 && cfg.max_participants >= 8, 'Disposable room admits eight P2P clients without external STUN');
  check(cfg.max_video_bitrate >= 4_000_000, 'Server permits the requested 4 Mb/s profile');
  await request('POST', `/channels/${channel.id}/media-token`, {}, owner.access_token, [503]);
  check(true, 'LiveKit token endpoint remains disabled');
  const invite = await request('POST', `/guilds/${guild.id}/invites`, { max_uses: 7, expires_hours: 1 }, owner.access_token);
  for (const p of people.slice(1)) await request('POST', '/invites/accept', { token: invite.token }, p.access_token);
  const role = await request('POST', `/guilds/${guild.id}/roles`, { name: 'Capacity moderation fixture', permissions: '63' }, owner.access_token);
  await request('PUT', `/guilds/${guild.id}/members/${people[7].user.id}/roles/${role.id}`, {}, owner.access_token);
  if (browserMode === 'contexts') {
    sharedHost = await launchBrowser('shared');
    const version = await (await fetch(`http://127.0.0.1:${sharedHost.port}/json/version`)).json();
    sharedHost.control = new CDP(version.webSocketDebuggerUrl);
  }
  // Booting eight module graphs and audio services at once distorts the host
  // before the measured RTC workload begins. Both A/B arms use this same boot.
  for (let first = 0; first < 8; first += startConcurrency)
    await all(Array.from({ length: Math.min(startConcurrency, 8 - first) }, (_, i) => makeBrowser(first + i)));
  if (browserMode === 'contexts') check(new Set(browsers.map(b => b.contextId)).size === 8, 'Eight distinct browser context identifiers exist');
  const isolatedStorage = await all(browsers.map(b => b.client.evaluate(`localStorage.getItem('harmony.capacity.isolation')`)));
  check(isolatedStorage.every((value, i) => value === runId + ':' + i), 'All eight storage partitions retain independent markers');
  report.browser = await browsers[0].client.send('Browser.getVersion');
  await all(browsers.map((_, i) => start(i, channel.id)));
  await until(async () => meshValid(await snapshots()), 'Eight identities form all 28 real RTC peer connections', 90_000);
  check((await snapshots()).every(s => Object.keys(s.localTracks).length === 0), 'Joining never starts a capture automatically');
  await all(browsers.map((_, i) => publishVoice(i)));
  await browsers[0].client.run(`await qa.call.setScreenProfile({height:${height},fps:${fps},bitrate:4,content:'motion',audio:true});
    await qa.call.setTrack('screen',await qa.screen());await qa.call.setTrack('screen_audio',await qa.tone(${screenFrequency}));return true;`, true);
  await stableMeasurement();
  await moderation(admin, guild, channel, role);
  report.sources_unchanged = report.sources.engine_sha256 === hash(await readFile(join(engineDirectory, 'call.ts')))
    && report.sources.api_sha256 === hash(await readFile(join(engineDirectory, 'api.ts')))
    && report.sources.harness_sha256 === hash(await readFile(import.meta.filename))
    && report.sources.server_source_sha256 === hash(await readFile(serverSource))
    && report.sources.server_binary_sha256 === hash(await readFile(serverBinary));
  check(report.sources_unchanged, 'Declared engine, session module, server binary/source and harness did not change during the run');
  report.status = report.functional_status === 'PASS' && report.quality_status === 'PASS' && report.moderation_status === 'PASS' ? 'PASS' : 'FAIL';
  if (report.status !== 'PASS') { report.error = `Functional/security results and exact ${height}p, average >=${minimumFps} FPS quality are separate gates; inspect their statuses`; process.exitCode = 1; }
} catch (error) {
  report.status = 'FAIL'; report.error = error.message; process.exitCode = 1;
  report.failure = await Promise.all(browsers.map(async b => b?.client ? b.client.evaluate(`
    window.qa?.sample ? qa.sample(false) : ({setup:window.qa?.setup||[],audioStates:(window.qa?.audioContexts||[]).map(c=>c.state),snapshot:null})
  `).catch(() => null) : null));
} finally {
  report.cleanup = [];
  for (const b of browsers) if (b) {
    let captureStopped = false;
    try { captureStopped = await b.client?.run(`
      if(window.qa?.cleanup)await qa.cleanup();
      else if(window.qa){qa.call?.close();for(const r of qa.resources||[]){r.track.stop();try{r.close()}catch{}}for(const pc of qa.pcs||[])pc.close();await Promise.all((qa.audioContexts||[]).filter(c=>c.state!=='closed').map(c=>c.close()));}
      return !!window.qa&&(qa.resources||[]).every(r=>r.track.readyState==='ended')&&(qa.pcs||[]).every(pc=>pc.connectionState==='closed')&&(qa.audioContexts||[]).every(c=>c.state==='closed');
    `); } catch {}
    b.client?.close();
    let contextDisposed = b.contextId === null;
    if (b.contextId && b.host?.control) {
      try { await b.host.control.send('Target.disposeBrowserContext', { browserContextId: b.contextId }); contextDisposed = true; } catch {}
    }
    report.cleanup.push({ browser: b.index, capture_stopped: captureStopped === true, context_disposed: contextDisposed });
  }
  // A shared host must outlive cleanup of every app context. Ownership belongs
  // to this host list, never to whichever app/browser happened to finish first.
  report.host_cleanup = [];
  for (const host of browserHosts) {
    host.control?.close();
    if (host.child?.pid && host.child.exitCode === null) {
      host.child.kill('SIGTERM');
      for (let i = 0; i < 20 && host.child.exitCode === null; i++) await delay(100);
      if (host.child.exitCode === null) host.child.kill('SIGKILL');
    }
    // Chrome helper processes can retain the inherited pipe after the owning
    // browser exits. Release our pipe handle explicitly; never kill unrelated PIDs.
    host.child?.stderr?.destroy();
    let profileRemoved = false;
    try { if (host.profile) await rm(host.profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); profileRemoved = true; } catch {}
    const stderrPath = join(dirname(reportPath), `chrome-${host.label}-${runId}.private.log`);
    await writeFile(stderrPath, host.stderr, { mode: 0o600 });
    report.host_cleanup.push({ host: host.label, profile_removed: profileRemoved, private_stderr_bytes: host.stderr.length,
      stderr_total_bytes: host.stderrBytes, stderr_truncated: host.stderrBytes > host.stderr.length, private_stderr_sha256: hash(host.stderr) });
  }
  await rm(fixture, { force: true }).catch(() => {});
  if (mediaDirectory) {
    try { await rm(mediaDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); report.native_media_removed = true; }
    catch { report.native_media_removed = false; }
  }
  if (audioMediaDirectory) {
    try { await rm(audioMediaDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); report.native_audio_removed = true; }
    catch { report.native_audio_removed = false; }
  }
  report.host_load_at_end = loadavg(); report.finished_at = new Date().toISOString();
  if (report.status === 'PASS' && (report.cleanup.some(x => !x.capture_stopped || !x.context_disposed) || report.host_cleanup.some(x => !x.profile_removed) || report.native_media_removed === false || report.native_audio_removed === false)) {
    report.status = 'FAIL'; report.error = 'Cleanup did not release all owned tracks/contexts/profiles'; process.exitCode = 1;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await new Promise(resolve => process.stdout.write(JSON.stringify({ status: report.status, functional: report.functional_status, quality: report.quality_status, moderation: report.moderation_status, checks: report.checks.length, error: report.error, evidence: reportPath }) + '\n', resolve));
  // Report has been written and stdout has flushed; residual Chromium handles must
  // not leave a completed test process alive indefinitely.
  process.exit(process.exitCode || 0);
}
