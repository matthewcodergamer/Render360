import fs from 'node:fs';
import { WASI } from 'node:wasi';

const mod=await WebAssembly.compile(fs.readFileSync(process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const e=(await WebAssembly.instantiate(mod,imports)).exports;wasi.initialize({exports:e});
const pick=n=>e[n]??e[`_${n}`];
for(const n of ['r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_kernel_import_reset','r360_kernel_import_register','r360_kernel_import_calls','r360_kernel_import_last_thunk','r360_kernel_import_last_module','r360_kernel_import_last_ordinal','r360_kernel_import_last_status'])if(typeof pick(n)!=='function')throw new Error(`missing HLE bridge export ${n}`);

const base=0x80000000,thunk=0x90001234,hi=(thunk>>>16)&0xffff,lo=thunk&0xffff;
const words=[0x3D600000|hi,0x616B0000|lo,0x7D6903A6,0x4E800421,0x4E800020];
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const writeCode=()=>{const m=new Uint8Array(e.memory.buffer);for(let i=0;i<words.length;i++){const w=words[i]>>>0,o=input+i*4;m[o]=w>>>24;m[o+1]=(w>>>16)&255;m[o+2]=(w>>>8)&255;m[o+3]=w&255;}};
const run=({implemented,result})=>{
  pick('r360_ppc_probe_reset')();pick('r360_kernel_import_reset')();
  if((pick('r360_kernel_import_register')(thunk,1,0x123,implemented?1:0,result>>>0)>>>0)!==1)throw new Error('kernel import registration failed');
  writeCode();if((pick('r360_ppc_probe_load_at')(base,input,words.length*4)>>>0)!==words.length*4)throw new Error('PPC HLE workload load failed');
  const hir=pick('r360_ppc_probe_translate')()>>>0;if(!hir)throw new Error('PPC HLE workload translation failed');
  return {hir,status:pick('r360_ppc_probe_correctness_status')()>>>0,r3:BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')()),calls:pick('r360_kernel_import_calls')()>>>0,lastThunk:pick('r360_kernel_import_last_thunk')()>>>0,lastModule:pick('r360_kernel_import_last_module')()>>>0,lastOrdinal:pick('r360_kernel_import_last_ordinal')()>>>0,lastStatus:pick('r360_kernel_import_last_status')()>>>0};
};

const ok=run({implemented:true,result:0x55});
if(ok.status!==3||ok.r3!==0x55n||ok.calls!==1||ok.lastThunk!==thunk||ok.lastModule!==1||ok.lastOrdinal!==0x123||ok.lastStatus!==1)throw new Error(`implemented HLE path mismatch ${JSON.stringify({...ok,r3:ok.r3.toString()})}`);
console.log('PPC_TO_KERNEL_HLE_DISPATCH=PASS');
console.log('KERNEL_HLE_PPC_CONTEXT_RETURN=PASS');

const blocked=run({implemented:false,result:0});
if(blocked.status!==1||blocked.calls!==1||blocked.lastThunk!==thunk||blocked.lastModule!==1||blocked.lastOrdinal!==0x123||blocked.lastStatus!==2)throw new Error(`unimplemented HLE blocker mismatch ${JSON.stringify({...blocked,r3:blocked.r3.toString()})}`);
console.log('KERNEL_HLE_EXACT_UNIMPLEMENTED_BLOCKER=PASS');
console.log('KERNEL_HLE_FAIL_CLOSED=PASS');
