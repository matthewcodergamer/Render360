import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports;const pick=n=>e[n]??e[`_${n}`];
const required=[
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer',
  'r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status',
  'r360_ppc_probe_correctness_r3','r360_kernel_import_reset','r360_kernel_import_register',
  'r360_kernel_import_calls','r360_kernel_import_last_thunk','r360_kernel_import_last_module',
  'r360_kernel_import_last_ordinal','r360_kernel_import_last_status',
  'r360_kernel_service_reset','r360_kernel_service_status','r360_kernel_service_calls',
  'r360_kernel_service_last_module','r360_kernel_service_last_ordinal'
];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`service bridge critic missing export ${n}`);

const base=0x80000000;
const thunk=0x70004321;
const hi=(thunk>>>16)&0xffff,lo=thunk&0xffff;
// lis r11,hi(thunk); ori r11,r11,lo; mtctr r11; bctrl;
// addi r3,r3,1; blr. The +1 proves execution really resumes after HLE.
const words=[0x3D600000|hi,0x616B0000|lo,0x7D6903A6,0x4E800421,0x38630001,0x4E800020];
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
function stage(){
  const m=new Uint8Array(e.memory.buffer);
  for(let i=0;i<words.length;i++){
    const w=words[i]>>>0,o=input+i*4;
    m[o]=w>>>24;m[o+1]=(w>>>16)&255;m[o+2]=(w>>>8)&255;m[o+3]=w&255;
  }
  if((pick('r360_ppc_probe_load_at')(base,input,words.length*4)>>>0)!==words.length*4)throw new Error('service bridge PPC load failed');
}
function run(moduleId,ordinal,r3=0){
  pick('r360_ppc_probe_reset')();pick('r360_kernel_import_reset')();pick('r360_kernel_service_reset')();
  stage();
  if((pick('r360_ppc_probe_set_initial_gpr')(3,BigInt(r3>>>0))>>>0)!==1)throw new Error('service bridge set r3 failed');
  // Deliberately register as unresolved from JS. The runtime itself must detect
  // whether its bounded built-in xboxkrnl/XAM service surface implements it.
  if((pick('r360_kernel_import_register')(thunk,moduleId,ordinal,0,0)>>>0)!==1)throw new Error('service bridge import register failed');
  if(!(pick('r360_ppc_probe_translate')()>>>0))throw new Error('service bridge translation failed');
  return {
    status:pick('r360_ppc_probe_correctness_status')()>>>0,
    r3:Number(pick('r360_ppc_probe_correctness_r3')()),
    importCalls:pick('r360_kernel_import_calls')()>>>0,
    importThunk:pick('r360_kernel_import_last_thunk')()>>>0,
    importModule:pick('r360_kernel_import_last_module')()>>>0,
    importOrdinal:pick('r360_kernel_import_last_ordinal')()>>>0,
    importStatus:pick('r360_kernel_import_last_status')()>>>0,
    serviceCalls:pick('r360_kernel_service_calls')()>>>0,
    serviceModule:pick('r360_kernel_service_last_module')()>>>0,
    serviceOrdinal:pick('r360_kernel_service_last_ordinal')()>>>0,
    serviceStatus:pick('r360_kernel_service_status')()>>>0,
  };
}

// xboxkrnl RtlUpperChar('a') => 'A', then translated caller addi => 'B'.
const upper=run(1,0x014A,'a'.charCodeAt(0));
if(upper.status!==3||upper.r3!=='B'.charCodeAt(0)||upper.importCalls!==1||upper.importThunk!==thunk||
   upper.importModule!==1||upper.importOrdinal!==0x014A||upper.importStatus!==1||
   upper.serviceCalls!==1||upper.serviceModule!==1||upper.serviceOrdinal!==0x014A||upper.serviceStatus!==1){
  throw new Error(`xboxkrnl imported-service bridge mismatch ${JSON.stringify(upper)}`);
}
console.log('KERNEL_IMPORT_SERVICE_XBOXKRNL=PASS');
console.log('KERNEL_IMPORT_SERVICE_R3_RETURN=PASS');
console.log('KERNEL_IMPORT_SERVICE_GUEST_CONTINUATION=PASS');

// XAM XGetLanguage() => 1, then translated caller addi => 2.
const language=run(2,0x03CD,0xDEADBEEF);
if(language.status!==3||language.r3!==2||language.importCalls!==1||language.importModule!==2||
   language.importOrdinal!==0x03CD||language.importStatus!==1||language.serviceCalls!==1||
   language.serviceModule!==2||language.serviceOrdinal!==0x03CD||language.serviceStatus!==1){
  throw new Error(`XAM imported-service bridge mismatch ${JSON.stringify(language)}`);
}
console.log('KERNEL_IMPORT_SERVICE_XAM=PASS');

// An unknown real-title ordinal must still be the exact blocker. The runtime is
// not allowed to turn every import into success just because the module exists.
const unknown=run(1,0xFFFF,0x11223344);
if(unknown.status!==1||unknown.importCalls!==1||unknown.importModule!==1||unknown.importOrdinal!==0xFFFF||
   unknown.importStatus!==2||unknown.serviceCalls!==1||unknown.serviceStatus!==2){
  throw new Error(`unknown imported service did not fail closed ${JSON.stringify(unknown)}`);
}
console.log('KERNEL_IMPORT_SERVICE_UNKNOWN_FAIL_CLOSED=PASS');
console.log('KERNEL_IMPORT_SERVICE_BRIDGE_CRITIC=PASS');
