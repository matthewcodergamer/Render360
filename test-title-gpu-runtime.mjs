import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {submitCapturedTitleGpuTraffic} from './render360-title-gpu-traffic.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports;const pick=n=>e[n]??e[`_${n}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_kernel_import_reset','r360_kernel_import_register','r360_title_gpu_reset','r360_title_gpu_ring_base','r360_title_gpu_ring_size_log2','r360_title_gpu_ring_bytes','r360_title_gpu_ring_word_capacity','r360_title_gpu_write_pointer','r360_title_gpu_status','r360_title_gpu_mmio_writes','r360_title_gpu_ring_word','r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_sparse_guest_memory_protect','r360_sparse_guest_memory_write_u32_be','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_status','r360_xenos_packets','r360_xenos_draws','r360_xenos_presents'];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`title GPU runtime missing export ${n}`);

const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const dform=(op,rt,ra,imm)=>((op<<26)|(rt<<21)|(ra<<16)|(imm&0xffff))>>>0;
const lis=(rt,imm)=>dform(15,rt,0,imm),li=(rt,imm)=>dform(14,rt,0,imm),ori=(ra,rs,imm)=>dform(24,rs,ra,imm),lwz=(rt,ra,d)=>dform(32,rt,ra,d),stw=(rs,ra,d)=>dform(36,rs,ra,d);
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
const writeWptr=value=>run([lis(11,0x7FC8),ori(11,11,0x0714),stw(3,11,0),blr],{3:value});
const readRptr=()=>run([lis(11,0x7FC8),ori(11,11,0x0710),lwz(3,11,0),blr]);

// First prove the executor can load mapped data outside its active 64 KiB code
// window through SparseGuestMemory instead of rejecting the access.
pick('r360_sparse_guest_memory_reset')();
const dataBase=0x10000000;const backing=pick('r360_sparse_guest_memory_alloc')(1)>>>0;if(!backing)throw new Error('sparse backing allocation failed');
if((pick('r360_sparse_guest_memory_map')(dataBase,1,backing,0,3)>>>0)!==1)throw new Error('sparse data mapping failed');
if((pick('r360_sparse_guest_memory_write_u32_be')(dataBase,0x12345678)>>>0)!==1)throw new Error('sparse data seed failed');
const sparseLoad=run([lis(11,0x1000),lwz(3,11,0),blr]);
if(sparseLoad!==0x12345678)throw new Error(`sparse HIR load mismatch 0x${sparseLoad.toString(16)}`);
console.log('TITLE_RUNTIME_SPARSE_DATA_OUTSIDE_64K=PASS');

// Prove nested title execution is no longer constrained to the active entry
// window. The caller is staged at 0x20000000 while the callee lives solely in
// executable sparse guest memory at 0x30000000.
const farCode=0x30000000;const farBacking=pick('r360_sparse_guest_memory_alloc')(1)>>>0;if(!farBacking)throw new Error('far sparse code backing allocation failed');
if((pick('r360_sparse_guest_memory_map')(farCode,1,farBacking,0,7)>>>0)!==1)throw new Error('far sparse code mapping failed');
if((pick('r360_sparse_guest_memory_write_u32_be')(farCode,li(3,0x42))>>>0)!==1||(pick('r360_sparse_guest_memory_write_u32_be')(farCode+4,blr)>>>0)!==1)throw new Error('far sparse code seed failed');
const farResult=run([lis(11,0x3000),ori(11,11,0),mtctr11,bctrl,blr]);
if(farResult!==0x42)throw new Error(`far sparse PPC call mismatch 0x${farResult.toString(16)}`);
console.log('TITLE_RUNTIME_NESTED_CODE_OUTSIDE_64K=PASS');

// A readable data page must not become executable merely because translated
// title PPC branches into it.
const nonExecCode=0x31000000;const nonExecBacking=pick('r360_sparse_guest_memory_alloc')(1)>>>0;if(!nonExecBacking)throw new Error('non-executable sparse backing allocation failed');
if((pick('r360_sparse_guest_memory_map')(nonExecCode,1,nonExecBacking,0,3)>>>0)!==1)throw new Error('non-executable sparse mapping failed');
if((pick('r360_sparse_guest_memory_write_u32_be')(nonExecCode,li(3,0x77))>>>0)!==1||(pick('r360_sparse_guest_memory_write_u32_be')(nonExecCode+4,blr)>>>0)!==1)throw new Error('non-executable sparse seed failed');
if((pick('r360_sparse_guest_memory_protect')(nonExecCode,1,1)>>>0)!==1)throw new Error('non-executable sparse protection failed');
let nonExecRejected=false;try{run([lis(11,0x3100),ori(11,11,0),mtctr11,bctrl,blr]);}catch{nonExecRejected=true;}
if(!nonExecRejected)throw new Error('PPC pager executed a readable non-executable sparse page');
console.log('TITLE_RUNTIME_NONEXEC_CODE_REJECTED=PASS');

