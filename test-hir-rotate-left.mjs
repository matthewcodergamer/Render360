import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`HIR rotate-left bootstrap WASM not found: ${wasmPath}`);
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
  if(typeof p(n)!=='function')throw new Error(`missing HIR rotate-left fixture export ${n}`);
}

// Exact Braid instruction seen at 0x8234447C:
//   0x54A7EF3E = rlwinm r7,r5,29,28,31
// Xenia expands rlwinm by duplicating the low 32-bit word into a 64-bit value,
// then emits HIR OPCODE_ROTATE_LEFT (opcode 98) before applying the mask.
// With r5=0x1234, ROTL32(0x1234,29) & 0xF == 6.
const words=[
  0x38A01234, // li     r5,0x1234
  0x54A7EF3E, // rlwinm r7,r5,29,28,31 -> HIR ROTATE_LEFT / opcode 98
  0x38670000, // addi   r3,r7,0
  0x4E800020, // blr
];
const code=Uint8Array.from(words.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const input=p('r360_ppc_probe_input_buffer')()>>>0;
const cap=p('r360_ppc_probe_input_capacity')()>>>0;
if(!input||code.length>cap)throw new Error('HIR rotate-left PPC fixture does not fit staging buffer');

p('r360_ppc_probe_reset')();
new Uint8Array(e.memory.buffer,input,code.length).set(code);
if((p('r360_ppc_probe_load_at')(0x80000000,input,code.length)>>>0)!==code.length)throw new Error('HIR rotate-left PPC fixture load failed');
if(!(p('r360_ppc_probe_translate')()>>>0))throw new Error('HIR rotate-left PPC fixture translation failed');

const status=p('r360_ppc_probe_correctness_status')()>>>0;
const blocker=p('r360_ppc_probe_correctness_blocker_opcode')()>>>0;
const r3=Number(BigInt.asUintN(32,p('r360_ppc_probe_correctness_r3')()))>>>0;
if(status!==3||blocker!==0||r3!==6){
  throw new Error(`rlwinm/HIR ROTATE_LEFT compatibility failed status=${status} blocker=${blocker} r3=0x${r3.toString(16)}`);
}

console.log('braid_ppc_rlwinm=0x54A7EF3E');
console.log('braid_hir_rotate_left_opcode=98');
console.log('HIR_ROTATE_LEFT_INTEGER=PASS');
console.log('BRAID_RLWINM_TAIL_FRAGMENT=PASS');
