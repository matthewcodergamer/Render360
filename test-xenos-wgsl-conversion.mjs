import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {pathToFileURL} from 'node:url';
import {translateCapturedXenosShaderToSpirv} from './render360-xenos-shader-runtime.mjs';

const xeniaPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const converterJs=process.argv[3]||'build/spirv-wgsl/render360_spirv_wgsl.js';
const converterWasm=process.argv[4]||'build/spirv-wgsl/render360_spirv_wgsl_bg.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(xeniaPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);
const e=bootstrap.exports,f=n=>e[n]??e[`_${n}`];
for(const n of ['r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit'])if(typeof f(n)!=='function')throw new Error(`missing Xenos export ${n}`);

const converter=await import(pathToFileURL(converterJs).href);
if(typeof converter.default!=='function'||typeof converter.spirv_to_wgsl!=='function')throw new Error('generated Naga converter exports missing');
await converter.default(fs.readFileSync(converterWasm));

const packet3=(opcode,count)=>((3<<30)|(((count-1)&0x3fff)<<16)|((opcode&0x7f)<<8))>>>0;
const terminatingShader=[0x00000001,0x00002000,0x00000000];
const submitShader=type=>{
  const words=[packet3(0x2b,5),type,terminatingShader.length,...terminatingShader];
  f('r360_xenos_reset')();
  const ptr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;
  if(!ptr||words.length>cap)throw new Error('Xenos ring unavailable');
  const ring=new Uint32Array(e.memory.buffer,ptr,cap);ring.fill(0);ring.set(words);
  if((f('r360_xenos_submit')(words.length)>>>0)!==1)throw new Error(`Xenos shader capture failed type=${type}`);
};

for(const type of [0,1]){
  submitShader(type);
  const spirv=translateCapturedXenosShaderToSpirv({bootstrap,type});
  if(!spirv.translated)throw new Error(`Xenia SPIR-V unavailable type=${type}: ${spirv.reason}`);
  const wgsl=converter.spirv_to_wgsl(spirv.bytes);
  if(typeof wgsl!=='string'||!wgsl.trim())throw new Error(`empty WGSL type=${type}`);
  const stage=type===0?'@vertex':'@fragment';
  if(!wgsl.includes(stage))throw new Error(`WGSL type=${type} missing ${stage} entry point`);
  console.log(`${type===0?'XENOS_VERTEX':'XENOS_PIXEL'}_SPIRV_TO_WGSL=PASS`);
}
console.log('XENOS_NAGA_WGSL_VALIDATED=PASS');
console.log('XENOS_WEBGPU_SHADER_TRANSLATION_PATH=PASS');
