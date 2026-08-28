import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`Sparse guest-memory WASM not found: ${wasmPath}`);
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
  'r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc',
  'r360_sparse_guest_memory_map','r360_sparse_guest_memory_protect',
  'r360_sparse_guest_memory_unmap','r360_sparse_guest_memory_read_u8',
  'r360_sparse_guest_memory_write_u8','r360_sparse_guest_memory_write_u32_be',
  'r360_sparse_guest_memory_mapped_pages','r360_sparse_guest_memory_backing_pages',
  'r360_sparse_guest_memory_last_fault_address','r360_sparse_guest_memory_last_fault_code',
  'r360_wasm_backend_executable_page_generation','r360_wasm_backend_call_invalidations'
];
for (const n of required) if (typeof pick(n) !== 'function') throw new Error(`Missing sparse-memory export ${n}`);

const R=1,W=2,X=4;
const ok=(v,msg)=>{ if ((v>>>0)!==1) throw new Error(msg); };
const eq=(a,b,msg)=>{ if ((a>>>0)!==(b>>>0)) throw new Error(`${msg}: got 0x${(a>>>0).toString(16)}, expected 0x${(b>>>0).toString(16)}`); };
const fault=(code,address,msg)=>{
  eq(pick('r360_sparse_guest_memory_last_fault_code')(),code,`${msg} fault code`);
  eq(pick('r360_sparse_guest_memory_last_fault_address')(),address,`${msg} fault address`);
};

pick('r360_sparse_guest_memory_reset')();
const backing = pick('r360_sparse_guest_memory_alloc')(4)>>>0;
if (!backing) throw new Error('Backing allocation failed');
eq(pick('r360_sparse_guest_memory_backing_pages')(),4,'backing page count');

// Widely separated, non-contiguous mappings consume only the four backing pages.
ok(pick('r360_sparse_guest_memory_map')(0x10000000,2,backing,0,R|W),'map cross-page region');
ok(pick('r360_sparse_guest_memory_map')(0x70000000,1,backing,3,R|W),'map distant page');
eq(pick('r360_sparse_guest_memory_mapped_pages')(),3,'sparse mapped page count');
eq(pick('r360_sparse_guest_memory_backing_pages')(),4,'sparse backing stays physical-only');

ok(pick('r360_sparse_guest_memory_write_u8')(0x7000007f,0x5a),'distant write');
eq(pick('r360_sparse_guest_memory_read_u8')(0x7000007f),0x5a,'distant read');

// Cross-page big-endian write: final byte of page 0 + first three bytes of page 1.
ok(pick('r360_sparse_guest_memory_write_u32_be')(0x10000fff,0x12345678),'cross-page u32 write');
eq(pick('r360_sparse_guest_memory_read_u8')(0x10000fff),0x12,'cross-page byte 0');
eq(pick('r360_sparse_guest_memory_read_u8')(0x10001000),0x34,'cross-page byte 1');
eq(pick('r360_sparse_guest_memory_read_u8')(0x10001001),0x56,'cross-page byte 2');
eq(pick('r360_sparse_guest_memory_read_u8')(0x10001002),0x78,'cross-page byte 3');

// Aliases share the exact same backing page.
ok(pick('r360_sparse_guest_memory_map')(0x50000000,1,backing,2,R|W),'map alias A');
ok(pick('r360_sparse_guest_memory_map')(0x60000000,1,backing,2,R|W),'map alias B');
ok(pick('r360_sparse_guest_memory_write_u8')(0x50000033,0xa7),'alias write');
eq(pick('r360_sparse_guest_memory_read_u8')(0x60000033),0xa7,'alias readback');

// Read-only protection rejects writes without mutating the byte.
ok(pick('r360_sparse_guest_memory_protect')(0x60000000,1,R),'protect alias read-only');
eq(pick('r360_sparse_guest_memory_write_u8')(0x60000033,0x11),0,'read-only write must fail');
fault(3,0x60000033,'read-only write');
eq(pick('r360_sparse_guest_memory_read_u8')(0x60000033),0xa7,'failed write must not mutate');

// Unmapped access fails closed.
eq(pick('r360_sparse_guest_memory_read_u8')(0x30000000),0,'unmapped read value');
fault(1,0x30000000,'unmapped read');

// Executable alias invalidation: code is RX at 0x80002000, but modified through
// a separate RW alias. Content mutation must advance the executable generation.
ok(pick('r360_sparse_guest_memory_map')(0x80002000,1,backing,2,R|X),'map executable alias');
const generationBefore = pick('r360_wasm_backend_executable_page_generation')(0x80002000)>>>0;
const invalidationsBeforeWrite = pick('r360_wasm_backend_call_invalidations')()>>>0;
ok(pick('r360_sparse_guest_memory_write_u8')(0x50000044,0xcc),'write through non-exec alias');
const generationAfterWrite = pick('r360_wasm_backend_executable_page_generation')(0x80002000)>>>0;
const invalidationsAfterWrite = pick('r360_wasm_backend_call_invalidations')()>>>0;
if (generationAfterWrite === generationBefore) throw new Error(`Executable alias generation did not advance (${generationBefore})`);
if (invalidationsAfterWrite === invalidationsBeforeWrite) throw new Error('Executable alias write did not invalidate cached code');

// Mapping/protection changes invalidate compiled code even when code bytes are
// unchanged. Content generation and mapping invalidation are distinct contracts.
const invalidationsBeforeProtect = pick('r360_wasm_backend_call_invalidations')()>>>0;
ok(pick('r360_sparse_guest_memory_protect')(0x80002000,1,R),'remove execute protection');
const invalidationsAfterProtect = pick('r360_wasm_backend_call_invalidations')()>>>0;
if (invalidationsAfterProtect === invalidationsBeforeProtect) throw new Error('Execute-protection change did not invalidate cached code');
ok(pick('r360_sparse_guest_memory_protect')(0x80002000,1,R|X),'restore execute protection');
const invalidationsBeforeUnmap = pick('r360_wasm_backend_call_invalidations')()>>>0;
ok(pick('r360_sparse_guest_memory_unmap')(0x80002000,1),'unmap executable page');
const invalidationsAfterUnmap = pick('r360_wasm_backend_call_invalidations')()>>>0;
if (invalidationsAfterUnmap === invalidationsBeforeUnmap) throw new Error('Executable unmap did not invalidate cached code');

console.log(`sparse_backing_pages=${pick('r360_sparse_guest_memory_backing_pages')()>>>0}`);
console.log(`sparse_mapped_pages=${pick('r360_sparse_guest_memory_mapped_pages')()>>>0}`);
console.log(`executable_generation_before=${generationBefore}`);
console.log(`executable_generation_after_alias_write=${generationAfterWrite}`);
console.log(`backend_invalidations_after_alias_write=${invalidationsAfterWrite}`);
console.log(`backend_invalidations_after_protect=${invalidationsAfterProtect}`);
console.log(`backend_invalidations_after_unmap=${invalidationsAfterUnmap}`);
console.log('SPARSE_WIDELY_SEPARATED_MAPS=PASS');
console.log('SPARSE_CROSS_PAGE_RW=PASS');
console.log('SPARSE_ALIAS_BACKING=PASS');
console.log('SPARSE_PROTECTION_FAIL_CLOSED=PASS');
console.log('SPARSE_UNMAPPED_FAIL_CLOSED=PASS');
console.log('SPARSE_EXECUTABLE_ALIAS_INVALIDATION=PASS');
console.log('SPARSE_MAPPING_INVALIDATION=PASS');
console.log('SPARSE_GUEST_MEMORY_FOUNDATION=PASS');
