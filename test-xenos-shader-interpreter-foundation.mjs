import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports, f=n=>e[n]??e[`_${n}`];
const required=['r360_ppc_probe_read_guest_u32_be','r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_shader_dwords','r360_xenos_shader_interpreter_reset','r360_xenos_shader_interpreter_analyze','r360_xenos_shader_interpreter_execute','r360_xenos_shader_interpreter_status','r360_xenos_shader_interpreter_ucode_dwords','r360_xenos_shader_interpreter_uses_texture_fetch','r360_xenos_shader_interpreter_execution_count'];
for(const n of required)if(typeof f(n)!=='function')throw new Error(`missing shader interpreter export ${n}`);

// Ensure the shared Xenia Memory/Processor exists. The shader interpreter is
// intentionally attached to the same runtime memory as real title PPC.
f('r360_ppc_probe_read_guest_u32_be')(0x80000000);

const packet3=(opcode,count)=>((3<<30)|(((count-1)&0x3fff)<<16)|((opcode&0x7f)<<8))>>>0;
const submit=words=>{f('r360_xenos_reset')();const ptr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;if(!ptr||words.length>cap)throw new Error('Xenos ring unavailable');const ring=new Uint32Array(e.memory.buffer,ptr,cap);ring.fill(0);ring.set(words);if((f('r360_xenos_submit')(words.length)>>>0)!==1)throw new Error('Xenos shader capture failed');};

// One control-flow pair whose first instruction is an empty EXEC_END. This is
// valid Xenos microcode and terminates immediately without relying on invented
// shader behavior. Word 1 low 16 bits hold opcode=EXEC_END (2) at bits 12..15.
const terminatingShader=[0x00000001,0x00002000,0x00000000];
for(const type of [0,1]){
  submit([packet3(0x2b,5),type,terminatingShader.length,...terminatingShader]);
  if((f('r360_xenos_shader_dwords')(type)>>>0)!==terminatingShader.length)throw new Error(`captured shader ${type} length mismatch`);
  f('r360_xenos_shader_interpreter_reset')();
  if((f('r360_xenos_shader_interpreter_analyze')(type)>>>0)!==1)throw new Error(`Xenia shader analyze failed type=${type} status=0x${(f('r360_xenos_shader_interpreter_status')()>>>0).toString(16)}`);
  if((f('r360_xenos_shader_interpreter_status')()>>>0)!==2)throw new Error(`shader ${type} was not marked interpretable`);
  if((f('r360_xenos_shader_interpreter_ucode_dwords')()>>>0)!==terminatingShader.length)throw new Error(`shader ${type} ucode telemetry mismatch`);
  if((f('r360_xenos_shader_interpreter_uses_texture_fetch')()>>>0)!==0)throw new Error(`empty shader ${type} unexpectedly uses texture fetch`);
  const before=f('r360_xenos_shader_interpreter_execution_count')()>>>0;
  if((f('r360_xenos_shader_interpreter_execute')(type)>>>0)!==1)throw new Error(`Xenia shader execute failed type=${type} status=0x${(f('r360_xenos_shader_interpreter_status')()>>>0).toString(16)}`);
  if((f('r360_xenos_shader_interpreter_status')()>>>0)!==3)throw new Error(`shader ${type} did not execute`);
  if((f('r360_xenos_shader_interpreter_execution_count')()>>>0)!==before+1)throw new Error(`shader ${type} execution telemetry did not advance`);
}
console.log('XENOS_UPSTREAM_SHADER_ANALYSIS=PASS');
console.log('XENOS_UPSTREAM_VERTEX_SHADER_EXECUTION=PASS');
console.log('XENOS_UPSTREAM_PIXEL_SHADER_EXECUTION=PASS');
console.log('XENOS_SHADER_INTERPRETER_FOUNDATION=PASS');
