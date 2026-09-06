import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);
const e=bootstrap.exports;const pick=n=>e[n]??e[`_${n}`];

const required=[
  'r360_kernel_service_reset','r360_kernel_service_call','r360_kernel_service_status',
  'r360_kernel_service_firmware_requested','r360_kernel_service_firmware_routine',
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer',
  'r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status',
  'r360_kernel_import_reset','r360_kernel_import_register','r360_kernel_import_last_status',
  'r360_kernel_import_history_count','r360_kernel_import_history_thunk',
  'r360_kernel_import_history_module','r360_kernel_import_history_ordinal'
];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`missing V75 export ${n}`);

pick('r360_kernel_service_reset')();
const direct=pick('r360_kernel_service_call')(1,0x28,1,0,0,0,0,0,0,0)>>>0;
const directStatus=pick('r360_kernel_service_status')()>>>0;
const firmwareRequested=pick('r360_kernel_service_firmware_requested')()>>>0;
const firmwareRoutine=pick('r360_kernel_service_firmware_routine')()>>>0;
if(direct!==0||directStatus!==4||firmwareRequested!==1||firmwareRoutine!==1){
  throw new Error(`HalReturnToFirmware direct semantics mismatch ${JSON.stringify({direct,directStatus,firmwareRequested,firmwareRoutine})}`);
}
console.log('HAL_RETURN_TO_FIRMWARE_TERMINAL_STATUS=PASS');
console.log('HAL_REBOOT_ROUTINE_CAPTURE=PASS');

pick('r360_kernel_service_reset')();
pick('r360_ppc_probe_reset')();
pick('r360_kernel_import_reset')();
const base=0x80000000,thunk=0x70001234,hi=(thunk>>>16)&0xffff,lo=thunk&0xffff;
const words=[0x3D600000|hi,0x616B0000|lo,0x7D6903A6,0x4E800421,0x38600077,0x4E800020];
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const mem=new Uint8Array(e.memory.buffer);
for(let i=0;i<words.length;i++){
  const w=words[i]>>>0,o=input+i*4;
  mem[o]=w>>>24;mem[o+1]=(w>>>16)&255;mem[o+2]=(w>>>8)&255;mem[o+3]=w&255;
}
if((pick('r360_ppc_probe_set_initial_gpr')(3,1n)>>>0)!==1)throw new Error('set initial r3 failed');
if((pick('r360_kernel_import_register')(thunk,1,0x28,0,0)>>>0)!==1)throw new Error('register HalReturnToFirmware import failed');
if((pick('r360_ppc_probe_load_at')(base,input,words.length*4)>>>0)!==words.length*4)throw new Error('load synthetic caller failed');
const hir=pick('r360_ppc_probe_translate')()>>>0;if(!hir)throw new Error('translate synthetic caller failed');
const status=pick('r360_ppc_probe_correctness_status')()>>>0;
const lastStatus=pick('r360_kernel_import_last_status')()>>>0;
const historyCount=pick('r360_kernel_import_history_count')()>>>0;
const history=Array.from({length:historyCount},(_,i)=>({
  thunk:pick('r360_kernel_import_history_thunk')(i)>>>0,
  module:pick('r360_kernel_import_history_module')(i)>>>0,
  ordinal:pick('r360_kernel_import_history_ordinal')(i)>>>0,
}));
const requested2=pick('r360_kernel_service_firmware_requested')()>>>0;
const routine2=pick('r360_kernel_service_firmware_routine')()>>>0;
if(status!==1||lastStatus!==4||historyCount!==1||history[0].thunk!==thunk||history[0].module!==1||history[0].ordinal!==0x28||requested2!==1||routine2!==1){
  throw new Error(`HalReturnToFirmware import boundary mismatch ${JSON.stringify({status,lastStatus,historyCount,history,requested2,routine2})}`);
}
console.log('HAL_RETURN_TO_FIRMWARE_IMPORT_BOUNDARY=PASS');
console.log('KERNEL_IMPORT_HISTORY_ORDINAL_28=PASS');
console.log('V75_HAL_RETURN_TO_FIRMWARE_REGRESSION=PASS');
