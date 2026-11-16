const traceMethods=new Set(['Runtime.evaluate','Runtime.enable','Network.enable','Network.getResponseBody','Browser.getVersion','Browser.getBrowserCommandLine','Browser.grantPermissions','Emulation.setFocusEmulationEnabled']);
const traceStages=new Set(['session.start','session.setup','session.login_ready','session.observe','ui.fill','ui.button.enabled','ui.button.click','ui.labelled.enabled','ui.labelled.click','ui.select','login.enabled','login.click','call.open.enabled','call.open.click','share.open.enabled','share.open.click','capture.choose.enabled','capture.choose.click','capture.native.confirm.enabled','capture.native.confirm.click','share.configure.resolution','share.configure.fps','share.configure.bitrate_mode','share.configure.bitrate','share.configure.content','share.configure.audio','call.ready','call.microphone.ready','call.microphone.observe','capture.fixture','capture.method.detect','capture.method.select','capture.native_picker.wait','capture.native_picker.select','capture.native_consent','capture.preview.wait','capture.snapshot','capture.owner','capture.measure','failure.dom','failure.captures','failure.http','failure.browser','failure.renderer','failure.windows','failure.stats']);
export class CDP {
  constructor(url,{trace}={}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('CDP must stay on loopback');
    if(trace!==undefined&&typeof trace!=='function')throw Error('CDP trace observer must be a function');
    this.trace=trace;this.stage='session.start';this.url=url;this.socket = new WebSocket(url); this.sequence = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {this.rejectReady=reject;this.socket.onopen=resolve;this.socket.onerror=()=>{reject(new Error('CDP connection failed'));for(const p of this.pending.values())p.reject(new Error('CDP connection failed'),'connection_error');};});
    // A socket can close before any command; callers still observe rejection.
    void this.ready.catch(()=>{});
    this.socket.onmessage = event => {
      const value = JSON.parse(event.data); if(value.method)this.onEvent?.(value); const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      value.error ? pending.reject(new Error('CDP command rejected')) : pending.resolve(value.result);
    };
    this.socket.onclose = () => {this.rejectReady(new Error('CDP closed'));for (const p of this.pending.values()) p.reject(new Error('CDP closed'),'closed');this.pending.clear();};
  }
  setStage(stage){if(!traceStages.has(stage))throw Error('Unknown CDP trace stage');this.stage=stage;}
  async send(method, params = {}, timeout = 30000) {
    if(!Number.isFinite(timeout)||timeout<1||timeout>2147483647)throw Error('Invalid CDP deadline');
    const id = ++this.sequence,stage=this.stage,started=performance.now();
    const emit=state=>{if(!this.trace||!traceMethods.has(method))return;try{this.trace({method,id,stage,utc:new Date().toISOString(),socket_state:['connecting','open','closing','closed'][this.socket.readyState]||'closed',state,elapsed_ms:performance.now()-started,timeout_ms:timeout});}catch{}};
    return new Promise((resolve, reject) => {
      let settled=false;
      const finish=(value,error,state)=>{if(settled)return;settled=true;clearTimeout(timer);this.pending.delete(id);emit(state);error?reject(error):resolve(value);};
      // The same deadline covers connection readiness and the response. A late
      // open must never dispatch an already expired UI action.
      const timer=setTimeout(()=>finish(undefined,new Error('CDP timeout: '+method),'timeout'),timeout);
      this.pending.set(id,{resolve:value=>finish(value,null,'completed'),reject:(error,state='rejected')=>finish(undefined,error,state)});
      emit('waiting');
      void this.ready.then(()=>{if(settled)return;try{this.socket.send(JSON.stringify({id,method,params}));emit('sent');}catch{finish(undefined,new Error('CDP send failed'),'send_error');}},error=>finish(undefined,error,'connection_error'));
    });
  }
  async evaluate(expression, userGesture = false, timeout = 30000) {
    const result = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture}, timeout);
    if (result.exceptionDetails) throw new Error('Owned WebView evaluation failed');
    return result.result?.value;
  }
  run(body, gesture = false, timeout = 30000) { return this.evaluate(`(async()=>{${body}})()`, gesture, timeout); }
  close() { this.socket.close(); }
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function hasFlag(argumentsList, flag) {
  if (flag.startsWith('--disable-features=')) {
    const required=flag.slice('--disable-features='.length).split(',');
    const actual=argumentsList.find(a=>a.startsWith('--disable-features='))?.slice('--disable-features='.length).split(',')||[];
    return required.every(value=>actual.includes(value));
  }
  return argumentsList.includes(flag);
}
export async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(250); }
  throw new Error('Timeout: ' + label);
}
