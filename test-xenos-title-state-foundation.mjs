import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(mod);
for (const im of WebAssembly.Module.imports(mod)) {
  if (im.module === 'env' && im.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(mod, imports);
wasi.initialize(instance);
const e = instance.exports;
const f = n => e[n] ?? e[`_${n}`];

const required = [
  'r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_status',
  'r360_xenos_register','r360_xenos_indirect_buffers','r360_xenos_shader_loads','r360_xenos_shader_buffer',
  'r360_xenos_shader_dwords','r360_xenos_shader_hash','r360_xenos_shader_guest_address','r360_xenos_shader_source',
  'r360_xenos_fetch_constant_word','r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc',
  'r360_sparse_guest_memory_map','r360_sparse_guest_memory_write_u32_be'
];
for (const n of required) if (typeof f(n) !== 'function') throw new Error(`missing export ${n}`);

const packet3 = (opcode, count) => ((3 << 30) | (((count - 1) & 0x3fff) << 16) | ((opcode & 0x7f) << 8)) >>> 0;
const submit = words => {
  f('r360_xenos_reset')();
  const ptr = f('r360_xenos_ring_buffer')() >>> 0;
  const cap = f('r360_xenos_ring_capacity')() >>> 0;
  if (!ptr || words.length > cap) throw new Error('Xenos ring unavailable');
  const ring = new Uint32Array(e.memory.buffer, ptr, cap);
  ring.fill(0);
  ring.set(words);
  const ok = f('r360_xenos_submit')(words.length) >>> 0;
  if (!ok) throw new Error(`Xenos submit failed status=${f('r360_xenos_status')()>>>0}`);
};

// SET_CONSTANT FETCH group. This is the real register range holding Xenos
// texture / vertex fetch constants, six dwords per fetch group.
const fetchWords = [0x00000006,0x12345000,0x00100020,0x0c600000,0x00000000,0x00000000];
submit([packet3(0x2d, 7), 0x00010000, ...fetchWords]);
for (let i = 0; i < 6; ++i) {
  if ((f('r360_xenos_fetch_constant_word')(0, i)>>>0) !== fetchWords[i]) {
    throw new Error(`fetch constant ${i} mismatch`);
  }
}
console.log('XENOS_TITLE_FETCH_CONSTANTS=PASS');

// Inline vertex shader microcode must be captured byte-for-byte with provenance.
const inlineVs = [0x11223344,0x55667788,0x99aabbcc];
submit([packet3(0x2b, 5), 0, inlineVs.length, ...inlineVs]);
if ((f('r360_xenos_shader_dwords')(0)>>>0) !== inlineVs.length) throw new Error('inline VS dword count mismatch');
if ((f('r360_xenos_shader_source')(0)>>>0) !== 2) throw new Error('inline VS source mismatch');
if (!(f('r360_xenos_shader_hash')(0)>>>0)) throw new Error('inline VS hash missing');
const vsPtr = f('r360_xenos_shader_buffer')(0)>>>0;
const vsView = new Uint32Array(e.memory.buffer, vsPtr, inlineVs.length);
for (let i=0;i<inlineVs.length;i++) if ((vsView[i]>>>0)!==inlineVs[i]) throw new Error(`inline VS word ${i} mismatch`);
console.log('XENOS_TITLE_INLINE_VERTEX_SHADER=PASS');

// Pointer-based pixel shader must be read from authoritative sparse guest RAM.
f('r360_sparse_guest_memory_reset')();
const shaderBase = 0x12000000;
const shaderBacking = f('r360_sparse_guest_memory_alloc')(1)>>>0;
if (!shaderBacking || (f('r360_sparse_guest_memory_map')(shaderBase,1,shaderBacking,0,3)>>>0)!==1) throw new Error('shader sparse map failed');
const pixelPs = [0xdeadbeef,0x01020304,0xa5a55a5a,0x13579bdf];
for (let i=0;i<pixelPs.length;i++) if ((f('r360_sparse_guest_memory_write_u32_be')(shaderBase+i*4,pixelPs[i])>>>0)!==1) throw new Error('shader seed failed');
submit([packet3(0x27,2),(shaderBase|1)>>>0,pixelPs.length]);
if ((f('r360_xenos_shader_dwords')(1)>>>0)!==pixelPs.length) throw new Error('pointer PS dword count mismatch');
if ((f('r360_xenos_shader_source')(1)>>>0)!==1) throw new Error('pointer PS source mismatch');
if ((f('r360_xenos_shader_guest_address')(1)>>>0)!==shaderBase) throw new Error('pointer PS guest address mismatch');
if (!(f('r360_xenos_shader_hash')(1)>>>0)) throw new Error('pointer PS hash missing');
const psPtr=f('r360_xenos_shader_buffer')(1)>>>0;const psView=new Uint32Array(e.memory.buffer,psPtr,pixelPs.length);
for(let i=0;i<pixelPs.length;i++)if((psView[i]>>>0)!==pixelPs[i])throw new Error(`pointer PS word ${i} mismatch`);
console.log('XENOS_TITLE_POINTER_PIXEL_SHADER=PASS');

// Real command streams dispatch secondary command lists. Prove an indirect
// buffer read from sparse guest memory mutates Xenos state rather than being
// treated as an opaque unsupported packet.
const ibBase=0x13000000;const ibBacking=f('r360_sparse_guest_memory_alloc')(1)>>>0;
if(!ibBacking||(f('r360_sparse_guest_memory_map')(ibBase,1,ibBacking,0,3)>>>0)!==1)throw new Error('IB sparse map failed');
const ibWords=[0x00001234,0xcafebabe];
for(let i=0;i<ibWords.length;i++)if((f('r360_sparse_guest_memory_write_u32_be')(ibBase+i*4,ibWords[i])>>>0)!==1)throw new Error('IB seed failed');
submit([packet3(0x3f,2),ibBase,ibWords.length]);
if((f('r360_xenos_indirect_buffers')()>>>0)!==1)throw new Error('indirect buffer telemetry missing');
if((f('r360_xenos_register')(0x1234)>>>0)!==0xcafebabe)throw new Error('indirect buffer register write missing');
console.log('XENOS_TITLE_INDIRECT_BUFFER=PASS');

// Register RMW is used during shader upload and EDRAM setup in upstream Xenia.
submit([0x00000123,0xf0f00000,packet3(0x21,3),0x00000123,0xffff0fff,0x0000005a]);
const expected=((0xf0f00000&0xffff0fff)|0x5a)>>>0;
if((f('r360_xenos_register')(0x123)>>>0)!==expected)throw new Error('REG_RMW result mismatch');
console.log('XENOS_TITLE_REG_RMW=PASS');
console.log('XENOS_TITLE_STATE_FOUNDATION=PASS');
