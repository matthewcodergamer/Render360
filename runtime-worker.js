import { Render360Core } from '../wasm-core.js';

const wasmUrl = new URL('../render360_xenia_core.wasm', import.meta.url).href;
const core = new Render360Core(wasmUrl);
let running = true;
let timer = 0;
let lastTick = performance.now();
let reportStart = lastTick;
let reportTicks = 0;

function post(type, data = {}) { self.postMessage({type, ...data}); }

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, 16);
}

function tick() {
  const now = performance.now();
  const dtMs = Math.max(0.1, Math.min(100, now - lastTick));
  lastTick = now;
  if (running && core.exports) {
    core.exports.r360_runtime_tick(Math.round(dtMs * 1000));
    reportTicks++;
  }
  const elapsed = now - reportStart;
  if (elapsed >= 500 && core.exports) {
    post('stats', {
      hz: reportTicks * 1000 / elapsed,
      ticks: core.exports.r360_runtime_ticks_lo() >>> 0,
      runtimeMs: core.exports.r360_runtime_time_ms() >>> 0,
      work: core.exports.r360_runtime_work_lo() >>> 0,
      checksum: core.exports.r360_runtime_checksum() >>> 0,
      inputMask: core.exports.r360_runtime_input_mask() >>> 0,
      running,
    });
    reportStart = now;
    reportTicks = 0;
  }
  schedule();
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (!core.exports) return;
  if (msg.type === 'input') core.exports.r360_runtime_set_input(msg.mask >>> 0);
  if (msg.type === 'pause') running = false;
  if (msg.type === 'resume') { running = true; lastTick = performance.now(); }
  if (msg.type === 'reset') core.exports.r360_runtime_reset();
};

(async () => {
  try {
    await core.init();
    core.exports.r360_runtime_reset();
    post('ready', {
      build: core.buildVersion,
      abi: core.abiVersion,
      features: core.featureBits,
    });
    schedule();
  } catch (error) {
    post('error', {message: error?.message || String(error)});
  }
})();
