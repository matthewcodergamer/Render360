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
  'r360_ppc_context_size', 'r360_ppc_context_offset_gpr', 'r360_ppc_context_offset_ctr',
  'r360_wasm_backend_status', 'r360_wasm_backend_module_ptr',
  'r360_wasm_backend_module_size', 'r360_wasm_backend_lowered_instructions',
  'r360_wasm_backend_context_ptr',
  'r360_wasm_backend_cfg_status', 'r360_wasm_backend_cfg_module_ptr',
  'r360_wasm_backend_cfg_module_size', 'r360_wasm_backend_cfg_lowered_instructions',
  'r360_wasm_backend_cfg_context_ptr',
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
const contextSize = pick('r360_ppc_context_size')() >>> 0;
const gprOffset = pick('r360_ppc_context_offset_gpr')() >>> 0;
const ctrOffset = pick('r360_ppc_context_offset_ctr')() >>> 0;

function seedContext(contextPtr, initialGprs = []) {
  if (!contextPtr || contextSize < gprOffset + 32 * 8) throw new Error('Invalid generated backend PPCContext buffer');
  new Uint8Array(instance.exports.memory.buffer, contextPtr, contextSize).fill(0);
  const view = new DataView(instance.exports.memory.buffer);
  for (const [reg, value] of initialGprs) {
    view.setBigUint64(contextPtr + gprOffset + reg * 8, BigInt.asUintN(64, value), true);
  }
  return view;
}

function loadAndTranslate(name, ppc, initialGprs = []) {
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
  return {
    status: pick('r360_ppc_probe_correctness_status')() >>> 0,
    r3: BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')()),
  };
}

async function instantiateGenerated(prefix) {
  const status = pick(`r360_wasm_backend${prefix}_status`)() >>> 0;
  const childPtr = pick(`r360_wasm_backend${prefix}_module_ptr`)() >>> 0;
  const childSize = pick(`r360_wasm_backend${prefix}_module_size`)() >>> 0;
  const lowered = pick(`r360_wasm_backend${prefix}_lowered_instructions`)() >>> 0;
  if (status !== 2 || !childPtr || childSize <= 8 || lowered < 1) {
    throw new Error(`backend${prefix} failed status=${status} ptr=${childPtr} size=${childSize} lowered=${lowered}`);
  }
  const childBytes = new Uint8Array(instance.exports.memory.buffer, childPtr, childSize).slice();
  const childModule = await WebAssembly.compile(childBytes);
  const childImports = WebAssembly.Module.imports(childModule);
  if (childImports.length !== 1 || childImports[0].module !== 'env' ||
      childImports[0].name !== 'memory' || childImports[0].kind !== 'memory') {
    throw new Error(`backend${prefix}: unexpected generated imports ${JSON.stringify(childImports)}`);
  }
  const childInstance = await WebAssembly.instantiate(childModule, { env: { memory: instance.exports.memory } });
  if (typeof childInstance.exports.run !== 'function') throw new Error(`backend${prefix}: no run export`);
  return { childInstance, childSize, lowered };
}

