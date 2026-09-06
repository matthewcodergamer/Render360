import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`HIR cache-control bootstrap WASM not found: ${wasmPath}`);
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
for(const n of [
  'r360_ppc_probe_reset',
  'r360_ppc_probe_input_buffer',
  'r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load_at',
  'r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status',
  'r360_ppc_probe_correctness_r3',
  'r360_ppc_probe_correctness_blocker_opcode',
]){
  if(typeof p(n)!=='function')throw new Error(`missing HIR cache-control fixture export ${n}`);
}

// Exact Braid instruction seen at 0x823443F8:
//   0x7C00222C = dcbt r0,r4
// Xenia lowers dcbt to HIR OPCODE_CACHE_CONTROL (opcode 42), DATA_TOUCH, with
// a 128-byte cache-line size. In the browser compatibility executor this is a
// host cache hint only: it must not turn into a guest-memory read/fault.
const words=[
  0x38801234, // li   r4,0x1234 (intentionally unmapped guest address)
  0x7C00222C, // dcbt r0,r4 -> HIR OPCODE_CACHE_CONTROL / opcode 42
  0x38600069, // li   r3,0x69
  0x4E800020, // blr
];
const code=Uint8Array.from(words.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const input=p('r360_ppc_probe_input_buffer')()>>>0;
const cap=p('r360_ppc_probe_input_capacity')()>>>0;
if(!input||code.length>cap)throw new Error('HIR cache-control PPC fixture does not fit staging buffer');

p('r360_ppc_probe_reset')();
new Uint8Array(e.memory.buffer,input,code.length).set(code);
if((p('r360_ppc_probe_load_at')(0x80000000,input,code.length)>>>0)!==code.length)throw new Error('HIR cache-control PPC fixture load failed');
if(!(p('r360_ppc_probe_translate')()>>>0))throw new Error('HIR cache-control PPC fixture translation failed');

const status=p('r360_ppc_probe_correctness_status')()>>>0;
const blocker=p('r360_ppc_probe_correctness_blocker_opcode')()>>>0;
const r3=Number(BigInt.asUintN(32,p('r360_ppc_probe_correctness_r3')()))>>>0;
if(status!==3||blocker!==0||r3!==0x69){
  throw new Error(`dcbt/HIR CACHE_CONTROL compatibility failed status=${status} blocker=${blocker} r3=0x${r3.toString(16)}`);
}

console.log('braid_ppc_dcbt=0x7C00222C');
console.log('braid_hir_cache_control_opcode=42');
console.log('HIR_CACHE_CONTROL_DATA_TOUCH_NOOP=PASS');
console.log('BRAID_DCBT_TAIL_FRAGMENT=PASS');
