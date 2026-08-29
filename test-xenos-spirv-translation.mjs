import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports, f=n=>e[n]??e[`_${n}`];
const required=['r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_shader_dwords','r360_xenos_spirv_reset','r360_xenos_spirv_translate','r360_xenos_spirv_status','r360_xenos_spirv_shader_type','r360_xenos_spirv_ucode_dwords','r360_xenos_spirv_translation_count','r360_xenos_spirv_error_count','r360_xenos_spirv_buffer','r360_xenos_spirv_size','r360_xenos_spirv_word'];
for(const n of required)if(typeof f(n)!=='function')throw new Error(`missing Xenos SPIR-V export ${n}`);

const packet3=(opcode,count)=>((3<<30)|(((count-1)&0x3fff)<<16)|((opcode&0x7f)<<8))>>>0;
const submitShader=(type,words)=>{
  f('r360_xenos_reset')();
  const ptr=f('r360_xenos_ring_buffer')()>>>0, cap=f('r360_xenos_ring_capacity')()>>>0;
  const command=[packet3(0x2b,2+words.length),type>>>0,words.length>>>0,...words.map(v=>v>>>0)];
  if(!ptr||command.length>cap)throw new Error('Xenos ring unavailable for SPIR-V test');
  const ring=new Uint32Array(e.memory.buffer,ptr,cap);ring.fill(0);ring.set(command);
  if((f('r360_xenos_submit')(command.length)>>>0)!==1)throw new Error(`Xenos shader capture failed type=${type}`);
  if((f('r360_xenos_shader_dwords')(type)>>>0)!==words.length)throw new Error(`captured shader length mismatch type=${type}`);
};

// One valid CF pair whose first instruction is an empty EXEC_END. This keeps
// the accelerator gate focused on Xenia's real AnalyzeUcode -> SPIR-V path,
// without inventing shader semantics in the test itself.
const terminatingShader=[0x00000001,0x00002000,0x00000000];
for(const type of [0,1]){
  submitShader(type,terminatingShader);
  const before=f('r360_xenos_spirv_translation_count')()>>>0;
  f('r360_xenos_spirv_reset')();
  if((f('r360_xenos_spirv_translate')(type)>>>0)!==1)throw new Error(`SPIR-V translation failed type=${type} status=0x${(f('r360_xenos_spirv_status')()>>>0).toString(16)} errors=${f('r360_xenos_spirv_error_count')()>>>0}`);
  if((f('r360_xenos_spirv_status')()>>>0)!==1)throw new Error(`SPIR-V status mismatch type=${type}`);
  if((f('r360_xenos_spirv_shader_type')()>>>0)!==type)throw new Error(`SPIR-V shader type mismatch type=${type}`);
  if((f('r360_xenos_spirv_ucode_dwords')()>>>0)!==terminatingShader.length)throw new Error(`SPIR-V ucode telemetry mismatch type=${type}`);
  const size=f('r360_xenos_spirv_size')()>>>0, ptr=f('r360_xenos_spirv_buffer')()>>>0;
  if(!ptr||size<20||(size&3)!==0)throw new Error(`invalid SPIR-V buffer type=${type} ptr=${ptr} size=${size}`);
  if((f('r360_xenos_spirv_word')(0)>>>0)!==0x07230203)throw new Error(`SPIR-V magic mismatch type=${type}`);
  if((f('r360_xenos_spirv_translation_count')()>>>0)!==before+1)throw new Error(`SPIR-V translation counter did not advance type=${type}`);
  if((f('r360_xenos_spirv_error_count')()>>>0)!==0)throw new Error(`SPIR-V translator reported errors type=${type}`);
}
console.log('XENOS_XENIA_VERTEX_TO_SPIRV=PASS');
console.log('XENOS_XENIA_PIXEL_TO_SPIRV=PASS');
console.log('XENOS_SPIRV_MAGIC_AND_BUFFER=PASS');

f('r360_xenos_spirv_reset')();
if((f('r360_xenos_spirv_translate')(2)>>>0)!==0||(f('r360_xenos_spirv_status')()>>>0)!==0xE2000002)throw new Error('invalid shader type did not fail closed');
console.log('XENOS_SPIRV_INVALID_TYPE_FAIL_CLOSED=PASS');
console.log('XENOS_SPIRV_TRANSLATION_FOUNDATION=PASS');

// The same published bootstrap must also prove that Xenia's VdSwap frontbuffer
// fetch can be decoded from real sparse title memory without falling back to
// the bounded software triangle.
await import('./test-xenos-frontbuffer-snapshot.mjs');
