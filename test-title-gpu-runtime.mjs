import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports;const pick=n=>e[n]??e[`_${n}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_kernel_import_reset','r360_kernel_import_register','r360_title_gpu_reset','r360_title_gpu_ring_base','r360_title_gpu_ring_size_log2','r360_title_gpu_ring_bytes','r360_title_gpu_write_pointer','r360_title_gpu_status','r360_title_gpu_mmio_writes','r360_title_gpu_ring_word','r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_sparse_guest_memory_write_u32_be'];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`title GPU runtime missing export ${n}`);

const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const dform=(op,rt,ra,imm)=>((op<<26)|(rt<<21)|(ra<<16)|(imm&0xffff))>>>0;
const lis=(rt,imm)=>dform(15,rt,0,imm),ori=(ra,rs,imm)=>dform(24,rs,ra,imm),lwz=(rt,ra,d)=>dform(32,rt,ra,d),stw=(rs,ra,d)=>dform(36,rs,ra,d);
const mtctr11=0x7D6903A6,bctrl=0x4E800421,blr=0x4E800020;
const codeBase=0x20000000;
const thunk=0x70004510;

function stage(words){
  const input=pick('r360_ppc_probe_input_buffer')()>>>0;const mem=new Uint8Array(e.memory.buffer,input,words.length*4);words.forEach((w,i)=>p32be(mem,i*4,w>>>0));
  if((pick('r360_ppc_probe_load_at')(codeBase,input,mem.length)>>>0)!==mem.length)throw new Error('title GPU PPC stage failed');
}
function run(words,gprs={}){
  pick('r360_ppc_probe_reset')();stage(words);
  for(const [r,v] of Object.entries(gprs))if((pick('r360_ppc_probe_set_initial_gpr')(Number(r),BigInt(v>>>0))>>>0)!==1)throw new Error(`set r${r} failed`);
  if(!(pick('r360_ppc_probe_translate')()>>>0))throw new Error('title GPU PPC translation failed');
  const status=pick('r360_ppc_probe_correctness_status')()>>>0;if(status!==3)throw new Error(`title GPU PPC execution failed status=${status}`);
  return Number(BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')()))>>>0;
}

// First prove the executor can load mapped data outside its active 64 KiB code
// window through SparseGuestMemory instead of rejecting the access.
pick('r360_sparse_guest_memory_reset')();
const dataBase=0x10000000;const backing=pick('r360_sparse_guest_memory_alloc')(1)>>>0;if(!backing)throw new Error('sparse backing allocation failed');
if((pick('r360_sparse_guest_memory_map')(dataBase,1,backing,0,3)>>>0)!==1)throw new Error('sparse data mapping failed');
if((pick('r360_sparse_guest_memory_write_u32_be')(dataBase,0x12345678)>>>0)!==1)throw new Error('sparse data seed failed');
const sparseLoad=run([lis(11,0x1000),lwz(3,11,0),blr]);
if(sparseLoad!==0x12345678)throw new Error(`sparse HIR load mismatch 0x${sparseLoad.toString(16)}`);
console.log('TITLE_RUNTIME_SPARSE_DATA_OUTSIDE_64K=PASS');

// Register the real xboxkrnl VdInitializeRingBuffer ordinal as unresolved. The
// runtime itself must consume r3/r4 from the active translated PPC context.
pick('r360_kernel_import_reset')();
pick('r360_title_gpu_reset')();
if((pick('r360_kernel_import_register')(thunk,1,0x01C3,0,0)>>>0)!==1)throw new Error('VdInitializeRingBuffer registration failed');
const hi=(thunk>>>16)&0xffff,lo=thunk&0xffff;
const ringBase=0x10001000,ringSizeLog2=9;
run([lis(11,hi),ori(11,11,lo),mtctr11,bctrl,blr],{3:ringBase,4:ringSizeLog2});
if((pick('r360_title_gpu_ring_base')()>>>0)!==ringBase||(pick('r360_title_gpu_ring_size_log2')()>>>0)!==ringSizeLog2||(pick('r360_title_gpu_ring_bytes')()>>>0)!==4096||(pick('r360_title_gpu_status')()>>>0)<1)throw new Error('real title ring service capture mismatch');
console.log('TITLE_RUNTIME_REAL_VD_INITIALIZE_RING=PASS');

// Map and seed the actual ring in sparse guest RAM. Type-2 NOP is a valid PM4
// word and gives the bridge a deterministic first genuine command word.
const ringBacking=pick('r360_sparse_guest_memory_alloc')(1)>>>0;if(!ringBacking)throw new Error('ring sparse backing allocation failed');
if((pick('r360_sparse_guest_memory_map')(ringBase,1,ringBacking,0,3)>>>0)!==1)throw new Error('ring sparse mapping failed');
if((pick('r360_sparse_guest_memory_write_u32_be')(ringBase,0x80000000)>>>0)!==1)throw new Error('ring seed failed');

// stw r3,0(r11) to 0x7FC80714, Xenia's CP_RB_WPTR register. This goes through
// translated PPC HIR, not a direct JS telemetry setter, and proves endian/MMIO
// handling in the executor overlay.
run([lis(11,0x7FC8),ori(11,11,0x0714),stw(3,11,0),blr],{3:1});
if((pick('r360_title_gpu_write_pointer')()>>>0)!==1||(pick('r360_title_gpu_mmio_writes')()>>>0)!==1||(pick('r360_title_gpu_status')()>>>0)<2)throw new Error('CP_RB_WPTR translated PPC MMIO capture mismatch');
console.log('TITLE_RUNTIME_REAL_CP_RB_WPTR_MMIO=PASS');

const scratch=pick('r360_ppc_probe_input_buffer')()>>>0;
if((pick('r360_title_gpu_ring_word')(0,scratch)>>>0)!==1)throw new Error('title ring sparse word read failed');
const bytes=new Uint8Array(e.memory.buffer,scratch,4);const word=(bytes[0]|(bytes[1]<<8)|(bytes[2]<<16)|(bytes[3]<<24))>>>0;
if(word!==0x80000000)throw new Error(`title ring word mismatch 0x${word.toString(16)}`);
console.log('TITLE_RUNTIME_REAL_RING_WORD_READ=PASS');
console.log('TITLE_GPU_RUNTIME_BRIDGE=PASS');
