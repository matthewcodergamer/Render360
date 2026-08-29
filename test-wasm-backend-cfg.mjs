import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`WasmBackend CFG bootstrap WASM not found: ${wasmPath}`);

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
  'r360_wasm_backend_cfg_status', 'r360_wasm_backend_cfg_module_ptr',
  'r360_wasm_backend_cfg_module_size',
  'r360_wasm_backend_cfg_lowered_instructions',
  'r360_wasm_backend_cfg_context_ptr',
  'r360_wasm_backend_cfg_continuation_slot_count',
  'r360_wasm_backend_cfg_continuation_state_size',
  'r360_wasm_backend_cfg_continuation_ptr',
  'r360_wasm_backend_cfg_continuation_status',
  'r360_wasm_backend_cfg_continuation_reset',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') throw new Error(`Missing resumable WasmBackend CFG gate export ${name}`);
}
if (!(instance.exports.memory instanceof WebAssembly.Memory)) throw new Error('Parent bootstrap memory is not exported');

const wordBytes = (...words) => Uint8Array.from(words.flatMap((word) => [
  (word >>> 24) & 0xFF, (word >>> 16) & 0xFF, (word >>> 8) & 0xFF, word & 0xFF,
]));
const conditionalProgram = wordBytes(
  0x2C040000, // cmpwi r4,0
  0x4182000C, // beq   taken
  0x38600001, // li    r3,1
  0x48000008, // b     done
  0x38600002, // taken: li r3,2
  0x4E800020, // done:  blr
);
const ctrLoopProgram = wordBytes(
  0x7C8903A6, // mtctr r4
  0x38600000, // li    r3,0
  0x38630001, // loop: addi r3,r3,1
  0x4200FFFC, // bdnz  loop
  0x4E800020, // blr
);

const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
const contextPtr = pick('r360_wasm_backend_cfg_context_ptr')() >>> 0;
const contextSize = pick('r360_ppc_context_size')() >>> 0;
const gprOffset = pick('r360_ppc_context_offset_gpr')() >>> 0;
if (!contextPtr || contextSize < gprOffset + 32 * 8) throw new Error('Invalid CFG PPCContext buffer');

function seedContext(initialGprs) {
  new Uint8Array(instance.exports.memory.buffer, contextPtr, contextSize).fill(0);
  const view = new DataView(instance.exports.memory.buffer);
  for (const [reg, value] of initialGprs) {
    view.setBigUint64(contextPtr + gprOffset + reg * 8, BigInt.asUintN(64, value), true);
  }
  return view;
}

function continuation(slot = 0) {
  const count = pick('r360_wasm_backend_cfg_continuation_slot_count')() >>> 0;
  const stateSize = pick('r360_wasm_backend_cfg_continuation_state_size')() >>> 0;
  if (!count || slot >= count || stateSize < 8) throw new Error(`Invalid CFG continuation layout count=${count} size=${stateSize}`);
  pick('r360_wasm_backend_cfg_continuation_reset')(slot);
  const ptr = pick('r360_wasm_backend_cfg_continuation_ptr')(slot) >>> 0;
  if (!ptr || ptr + stateSize > instance.exports.memory.buffer.byteLength) throw new Error(`Invalid CFG continuation pointer slot=${slot} ptr=0x${ptr.toString(16)} size=${stateSize}`);
  return {slot, ptr, stateSize, status: () => pick('r360_wasm_backend_cfg_continuation_status')(slot) >>> 0};
}

