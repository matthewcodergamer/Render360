import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
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
const e = instance.exports;
const pick = (name) => e[name] ?? e[`_${name}`];

const required = [
  'r360_ppc_probe_reset',
  'r360_ppc_probe_input_buffer',
  'r360_ppc_probe_load_at',
  'r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_write_guest_u32_be',
  'r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status',
  'r360_ppc_probe_correctness_r3',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') {
    throw new Error(`missing HIR load-offset regression export ${name}`);
  }
}

// Braid's post-direct-call blocker exposed HIR opcode 37. In the pinned Xenia
// opcode table that is LOAD_OFFSET, not CALL_INDIRECT. PPC D-form loads use a
// signed 16-bit displacement that Xenia materializes as an INT64 constant.
// The guest memory backend intentionally uses the low 32 bits of the effective
// address, so base + (-4) must wrap in 32-bit address space rather than being
// rejected as a uint64 overflow.
const codeBase = 0x22000000;
const dataAddress = codeBase + 0x100;
const initialR1 = dataAddress + 4;
const expected = 0x12345678;
const words = [
  0x8061FFFC, // lwz r3,-4(r1)
  0x4E800020, // blr
];

pick('r360_ppc_probe_reset')();
const input = pick('r360_ppc_probe_input_buffer')() >>> 0;
const bytes = new Uint8Array(e.memory.buffer, input, words.length * 4);
words.forEach((word, i) => {
  bytes[i * 4] = word >>> 24;
  bytes[i * 4 + 1] = (word >>> 16) & 255;
  bytes[i * 4 + 2] = (word >>> 8) & 255;
  bytes[i * 4 + 3] = word & 255;
});

if ((pick('r360_ppc_probe_load_at')(codeBase, input, bytes.length) >>> 0) !== bytes.length) {
  throw new Error('could not stage signed LOAD_OFFSET regression code');
}
if ((pick('r360_ppc_probe_set_initial_gpr')(1, BigInt(initialR1)) >>> 0) !== 1) {
  throw new Error('could not seed r1 for signed LOAD_OFFSET regression');
}
if ((pick('r360_ppc_probe_write_guest_u32_be')(dataAddress, expected) >>> 0) !== 1) {
  throw new Error('could not seed guest data for signed LOAD_OFFSET regression');
}
if (!(pick('r360_ppc_probe_translate')() >>> 0)) {
  throw new Error('signed LOAD_OFFSET translation failed');
}

const status = pick('r360_ppc_probe_correctness_status')() >>> 0;
const r3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
if (status !== 3 || Number(r3 & 0xFFFFFFFFn) !== expected) {
  throw new Error(
    `signed LOAD_OFFSET execution failed status=${status} r3=0x${r3.toString(16)}`,
  );
}

console.log(`HIR_LOAD_OFFSET_EA32_VALUE=0x${expected.toString(16)}`);
console.log('HIR_LOAD_OFFSET_SIGNED_EA32=PASS');
