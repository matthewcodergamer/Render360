import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports = wasi.getImportObject(mod);
for (const im of WebAssembly.Module.imports(mod)) {
  if (im.module === 'env' && im.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const bootstrap = await WebAssembly.instantiate(mod, imports);
wasi.initialize(bootstrap);
const e = bootstrap.exports;
const pick = n => e[n] ?? e[`_${n}`];

const required = [
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3',
  'r360_kernel_import_reset','r360_kernel_import_register','r360_kernel_import_calls',
  'r360_kernel_import_last_thunk','r360_kernel_import_last_module',
  'r360_kernel_import_last_ordinal','r360_kernel_import_last_status'
];
for (const n of required) if (typeof pick(n) !== 'function') throw new Error(`critic missing export ${n}`);

const base = 0x80000000;
const thunk = 0x70004321;
const moduleId = 7;
const ordinal = 0x456;
const service = base + 24;
const ptr = base + 0x300;
const value = 0xA1B2C3D4;
const hi = (thunk >>> 16) & 0xffff;
const lo = thunk & 0xffff;
const input = pick('r360_ppc_probe_input_buffer')() >>> 0;

// Caller: materialize thunk, bctrl, increment service return in r3, return.
// Service: store r4 through guest pointer r3, return 0x41 in r3.
const abiWords = [
  0x3D600000 | hi, 0x616B0000 | lo, 0x7D6903A6, 0x4E800421,
  0x38630001, 0x4E800020,
  0x90830000, 0x38600041, 0x4E800020,
];
const controlWords = [0x3D600000 | hi, 0x616B0000 | lo, 0x7D6903A6, 0x4E800421, 0x4E800020];

function writeWords(words) {
  const m = new Uint8Array(e.memory.buffer);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] >>> 0, o = input + i * 4;
    m[o] = w >>> 24; m[o+1] = (w >>> 16) & 255; m[o+2] = (w >>> 8) & 255; m[o+3] = w & 255;
  }
}
function telemetry() {
  return {
    status: pick('r360_ppc_probe_correctness_status')() >>> 0,
    r3: Number(pick('r360_ppc_probe_correctness_r3')()),
    calls: pick('r360_kernel_import_calls')() >>> 0,
    thunk: pick('r360_kernel_import_last_thunk')() >>> 0,
    module: pick('r360_kernel_import_last_module')() >>> 0,
    ordinal: pick('r360_kernel_import_last_ordinal')() >>> 0,
    lastStatus: pick('r360_kernel_import_last_status')() >>> 0,
  };
}
function runAbi(guestPtr, abiTarget = service, implemented = true) {
  pick('r360_ppc_probe_reset')();
  pick('r360_kernel_import_reset')();
  writeWords(abiWords);
  if ((pick('r360_ppc_probe_load_at')(base, input, abiWords.length * 4) >>> 0) !== abiWords.length * 4) throw new Error('critic ABI load failed');
  if ((pick('r360_ppc_probe_set_initial_gpr')(3, BigInt(guestPtr >>> 0)) >>> 0) !== 1) throw new Error('critic set r3 failed');
  if ((pick('r360_ppc_probe_set_initial_gpr')(4, BigInt(value >>> 0)) >>> 0) !== 1) throw new Error('critic set r4 failed');
  if ((pick('r360_kernel_import_register')(thunk, moduleId, ordinal, implemented ? 1 : 0, abiTarget >>> 0) >>> 0) !== 1) throw new Error('critic register failed');
  if (!(pick('r360_ppc_probe_translate')() >>> 0)) throw new Error('critic translate failed');
  return telemetry();
}
function runControl(implemented, abiTarget = 0) {
  pick('r360_ppc_probe_reset')();
  pick('r360_kernel_import_reset')();
  writeWords(controlWords);
  if ((pick('r360_ppc_probe_load_at')(base, input, controlWords.length * 4) >>> 0) !== controlWords.length * 4) throw new Error('critic control load failed');
  if ((pick('r360_kernel_import_register')(thunk, moduleId, ordinal, implemented ? 1 : 0, abiTarget >>> 0) >>> 0) !== 1) throw new Error('critic control register failed');
  if (!(pick('r360_ppc_probe_translate')() >>> 0)) throw new Error('critic control translate failed');
  return telemetry();
}

// Positive path: arguments, guest-visible state, return ABI, and continuation all must agree.
if ((pick('r360_ppc_probe_write_guest_u32_be')(ptr, 0) >>> 0) !== 1) throw new Error('critic seed failed');
const ok = runAbi(ptr);
const stored = pick('r360_ppc_probe_read_guest_u32_be')(ptr) >>> 0;
if (ok.status !== 3 || ok.r3 !== 0x42 || ok.calls !== 1 || ok.lastStatus !== 1 ||
    ok.thunk !== thunk || ok.module !== moduleId || ok.ordinal !== ordinal || stored !== (value >>> 0)) {
  throw new Error(`critic positive ABI mismatch ${JSON.stringify({...ok,stored})}`);
}
console.log('KERNEL_ABI_CRITIC_ARGUMENTS=PASS');
console.log('KERNEL_ABI_CRITIC_GUEST_MEMORY=PASS');
console.log('KERNEL_ABI_CRITIC_R3_RETURN=PASS');
console.log('KERNEL_ABI_CRITIC_CONTINUATION=PASS');

// Exact end-of-window crossing: a 4-byte store beginning at +0xFFFE must fail closed.
const boundary = runAbi(base + 0xFFFE);
if (boundary.status !== 1 || boundary.lastStatus !== 3 || boundary.calls !== 1) throw new Error(`critic boundary failure ${JSON.stringify(boundary)}`);
console.log('KERNEL_ABI_CRITIC_RANGE_FAIL_CLOSED=PASS');

// 32-bit wraparound pointer must fail closed, never alias back into the staging window.
const wrap = runAbi(0xFFFFFFFE);
if (wrap.status !== 1 || wrap.lastStatus !== 3 || wrap.calls !== 1) throw new Error(`critic wraparound failure ${JSON.stringify(wrap)}`);
console.log('KERNEL_ABI_CRITIC_WRAPAROUND_FAIL_CLOSED=PASS');

// Recursive ABI target must be rejected explicitly rather than recursing or becoming a blanket success.
const recursive = runControl(true, thunk);
if (recursive.status !== 1 || recursive.lastStatus !== 3 || recursive.calls !== 1) throw new Error(`critic recursive target failure ${JSON.stringify(recursive)}`);
console.log('KERNEL_ABI_CRITIC_RECURSION_FAIL_CLOSED=PASS');

// Unsupported export must preserve exact blocker telemetry and may not mutate guest state.
if ((pick('r360_ppc_probe_write_guest_u32_be')(ptr, 0x0BADF00D) >>> 0) !== 1) throw new Error('critic unsupported seed failed');
const unsupported = runControl(false, 0);
const unchanged = pick('r360_ppc_probe_read_guest_u32_be')(ptr) >>> 0;
if (unsupported.status !== 1 || unsupported.lastStatus !== 2 || unsupported.calls !== 1 ||
    unsupported.thunk !== thunk || unsupported.module !== moduleId || unsupported.ordinal !== ordinal || unchanged !== 0x0BADF00D) {
  throw new Error(`critic unsupported blocker mismatch ${JSON.stringify({...unsupported,unchanged})}`);
}
console.log('KERNEL_ABI_CRITIC_UNSUPPORTED_EXACT_BLOCKER=PASS');
console.log('KERNEL_ABI_CRITIC_NO_BLANKET_SUCCESS=PASS');
console.log('KERNEL_ABI_CRITIC=PASS');