async function scalarCase({ name, ppc, initialGprs = [], expectedR3, minLowered = 1 }) {
  const correctness = loadAndTranslate(name, ppc, initialGprs);
  const expected = BigInt.asUintN(64, expectedR3);
  if (correctness.status !== 3 || correctness.r3 !== expected) {
    throw new Error(`${name}: Xenia reference failed status=${correctness.status} r3=0x${correctness.r3.toString(16)}`);
  }
  const generated = await instantiateGenerated('');
  if (generated.lowered < minLowered) throw new Error(`${name}: lowered only ${generated.lowered}`);
  const contextPtr = pick('r360_wasm_backend_context_ptr')() >>> 0;
  const view = seedContext(contextPtr, initialGprs);
  const result = BigInt.asUintN(64, generated.childInstance.exports.run(contextPtr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (result !== expected || stored !== expected) {
    throw new Error(`${name}: generated mismatch result=0x${result.toString(16)} stored=0x${stored.toString(16)} expected=0x${expected.toString(16)}`);
  }
  return { ...generated, r3: result };
}

async function cfgCase({ name, ppc, initialGprs = [], expectedR3, expectedCtr = null, minLowered = 1 }) {
  const correctness = loadAndTranslate(name, ppc, initialGprs);
  const expected = BigInt.asUintN(64, expectedR3);
  if (correctness.status !== 3 || correctness.r3 !== expected) {
    throw new Error(`${name}: Xenia CFG reference failed status=${correctness.status} r3=0x${correctness.r3.toString(16)}`);
  }
  const generated = await instantiateGenerated('_cfg');
  if (generated.lowered < minLowered) throw new Error(`${name}: CFG lowered only ${generated.lowered}`);
  const contextPtr = pick('r360_wasm_backend_cfg_context_ptr')() >>> 0;
  const view = seedContext(contextPtr, initialGprs);
  const result = BigInt.asUintN(64, generated.childInstance.exports.run(contextPtr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (result !== expected || stored !== expected) {
    throw new Error(`${name}: CFG mismatch result=0x${result.toString(16)} stored=0x${stored.toString(16)} expected=0x${expected.toString(16)}`);
  }
  if (expectedCtr !== null) {
    const ctr = view.getBigUint64(contextPtr + ctrOffset, true);
    if (ctr !== BigInt.asUintN(64, expectedCtr)) {
      throw new Error(`${name}: CTR mismatch got=${ctr} expected=${expectedCtr}`);
    }
  }
  return { ...generated, r3: result };
}

// Scalar dataflow: genuine PPC addi -> Xenia finalized HIR -> generated WASM.
const addi = await scalarCase({
  name: 'addi-r4-plus-5',
  ppc: wordBytes(0x38640005, 0x4E800020),
  initialGprs: [[4, 7n]],
  expectedR3: 12n,
  minLowered: 2,
});
{
  const contextPtr = pick('r360_wasm_backend_context_ptr')() >>> 0;
  const view = seedContext(contextPtr, [[4, 100n]]);
  const reused = BigInt.asUintN(64, addi.childInstance.exports.run(contextPtr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (reused !== 105n || stored !== 105n) throw new Error(`addi reuse mismatch returned=${reused} stored=${stored}`);
  console.log(`generated_wasm_reuse_r3=${reused}`);
}

// Harsh scalar gate: cmpwi + mfcr expands to truncate, signed comparisons,
// boolean values, zero-extends, shifts and OR composition in finalized HIR.
const cmpProgram = wordBytes(0x2C040000, 0x7C600026, 0x4E800020);
for (const c of [
  { name: 'cmpwi-less', seed: 0xFFFFFFFFFFFFFFFFn, expected: 0x80000000n },
  { name: 'cmpwi-equal', seed: 0n, expected: 0x20000000n },
  { name: 'cmpwi-greater', seed: 5n, expected: 0x40000000n },
]) {
  const r = await scalarCase({ name: c.name, ppc: cmpProgram, initialGprs: [[4, c.seed]], expectedR3: c.expected, minLowered: 8 });
  console.log(`${c.name}_generated_r3=0x${r.r3.toString(16)}`);
}

// Multi-block conditional branch, both sides.
const conditionalProgram = wordBytes(
  0x2C040000, 0x4182000C, 0x38600001, 0x48000008, 0x38600002, 0x4E800020,
);
const branchTaken = await cfgCase({
  name: 'cfg-branch-equal-taken', ppc: conditionalProgram,
  initialGprs: [[4, 0n]], expectedR3: 2n, minLowered: 4,
});
const branchNotTaken = await cfgCase({
  name: 'cfg-branch-equal-not-taken', ppc: conditionalProgram,
  initialGprs: [[4, 5n]], expectedR3: 1n, minLowered: 4,
});

// Genuine CTR-controlled loop. This verifies repeated dispatch, context writes,
// loop back-edge handling and the LR possible-return boundary.
const ctrLoopProgram = wordBytes(
  0x7C8903A6, 0x38600000, 0x38630001, 0x4200FFFC, 0x4E800020,
);
const ctrLoop = await cfgCase({
  name: 'cfg-ctr-bdnz-three', ppc: ctrLoopProgram,
  initialGprs: [[4, 3n]], expectedR3: 3n, expectedCtr: 0n, minLowered: 6,
});

console.log(`addi_generated_wasm_r3=${addi.r3}`);
console.log(`cfg_branch_taken_r3=${branchTaken.r3}`);
console.log(`cfg_branch_not_taken_r3=${branchNotTaken.r3}`);
console.log(`cfg_ctr_loop_r3=${ctrLoop.r3}`);
console.log('WASM_BACKEND_SCALAR_DATAFLOW=PASS');
console.log('WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS');
console.log('WASM_BACKEND_CFG_BRANCH=PASS');
console.log('WASM_BACKEND_CFG_LOOP=PASS');
console.log('WASM_BACKEND_STAGE=CFG_BRANCH_LOOP_PASS');
