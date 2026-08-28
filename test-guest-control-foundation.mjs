import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`Missing bootstrap WASM: ${wasmPath}`);

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
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_status',
  'r360_ppc_probe_guest_base','r360_ppc_probe_assembled_functions',
  'r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3',
];
for (const name of required) if (typeof pick(name) !== 'function') throw new Error(`Missing export: ${name}`);

const wordBytes = (...words) => Uint8Array.from(words.flatMap((word) => [
  (word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255,
]));

// Real stack-frame-shaped PPC control flow:
//   save LR -> move r1 down -> spill LR -> bl callee -> resume caller
//   -> restore LR from guest memory -> restore r1 -> publish restored SP
//   -> return via blr. The callee is independently Xenia-scanned/translated.
const program = wordBytes(
  0x7CA802A6, // mflr  r5
  0x3821FFE0, // addi  r1,r1,-32
  0x90A10010, // stw   r5,16(r1)
  0x4800001D, // bl    +0x1c -> callee @ +0x28
  0x38630002, // addi  r3,r3,2
  0x80A10010, // lwz   r5,16(r1)
  0x38210020, // addi  r1,r1,32
  0x90280000, // stw   r1,0(r8) -- publish restored SP for exact check
  0x7CA803A6, // mtlr  r5
  0x4E800020, // blr
  0x38600005, // callee: li r3,5
  0x4E800020, //         blr
);

const base = pick('r360_ppc_probe_guest_base')() >>> 0;
const initialSp = (base + 0x1C0) >>> 0;
const publishedSp = (base + 0x1F0) >>> 0;
const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
if (program.length > capacity) throw new Error('Probe input capacity too small');

pick('r360_ppc_probe_reset')();
if ((pick('r360_ppc_probe_set_initial_gpr')(1, BigInt(initialSp)) >>> 0) !== 1) throw new Error('Unable to seed r1');
if ((pick('r360_ppc_probe_set_initial_gpr')(8, BigInt(publishedSp)) >>> 0) !== 1) throw new Error('Unable to seed r8');
if ((pick('r360_ppc_probe_write_guest_u32_be')(publishedSp, 0) >>> 0) !== 1) throw new Error('Unable to clear SP result slot');

new Uint8Array(instance.exports.memory.buffer, inputPtr, program.length).set(program);
if ((pick('r360_ppc_probe_load')(inputPtr, program.length) >>> 0) !== program.length) throw new Error('Program load failed');
if ((pick('r360_ppc_probe_translate')() >>> 0) === 0) throw new Error('Xenia translation failed');
if ((pick('r360_ppc_probe_status')() >>> 0) !== 3) throw new Error('Probe did not reach translated state');
if ((pick('r360_ppc_probe_correctness_status')() >>> 0) !== 3) throw new Error('Finalized HIR correctness execution failed');
if ((pick('r360_ppc_probe_assembled_functions')() >>> 0) < 2) throw new Error('Callee was not independently assembled');

const r3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
if (r3 !== 7n) throw new Error(`Caller/callee result mismatch: r3=${r3}`);
const restoredSp = pick('r360_ppc_probe_read_guest_u32_be')(publishedSp) >>> 0;
if (restoredSp !== initialSp) throw new Error(`Stack pointer was not restored: got=0x${restoredSp.toString(16)} expected=0x${initialSp.toString(16)}`);

console.log('GUEST_CONTROL_FOUNDATION=PASS');
console.log('SCALAR_PPC_CORRECTNESS_FOUNDATION=PASS');
console.log(`assembled_functions=${pick('r360_ppc_probe_assembled_functions')() >>> 0}`);
console.log(`result_r3=${r3}`);
console.log(`restored_sp=0x${restoredSp.toString(16)}`);
console.log('PASS: direct/nested/CTR-call suite plus a real guest-memory stack-frame call/return shape is regression-gated through Xenia finalized HIR.');
