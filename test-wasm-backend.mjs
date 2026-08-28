import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`WasmBackend bootstrap WASM not found: ${wasmPath}`);

const bytes = fs.readFileSync(wasmPath);
const module = await WebAssembly.compile(bytes);
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(module);
for (const entry of WebAssembly.Module.imports(module)) {
  if (entry.module === 'env' && entry.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const pick = (name) => instance.exports[name] ?? instance.exports[`_${name}`];

const required = [
  'r360_ppc_probe_reset', 'r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_input_buffer', 'r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load', 'r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status', 'r360_ppc_probe_correctness_r3',
  'r360_ppc_context_size', 'r360_ppc_context_offset_gpr',
  'r360_wasm_backend_status', 'r360_wasm_backend_module_ptr',
  'r360_wasm_backend_module_size', 'r360_wasm_backend_lowered_instructions',
  'r360_wasm_backend_context_ptr',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') throw new Error(`Missing WasmBackend gate export ${name}`);
}
if (!(instance.exports.memory instanceof WebAssembly.Memory)) throw new Error('Parent bootstrap memory is not exported');

const wordBytes = (...words) => Uint8Array.from(words.flatMap((word) => [
  (word >>> 24) & 0xFF, (word >>> 16) & 0xFF, (word >>> 8) & 0xFF, word & 0xFF,
]));

// Genuine PPC: addi r3,r4,5 ; blr. This must first go through Xenia's scanner,
// frontend, PPCHIRBuilder and compiler passes before the backend sees it.
const ppc = wordBytes(0x38640005, 0x4E800020);
const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
if (ppc.length > capacity) throw new Error('Probe capacity too small');

pick('r360_ppc_probe_reset')();
if ((pick('r360_ppc_probe_set_initial_gpr')(4, 7n) >>> 0) !== 1) throw new Error('Could not seed correctness r4');
new Uint8Array(instance.exports.memory.buffer, inputPtr, ppc.length).set(ppc);
if ((pick('r360_ppc_probe_load')(inputPtr, ppc.length) >>> 0) !== ppc.length) throw new Error('Could not load PPC test');
pick('r360_ppc_probe_translate')();

const correctnessStatus = pick('r360_ppc_probe_correctness_status')() >>> 0;
const correctnessR3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
if (correctnessStatus !== 3 || correctnessR3 !== 12n) {
  throw new Error(`Xenia correctness reference failed: status=${correctnessStatus} r3=${correctnessR3}`);
}

const backendStatus = pick('r360_wasm_backend_status')() >>> 0;
const childPtr = pick('r360_wasm_backend_module_ptr')() >>> 0;
const childSize = pick('r360_wasm_backend_module_size')() >>> 0;
const lowered = pick('r360_wasm_backend_lowered_instructions')() >>> 0;
if (backendStatus !== 2 || !childPtr || childSize <= 8 || lowered < 2) {
  throw new Error(`WasmBackend did not produce a real module: status=${backendStatus} ptr=${childPtr} size=${childSize} lowered=${lowered}`);
}

const childBytes = new Uint8Array(instance.exports.memory.buffer, childPtr, childSize).slice();
const childModule = await WebAssembly.compile(childBytes);
const childImports = WebAssembly.Module.imports(childModule);
if (childImports.length !== 1 || childImports[0].module !== 'env' ||
    childImports[0].name !== 'memory' || childImports[0].kind !== 'memory') {
  throw new Error(`Unexpected generated module imports: ${JSON.stringify(childImports)}`);
}
const childInstance = await WebAssembly.instantiate(childModule, { env: { memory: instance.exports.memory } });
if (typeof childInstance.exports.run !== 'function') throw new Error('Generated module has no run export');

const contextPtr = pick('r360_wasm_backend_context_ptr')() >>> 0;
const contextSize = pick('r360_ppc_context_size')() >>> 0;
const gprOffset = pick('r360_ppc_context_offset_gpr')() >>> 0;
if (!contextPtr || contextSize < gprOffset + 32 * 8) throw new Error('Invalid generated backend PPCContext buffer');

function runGenerated(seedR4) {
  new Uint8Array(instance.exports.memory.buffer, contextPtr, contextSize).fill(0);
  const view = new DataView(instance.exports.memory.buffer);
  view.setBigUint64(contextPtr + gprOffset + 4 * 8, seedR4, true);
  const returned = BigInt.asUintN(64, childInstance.exports.run(contextPtr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (returned !== seedR4 + 5n || stored !== returned) {
    throw new Error(`Generated-WASM mismatch seed=${seedR4}: returned=${returned} stored=${stored}`);
  }
  return returned;
}

const generatedR3 = runGenerated(7n);
const reusedR3 = runGenerated(100n);
if (generatedR3 !== correctnessR3) throw new Error(`Equivalence mismatch: Xenia=${correctnessR3} generated=${generatedR3}`);

console.log(`wasm_backend_status=${backendStatus}`);
console.log(`wasm_backend_module_bytes=${childSize}`);
console.log(`wasm_backend_lowered_instructions=${lowered}`);
console.log(`xenia_correctness_r3=${correctnessR3}`);
console.log(`generated_wasm_r3=${generatedR3}`);
console.log(`generated_wasm_reuse_r3=${reusedR3}`);
console.log('WASM_BACKEND_SCALAR_DATAFLOW=PASS');
console.log('WASM_BACKEND_STAGE=SCALAR_DATAFLOW_PASS');
