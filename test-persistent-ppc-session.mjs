import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {createPersistentPpcSession} from './render360-browser-ppc-session.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`Persistent PPC bootstrap WASM not found: ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const entry of WebAssembly.Module.imports(module)){
  if(entry.module==='env'&&entry.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const bootstrap=instance;
const pick=name=>bootstrap.exports[name]??bootstrap.exports[`_${name}`];
for(const name of ['r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_guest_base']){
  if(typeof pick(name)!=='function')throw new Error(`Missing persistent-session fixture export ${name}`);
}

const wordBytes=(...words)=>Uint8Array.from(words.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const loadAndTranslate=program=>{
  const input=pick('r360_ppc_probe_input_buffer')()>>>0;
  if(program.length>(pick('r360_ppc_probe_input_capacity')()>>>0))throw new Error('PPC session fixture is too large');
  new Uint8Array(bootstrap.exports.memory.buffer,input,program.length).set(program);
  if((pick('r360_ppc_probe_load')(input,program.length)>>>0)!==program.length)throw new Error('Could not load PPC session fixture');
  if(!(pick('r360_ppc_probe_translate')()>>>0))throw new Error('Could not translate PPC session fixture');
};

pick('r360_ppc_probe_reset')();
// addi r3,r3,1 ; blr. The generated function reads and writes Xenia's real
// PPCContext, so invoking it twice without clearing the context must accumulate.
loadAndTranslate(wordBytes(0x38630001,0x4E800020));
const entry=pick('r360_ppc_probe_guest_base')()>>>0;
const session=await createPersistentPpcSession({bootstrap,initialGprs:{3:5n}});
const contextPtr=session.contextPtr;
const first=await session.runFunctionSlice(entry);
const second=await session.runFunctionSlice(entry);
if(first.r3!==6n||second.r3!==7n)throw new Error(`Persistent PPC state did not survive slices: ${first.r3}/${second.r3}`);
if(first.yielded||second.yielded||first.guestReturned!==true||second.guestReturned!==true)throw new Error('Complete callable PPC function was incorrectly reported as a CFG yield');
if(session.contextPtr!==contextPtr||session.sliceCount!==2)throw new Error('Persistent PPC session recreated its architectural context');

// Replace executable bytes with addi r3,r3,2 ; blr. The Xenia executable-page
// generation must invalidate/rebuild the generated module without clearing the
// live architectural context. 7 + 2 => 9 proves state + code generation both
// survived the transition correctly.
const refreshesBefore=session.registryRefreshes;
loadAndTranslate(wordBytes(0x38630002,0x4E800020));
const third=await session.runFunctionSlice(entry);
if(third.r3!==9n)throw new Error(`Generation-aware resume produced r3=${third.r3}, expected 9`);
if(session.registryRefreshes<=refreshesBefore)throw new Error('Executable generation change did not refresh generated function registry');

let failedClosed=false;
try{await session.runFunctionSlice((entry+0x100)>>>0);}catch(error){failedClosed=String(error).includes('FAIL_CLOSED_UNKNOWN_GUEST_TARGET');}
if(!failedClosed)throw new Error('Persistent PPC session did not fail closed on an unknown guest function');
if(session.contract.midFunctionPreemption!==true||
   session.contract.midFunctionPreemptionTier!=='integer-cfg-fallback'||
   session.contract.cfgFuelExhaustionYields!==true||
   session.contract.cfgPerThreadContinuationSlots!==true||
   session.contract.fullXboxThreadScheduler!==false){
  throw new Error('Persistent PPC session does not expose the bounded resumable CFG contract exactly');
}

console.log('PERSISTENT_PPC_CONTEXT_ACROSS_SLICES=PASS');
console.log('PERSISTENT_PPC_GENERATION_REFRESH=PASS');
console.log('PERSISTENT_PPC_UNKNOWN_TARGET_FAIL_CLOSED=PASS');
console.log('PERSISTENT_PPC_CFG_CONTINUATION_CONTRACT=PASS');
console.log('PERSISTENT_PPC_FUNCTION_BOUNDARY_SESSION=PASS');
console.log(`persistent_ppc_context_ptr=0x${contextPtr.toString(16)}`);
console.log(`persistent_ppc_slices=${session.sliceCount}`);
console.log(`persistent_ppc_registry_refreshes=${session.registryRefreshes}`);
