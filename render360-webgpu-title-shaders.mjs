import {translateCapturedXenosShaderToWgsl} from './render360-xenos-shader-runtime.mjs';
import {spirvToWgsl} from './render360-spirv-wgsl-runtime.mjs';

const moduleCache=new WeakMap();

function cacheFor(device){let cache=moduleCache.get(device);if(!cache){cache=new Map();moduleCache.set(device,cache);}return cache;}
async function compilationMessages(module){
  if(typeof module?.getCompilationInfo!=='function')return [];
  const info=await module.getCompilationInfo();
  return Array.from(info?.messages||[],m=>({type:m.type||'info',message:m.message||'',lineNum:m.lineNum||0,linePos:m.linePos||0,offset:m.offset||0,length:m.length||0}));
}
function shaderHash(bootstrap,type){
  const e=bootstrap?.exports,f=n=>e?.[n]??e?.[`_${n}`];
  const hash=typeof f('r360_xenos_shader_hash')==='function'?f('r360_xenos_shader_hash')(type)>>>0:0;
  const dwords=typeof f('r360_xenos_shader_dwords')==='function'?f('r360_xenos_shader_dwords')(type)>>>0:0;
  return `${type}:${hash.toString(16)}:${dwords}`;
}

export async function compileCapturedXenosShaderForWebGPU({device,bootstrap,type,converter=spirvToWgsl}={}){
  if(!device||typeof device.createShaderModule!=='function')throw new TypeError('WebGPU GPUDevice required');
  if(type!==0&&type!==1)throw new RangeError('Xenos shader type must be 0 (vertex) or 1 (pixel)');
  const key=shaderHash(bootstrap,type),cache=cacheFor(device);
  if(cache.has(key))return {...cache.get(key),cached:true};
  const translated=await translateCapturedXenosShaderToWgsl({bootstrap,type,converter});
  if(!translated.wgslTranslated) return {...translated,webgpuAccepted:false,cached:false};
  const module=device.createShaderModule({code:translated.wgsl,label:`Render360 ${type===0?'Xenos VS':'Xenos PS'} ${key}`});
  const messages=await compilationMessages(module);
  const errors=messages.filter(m=>m.type==='error');
  const result={...translated,module,messages,errors,webgpuAccepted:errors.length===0,cached:false,key};
  if(result.webgpuAccepted)cache.set(key,result);
  return result;
}

export async function validateCapturedXenosShadersWebGPU({bootstrap,device=null}={}){
  if(!bootstrap?.exports)throw new TypeError('Xenia bootstrap required');
  let adapter=null;
  if(!device){
    if(!globalThis.navigator?.gpu)return {available:false,reason:'webgpu-unavailable',vertex:null,pixel:null};
    adapter=await navigator.gpu.requestAdapter();
    if(!adapter)return {available:false,reason:'no-webgpu-adapter',vertex:null,pixel:null};
    device=await adapter.requestDevice();
  }
  const vertex=await compileCapturedXenosShaderForWebGPU({device,bootstrap,type:0});
  const pixel=await compileCapturedXenosShaderForWebGPU({device,bootstrap,type:1});
  return {available:true,device,adapter,vertex,pixel,bothAccepted:vertex.webgpuAccepted===true&&pixel.webgpuAccepted===true,acceptedShaders:Number(vertex.webgpuAccepted===true)+Number(pixel.webgpuAccepted===true)};
}

export function titleShaderWebGPUContract(){return {input:'captured Xenos ucode',translation:'Xenia SPIR-V -> Naga WGSL',validation:'GPUDevice.createShaderModule + compilationInfo',cache:'shader hash + dword count',failClosed:true,countsAsRealFrame:false};}
