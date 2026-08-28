import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`XEX mapper WASM not found: ${wasmPath}`);
const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports = wasi.getImportObject(module);
for (const e of WebAssembly.Module.imports(module)) {
  if (e.module === 'env' && e.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const pick = n => instance.exports[n] ?? instance.exports[`_${n}`];
const required = [
  'r360_xex_guest_mapper_reset','r360_xex_guest_mapper_map_section',
  'r360_xex_guest_mapper_load','r360_xex_guest_mapper_set_entry',
  'r360_xex_guest_mapper_finalize','r360_xex_guest_mapper_status',
  'r360_xex_guest_mapper_entry_address','r360_xex_guest_mapper_section_count',
  'r360_xex_guest_mapper_mapped_bytes','r360_xex_guest_mapper_input_buffer',
  'r360_xex_guest_mapper_input_capacity','r360_sparse_guest_memory_read_u8',
  'r360_sparse_guest_memory_write_u8','r360_sparse_guest_memory_last_fault_code'
];
for (const n of required) if (typeof pick(n) !== 'function') throw new Error(`Missing XEX mapper export ${n}`);

const R=1,W=2,X=4;
const ok=(v,msg)=>{ if ((v>>>0)!==1) throw new Error(msg); };
const no=(v,msg)=>{ if ((v>>>0)!==0) throw new Error(msg); };
const eq=(a,b,msg)=>{ if ((a>>>0)!==(b>>>0)) throw new Error(`${msg}: got 0x${(a>>>0).toString(16)}, expected 0x${(b>>>0).toString(16)}`); };
const input=pick('r360_xex_guest_mapper_input_buffer')()>>>0;
const capacity=pick('r360_xex_guest_mapper_input_capacity')()>>>0;
if (!input || capacity < 16) throw new Error('XEX mapper staging buffer unavailable');

// Realistic Xbox 360 user image addresses: separate RX, R, and RW regions.
pick('r360_xex_guest_mapper_reset')();
ok(pick('r360_xex_guest_mapper_map_section')(0x82000000,0x1800,R|X),'RX code mapping');
ok(pick('r360_xex_guest_mapper_map_section')(0x82002000,0x1000,R),'R rodata mapping');
ok(pick('r360_xex_guest_mapper_map_section')(0x82003000,0x1800,R|W),'RW data mapping');
eq(pick('r360_xex_guest_mapper_section_count')(),3,'section count');
eq(pick('r360_xex_guest_mapper_mapped_bytes')(),0x5000,'rounded mapped bytes');

const seed=Uint8Array.from([0x48,0x00,0x00,0x04,0x4e,0x80,0x00,0x20]);
new Uint8Array(instance.exports.memory.buffer,input,seed.length).set(seed);
ok(pick('r360_xex_guest_mapper_load')(0x82000000,input,seed.length),'load code bytes');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82000000),0x48,'loaded code byte');

// Reject overlapping pages and 32-bit wraparound before finalization.
no(pick('r360_xex_guest_mapper_map_section')(0x82001000,0x1000,R),'overlapping section must fail');
pick('r360_xex_guest_mapper_reset')();
no(pick('r360_xex_guest_mapper_map_section')(0xfffff000,0x2000,R),'wraparound section must fail');
console.log('XEX_OVERLAP_REJECTION=PASS');
console.log('XEX_WRAPAROUND_REJECTION=PASS');

// Entry outside executable content fails closed.
pick('r360_xex_guest_mapper_reset')();
ok(pick('r360_xex_guest_mapper_map_section')(0x82000000,0x1000,R|X),'map entry test code');
ok(pick('r360_xex_guest_mapper_map_section')(0x82001000,0x1000,R|W),'map entry test data');
ok(pick('r360_xex_guest_mapper_set_entry')(0x82001000),'set non-exec entry');
no(pick('r360_xex_guest_mapper_finalize')(),'non-exec entry must fail closed');
eq(pick('r360_xex_guest_mapper_status')(),0x80000004,'entry invalid status');
console.log('XEX_ENTRY_OUTSIDE_EXEC_FAIL_CLOSED=PASS');

// A valid entry finalizes permissions: RX/R reject writes while RW remains writable.
pick('r360_xex_guest_mapper_reset')();
ok(pick('r360_xex_guest_mapper_map_section')(0x82000000,0x1800,R|X),'RX code mapping final');
ok(pick('r360_xex_guest_mapper_map_section')(0x82002000,0x1000,R),'R rodata mapping final');
ok(pick('r360_xex_guest_mapper_map_section')(0x82003000,0x1800,R|W),'RW data mapping final');
new Uint8Array(instance.exports.memory.buffer,input,seed.length).set(seed);
ok(pick('r360_xex_guest_mapper_load')(0x82000000,input,seed.length),'load code final');
ok(pick('r360_xex_guest_mapper_set_entry')(0x82000004),'set executable entry');
ok(pick('r360_xex_guest_mapper_finalize')(),'valid mapping finalize');
eq(pick('r360_xex_guest_mapper_status')(),2,'finalized status');
eq(pick('r360_xex_guest_mapper_entry_address')(),0x82000004,'entry address');

no(pick('r360_sparse_guest_memory_write_u8')(0x82000000,0xaa),'RX write rejection');
eq(pick('r360_sparse_guest_memory_last_fault_code')(),3,'RX write fault');
no(pick('r360_sparse_guest_memory_write_u8')(0x82002000,0xbb),'R write rejection');
eq(pick('r360_sparse_guest_memory_last_fault_code')(),3,'R write fault');
ok(pick('r360_sparse_guest_memory_write_u8')(0x82003000,0xcc),'RW write');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82003000),0xcc,'RW readback');
no(pick('r360_xex_guest_mapper_map_section')(0x83000000,0x1000,R),'mapping after finalize must fail');

console.log('XEX_RX_MAPPING=PASS');
console.log('XEX_RODATA_MAPPING=PASS');
console.log('XEX_RW_MAPPING=PASS');
console.log('XEX_RX_WRITE_REJECTION=PASS');
console.log('XEX_R_WRITE_REJECTION=PASS');
console.log('XEX_RW_READ_WRITE=PASS');
console.log('XEX_ENTRY_VALIDATION=PASS');
console.log('XEX_GUEST_MAPPING=PASS');
