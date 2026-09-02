import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};
    imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(mod,imports);
wasi.initialize(instance);
const e=instance.exports;
const p=n=>e[n]??e[`_${n}`];
for(const n of ['r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_sparse_guest_memory_write_u32_be','r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_ppc_probe_correctness_blocker_opcode']){
  if(typeof p(n)!=='function')throw new Error(`missing opcode39 fixture export ${n}`);
}

p('r360_sparse_guest_memory_reset')();
p('r360_ppc_probe_reset')();
const stackSlotBase=0x70000000;
const stackLimit=0x70001000;
const stackPages=128;
const stackBasePointer=stackLimit+stackPages*4096;
const stackTop=(stackBasePointer-(64+112))&~15;
const backing=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;
if(!backing)throw new Error('stack backing allocation failed');
if((p('r360_sparse_guest_memory_map')(stackLimit,stackPages,backing,0,3)>>>0)!==1)throw new Error('stack mapping failed');
if((p('r360_sparse_guest_memory_write_u32_be')(stackSlotBase,0xBAD0BAD0)>>>0)!==0)throw new Error('lower stack guard unexpectedly mapped');
if((p('r360_sparse_guest_memory_write_u32_be')(0x70080020,0x01020304)>>>0)!==1)throw new Error('Braid high-side stack address is not mapped');
if((p('r360_sparse_guest_memory_write_u32_be')(stackBasePointer,0xBAD1BAD1)>>>0)!==0)throw new Error('upper stack guard unexpectedly mapped');
if((p('r360_ppc_probe_set_initial_gpr')(1,BigInt(stackTop))>>>0)!==1)throw new Error('r1 initialization failed');

// Braid's first observed compatibility state produced 0x7007FF58, exactly
// stackTop + 0x58. Exercise a real PPC lwz through finalized HIR OPCODE_LOAD
// against that sparse main-thread stack address.
const expected=0x12345678;
if((p('r360_sparse_guest_memory_write_u32_be')(stackTop+0x58,expected)>>>0)!==1)throw new Error('stack fixture write failed');
const words=[
  0x38610058, // addi r3,r1,0x58
  0x80830000, // lwz  r4,0(r3) -> HIR LOAD / opcode 39
  0x38640000, // addi r3,r4,0
  0x4E800020, // blr
];
const code=Uint8Array.from(words.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const input=p('r360_ppc_probe_input_buffer')()>>>0;
new Uint8Array(e.memory.buffer,input,code.length).set(code);
if((p('r360_ppc_probe_load_at')(0x80000000,input,code.length)>>>0)!==code.length)throw new Error('PPC fixture load failed');
if(!(p('r360_ppc_probe_translate')()>>>0))throw new Error('PPC fixture translation failed');
const status=p('r360_ppc_probe_correctness_status')()>>>0;
const got=Number(BigInt.asUintN(32,p('r360_ppc_probe_correctness_r3')()))>>>0;
const blocker=p('r360_ppc_probe_correctness_blocker_opcode')()>>>0;
if(status!==3||got!==expected){
  throw new Error(`opcode39 stack load failed status=${status} r3=0x${got.toString(16)} blocker=${blocker}`);
}
console.log(`opcode39_stack_address=0x${(stackTop+0x58).toString(16)}`);
console.log('BRAID_OPCODE39_MAIN_THREAD_STACK_LOAD=PASS');