async function translateCfg({ name, ppc, initialGprs, expectedR3, minLowered }) {
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

  const oracleStatus = pick('r360_ppc_probe_correctness_status')() >>> 0;
  const oracleR3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
  if (oracleStatus !== 3 || oracleR3 !== BigInt.asUintN(64, expectedR3)) {
    throw new Error(`${name}: Xenia oracle failed status=${oracleStatus} r3=${oracleR3}`);
  }

  const status = pick('r360_wasm_backend_cfg_status')() >>> 0;
  const childPtr = pick('r360_wasm_backend_cfg_module_ptr')() >>> 0;
  const childSize = pick('r360_wasm_backend_cfg_module_size')() >>> 0;
  const lowered = pick('r360_wasm_backend_cfg_lowered_instructions')() >>> 0;
  if (status !== 2 || !childPtr || childSize <= 8 || lowered < minLowered) {
    throw new Error(`${name}: CFG backend failed status=${status} bytes=${childSize} lowered=${lowered}`);
  }
  const childBytes = new Uint8Array(instance.exports.memory.buffer, childPtr, childSize).slice();
  const childModule = await WebAssembly.compile(childBytes);
  const childImports = WebAssembly.Module.imports(childModule);
  if (childImports.length !== 1 || childImports[0].module !== 'env' ||
      childImports[0].name !== 'memory' || childImports[0].kind !== 'memory') {
    throw new Error(`${name}: unexpected generated imports ${JSON.stringify(childImports)}`);
  }
  const child = await WebAssembly.instantiate(childModule, { env: { memory: instance.exports.memory } });
  if (typeof child.exports.run !== 'function') throw new Error(`${name}: generated CFG module has no run export`);

  const state = continuation(0);
  const view = seedContext(initialGprs);
  const generatedR3 = BigInt.asUintN(64, child.exports.run(contextPtr, state.ptr));
  const storedR3 = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (state.status() !== 2) throw new Error(`${name}: small CFG function did not reach completed continuation state`);
  if (generatedR3 !== oracleR3 || storedR3 !== oracleR3) {
    throw new Error(`${name}: CFG mismatch oracle=${oracleR3} generated=${generatedR3} stored=${storedR3}`);
  }
  console.log(`${name}_module_bytes=${childSize}`);
  console.log(`${name}_lowered=${lowered}`);
  console.log(`${name}_generated_r3=${generatedR3}`);
  return child;
}

const conditional = await translateCfg({
  name: 'cfg-conditional-taken', ppc: conditionalProgram,
  initialGprs: [[4, 0n]], expectedR3: 2n, minLowered: 2,
});

// Reuse the exact same compiled CFG module with the opposite live predicate.
{
  const state = continuation(0);
  const view = seedContext([[4, 5n]]);
  const reused = BigInt.asUintN(64, conditional.exports.run(contextPtr, state.ptr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (state.status() !== 2 || reused !== 1n || stored !== 1n) throw new Error(`conditional reuse mismatch status=${state.status()} returned=${reused} stored=${stored}`);
  console.log(`cfg_conditional_reuse_r3=${reused}`);
}

const loop = await translateCfg({
  name: 'cfg-ctr-loop-three', ppc: ctrLoopProgram,
  initialGprs: [[4, 3n]], expectedR3: 3n, minLowered: 4,
});

// Reuse proves the loop trip count comes from the live PPCContext, not from a
// translation-time constant or the oracle result.
{
  const state = continuation(0);
  const view = seedContext([[4, 5n]]);
  const reused = BigInt.asUintN(64, loop.exports.run(contextPtr, state.ptr));
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (state.status() !== 2 || reused !== 5n || stored !== 5n) throw new Error(`loop reuse mismatch status=${state.status()} returned=${reused} stored=${stored}`);
  console.log(`cfg_loop_reuse_r3=${reused}`);
}

// Adversarial resumability proof: this live trip count is intentionally larger
// than the generated browser fuel quantum. The first invocation must yield
// without claiming a guest return, then later invocations using the exact same
// continuation slot must resume from the saved dispatcher PC / HIR locals and
// eventually match the true PPC result. A trap/restart implementation cannot
// satisfy both the observed yield and the exact final r3=10000.
{
  const state = continuation(0);
  const view = seedContext([[4, 10000n]]);
  let sawYield = false;
  let completed = false;
  let quanta = 0;
  let returned = 0n;
  for (; quanta < 16; quanta++) {
    returned = BigInt.asUintN(64, loop.exports.run(contextPtr, state.ptr));
    const status = state.status();
    if (status === 1) {
      sawYield = true;
      continue;
    }
    if (status === 2) {
      completed = true;
      quanta++;
      break;
    }
    throw new Error(`long CFG loop entered invalid continuation status ${status}`);
  }
  const stored = view.getBigUint64(contextPtr + gprOffset + 3 * 8, true);
  if (!sawYield) throw new Error('Long CFG loop completed without exercising fuel-yield continuation');
  if (!completed) throw new Error(`Long CFG loop did not complete after ${quanta} resumable quanta`);
  if (returned !== 10000n || stored !== 10000n) throw new Error(`Resumed CFG loop corrupted PPC state returned=${returned} stored=${stored}`);
  console.log(`cfg_resumable_quanta=${quanta}`);
  console.log(`cfg_resumable_final_r3=${returned}`);
}

console.log('WASM_BACKEND_CFG_BRANCH=PASS');
console.log('WASM_BACKEND_CFG_LOOP=PASS');
console.log('WASM_BACKEND_CFG_RESUMABLE_FUEL=PASS');
console.log('WASM_BACKEND_STAGE=CFG_BRANCH_LOOP_RESUME_PASS');
