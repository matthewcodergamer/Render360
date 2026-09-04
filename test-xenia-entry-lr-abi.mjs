import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const entry of WebAssembly.Module.imports(module)){
  if(entry.module==='env'&&entry.name==='emscripten_notify_memory_growth'){
    imports.env||={};
    imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const e=instance.exports;
const pick=name=>e[name]??e[`_${name}`];
for(const name of ['r360_ppc_probe_reset','r360_ppc_probe_set_initial_lr','r360_ppc_probe_initial_lr']){
  if(typeof pick(name)!=='function')throw new Error(`missing Xenia title-entry LR ABI export ${name}`);
}
pick('r360_ppc_probe_reset')();
const sentinel=0xBCBCBCBCn;
if((pick('r360_ppc_probe_set_initial_lr')(sentinel)>>>0)!==1)throw new Error('initial LR setter rejected Xenia sentinel');
if((pick('r360_ppc_probe_initial_lr')()&0xFFFFFFFFn)!==sentinel)throw new Error('initial LR sentinel did not persist');
pick('r360_ppc_probe_reset')();
if((pick('r360_ppc_probe_initial_lr')()&0xFFFFFFFFn)!==0n)throw new Error('probe reset did not clear initial LR state');
console.log('XENIA_ENTRY_LR_ABI=PASS');
