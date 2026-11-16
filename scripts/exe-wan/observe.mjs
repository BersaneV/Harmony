// Passive instrumentation of the shipped WebView. No import of the engine,
// source replacement, encoder preference change, or media substitution.
export function observe(){
 if(!window.__TAURI_INTERNALS__||!['http://tauri.localhost','https://tauri.localhost'].includes(location.origin))throw Error('Owned compiled Tauri page required');
 if(window.__exeWan)throw Error('Already instrumented');
 const qa=window.__exeWan={pcs:[],tracks:[],events:[],contexts:[],captures:[],microphones:[],screenAudio:[],started:performance.now()};
 const nativeFrameSnapshots=new WeakMap();

 function countSource(record){
  record.processor_frames=0;record.distinct_marker_frames=0;record.marker_copy_errors=0;record.marker_copy_calls=0;record.marker_copy_total_ms=0;record.marker_copy_max_ms=0;record.processor_error=null;record.processor_sizes=new Set();record.processor_formats=new Set();record.processor_status='starting';
  record.observer_overhead='One permanent native-track clone/reader and one timed 1px RGBA copy per delivered frame; preflight reuses its counters and requests one frame clone after the timed window. Full source geometry is unchanged.';
  if(typeof MediaStreamTrackProcessor!=='function'){record.processor_status='unsupported';return;}
  const clone=record.track.clone(),pixel=new Uint8Array(4),pixelLayout={format:'RGBA',rect:{x:0,y:0,width:1,height:1}};let reader,watch,previous=null,snapshot=null;
  function finishSnapshot(error,frame){const pending=snapshot;if(!pending)return;snapshot=null;clearTimeout(pending.timer);if(error)pending.reject(error);else try{pending.resolve(frame.clone());}catch(e){pending.reject(e);}}
  try{reader=new MediaStreamTrackProcessor({track:clone,maxBufferSize:1}).readable.getReader();record.processor_status='running';
   nativeFrameSnapshots.set(record,()=>new Promise((resolve,reject)=>{if(snapshot){reject(Error('A source frame inspection is already pending'));return;}if(record.processor_status!=='running'||record.track.readyState!=='live'){reject(Error('Live source observer required'));return;}snapshot={resolve,reject,timer:setTimeout(()=>finishSnapshot(Error('Actual source frame inspection timed out')),3000)};}));
   watch=setInterval(()=>{if(record.track.readyState!=='live'){void reader.cancel().catch(()=>{});clone.stop();}},250);
   void(async()=>{try{while(record.track.readyState==='live'){const next=await reader.read();if(next.done)break;try{record.processor_sizes.add(`${next.value.displayWidth}x${next.value.displayHeight}`);record.processor_formats.add(next.value.format);if(record.kind==='native'){const before=performance.now();try{await next.value.copyTo(pixel,pixelLayout);}catch(error){record.marker_copy_errors++;throw error;}finally{const elapsed=performance.now()-before;record.marker_copy_calls++;record.marker_copy_total_ms+=elapsed;record.marker_copy_max_ms=Math.max(record.marker_copy_max_ms,elapsed);}const marker=(pixel[0]<<16)|(pixel[1]<<8)|pixel[2];if(marker!==previous)record.distinct_marker_frames++;previous=marker;}record.processor_frames++;finishSnapshot(null,next.value);}finally{next.value.close();}}record.processor_status=record.track.readyState==='live'?'ended':'stopped';}catch(error){record.processor_status='error';record.processor_error=String(error?.message||error).slice(0,300);}finally{finishSnapshot(Error('Actual source observer stopped'));nativeFrameSnapshots.delete(record);clearInterval(watch);clone.stop();reader.releaseLock();}})();
  }catch(error){clearInterval(watch);clone.stop();record.processor_status='error';record.processor_error=String(error?.message||error).slice(0,300);}
 }
 window.addEventListener('harmony-native-screen',event=>{
  const d=event.detail;
  if(!d||d.track?.kind!=='video'||typeof d.settings!=='function'||typeof d.label!=='string'||typeof d.backend!=='string')throw Error('Invalid native capture observation');
  const record={kind:'native',track:d.track,getSettings:d.settings,label:d.label,backend:d.backend,settings_source:'native-frame-metadata'};
  qa.captures.push(record);countSource(record);
 });
 qa.captureSnapshots=()=>qa.captures.map((c,index)=>({index,kind:c.kind,track_id:c.track.id,track_label:c.track.label,label:c.label,backend:c.backend,settings:c.getSettings(),track_settings:c.track.getSettings(),settings_source:c.settings_source,...(c.initial_settings?{initial_settings:{...c.initial_settings}}:{}),ready:c.track.readyState,processor_frames:c.processor_frames??null,distinct_marker_frames:c.distinct_marker_frames??null,marker_copy_errors:c.marker_copy_errors??null,marker_copy_calls:c.marker_copy_calls??null,marker_copy_total_ms:c.marker_copy_total_ms??null,marker_copy_max_ms:c.marker_copy_max_ms??null,processor_formats:[...(c.processor_formats||[])],processor_error:c.processor_error??null,observer_overhead:c.observer_overhead??null,processor_status:c.processor_status??null,processor_sizes:[...(c.processor_sizes||[])]}));
 // Inspect clones of actual application tracks. Nothing is substituted or
 // attached to a sender, and pixel inspection retains the complete frame size.
 qa.measureCapture=async(index,durationMs=10000)=>{
  if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>15000)throw Error('Bounded capture observation required');
  const capture=qa.captures[index];if(!capture||capture.track.readyState!=='live')throw Error('Live application capture required');
  const video=[...document.querySelectorAll('video')].find(v=>v.srcObject?.getVideoTracks?.().some(t=>t.id===capture.track.id));
  if(capture.kind==='native'){
   const snapshotFrame=nativeFrameSnapshots.get(capture);if(!snapshotFrame||capture.processor_status!=='running')throw Error('Native source must be counted by its permanent MediaStreamTrackProcessor');
   const first=qa.captureSnapshots()[index],initialVideo=video?.getVideoPlaybackQuality().totalVideoFrames??null,begin=performance.now();let frame;
   try{
    await new Promise(r=>setTimeout(r,durationMs));const elapsed=performance.now()-begin,end=qa.captureSnapshots()[index];
    if(end.processor_status!=='running'||end.processor_error||end.marker_copy_errors!==0)throw Error('Actual source observation failed: '+(end.processor_error||end.processor_status));
    const frames=end.processor_frames-first.processor_frames,changed=end.distinct_marker_frames-first.distinct_marker_frames;
    if(!Number.isSafeInteger(frames)||frames<0||!Number.isSafeInteger(changed)||changed<0||changed>frames)throw Error('Actual source counters are invalid');
    const measuredFps=video&&initialVideo!==null?(video.getVideoPlaybackQuality().totalVideoFrames-initialVideo)*1000/elapsed:null;
    // This is a handle clone of one full frame from the same permanent reader,
    // requested only after the counter window. No second processor/marker copy.
    frame=await snapshotFrame();const width=frame.displayWidth,height=frame.displayHeight;if(!width||!height)throw Error('Complete source frame unavailable');
    const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(width,height):Object.assign(document.createElement('canvas'),{width,height}),context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(frame,0,0,width,height);const rgba=context.getImageData(0,0,width,height).data;let light=0,colored=0;
    for(let y=0;y<90;y++)for(let x=0;x<160;x++){const p=(Math.floor(y*height/90)*width+Math.floor(x*width/160))*4;if(rgba[p]+rgba[p+1]+rgba[p+2]>30)light++;if(Math.abs(rgba[p]-rgba[p+1])+Math.abs(rgba[p+1]-rgba[p+2])>20)colored++;}
    return{...end,pixel_width:width,pixel_height:height,pixel_samples:14400,light_pixels:light,colored_pixels:colored,sampled_sizes:end.processor_sizes,observation_ms:elapsed,processor_frames:frames,processor_source_fps:frames*1000/elapsed,distinct_marker_frames:changed,distinct_marker_fps:changed*1000/elapsed,marker_copy_calls_delta:end.marker_copy_calls-first.marker_copy_calls,marker_copy_total_ms_delta:end.marker_copy_total_ms-first.marker_copy_total_ms,measured_fps:measuredFps};
   }finally{frame?.close();}
  }
  let clone,reader,task,lastFrame,error=null,frames=0,changed=0,previous=null,reading=true;const sizes=new Set();
  const initial=video?.getVideoPlaybackQuality().totalVideoFrames??null,begin=performance.now();
  if(typeof MediaStreamTrackProcessor==='function'){
   clone=capture.track.clone();reader=new MediaStreamTrackProcessor({track:clone,maxBufferSize:1}).readable.getReader();
   task=(async()=>{try{while(reading){const next=await reader.read();if(next.done)break;const frame=next.value;try{if(!reading)break;frames++;sizes.add(`${frame.displayWidth}x${frame.displayHeight}`);lastFrame?.close();lastFrame=frame.clone();if(capture.kind==='native'){const bytes=new Uint8Array(4);await frame.copyTo(bytes,{format:'RGBA',rect:{x:0,y:0,width:1,height:1}});const marker=`${bytes[0]},${bytes[1]},${bytes[2]}`;if(marker!==previous)changed++;previous=marker;}}finally{frame.close();}}}catch(e){if(reading)error=String(e?.message||e).slice(0,300);}})();
  }else if(capture.kind==='native')throw Error('Native source must be counted by MediaStreamTrackProcessor');
  try{
   await new Promise(r=>setTimeout(r,durationMs));const elapsed=performance.now()-begin;reading=false;if(reader){await reader.cancel();await task;}
   if(error)throw Error('Actual source observation failed: '+error);
   const width=lastFrame?.displayWidth??video?.videoWidth,height=lastFrame?.displayHeight??video?.videoHeight;if(!width||!height)throw Error('Complete source frame unavailable');
   const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(width,height):Object.assign(document.createElement('canvas'),{width,height}),context=canvas.getContext('2d',{willReadFrequently:true});
   context.drawImage(lastFrame||video,0,0,width,height);const rgba=context.getImageData(0,0,width,height).data;let light=0,colored=0;
   for(let y=0;y<90;y++)for(let x=0;x<160;x++){const p=(Math.floor(y*height/90)*width+Math.floor(x*width/160))*4;if(rgba[p]+rgba[p+1]+rgba[p+2]>30)light++;if(Math.abs(rgba[p]-rgba[p+1])+Math.abs(rgba[p+1]-rgba[p+2])>20)colored++;}
   if(!reader)sizes.add(`${width}x${height}`);
   return{...qa.captureSnapshots()[index],pixel_width:width,pixel_height:height,pixel_samples:14400,light_pixels:light,colored_pixels:colored,sampled_sizes:[...sizes],observation_ms:elapsed,processor_frames:reader?frames:null,processor_source_fps:reader?frames*1000/elapsed:null,distinct_marker_frames:capture.kind==='native'?changed:null,distinct_marker_fps:capture.kind==='native'?changed*1000/elapsed:null,measured_fps:video&&initial!==null?(video.getVideoPlaybackQuality().totalVideoFrames-initial)*1000/elapsed:null};
  }finally{reading=false;if(reader)try{await reader.cancel();await task;reader.releaseLock();}catch{}clone?.stop();lastFrame?.close();}
 };
 const userMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
 navigator.mediaDevices.getUserMedia=async(...args)=>{const stream=await userMedia(...args);for(const track of stream.getAudioTracks())qa.microphones.push(track);return stream;};
 qa.measureMicrophone=async()=>{const track=qa.microphones.find(t=>t.readyState==='live');if(!track)throw Error('Compiled UI microphone required');const clone=track.clone(),context=new AudioContext({sinkId:{type:'none'}});try{await context.resume();const a=context.createAnalyser();a.fftSize=4096;context.createMediaStreamSource(new MediaStream([clone])).connect(a);const values=new Float32Array(a.fftSize),begin=performance.now();let energy=0,samples=0,peak=0;while(performance.now()-begin<3000){await new Promise(r=>setTimeout(r,85));a.getFloatTimeDomainData(values);const square=values.reduce((sum,v)=>sum+v*v,0);energy+=square;samples+=values.length;peak=Math.max(peak,Math.sqrt(square/values.length));}return{rms:Math.sqrt(energy/samples),peak_window_rms:peak,observation_ms:performance.now()-begin,settings:track.getSettings(),source:'compiled UI microphone track'};}finally{clone.stop();await context.close();}};
 const Native=window.RTCPeerConnection;
 window.RTCPeerConnection=class extends Native{
  constructor(...args){super(...args);const pc=this,index=qa.pcs.length;qa.pcs.push(pc);pc.addEventListener('connectionstatechange',()=>qa.events.push({at:performance.now(),pc:index,state:pc.connectionState}));
   pc.addEventListener('track',event=>{const record={pc:index,track:event.track,transceiver:event.transceiver,analyser:null,context:null,error:null};qa.tracks.push(record);
    if(event.track.kind==='audio'){try{const context=new AudioContext({sinkId:{type:'none'}}),source=context.createMediaStreamSource(new MediaStream([event.track])),a=context.createAnalyser(),gain=context.createGain();a.fftSize=4096;gain.gain.value=0;source.connect(a).connect(gain).connect(context.destination);record.analyser=a;record.context=context;qa.contexts.push(context);context.resume().catch(()=>record.error='audio_analysis_resume')}catch{record.error='audio_analysis_setup'}}
   });
  }
 };
 // Record the real track returned by getDisplayMedia, without replacing it.
 const display=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
 navigator.mediaDevices.getDisplayMedia=async(...args)=>{const stream=await display(...args);for(const track of stream.getVideoTracks())qa.captures.push({kind:'browser',track,getSettings:()=>track.getSettings(),label:track.label,backend:'browser-getDisplayMedia',settings_source:'browser-track',initial_settings:{...track.getSettings()}});for(const track of stream.getAudioTracks())qa.screenAudio.push(track);return stream;};
 const numeric=['timestamp','bytesSent','bytesReceived','packetsSent','packetsReceived','packetsLost','jitter','framesEncoded','framesDecoded','framesPerSecond','frameWidth','frameHeight','totalEncodeTime','totalDecodeTime','totalAudioEnergy','totalSamplesDuration','totalSamplesReceived','concealedSamples','silentConcealedSamples','concealmentEvents','packetsDiscarded','jitterBufferDelay','jitterBufferEmittedCount','jitterBufferTargetDelay','jitterBufferMinimumDelay','framesDropped','freezeCount','totalFreezesDuration','qualityLimitationResolutionChanges','targetBitrate','qpSum','pliCount','firCount','nackCount','retransmittedPacketsSent','retransmittedBytesSent','totalPacketSendDelay','framesSent'];
 function localStatsId(value){return typeof value==='string'&&value.length>0&&value.length<=128&&/^[A-Za-z0-9_.:-]+$/.test(value)?value:undefined;}
 const sources=['microphone','camera','screen','screen_audio'];
 const uiVideo=track=>[...document.querySelectorAll('video')].find(v=>v.srcObject?.getVideoTracks?.().some(t=>t.id===track?.id));
 const shape=pc=>(pc.localDescription?.sdp||pc.remoteDescription?.sdp||'').split(/\r?\n/).filter(l=>l.startsWith('m=')).map(l=>l.slice(2).split(' ')[0]);
 const mesh=pc=>{const m=shape(pc),t=pc.getTransceivers().map(t=>t.receiver.track.kind);return m.join(',')==='audio,video,video,audio'&&t.join(',')===m.join(',');};
 const fingerprint=(certificate,description)=>{if(certificate?.fingerprint)return (certificate.fingerprintAlgorithm||'sha-256').toLowerCase()+':'+certificate.fingerprint.replace(/:/g,'').toLowerCase();const m=description?.sdp?.match(/^a=fingerprint:([^ ]+) ([^\r\n]+)/m);return m?m[1].toLowerCase()+':'+m[2].replace(/:/g,'').toLowerCase():null;};
 function uiSnapshot(){
  const visible=element=>!element.hidden&&typeof element.getClientRects==='function'&&element.getClientRects().length>0;
  const text=element=>String(element.textContent||'').slice(0,4096)
   .replace(/\b(?:https?|wss?):\/\/[^\s<>]+/gi,'[link]')
   .replace(/\bBearer\s+\S+/gi,'Bearer [redacted]')
   .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}/g,'[redacted]')
   .replace(/\b(access_token|refresh_token|token|password|senha|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,'$1=[redacted]')
   .replace(/\s+/g,' ').trim().slice(0,300);
  const header=[...document.querySelectorAll('.call-header')].find(visible);
  return{call_header:header?text(header):null,alerts:[...document.querySelectorAll('[role="alert"]')].filter(visible).slice(0,8).map(text),login_visible:[...document.querySelectorAll('input[autocomplete="username"]')].some(visible),self_microphones:qa.microphones.slice(-4).map(track=>({ready:track.readyState==='live'?'live':'ended',enabled:track.enabled===true}))};
 }
 qa.sample=async()=>{
  const peers=await Promise.all(qa.pcs.map(async(pc,index)=>{const report=await pc.getStats(),rows=new Map();report.forEach(r=>rows.set(r.id,r));const route=mesh(pc)?'p2p':'sfu',all=[...rows.values()],transport=all.find(r=>r.type==='transport'&&r.selectedCandidatePairId),pair=rows.get(transport?.selectedCandidatePairId)||all.find(r=>r.type==='candidate-pair'&&r.nominated&&r.state==='succeeded'),local=rows.get(pair?.localCandidateId),remote=rows.get(pair?.remoteCandidateId);
   const rtp=all.filter(r=>['inbound-rtp','outbound-rtp'].includes(r.type)&&!r.isRemote&&!/\/(rtx|red|ulpfec)$/i.test(rows.get(r.codecId)?.mimeType||'')).map(r=>{const inbound=r.type==='inbound-rtp',transceivers=pc.getTransceivers(),id=r.trackIdentifier||rows.get(r.mediaSourceId)?.trackIdentifier,transceiver=transceivers.find(t=>(inbound?t.receiver.track:t.sender.track)?.id===id),kind=r.kind||r.mediaType||rows.get(r.codecId)?.mimeType?.split('/')[0];let source;if(route==='p2p'){source=typeof r.mid==='string'?sources[Number(r.mid)]:null;if(!source)source=sources[transceivers.findIndex(t=>(inbound?t.receiver.track:t.sender.track)?.id===id)];}else if(kind==='video'){source=inbound?(uiVideo(transceiver?.receiver.track)?'screen':'unknown_video'):(qa.captures.some(c=>c.track.id===id)?'screen':'unknown_video');}else if(!inbound&&kind==='audio'&&qa.screenAudio.some(t=>t.id===id))source='screen_audio';else source=kind==='audio'?'unknown_audio':'unknown';const x={route,direction:inbound?'inbound':'outbound',source:source||'unknown',kind,track_id:id||null,codec:rows.get(r.codecId)?.mimeType||null};if(typeof r.id==='string')x.stats_id=r.id;if(typeof r.ssrc==='number'&&Number.isFinite(r.ssrc))x.ssrc=r.ssrc;for(const key of numeric)if(typeof r[key]==='number'&&Number.isFinite(r[key]))x[key]=r[key];if(typeof r.qualityLimitationReason==='string')x.quality_limitation_reason=r.qualityLimitationReason;if(typeof r.scalabilityMode==='string')x.scalability_mode=r.scalabilityMode.slice(0,32);
    if(r.qualityLimitationDurations)x.quality_limitation_durations=Object.fromEntries(Object.entries(r.qualityLimitationDurations).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)));
    if(typeof r.encoderImplementation==='string')x.encoder_implementation=r.encoderImplementation;
    if(typeof r.powerEfficientEncoder==='boolean')x.power_efficient_encoder=r.powerEfficientEncoder;
    if(r.type==='outbound-rtp'&&source==='screen'){const sender=transceiver?.sender||(route==='p2p'?pc.getTransceivers()[2]?.sender:null);const parameters=sender?.getParameters();x.sender_active=pc.connectionState==='connected'&&sender?.track?.readyState==='live'&&parameters?.encodings?.some(e=>e.active!==false)===true;if(parameters)x.sender_parameters={degradationPreference:parameters.degradationPreference,encodings:parameters.encodings?.map(e=>Object.fromEntries(['active','maxBitrate','maxFramerate','scaleResolutionDownBy','codec','scalabilityMode'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))),contentHint:sender.track?.contentHint,negotiated_codecs:parameters.codecs?.map(c=>({mimeType:c.mimeType,clockRate:c.clockRate,sdpFmtpLine:c.sdpFmtpLine,payloadType:c.payloadType}))};}
    const remoteStats=rows.get(r.remoteId);if(remoteStats)x.remote_feedback=Object.fromEntries(['packetsLost','fractionLost','roundTripTime','totalRoundTripTime','roundTripTimeMeasurements'].filter(k=>typeof remoteStats[k]==='number').map(k=>[k,remoteStats[k]]));
    const media=rows.get(r.mediaSourceId);
    if(!inbound&&kind==='video'){
     if(typeof r.contentType==='string'&&['unspecified','screenshare'].includes(r.contentType))x.content_type=r.contentType;
     const mediaId=localStatsId(r.mediaSourceId);
     if(mediaId&&media?.type==='media-source'&&media.kind==='video'&&localStatsId(media.id)===mediaId){
      const sourceStats={stats_id:mediaId,kind:'video'},trackId=localStatsId(media.trackIdentifier);if(trackId)sourceStats.track_id=trackId;
      for(const key of ['timestamp','framesPerSecond'])if(typeof media[key]==='number'&&Number.isFinite(media[key])&&media[key]>=0)sourceStats[key]=media[key];
      for(const key of ['width','height','frames'])if(typeof media[key]==='number'&&Number.isInteger(media[key])&&media[key]>=0&&media[key]<=0xffffffff)sourceStats[key]=media[key];
      x.media_source=sourceStats;
     }
    }else if(media)x.media_source=Object.fromEntries(['timestamp','width','height','frames','framesPerSecond','totalAudioEnergy','totalSamplesDuration'].filter(k=>typeof media[k]==='number').map(k=>[k,media[k]]));return x;});
   const tracks=qa.tracks.filter(t=>t.pc===index).map(t=>{const out={route,track_id:t.track.id,source:route==='p2p'?(sources[Number(t.transceiver.mid)]||'unknown'):(t.track.kind==='video'&&uiVideo(t.track)?'screen':t.track.kind==='audio'?'unknown_audio':'unknown_video'),kind:t.track.kind,ready:t.track.readyState,muted:t.track.muted,analysis_error:t.error};if(t.analyser){const a=new Float32Array(t.analyser.fftSize);t.analyser.getFloatTimeDomainData(a);out.rms=Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);out.analysis_state=t.context.state;const spectrum=new Float32Array(t.analyser.frequencyBinCount);t.analyser.getFloatFrequencyData(spectrum);let bin=1;for(let i=2;i<spectrum.length;i++)if(spectrum[i]>spectrum[bin])bin=i;out.peak_hz=bin*t.context.sampleRate/t.analyser.fftSize;}
    if(t.track.kind==='video'){const v=[...document.querySelectorAll('video')].find(v=>v.srcObject?.getVideoTracks?.().some(a=>a.id===t.track.id));if(v){const q=v.getVideoPlaybackQuality();out.video={width:v.videoWidth,height:v.videoHeight,current_time:v.currentTime,total_frames:q.totalVideoFrames,dropped_frames:q.droppedVideoFrames,paused:v.paused,ready_state:v.readyState};}}return out;});
   return{pc:index,route,m_line_kinds:shape(pc),legacy_conference:[pc.localDescription?.sdp,pc.remoteDescription?.sdp].some(s=>typeof s==='string'&&/^a=x-google-flag:conference\r?$/m.test(s)),state:pc.connectionState,local_fingerprint:fingerprint(rows.get(transport?.localCertificateId),pc.localDescription),remote_fingerprint:fingerprint(rows.get(transport?.remoteCertificateId),pc.remoteDescription),local_candidate:{type:local?.candidateType||null,protocol:local?.protocol||null,address:local?.address||local?.ip||null,port:local?.port||null},remote_candidate:{type:remote?.candidateType||null,protocol:remote?.protocol||null,address:remote?.address||remote?.ip||null,port:remote?.port||null},ice_rtt_ms:typeof pair?.currentRoundTripTime==='number'?pair.currentRoundTripTime*1000:null,available_outgoing_bitrate:typeof pair?.availableOutgoingBitrate==='number'?pair.availableOutgoingBitrate:null,rtp,tracks};
  }));
  return{at:performance.now(),wall_utc:Date.now(),peers,events:qa.events.slice(-200),captures:qa.captureSnapshots(),ui:uiSnapshot()};
 };
 return true;
}
