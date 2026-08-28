import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) {
  console.error(`PPC probe WASM not found: ${wasmPath}`);
  process.exit(2);
}

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

const unresolved = WebAssembly.Module.imports(module).filter(
  ({ module: mod, name }) => !(imports[mod] && name in imports[mod]),
);
if (unresolved.length) {
  console.error('Unresolved WASM host imports:');
  for (const entry of unresolved) console.error(`  ${entry.module}.${entry.name}`);
  process.exit(3);
}

const instance = await WebAssembly.instantiate(module, imports);
// This standalone Emscripten module is used as a WASI reactor: it intentionally
// has no _start entry point. Node's WASI implementation still must be marked as
// initialized before any imported WASI function can be called. initialize()
// does that and invokes _initialize when the module exports one.
wasi.initialize(instance);

const exportedNames = Object.keys(instance.exports).sort();
console.log(`wasm_exports=${exportedNames.join(',')}`);
const pick = (name) => instance.exports[name] ?? instance.exports[`_${name}`];
const required = [
  'r360_ppc_probe_reset',
  'r360_ppc_probe_input_buffer',
  'r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load',
  'r360_ppc_probe_translate',
  'r360_ppc_probe_status',
  'r360_ppc_probe_guest_base',
  'r360_ppc_probe_loaded_size',
  'r360_ppc_probe_assembled_functions',
  'r360_ppc_probe_hir_block_count',
  'r360_ppc_probe_hir_instruction_count',
  'r360_ppc_probe_last_guest_address',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') {
    console.error(`Missing required probe export: ${name}`);
    console.error(`Available exports: ${exportedNames.join(', ')}`);
    process.exit(4);
  }
}
if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
  console.error('Standalone probe did not export WebAssembly.Memory');
  process.exit(5);
}

// Real Xbox 360 PowerPC instructions, stored big-endian as the guest sees them:
//   0x38600001  addi r3, r0, 1   (li r3, 1)
//   0x4E800020  blr
const ppc = Uint8Array.from([0x38, 0x60, 0x00, 0x01, 0x4E, 0x80, 0x00, 0x20]);

pick('r360_ppc_probe_reset')();
const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
if (capacity < ppc.length) {
  console.error(`Probe input capacity too small: ${capacity}`);
  process.exit(6);
}
new Uint8Array(instance.exports.memory.buffer, inputPtr, ppc.length).set(ppc);

const loaded = pick('r360_ppc_probe_load')(inputPtr, ppc.length) >>> 0;
if (loaded !== ppc.length) {
  console.error(`Probe load failed: loaded=${loaded} status=0x${(pick('r360_ppc_probe_status')() >>> 0).toString(16)}`);
  process.exit(7);
}

const translatedCount = pick('r360_ppc_probe_translate')() >>> 0;
const status = pick('r360_ppc_probe_status')() >>> 0;
const guestBase = pick('r360_ppc_probe_guest_base')() >>> 0;
const loadedSize = pick('r360_ppc_probe_loaded_size')() >>> 0;
const assembled = pick('r360_ppc_probe_assembled_functions')() >>> 0;
const blocks = pick('r360_ppc_probe_hir_block_count')() >>> 0;
const hir = pick('r360_ppc_probe_hir_instruction_count')() >>> 0;
const lastGuest = pick('r360_ppc_probe_last_guest_address')() >>> 0;

console.log(`status=${status}`);
console.log(`guest_base=0x${guestBase.toString(16).padStart(8, '0')}`);
console.log(`loaded_bytes=${loadedSize}`);
console.log(`assembled_functions=${assembled}`);
console.log(`hir_blocks=${blocks}`);
console.log(`hir_instructions=${hir}`);
console.log(`translate_return=${translatedCount}`);
console.log(`last_guest_address=0x${lastGuest.toString(16).padStart(8, '0')}`);

if (status !== 3 || loadedSize !== ppc.length || assembled === 0 || blocks === 0 ||
    hir === 0 || translatedCount === 0 || lastGuest !== guestBase) {
  console.error('FAIL: real PPC bytes did not complete the Xenia PPC -> HIR probe contract.');
  process.exit(8);
}

console.log('PASS: real PPC bytes reached Xenia HIR and the ProbeAssembler observed finalized HIR.');
