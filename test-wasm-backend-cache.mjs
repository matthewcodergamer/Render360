import fs from 'node:fs';
import { WASI } from 'node:wasi';
import { CompiledGuestFunctionCache } from './wasm-backend-function-cache.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`Cache critic bootstrap WASM not found: ${wasmPath}`);
const parentModule=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(parentModule);
for(const e of WebAssembly.Module.imports(parentModule)){if(e.module==='env'&&e.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}}
const parent=await WebAssembly.instantiate(parentModule,imports);wasi.initialize(parent);
const pick=n=>parent.exports[n]??parent.exports[`_${n}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_guest_base','r360_ppc_probe_correctness_status','r360_wasm_backend_call_status','r360_wasm_backend_call_function_count','r360_wasm_backend_call_function_address','r360_wasm_backend_call_function_generation','r360_wasm_backend_call_module_ptr','r360_wasm_backend_call_module_size','r360_wasm_backend_call_cache_hits','r360_wasm_backend_call_cache_misses','r360_wasm_backend_call_invalidations','r360_wasm_backend_executable_page_generation','r360_wasm_backend_invalidate_executable_range'];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`Missing cache export ${n}`);
const wordBytes=(...w)=>Uint8Array.from(w.flatMap(x=>[x>>>24,(x>>>16)&255,(x>>>8)&255,x&255]));
const direct=wordBytes(0x7CA802A6,0x48000011,0x38630002,0x7CA803A6,0x4E800020,0x38600005,0x4E800020);
const base=pick('r360_ppc_probe_guest_base')()>>>0,input=pick('r360_ppc_probe_input_buffer')()>>>0;
if(direct.length>(pick('r360_ppc_probe_input_capacity')()>>>0))throw new Error('cache probe too large');
function loadOnce(){new Uint8Array(parent.exports.memory.buffer,input,direct.length).set(direct);if((pick('r360_ppc_probe_load')(input,direct.length)>>>0)!==direct.length)throw new Error('cache PPC load failed');}
function translate(){pick('r360_ppc_probe_translate')();if((pick('r360_ppc_probe_correctness_status')()>>>0)!==3)throw new Error('cache Xenia oracle failed');if((pick('r360_wasm_backend_call_status')()>>>0)!==2)throw new Error('cache registry unavailable');}
function topRecord(){const count=pick('r360_wasm_backend_call_function_count')()>>>0;for(let i=0;i<count;i++){const address=pick('r360_wasm_backend_call_function_address')(i)>>>0;if(address===base){const generation=pick('r360_wasm_backend_call_function_generation')(i)>>>0,ptr=pick('r360_wasm_backend_call_module_ptr')(i)>>>0,size=pick('r360_wasm_backend_call_module_size')(i)>>>0;if(!generation||!ptr||size<=8)throw new Error('invalid top cache record');return{generation,bytes:new Uint8Array(parent.exports.memory.buffer,ptr,size).slice()};}}throw new Error('top generated function missing');}

pick('r360_ppc_probe_reset')();loadOnce();translate();
const count1=pick('r360_wasm_backend_call_function_count')()>>>0,misses1=pick('r360_wasm_backend_call_cache_misses')()>>>0,hits1=pick('r360_wasm_backend_call_cache_hits')()>>>0;
if(count1!==2||misses1<2)throw new Error(`initial generated cache population wrong count=${count1} misses=${misses1}`);
const first=topRecord();const pageGen1=pick('r360_wasm_backend_executable_page_generation')(base)>>>0;if(first.generation!==pageGen1)throw new Error('module/page generation mismatch');
const compiled=new CompiledGuestFunctionCache();const m1=await compiled.getOrCompile(base,first.generation,first.bytes);const m1Again=await compiled.getOrCompile(base,first.generation,first.bytes);if(m1!==m1Again||compiled.hits!==1||compiled.misses!==1)throw new Error('browser WebAssembly.Module cache did not reuse compiled module');

translate();
const count2=pick('r360_wasm_backend_call_function_count')()>>>0,hits2=pick('r360_wasm_backend_call_cache_hits')()>>>0,misses2=pick('r360_wasm_backend_call_cache_misses')()>>>0;
if(count2!==count1||hits2<=hits1||misses2!==misses1)throw new Error(`unchanged executable code did not hit cache count=${count2} hits=${hits2} misses=${misses2}`);

pick('r360_wasm_backend_invalidate_executable_range')(base,direct.length);
const pageGen2=pick('r360_wasm_backend_executable_page_generation')(base)>>>0;if(pageGen2===pageGen1)throw new Error('executable page generation did not advance');
if((pick('r360_wasm_backend_call_function_count')()>>>0)!==0)throw new Error('stale generated functions survived executable invalidation');
if((pick('r360_wasm_backend_call_invalidations')()>>>0)<2)throw new Error('invalidation telemetry did not record load + explicit mutation');
if(compiled.invalidateRange(base,direct.length)!==1||compiled.lookup(base,first.generation)!==null)throw new Error('browser compiled cache kept stale module');

translate();const second=topRecord();if(second.generation!==pageGen2||second.generation===first.generation)throw new Error('retranslated generated function did not use new code generation');
const m2=await compiled.getOrCompile(base,second.generation,second.bytes);if(m2===m1)throw new Error('compiled cache reused stale WebAssembly.Module after invalidation');
if(compiled.lookup((base+0x4000)>>>0,1)!==null)throw new Error('unknown compiled guest target did not fail closed');

console.log(`wasm_cache_initial_functions=${count1}`);
console.log(`wasm_cache_hits=${pick('r360_wasm_backend_call_cache_hits')()>>>0}`);
console.log(`wasm_cache_misses=${pick('r360_wasm_backend_call_cache_misses')()>>>0}`);
console.log(`wasm_cache_invalidations=${pick('r360_wasm_backend_call_invalidations')()>>>0}`);
console.log(`wasm_cache_generation_before=${pageGen1}`);
console.log(`wasm_cache_generation_after=${pageGen2}`);
console.log(`browser_compiled_cache_hits=${compiled.hits}`);
console.log(`browser_compiled_cache_misses=${compiled.misses}`);
console.log('WASM_BACKEND_CACHE_ADDRESS_VERSION=PASS');
console.log('WASM_BACKEND_COMPILED_MODULE_REUSE=PASS');
console.log('WASM_BACKEND_EXECUTABLE_INVALIDATION=PASS');
console.log('WASM_BACKEND_STALE_TARGET_FAIL_CLOSED=PASS');
console.log('WASM_BACKEND_STAGE=CACHE_INVALIDATION_PASS');
