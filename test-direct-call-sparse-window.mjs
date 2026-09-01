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
  'r360_ppc_probe_reset', 'r360_ppc_probe_input_buffer',
  'r360_ppc_probe_load_at', 'r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status', 'r360_ppc_probe_correctness_r3',
  'r360_sparse_guest_memory_reset', 'r360_sparse_guest_memory_alloc',
  'r360_sparse_guest_memory_map', 'r360_sparse_guest_memory_protect',
  'r360_sparse_guest_memory_write_u32_be',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') throw new Error(`missing direct-call regression export ${name}`);
}

const caller = 0x20000000;
// This address is inside the 64 KiB decoder reservation but outside the bytes
// initially staged for the caller. It must be paged from sparse executable RAM.
const callee = 0x20008000;
const callerWords = [
  0x7CA802A6, // mflr r5
  ((18 << 26) | ((callee - (caller + 4)) & 0x03FFFFFC) | 1) >>> 0, // bl callee
  0x38630002, // addi r3,r3,2
  0x7CA803A6, // mtlr r5
  0x4E800020, // blr
];
const calleeWords = [0x38600005, 0x4E800020]; // li r3,5; blr
const writeWords = (address, words) => {
  for (let i = 0; i < words.length; i++) {
    if ((pick('r360_sparse_guest_memory_write_u32_be')(address + i * 4, words[i]) >>> 0) !== 1) {
      throw new Error(`could not seed sparse PPC @ 0x${(address + i * 4).toString(16)}`);
    }
  }
};

pick('r360_sparse_guest_memory_reset')();
const callerBacking = pick('r360_sparse_guest_memory_alloc')(1) >>> 0;
const calleeBacking = pick('r360_sparse_guest_memory_alloc')(1) >>> 0;
if (!callerBacking || !calleeBacking) throw new Error('could not allocate direct-call sparse pages');
if ((pick('r360_sparse_guest_memory_map')(caller, 1, callerBacking, 0, 7) >>> 0) !== 1 ||
    (pick('r360_sparse_guest_memory_map')(callee, 1, calleeBacking, 0, 7) >>> 0) !== 1) {
  throw new Error('could not map direct-call sparse pages');
}
writeWords(caller, callerWords);
writeWords(callee, calleeWords);
if ((pick('r360_sparse_guest_memory_protect')(caller, 1, 5) >>> 0) !== 1 ||
    (pick('r360_sparse_guest_memory_protect')(callee, 1, 5) >>> 0) !== 1) {
  throw new Error('could not seal direct-call sparse pages RX');
}

pick('r360_ppc_probe_reset')();
const input = pick('r360_ppc_probe_input_buffer')() >>> 0;
const bytes = new Uint8Array(e.memory.buffer, input, callerWords.length * 4);
callerWords.forEach((word, i) => {
  bytes[i * 4] = word >>> 24;
  bytes[i * 4 + 1] = (word >>> 16) & 255;
  bytes[i * 4 + 2] = (word >>> 8) & 255;
  bytes[i * 4 + 3] = word & 255;
});
if ((pick('r360_ppc_probe_load_at')(caller, input, bytes.length) >>> 0) !== bytes.length) {
  throw new Error('could not stage direct-call caller');
}
if (!(pick('r360_ppc_probe_translate')() >>> 0)) throw new Error('direct-call translation failed');
const status = pick('r360_ppc_probe_correctness_status')() >>> 0;
const r3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
if (status !== 3 || r3 !== 7n) {
  throw new Error(`far direct call failed status=${status} r3=${r3}`);
}

console.log('DIRECT_CALL_SPARSE_SUBWINDOW=PASS');
