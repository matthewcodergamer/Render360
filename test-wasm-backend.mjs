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

const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
const contextPtr = pick('r360_wasm_backend_context_ptr')() >>> 0;
const contextSize = pick('r360_ppc_context_size')() >>> 0;
const gprOffset = pick('r360_ppc_context_offset_gpr')() >>> 0;
if (!contextPtr || contextSize < gprOffset + 32 * 8) throw new Error('Invalid generated backend PPCContext buffer');

function seedGeneratedContext(initialGprs = []) {
  new Uint8Array(instance.exports.memory.buffer, contextPtr, contextSize).fill(0);
  const view = new DataView(instance.exports.memory.buffer);
  for (const [reg, value] of initialGprs) {
    view.setBigUint64(contextPtr + gprOffset + reg * 8, BigInt.asUintN(64, value), true);
  }
  return view;
}

async function translateCase({ name, ppc, initialGprs = [], expectedR3, minLowered = 1 }) {
  if (ppc.length > capacity) throw new Error(`${name}: probe capacity too small`);
  pick('r360_ppc_probe_reset')();
  for (const [reg, value] of initialGprs) {
    if ((pick('r360_ppc_probe_set_initial_gpr')(reg, BigInt.asUintN(64, value)) >>> 0) !== 1) {
      throw new Error(`${name}: could not seed correctness r${reg}`);
    }
  }
  new Uint8Array(instance.exports.memory.buffer, inputPtr, ppc.length).set(ppc);
  if ((pick('r360_ppc_probe_load')(inputPtr, ppc.length) >>> 0) !== ppc.length) {
    throw new Error(`${name}: could not load PPC`);
  }
  pick('r360_ppc_probe_translate')();

  const correctnessStatus = pick('r360_ppc_probe_correctness_status')() >>> 0;
  const correctnessR3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
  if (correctnessStatus !== 3 || correctnessR3 !== BigInt.asUintN(64, expectedR3)) {
    throw new Error(`${name}: Xenia reference failed status=${correctnessStatus} r3=0x${correctnessR3.toString(16)}`);
  }

  const backendStatus = pick('r360_wasm_backend_status')() >>> 0;
  const childPtr = pick('r360_wasm_backend_module_ptr')() >>> 0;
  const childSize = pick('r360_wasm_backend_module_size')() >>> 0;
  const lowered = pick('r360_wasm_backend_lowered_instructions')() >>> 0;
  if (backendStatus !== 2 || !childPtr || childSize <= 8 || lowered < minLowered) {
    throw new Error(`${name}: backend failed status=${backendStatus} ptr=${childPtr} size=${childSize} lowered=${lowered}`);
  }

  const childBytes = new Uint8Array(instance.exports.memory.buffer, childPtr, childSize).slice();
  const childModule = await WebAssembly.compile(childBytes);
  const childImports = WebAssembly.Module.imports(childModule);
  if (childImports.length !== 1 || childImports[0].module !== 'env' ||
      childImports[0].name !== 'memory' || childImports[0].kind !== 'memory') {
    throw new Error(`${name}: unexpected generated imports ${JSON.stringify(childImports)}`);
  }
  const childInstance = await WebAssembly.instantiate(childModule, { env: { memory: instance.exports.memory } });
  if (typeof childInstance.exports.run !== 'function') throw new Error(`${name}: generated module has no run export`);

  const view = seedGeneratedContext(initialGprs);
  const generated = BigInt.asUintN(64, childInstance.exports.run(contextPtr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (generated !== correctnessR3 || stored !== correctnessR3) {
    throw new Error(`${name}: equivalence mismatch Xenia=0x${correctnessR3.toString(16)} generated=0x${generated.toString(16)} stored=0x${stored.toString(16)}`);
  }

  return { name, correctnessR3, childSize, lowered, childInstance };
}

// Stage A: genuine PPC addi -> Xenia finalized HIR -> generated WebAssembly.
const addi = await translateCase({
  name: 'addi-r4-plus-5',
  ppc: wordBytes(0x38640005, 0x4E800020),
  initialGprs: [[4, 7n]],
  expectedR3: 12n,
  minLowered: 2,
});

// Reuse the exact generated child module with a different live PPCContext.
{
  const view = seedGeneratedContext([[4, 100n]]);
  const reused = BigInt.asUintN(64, addi.childInstance.exports.run(contextPtr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (reused !== 105n || stored !== 105n) {
    throw new Error(`addi reuse mismatch returned=${reused} stored=${stored}`);
  }
  console.log(`generated_wasm_reuse_r3=${reused}`);
}

// Stage B harsh scalar gate: cmpwi + mfcr forces Xenia to emit truncate,
// signed compares, boolean values, zero-extends, shifts and OR composition.
const cmpProgram = wordBytes(0x2C040000, 0x7C600026, 0x4E800020);
const scalarCases = [
  { name: 'cmpwi-less', seed: 0xFFFFFFFFFFFFFFFFn, expected: 0x80000000n },
  { name: 'cmpwi-equal', seed: 0n, expected: 0x20000000n },
  { name: 'cmpwi-greater', seed: 5n, expected: 0x40000000n },
];
let scalarLoweredMin = Number.MAX_SAFE_INTEGER;
for (const c of scalarCases) {
  const result = await translateCase({
    name: c.name,
    ppc: cmpProgram,
    initialGprs: [[4, c.seed]],
    expectedR3: c.expected,
    minLowered: 8,
  });
  scalarLoweredMin = Math.min(scalarLoweredMin, result.lowered);
  console.log(`${c.name}_generated_r3=0x${result.correctnessR3.toString(16)}`);
}

console.log(`wasm_backend_status=${pick('r360_wasm_backend_status')() >>> 0}`);
console.log(`wasm_backend_scalar_min_lowered=${scalarLoweredMin}`);
console.log(`addi_generated_wasm_r3=${addi.correctnessR3}`);
console.log('WASM_BACKEND_SCALAR_DATAFLOW=PASS');
console.log('WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS');
console.log('WASM_BACKEND_STAGE=SCALAR_COMPARE_SHIFT_PASS');
