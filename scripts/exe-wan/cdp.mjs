export class CDP {
  constructor(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('CDP must stay on loopback');
    this.socket = new WebSocket(url); this.sequence = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = () => reject(new Error('CDP connection failed')); });
    this.socket.onmessage = event => {
      const value = JSON.parse(event.data), pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      value.error ? pending.reject(new Error('CDP command rejected')) : pending.resolve(value.result);
    };
    this.socket.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('CDP closed')); this.pending.clear(); };
  }
  async send(method, params = {}, timeout = 30000) {
    await this.ready; const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({id, method, params}));
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
