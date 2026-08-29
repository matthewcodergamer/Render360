import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports, f=n=>e[n]??e[`_${n}`];
const required=['r360_ppc_probe_read_guest_u32_be','r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_shader_dwords','r360_xenos_shader_interpreter_reset','r360_xenos_shader_interpreter_analyze','r360_xenos_shader_interpreter_execute','r360_xenos_shader_interpreter_status','r360_xenos_shader_interpreter_ucode_dwords','r360_xenos_shader_interpreter_uses_texture_fetch','r360_xenos_shader_interpreter_execution_count','r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_sparse_guest_memory_unmap','r360_sparse_guest_memory_write_u32_be'];
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

// Real texture shader tier. CF0 executes one fetch at instruction slot 1 and
// ends. The fetch is tfetch2D tf0 -> r1 from r0.xy. r0 is initialized to zero
// by the probe, so this samples texel (0,0). The texture is a 4x4 RGBA8 base
// level with a real 32-pixel Xenos pitch and tiled storage in sparse guest RAM.
// The fetch constant uses 8-in-32 endian conversion and RGBA swizzle.
const cfFetchEnd=[0x00011001,0x00002000,0x00000000];
const tfetch2D=[0x90001001,0x00020688,0x00004002];
const textureShader=[...cfFetchEnd,...tfetch2D];
const textureBase=0x14000000;
f('r360_sparse_guest_memory_reset')();
const backing=f('r360_sparse_guest_memory_alloc')(1)>>>0;
if(!backing||(f('r360_sparse_guest_memory_map')(textureBase,1,backing,0,3)>>>0)!==1)throw new Error('texture shader sparse map failed');
if((f('r360_sparse_guest_memory_write_u32_be')(textureBase,0x10203040)>>>0)!==1)throw new Error('texture shader seed failed');
const rgbaSwizzle=(0|(1<<3)|(2<<6)|(3<<9))>>>0;
const fetchWords=[(0x80000000|(1<<22)|2)>>>0,(textureBase|6|(2<<6))>>>0,(3|(3<<13))>>>0,(rgbaSwizzle<<1)>>>0,0,(1<<9)>>>0];
submit([packet3(0x2d,7),0x00010000,...fetchWords,packet3(0x2b,8),1,textureShader.length,...textureShader]);
f('r360_xenos_shader_interpreter_reset')();
if((f('r360_xenos_shader_interpreter_analyze')(1)>>>0)!==1)throw new Error(`texture shader analyze failed status=0x${(f('r360_xenos_shader_interpreter_status')()>>>0).toString(16)}`);
if((f('r360_xenos_shader_interpreter_uses_texture_fetch')()>>>0)!==1)throw new Error('texture shader analysis did not detect texture fetch');
if((f('r360_xenos_shader_interpreter_execute')(1)>>>0)!==1)throw new Error(`real texture shader execute failed status=0x${(f('r360_xenos_shader_interpreter_status')()>>>0).toString(16)}`);
if((f('r360_xenos_shader_interpreter_status')()>>>0)!==3)throw new Error('real texture shader was not marked executed');
console.log('XENOS_TEXTURE_SHADER_REAL_GUEST_READ=PASS');

// Provenance critic: remove the actual texture mapping while leaving the shader
// and fetch constant intact. Execution MUST fail. A zero-sample/fake texture
// implementation would keep succeeding here and fail this gate.
if((f('r360_sparse_guest_memory_unmap')(textureBase,1)>>>0)!==1)throw new Error('texture shader sparse unmap failed');
if((f('r360_xenos_shader_interpreter_execute')(1)>>>0)!==0)throw new Error('texture shader falsely executed without its guest texture');
if((f('r360_xenos_shader_interpreter_status')()>>>0)!==0xE1000003)throw new Error(`unmapped texture did not surface exact blocker status=0x${(f('r360_xenos_shader_interpreter_status')()>>>0).toString(16)}`);
console.log('XENOS_TEXTURE_SHADER_UNMAPPED_FAIL_CLOSED=PASS');
console.log('XENOS_SHADER_INTERPRETER_FOUNDATION=PASS');

// Keep Xenia's translated-shader accelerator under the same publication gate
// as the interpreter fallback. This second critic instantiates the same exact
// bootstrap and requires valid vertex + pixel SPIR-V modules and fail-closed
// behavior before the full Xenia workflow can publish a browser artifact.
await import('./test-xenos-spirv-translation.mjs');
