import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`bootstrap WASM not found: ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const im of WebAssembly.Module.imports(module)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const pick=n=>instance.exports[n]??instance.exports[`_${n}`];
const required=[
  'r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity',
  'r360_pe_guest_load','r360_pe_guest_status','r360_pe_guest_entry_address',
  'r360_pe_guest_runtime_function_begin','r360_pe_guest_runtime_function_end',
  'r360_pe_guest_runtime_function_prolog_bytes','r360_pe_guest_raw_bytes',
  'r360_sparse_guest_memory_read_u8','r360_sparse_guest_memory_write_u8'
];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`missing export ${n}`);

const p16=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const eq=(a,b,m)=>{a>>>=0;b>>>=0;if(a!==b)throw new Error(`${m}: got 0x${a.toString(16)}, expected 0x${b.toString(16)}`)};
const yes=(v,m)=>{if((v>>>0)!==1)throw new Error(m)};
const no=(v,m)=>{if((v>>>0)!==0)throw new Error(m)};

// Xenia does not reconstruct a file-layout PE after XEX decrypt/decompress.
// It writes the prepared image directly at ImageBase, so section bytes live at
// image + VirtualAddress. PointerToRawData remains PE metadata only. This fixture
// deliberately puts different bytes at raw and virtual offsets to catch a loader
// that incorrectly re-copies the prepared image as though it were an on-disk PE.
function makePreparedMemoryImage(){
  const a=new Uint8Array(0x4000),nt=0x80,opt=nt+24,sections=opt+224;
  p16(a,0,0x5A4D);p32(a,0x3c,nt);p32(a,nt,0x00004550);
  p16(a,nt+4,0x01F2);p16(a,nt+6,3);p16(a,nt+20,224);p16(a,nt+22,0x0102);
  p16(a,opt,0x10B);p32(a,opt+16,0x1000);p32(a,opt+28,0x82000000);
  p32(a,opt+32,0x1000);p32(a,opt+36,0x200);p32(a,opt+56,0x4000);p32(a,opt+60,0x200);p16(a,opt+68,14);

  a.set(Buffer.from('.text\0\0\0','ascii'),sections);
  p32(a,sections+8,0x300);p32(a,sections+12,0x1000);p32(a,sections+16,0x200);p32(a,sections+20,0x200);p32(a,sections+36,0x60000020);
  const data=sections+40;
  a.set(Buffer.from('.data\0\0\0','ascii'),data);
  p32(a,data+8,0x300);p32(a,data+12,0x2000);p32(a,data+16,0x200);p32(a,data+20,0x400);p32(a,data+36,0xC0000040);
  const pdata=sections+80;
  a.set(Buffer.from('.pdata\0\0','ascii'),pdata);
  p32(a,pdata+8,0x200);p32(a,pdata+12,0x3000);p32(a,pdata+16,0x200);p32(a,pdata+20,0x600);p32(a,pdata+36,0x40000040);

  // File-layout decoys. A broken V65-style loader copies these to guest memory.
  a.set([0xDE,0xAD,0xBE,0xEF],0x200);
  a.set([0x11,0x22,0x33,0x44],0x400);
  // Leave raw .pdata as zero so runtime-function provenance also proves the source.

  // Prepared in-memory image bytes at their RVAs.
  a.set([0x38,0x61,0x00,0x58],0x1000); // addi r3,r1,88 - just a deterministic PPC word
  a.set([0xA5,0x5A,0xC3,0x3C],0x2000);
  p32be(a,0x3000,0x82001000);
  p32be(a,0x3004,(4<<8)|1); // four PPC instructions, one-instruction prolog
  return a;
}

const input=pick('r360_xex_guest_mapper_input_buffer')()>>>0;
const cap=pick('r360_xex_guest_mapper_input_capacity')()>>>0;
const image=makePreparedMemoryImage();
if(!input||image.length>cap)throw new Error(`staging buffer too small: ${cap}`);
new Uint8Array(instance.exports.memory.buffer,input,image.length).set(image);
yes(pick('r360_pe_guest_load')(input,image.length),'prepared memory image must load');
eq(pick('r360_pe_guest_status')(),1,'loader status');
eq(pick('r360_pe_guest_entry_address')(),0x82001000,'entry address');

// Critical regression: guest bytes must come from VirtualAddress (0x1000/0x2000),
// not PointerToRawData (0x200/0x400).
eq(pick('r360_sparse_guest_memory_read_u8')(0x82001000),0x38,'text sourced from prepared virtual image');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82001001),0x61,'text second byte sourced from prepared virtual image');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82002000),0xA5,'data sourced from prepared virtual image');
if((pick('r360_sparse_guest_memory_read_u8')(0x82001000)>>>0)===0xDE)throw new Error('raw-file decoy leaked into guest text');

// .pdata must also be parsed from its prepared virtual location.
eq(pick('r360_pe_guest_runtime_function_begin')(0x82001004),0x82001000,'runtime function begin from virtual .pdata');
eq(pick('r360_pe_guest_runtime_function_end')(0x82001004),0x82001010,'runtime function end from virtual .pdata');
eq(pick('r360_pe_guest_runtime_function_prolog_bytes')(0x82001004),4,'runtime function prolog from virtual .pdata');

// Preserve final page permissions.
no(pick('r360_sparse_guest_memory_write_u8')(0x82001000,0x99),'RX text must reject writes');
yes(pick('r360_sparse_guest_memory_write_u8')(0x82002000,0x77),'RW data must accept writes');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82002000),0x77,'RW data writeback');

console.log('XEX_PREPARED_MEMORY_IMAGE_TEXT_SOURCE=PASS');
console.log('XEX_PREPARED_MEMORY_IMAGE_DATA_SOURCE=PASS');
console.log('XEX_PREPARED_MEMORY_IMAGE_PDATA_SOURCE=PASS');
console.log('XEX_PREPARED_MEMORY_IMAGE_PERMISSIONS=PASS');
