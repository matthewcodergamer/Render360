import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`Call-backend bootstrap WASM not found: ${wasmPath}`);
const parentModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(parentModule);
for (const entry of WebAssembly.Module.imports(parentModule)) {
  if (entry.module === 'env' && entry.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const parent = await WebAssembly.instantiate(parentModule, imports);
wasi.initialize(parent);
const pick = (name) => parent.exports[name] ?? parent.exports[`_${name}`];

const required = [
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer',
  'r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3',
  'r360_ppc_probe_guest_base','r360_ppc_context_size','r360_ppc_context_offset_gpr',
  'r360_wasm_backend_call_status','r360_wasm_backend_call_function_count',
  'r360_wasm_backend_call_function_address','r360_wasm_backend_call_module_ptr',
  'r360_wasm_backend_call_module_size','r360_wasm_backend_call_lowered_instructions',
  'r360_wasm_backend_call_context_ptr',
];
for (const name of required) if (typeof pick(name) !== 'function') throw new Error(`Missing call-backend export ${name}`);
if (!(parent.exports.memory instanceof WebAssembly.Memory)) throw new Error('Parent memory not exported');

const wordBytes = (...words) => Uint8Array.from(words.flatMap((w) => [w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const guestBase = pick('r360_ppc_probe_guest_base')() >>> 0;
const contextSize = pick('r360_ppc_context_size')() >>> 0;
const gprOffset = pick('r360_ppc_context_offset_gpr')() >>> 0;

const direct = wordBytes(
  0x7CA802A6, 0x48000011, 0x38630002, 0x7CA803A6, 0x4E800020,
  0x38600005, 0x4E800020,
);
const nested = wordBytes(
  0x7CA802A6, 0x4800001D, 0x38630001, 0x7CA803A6, 0x4E800020,
  0x00000000, 0x00000000, 0x00000000,
  0x7CC802A6, 0x4800001D, 0x38630002, 0x7CC803A6, 0x4E800020,
  0x00000000, 0x00000000, 0x00000000,
  0x38600004, 0x4E800020,
);
const indirect = wordBytes(
  0x7CA802A6, 0x7C8903A6, 0x4E800421, 0x38630002,
  0x7CA803A6, 0x4E800020, 0x38600005, 0x4E800020,
);

async function translate(ppc, initialGprs = []) {
  pick('r360_ppc_probe_reset')();
  for (const [index,value] of initialGprs) {
    if ((pick('r360_ppc_probe_set_initial_gpr')(index, value) >>> 0) !== 1) throw new Error(`Could not seed correctness r${index}`);
  }
  const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
  if (ppc.length > (pick('r360_ppc_probe_input_capacity')() >>> 0)) throw new Error('PPC program too large');
  new Uint8Array(parent.exports.memory.buffer, inputPtr, ppc.length).set(ppc);
  if ((pick('r360_ppc_probe_load')(inputPtr, ppc.length) >>> 0) !== ppc.length) throw new Error('Could not load PPC');
  pick('r360_ppc_probe_translate')();
  const status = pick('r360_ppc_probe_correctness_status')() >>> 0;
  const r3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
  if (status !== 3 || r3 !== 7n) throw new Error(`Xenia call oracle failed status=${status} r3=${r3}`);
  return r3;
}

async function instantiateRegistry(expectedCount) {
  const status = pick('r360_wasm_backend_call_status')() >>> 0;
  const count = pick('r360_wasm_backend_call_function_count')() >>> 0;
  if (status !== 2 || count !== expectedCount) throw new Error(`Bad generated call registry status=${status} count=${count} expected=${expectedCount}`);

  const records = [];
  for (let i=0;i<count;i++) {
    const address = pick('r360_wasm_backend_call_function_address')(i) >>> 0;
    const ptr = pick('r360_wasm_backend_call_module_ptr')(i) >>> 0;
    const size = pick('r360_wasm_backend_call_module_size')(i) >>> 0;
    const lowered = pick('r360_wasm_backend_call_lowered_instructions')(i) >>> 0;
    if (!address || !ptr || size <= 8 || !lowered) throw new Error(`Invalid generated function record ${i}`);
    const bytes = new Uint8Array(parent.exports.memory.buffer, ptr, size).slice();
    const mod = await WebAssembly.compile(bytes);
    const declared = WebAssembly.Module.imports(mod);
    if (!declared.some((x)=>x.module==='env'&&x.name==='memory'&&x.kind==='memory') ||
        !declared.some((x)=>x.module==='env'&&x.name==='guest_call'&&x.kind==='function')) {
      throw new Error(`Generated call module ${address.toString(16)} missing strict imports`);
    }
    records.push({ address, size, lowered, mod, instance: null });
  }

  const byAddress = new Map(records.map((r)=>[r.address,r]));
  let dispatches = 0;
  const guest_call = (target, ctx) => {
    target >>>= 0; ctx >>>= 0;
    const callee = byAddress.get(target);
    if (!callee?.instance?.exports?.run) throw new Error(`FAIL_CLOSED_UNKNOWN_GUEST_TARGET_0x${target.toString(16)}`);
    dispatches++;
    callee.instance.exports.run(ctx);
    return 1;
  };
  for (const record of records) {
    record.instance = await WebAssembly.instantiate(record.mod, { env: { memory: parent.exports.memory, guest_call } });
  }
  return { records, byAddress, dispatchCount:()=>dispatches };
}

function clearAndSeedContext(initialGprs=[]) {
  const ptr = pick('r360_wasm_backend_call_context_ptr')() >>> 0;
  if (!ptr || contextSize < gprOffset + 32*8) throw new Error('Invalid generated call context');
  new Uint8Array(parent.exports.memory.buffer, ptr, contextSize).fill(0);
  const view = new DataView(parent.exports.memory.buffer);
  for (const [index,value] of initialGprs) view.setBigUint64(ptr+gprOffset+index*8, BigInt.asUintN(64,value), true);
  return { ptr, view };
}

async function runCase(name, ppc, expectedFunctions, correctnessSeeds=[], generatedSeeds=[]) {
  const oracle = await translate(ppc, correctnessSeeds);
  const registry = await instantiateRegistry(expectedFunctions);
  const top = registry.byAddress.get(guestBase);
  if (!top) throw new Error(`${name}: top-level generated module missing`);
  const {ptr,view} = clearAndSeedContext(generatedSeeds);
  const result = BigInt.asUintN(64, top.instance.exports.run(ptr));
  const stored = view.getBigUint64(ptr+gprOffset+3*8,true);
  if (result !== oracle || stored !== oracle) throw new Error(`${name}: generated=${result} stored=${stored} Xenia=${oracle}`);
  if (registry.dispatchCount() < expectedFunctions-1) throw new Error(`${name}: too few generated guest dispatches ${registry.dispatchCount()}`);
  console.log(`${name}_functions=${expectedFunctions}`);
  console.log(`${name}_dispatches=${registry.dispatchCount()}`);
  console.log(`${name}_r3=${result}`);
  return registry;
}

await runCase('wasm_call_direct', direct, 2);
await runCase('wasm_call_nested', nested, 3);
const indirectTarget = BigInt((guestBase + 24) >>> 0);
const indirectRegistry = await runCase('wasm_call_ctr_indirect', indirect, 2, [[4,indirectTarget]], [[4,indirectTarget]]);

// Harsh fail-closed critic: reuse the exact indirect generated caller but give
// it a dynamic target for which no Xenia-generated module exists.
const top = indirectRegistry.byAddress.get(guestBase);
const {ptr: badPtr} = clearAndSeedContext([[4,BigInt((guestBase+0x100)>>>0)]]);
let failedClosed = false;
try { top.instance.exports.run(badPtr); } catch (e) {
  failedClosed = String(e).includes('FAIL_CLOSED_UNKNOWN_GUEST_TARGET');
}
if (!failedClosed) throw new Error('Generated indirect guest call did not fail closed on an unknown target');

console.log('WASM_BACKEND_CALL_DIRECT=PASS');
console.log('WASM_BACKEND_CALL_NESTED=PASS');
console.log('WASM_BACKEND_CALL_INDIRECT=PASS');
console.log('WASM_BACKEND_CALL_FAIL_CLOSED=PASS');
console.log('WASM_BACKEND_STAGE=GUEST_CALLS_PASS');
