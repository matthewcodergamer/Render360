import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/kernel-runtime/kernel_runtime.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`kernel runtime WASM not found: ${wasmPath}`);
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(mod,imports);
wasi.initialize(instance);
const e=instance.exports;
const p=n=>e[n]??e[`_${n}`];
const need=n=>{const fn=p(n);if(typeof fn!=='function')throw new Error(`missing process-type fixture export ${n}`);return fn;};

const runtimeReset=need('r360_kernel_runtime_reset');
const serviceReset=need('r360_kernel_service_reset');
const service=need('r360_kernel_service_call');
const serviceStatus=need('r360_kernel_service_status');

const XBOXKRNL=1;
const KE_GET_CURRENT_PROCESS_TYPE=0x0066;
const KE_SET_CURRENT_PROCESS_TYPE=0x009A;
const SERVICE_SUCCESS=1;
const SERVICE_INVALID=3;

runtimeReset();serviceReset();

// Xenia's KernelState starts every title as X_PROCTYPE_USER (1).
const initial=service(XBOXKRNL,KE_GET_CURRENT_PROCESS_TYPE,0,0,0,0,0,0,0,0)>>>0;
if(initial!==1)throw new Error(`KeGetCurrentProcessType default should be USER(1), got ${initial}`);
if((serviceStatus()>>>0)!==SERVICE_SUCCESS)throw new Error(`getter service status ${serviceStatus()>>>0}`);

// Preserve the same stateful behavior as Xenia's KeSetCurrentProcessType.
serviceReset();
const setSystem=service(XBOXKRNL,KE_SET_CURRENT_PROCESS_TYPE,2,0,0,0,0,0,0,0)>>>0;
if(setSystem!==0||(serviceStatus()>>>0)!==SERVICE_SUCCESS)throw new Error('KeSetCurrentProcessType(SYSTEM) failed');
serviceReset();
if((service(XBOXKRNL,KE_GET_CURRENT_PROCESS_TYPE,0,0,0,0,0,0,0,0)>>>0)!==2)throw new Error('process type state did not persist as SYSTEM');

serviceReset();
service(XBOXKRNL,KE_SET_CURRENT_PROCESS_TYPE,0,0,0,0,0,0,0,0);
serviceReset();
if((service(XBOXKRNL,KE_GET_CURRENT_PROCESS_TYPE,0,0,0,0,0,0,0,0)>>>0)!==0)throw new Error('process type state did not persist as IDLE');

// Browser HLE stays fail-closed for an impossible process type instead of
// silently accepting guest corruption. The prior valid value must survive.
serviceReset();
service(XBOXKRNL,KE_SET_CURRENT_PROCESS_TYPE,3,0,0,0,0,0,0,0);
if((serviceStatus()>>>0)!==SERVICE_INVALID)throw new Error('invalid process type did not fail closed');
serviceReset();
if((service(XBOXKRNL,KE_GET_CURRENT_PROCESS_TYPE,0,0,0,0,0,0,0,0)>>>0)!==0)throw new Error('invalid setter mutated process type');

// A full kernel runtime reset starts a fresh title process as USER again.
runtimeReset();serviceReset();
if((service(XBOXKRNL,KE_GET_CURRENT_PROCESS_TYPE,0,0,0,0,0,0,0,0)>>>0)!==1)throw new Error('runtime reset did not restore USER process type');

console.log('XBOXKRNL_ORDINAL_66_KE_GET_CURRENT_PROCESS_TYPE=PASS');
console.log('XBOXKRNL_ORDINAL_9A_KE_SET_CURRENT_PROCESS_TYPE=PASS');
console.log('XENIA_DEFAULT_PROCESS_TYPE_USER=PASS');
console.log('PROCESS_TYPE_STATE_AND_RESET=PASS');
console.log('PROCESS_TYPE_INVALID_FAIL_CLOSED=PASS');
