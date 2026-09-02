import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`missing bootstrap ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const item of WebAssembly.Module.imports(module)){
  if(item.module==='env'&&item.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const pick=name=>instance.exports[name]??instance.exports[`_${name}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_guest_base','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_blocker_kind','r360_ppc_probe_correctness_blocker_address'];
for(const name of required)if(typeof pick(name)!=='function')throw new Error(`missing export ${name}`);
const wordBytes=(...words)=>Uint8Array.from(words.flatMap(word=>[(word>>>24)&255,(word>>>16)&255,(word>>>8)&255,word&255]));
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const codeBase=pick('r360_ppc_probe_guest_base')()>>>0;
const unmapped=0x70081020;

function run(program,{r3=0,r4=unmapped}={}){
  pick('r360_ppc_probe_reset')();
  if((pick('r360_ppc_probe_set_initial_gpr')(3,BigInt(r3))>>>0)!==1)throw new Error('unable to seed r3');
  if((pick('r360_ppc_probe_set_initial_gpr')(4,BigInt(r4))>>>0)!==1)throw new Error('unable to seed r4');
  new Uint8Array(instance.exports.memory.buffer,input,program.length).set(program);
  if((pick('r360_ppc_probe_load')(input,program.length)>>>0)!==program.length)throw new Error('fixture load failed');
  if((pick('r360_ppc_probe_translate')()>>>0)===0)throw new Error('fixture did not translate');
  const status=pick('r360_ppc_probe_correctness_status')()>>>0;
  const kind=pick('r360_ppc_probe_correctness_blocker_kind')()>>>0;
  const address=pick('r360_ppc_probe_correctness_blocker_address')()>>>0;
  if(status!==1||kind!==5)throw new Error(`real-title sparse miss did not fail closed status=${status} kind=${kind}`);
  if(address!==codeBase)throw new Error(`memory blocker attribution mismatch got=0x${address.toString(16)} expected=0x${codeBase.toString(16)}`);
}

run(wordBytes(0x80640000,0x4E800020)); // lwz r3,0(r4); blr
console.log('HIR_SPARSE_LOAD_FAIL_CLOSED=PASS');
run(wordBytes(0x90640000,0x4E800020),{r3:0x12345678}); // stw r3,0(r4); blr
console.log('HIR_SPARSE_STORE_FAIL_CLOSED=PASS');

const source=fs.readFileSync('src/xenia_web_bootstrap/hir_correctness_executor.cpp','utf8');
for(const token of ['IsSyntheticProbeWindowRange','in_window=%u','!in_probe_window ||'])if(!source.includes(token))throw new Error(`missing fail-closed source contract ${token}`);
console.log('HIR_SPARSE_FAIL_CLOSED=PASS');