// Register the real xboxkrnl VdInitializeRingBuffer ordinal as unresolved. The
// runtime itself must consume r3/r4 from the active translated PPC context.
pick('r360_kernel_import_reset')();pick('r360_title_gpu_reset')();
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

// The translated CP_RB_WPTR store must synchronously drain the real ring into
// Xenos, not merely record telemetry for JavaScript to replay later.
writeWptr(1);
if((pick('r360_title_gpu_write_pointer')()>>>0)!==1||(pick('r360_title_gpu_mmio_writes')()>>>0)!==1||(pick('r360_title_gpu_status')()>>>0)<2)throw new Error('CP_RB_WPTR translated PPC MMIO capture mismatch');
if((pick('r360_xenos_status')()>>>0)!==1||(pick('r360_xenos_packets')()>>>0)!==1||(pick('r360_xenos_draws')()>>>0)!==0)throw new Error('CP_RB_WPTR did not natively drain captured PM4');
if(readRptr()!==1)throw new Error('translated CP_RB_RPTR did not advance after accepted PM4');
console.log('TITLE_RUNTIME_REAL_CP_RB_WPTR_MMIO=PASS');
console.log('TITLE_RUNTIME_NATIVE_WPTR_TO_XENOS=PASS');
console.log('TITLE_RUNTIME_REAL_CP_RB_RPTR_PROGRESS=PASS');

const scratch=pick('r360_ppc_probe_input_buffer')()>>>0;
if((pick('r360_title_gpu_ring_word')(0,scratch)>>>0)!==1)throw new Error('title ring sparse word read failed');
const bytes=new Uint8Array(e.memory.buffer,scratch,4);const word=(bytes[0]|(bytes[1]<<8)|(bytes[2]<<16)|(bytes[3]<<24))>>>0;
if(word!==0x80000000)throw new Error(`title ring word mismatch 0x${word.toString(16)}`);
console.log('TITLE_RUNTIME_REAL_RING_WORD_READ=PASS');

// Prove circular producer/consumer behavior. Fill the remainder of the 1024
// word ring with real NOP packets, advance to the final word, wrap WPtr to 0,
// then produce one more command at index 0. Xenos state must persist across all
// three submissions and RPTR must follow the accepted producer boundary.
const ringCapacity=pick('r360_title_gpu_ring_word_capacity')()>>>0;if(ringCapacity!==1024)throw new Error(`unexpected ring capacity ${ringCapacity}`);
for(let i=1;i<ringCapacity;i++)if((pick('r360_sparse_guest_memory_write_u32_be')((ringBase+i*4)>>>0,0x80000000)>>>0)!==1)throw new Error(`ring wrap seed failed at ${i}`);
writeWptr(ringCapacity-1);
if(readRptr()!==ringCapacity-1)throw new Error('RPTR did not advance to final producer span');
writeWptr(0);
if(readRptr()!==0)throw new Error('RPTR did not wrap with circular ring');
writeWptr(1);
if(readRptr()!==1)throw new Error('RPTR did not consume post-wrap command');
if((pick('r360_xenos_packets')()>>>0)!==ringCapacity+1)throw new Error(`Xenos state did not persist across circular submissions packets=${pick('r360_xenos_packets')()>>>0}`);
console.log('TITLE_RUNTIME_CIRCULAR_RING_WRAP=PASS');
console.log('TITLE_RUNTIME_XENOS_STATE_PERSISTS=PASS');

// Modern JS must observe the already-drained native state without resetting or
// replaying it. This protects title shaders/registers accumulated over multiple
// producer updates.
const traffic=submitCapturedTitleGpuTraffic({bootstrap:instance});
if(!traffic.ready||!traffic.submitted||traffic.source!=='native-cp-rb-wptr-drain'||!traffic.nativeDrained||traffic.packets!==ringCapacity+1||traffic.draws!==0||traffic.frameGeneration!==0)throw new Error(`native captured title traffic mismatch ${JSON.stringify(traffic)}`);
console.log('TITLE_RUNTIME_JS_PRESERVES_NATIVE_XENOS_STATE=PASS');
console.log('TITLE_RUNTIME_CAPTURED_RING_TO_XENOS=PASS');
console.log('TITLE_GPU_RUNTIME_BRIDGE=PASS');
