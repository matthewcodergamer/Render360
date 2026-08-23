export class RuntimeHost {
  constructor(log, onStats) {
    this.log = log;
    this.onStats = onStats;
    this.worker = null;
    this.ready = false;
    this.inputMask = 0;
    this.keyBits = new Map([
      ['A',1<<0],['B',1<<1],['X',1<<2],['Y',1<<3],
      ['LT',1<<4],['RT',1<<5],['LB',1<<6],['RB',1<<7],
      ['START',1<<8],['BACK',1<<9]
    ]);
  }
  async init() {
    return new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(new URL('./worker/runtime-worker.js?v=30', import.meta.url), {type:'module', name:'Render360Runtime'});
      } catch (error) {
        reject(error); return;
      }
      const timeout = setTimeout(() => reject(new Error('Runtime worker startup timed out')), 8000);
      this.worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'ready') {
          clearTimeout(timeout); this.ready = true;
          this.log('ok', `WASM runtime worker active · V${msg.build} · ABI 0x${(msg.abi>>>0).toString(16).padStart(8,'0')}`);
          resolve(msg);
        } else if (msg.type === 'stats') {
          this.onStats?.(msg);
        } else if (msg.type === 'error') {
          this.log('error', `Runtime worker: ${msg.message}`);
        }
      };
      this.worker.onerror = (event) => {
        clearTimeout(timeout);
        const error = new Error(event.message || 'Runtime worker failed');
        if (!this.ready) reject(error); else this.log('error', error.message);
      };
    });
  }
  setKey(key, pressed) {
    const bit = this.keyBits.get(String(key).toUpperCase());
    if (!bit) return;
    if (pressed) this.inputMask |= bit; else this.inputMask &= ~bit;
    this.worker?.postMessage({type:'input', mask:this.inputMask>>>0});
  }
  pause(){this.worker?.postMessage({type:'pause'})}
  resume(){this.worker?.postMessage({type:'resume'})}
  setSession({kind=0,stage=0,titleId=0}={}){this.worker?.postMessage({type:'session',kind:kind>>>0,stage:stage>>>0,titleId:titleId>>>0})}
  reset(){this.worker?.postMessage({type:'reset'})}
}
