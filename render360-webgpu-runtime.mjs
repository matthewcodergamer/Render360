const EDRAM_BYTES=10*1024*1024;
const DEFAULT_XBOX_MEMORY_PAGES=8192; // 512 MiB maximum, 64 KiB/page.

const gpuUsage=(name,fallback)=>globalThis[name]??fallback;
export const R360_GPU_BUFFER_USAGE=gpuUsage('GPUBufferUsage',{MAP_READ:1,MAP_WRITE:2,COPY_SRC:4,COPY_DST:8,INDEX:16,VERTEX:32,UNIFORM:64,STORAGE:128,INDIRECT:256,QUERY_RESOLVE:512});
export const R360_GPU_TEXTURE_USAGE=gpuUsage('GPUTextureUsage',{COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16});

function assertDevice(device){if(!device||typeof device.createBuffer!=='function')throw new TypeError('WebGPU GPUDevice required');return device;}
function align(value,alignment){return Math.ceil(Number(value)/alignment)*alignment;}
function stableKey(parts){return parts.map(v=>String(v??'')).join('|');}

export function probeWebGPUArchitecture(){
  const nav=globalThis.navigator;
  const isolated=globalThis.crossOriginIsolated===true;
  const shared=typeof globalThis.SharedArrayBuffer==='function'&&isolated;
  return {
    webgpu:!!nav?.gpu,
    crossOriginIsolated:isolated,
    sharedArrayBuffer:shared,
    wasmThreadsReady:shared&&typeof globalThis.Worker==='function',
    opfs:typeof nav?.storage?.getDirectory==='function',
    hardwareConcurrency:Math.max(1,Number(nav?.hardwareConcurrency||1)),
    edramBytes:EDRAM_BYTES,
    xboxMemoryMaximumPages:DEFAULT_XBOX_MEMORY_PAGES,
  };
}

export class AsyncPipelineCache{
  constructor(device){this.device=assertDevice(device);this.render=new Map();this.compute=new Map();this.stats={renderCompiles:0,computeCompiles:0,hits:0,failures:0};}
  async renderPipeline(key,descriptor){
    key=String(key);if(this.render.has(key)){this.stats.hits++;return this.render.get(key);}
    const promise=(async()=>{try{this.stats.renderCompiles++;return typeof this.device.createRenderPipelineAsync==='function'?await this.device.createRenderPipelineAsync(descriptor):this.device.createRenderPipeline(descriptor);}catch(error){this.stats.failures++;this.render.delete(key);throw error;}})();
    this.render.set(key,promise);return promise;
  }
  async computePipeline(key,descriptor){
    key=String(key);if(this.compute.has(key)){this.stats.hits++;return this.compute.get(key);}
    const promise=(async()=>{try{this.stats.computeCompiles++;return typeof this.device.createComputePipelineAsync==='function'?await this.device.createComputePipelineAsync(descriptor):this.device.createComputePipeline(descriptor);}catch(error){this.stats.failures++;this.compute.delete(key);throw error;}})();
    this.compute.set(key,promise);return promise;
  }
  clear(){this.render.clear();this.compute.clear();}
  inspect(){return {...this.stats,renderEntries:this.render.size,computeEntries:this.compute.size};}
}

export class XenosEDRAMMirror{
  constructor(device,{bytes=EDRAM_BYTES,label='Render360 Xenos 10 MiB eDRAM mirror'}={}){
    this.device=assertDevice(device);this.bytes=Number(bytes);if(!Number.isInteger(this.bytes)||this.bytes<=0)throw new RangeError('eDRAM byte size must be positive');
    const max=Number(device.limits?.maxStorageBufferBindingSize||Number.MAX_SAFE_INTEGER);if(this.bytes>max)throw new Error(`WebGPU maxStorageBufferBindingSize ${max} is smaller than eDRAM mirror ${this.bytes}`);
    this.buffer=device.createBuffer({label,size:align(this.bytes,4),usage:R360_GPU_BUFFER_USAGE.STORAGE|R360_GPU_BUFFER_USAGE.COPY_DST|R360_GPU_BUFFER_USAGE.COPY_SRC});
    this.generation=0;this.writes=0;this.bytesWritten=0;
  }
  write(offset,data){
    if(!(data instanceof ArrayBuffer)&&!ArrayBuffer.isView(data))throw new TypeError('eDRAM write requires ArrayBuffer or typed array');
    const view=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);
    offset=Number(offset);if(!Number.isInteger(offset)||offset<0||offset+view.byteLength>this.bytes)throw new RangeError('eDRAM write outside 10 MiB mirror');
    this.device.queue.writeBuffer(this.buffer,offset,view);this.generation++;this.writes++;this.bytesWritten+=view.byteLength;return this.generation;
  }
  destroy(){this.buffer?.destroy?.();}
  inspect(){return {bytes:this.bytes,generation:this.generation,writes:this.writes,bytesWritten:this.bytesWritten};}
}

export class XenosRenderTargetCache{
  constructor(device,{maxEntries=24}={}){this.device=assertDevice(device);this.maxEntries=Math.max(1,Number(maxEntries)||24);this.entries=new Map();this.tick=0;}
  acquire({key,width,height,format='rgba8unorm',sampleCount=1,usage=R360_GPU_TEXTURE_USAGE.RENDER_ATTACHMENT|R360_GPU_TEXTURE_USAGE.TEXTURE_BINDING|R360_GPU_TEXTURE_USAGE.COPY_SRC|R360_GPU_TEXTURE_USAGE.COPY_DST}={}){
    width>>>=0;height>>>=0;if(!width||!height)throw new RangeError('render target dimensions required');key=String(key??stableKey([width,height,format,sampleCount]));
    let entry=this.entries.get(key);if(entry&&(entry.width!==width||entry.height!==height||entry.format!==format||entry.sampleCount!==sampleCount)){entry.texture.destroy?.();this.entries.delete(key);entry=null;}
    if(!entry){const texture=this.device.createTexture({label:`Render360 RT ${key}`,size:{width,height,depthOrArrayLayers:1},format,sampleCount,usage});entry={key,texture,width,height,format,sampleCount,lastUsed:++this.tick,uses:1};this.entries.set(key,entry);this.evict();return {...entry,view:entry.texture.createView()};}
    entry.lastUsed=++this.tick;entry.uses++;return {...entry,view:entry.texture.createView()};
  }
  evict(){if(this.entries.size<=this.maxEntries)return;const victims=[...this.entries.values()].sort((a,b)=>a.lastUsed-b.lastUsed);while(this.entries.size>this.maxEntries&&victims.length){const victim=victims.shift();this.entries.delete(victim.key);victim.texture.destroy?.();}}
  clear(){for(const entry of this.entries.values())entry.texture.destroy?.();this.entries.clear();}
  inspect(){return {entries:this.entries.size,maxEntries:this.maxEntries,targets:[...this.entries.values()].map(({key,width,height,format,sampleCount,uses})=>({key,width,height,format,sampleCount,uses}))};}
}


const LINEAR_EDRAM_RESOLVE_WGSL=`
struct ResolveParams { base_word:u32, width:u32, height:u32, _pad:u32 }
@group(0) @binding(0) var<storage, read> edram_words:array<u32>;
@group(0) @binding(1) var resolve_target:texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params:ResolveParams;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3u){
  if(gid.x>=params.width||gid.y>=params.height){return;}
  let index=params.base_word+gid.y*params.width+gid.x;
  let p=edram_words[index];
  let rgba=vec4f(
    f32((p>>0u)&255u),f32((p>>8u)&255u),f32((p>>16u)&255u),f32((p>>24u)&255u)
  )/255.0;
  textureStore(resolve_target,vec2i(gid.xy),rgba);
}`;

export class XenosEDRAMResolveEngine{
  constructor(device,{edram,pipelineCache,renderTargets}={}){
    this.device=assertDevice(device);this.edram=edram;if(!(edram instanceof XenosEDRAMMirror))throw new TypeError('XenosEDRAMMirror required');
    this.pipelineCache=pipelineCache??new AsyncPipelineCache(device);this.renderTargets=renderTargets??new XenosRenderTargetCache(device);
    this.params=device.createBuffer({label:'Render360 eDRAM resolve params',size:16,usage:R360_GPU_BUFFER_USAGE.UNIFORM|R360_GPU_BUFFER_USAGE.COPY_DST});
    this.resolves=0;this.last=null;
  }
  async resolveLinearRGBA({width,height,baseByteOffset=0,key=null}={}){
    width>>>=0;height>>>=0;baseByteOffset>>>=0;if(!width||!height)throw new RangeError('eDRAM resolve dimensions required');
    if((baseByteOffset&3)!==0)throw new RangeError('eDRAM resolve base must be dword aligned');
    const bytes=width*height*4;if(baseByteOffset+bytes>this.edram.bytes)throw new RangeError('linear eDRAM resolve exceeds 10 MiB mirror');
    const shader=this.device.createShaderModule({label:'Render360 canonical linear eDRAM resolve',code:LINEAR_EDRAM_RESOLVE_WGSL});
    const pipeline=await this.pipelineCache.computePipeline('edram-linear-rgba8-v1',{layout:'auto',compute:{module:shader,entryPoint:'main'}});
    const target=this.renderTargets.acquire({key:key??`edram-linear:${baseByteOffset}:${width}x${height}`,width,height,format:'rgba8unorm',usage:R360_GPU_TEXTURE_USAGE.STORAGE_BINDING|R360_GPU_TEXTURE_USAGE.TEXTURE_BINDING|R360_GPU_TEXTURE_USAGE.RENDER_ATTACHMENT|R360_GPU_TEXTURE_USAGE.COPY_SRC});
    this.device.queue.writeBuffer(this.params,0,new Uint32Array([baseByteOffset>>>2,width,height,0]));
    const bindGroup=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.edram.buffer}},{binding:1,resource:target.view},{binding:2,resource:{buffer:this.params}}]});
    const encoder=this.device.createCommandEncoder({label:'Render360 eDRAM linear resolve'});const pass=encoder.beginComputePass({label:'Render360 eDRAM linear resolve'});pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();this.device.queue.submit([encoder.finish()]);
    this.resolves++;this.last={width,height,baseByteOffset,key:target.key,generation:this.edram.generation};return {...target,resolve:'canonical-linear-rgba8',edramGeneration:this.edram.generation};
  }
  destroy(){this.params?.destroy?.();}
  inspect(){return {resolves:this.resolves,last:this.last,mode:'canonical-linear-rgba8',xenosTiledResolve:false};}
}

export class XenosVertexFetchArena{
  constructor(device,{bytes=16*1024*1024}={}){this.device=assertDevice(device);this.bytes=align(bytes,4);const max=Number(device.limits?.maxStorageBufferBindingSize||Number.MAX_SAFE_INTEGER);if(this.bytes>max)throw new Error(`vertex arena exceeds maxStorageBufferBindingSize ${max}`);this.buffer=device.createBuffer({label:'Render360 Xenos raw vertex fetch arena',size:this.bytes,usage:R360_GPU_BUFFER_USAGE.STORAGE|R360_GPU_BUFFER_USAGE.COPY_DST});this.highWater=0;}
  upload(offset,data){const view=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);offset>>>=0;if(offset+view.byteLength>this.bytes)throw new RangeError('vertex fetch upload outside arena');this.device.queue.writeBuffer(this.buffer,offset,view);this.highWater=Math.max(this.highWater,offset+view.byteLength);return {offset,bytes:view.byteLength};}
  binding(offset=0,size=this.bytes-offset){offset>>>=0;size>>>=0;if(offset+size>this.bytes)throw new RangeError('vertex fetch binding outside arena');return {buffer:this.buffer,offset,size};}
  destroy(){this.buffer?.destroy?.();}
  inspect(){return {bytes:this.bytes,highWater:this.highWater,rawStorageFetch:true};}
}

export function xenosRawVertexFetchWGSL({group=0,binding=0,name='xenos_vertex_words'}={}){
  return `@group(${group}) @binding(${binding}) var<storage, read> ${name}: array<u32>;
fn r360_vertex_u32(byte_offset:u32)->u32 { return ${name}[byte_offset >> 2u]; }
fn r360_vertex_f32(byte_offset:u32)->f32 { return bitcast<f32>(r360_vertex_u32(byte_offset)); }
fn r360_vertex_vec2(byte_offset:u32)->vec2f { return vec2f(r360_vertex_f32(byte_offset), r360_vertex_f32(byte_offset+4u)); }
fn r360_vertex_vec3(byte_offset:u32)->vec3f { return vec3f(r360_vertex_f32(byte_offset), r360_vertex_f32(byte_offset+4u), r360_vertex_f32(byte_offset+8u)); }
fn r360_vertex_vec4(byte_offset:u32)->vec4f { return vec4f(r360_vertex_f32(byte_offset), r360_vertex_f32(byte_offset+4u), r360_vertex_f32(byte_offset+8u), r360_vertex_f32(byte_offset+12u)); }`;
}

export function createXboxSharedMemory({initialPages=256,maximumPages=DEFAULT_XBOX_MEMORY_PAGES,requireIsolation=true}={}){
  const isolated=globalThis.crossOriginIsolated===true;
  if(requireIsolation&&!isolated)throw new Error('Shared Xbox memory requires cross-origin isolation (COOP/COEP)');
  if(typeof globalThis.SharedArrayBuffer!=='function')throw new Error('SharedArrayBuffer unavailable');
  initialPages=Number(initialPages);maximumPages=Number(maximumPages);
  if(!Number.isInteger(initialPages)||!Number.isInteger(maximumPages)||initialPages<1||maximumPages<initialPages||maximumPages>DEFAULT_XBOX_MEMORY_PAGES)throw new RangeError('invalid shared Xbox memory page range');
  return new WebAssembly.Memory({initial:initialPages,maximum:maximumPages,shared:true});
}

export async function createRender360WebGPUFoundation({canvas=null,powerPreference='high-performance',requiredFeatures=[],requiredLimits={}}={}){
  if(!globalThis.navigator?.gpu)throw new Error('WebGPU unavailable');
  const adapter=await globalThis.navigator.gpu.requestAdapter({powerPreference});if(!adapter)throw new Error('No WebGPU adapter available');
  const availableFeatures=new Set(adapter.features?Array.from(adapter.features):[]);const features=requiredFeatures.filter(f=>availableFeatures.has(f));
  const device=await adapter.requestDevice({requiredFeatures:features,requiredLimits});
  const context=canvas?.getContext?.('webgpu')??null;const format=globalThis.navigator.gpu.getPreferredCanvasFormat?.()||'bgra8unorm';
  if(canvas&&!context)throw new Error('Canvas WebGPU context unavailable');if(context)context.configure({device,format,alphaMode:'opaque'});
  const pipelineCache=new AsyncPipelineCache(device),edram=new XenosEDRAMMirror(device),renderTargets=new XenosRenderTargetCache(device),vertexFetch=new XenosVertexFetchArena(device);
  const edramResolve=new XenosEDRAMResolveEngine(device,{edram,pipelineCache,renderTargets});
  const state={lost:false,lostReason:null};device.lost?.then?.(info=>{state.lost=true;state.lostReason=info?.message||info?.reason||'device-lost';}).catch(()=>{});
  return {adapter,device,context,format,pipelineCache,edram,edramResolve,renderTargets,vertexFetch,state,inspect(){return {kind:'render360-webgpu-xenos-foundation',format,features:[...features],limits:{maxStorageBufferBindingSize:Number(device.limits?.maxStorageBufferBindingSize||0),maxBufferSize:Number(device.limits?.maxBufferSize||0)},edram:edram.inspect(),edramResolve:edramResolve.inspect(),renderTargets:renderTargets.inspect(),vertexFetch:vertexFetch.inspect(),pipelines:pipelineCache.inspect(),lost:state.lost,lostReason:state.lostReason,contract:webGPUFoundationContract()};},destroy(){edramResolve.destroy();renderTargets.clear();edram.destroy();vertexFetch.destroy();device.destroy?.();}};
}

const PRESENT_WGSL=`
struct VSOut { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vs_main(@builtin(vertex_index) i:u32)->VSOut {
  var p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var o:VSOut;o.position=vec4f(p[i],0.0,1.0);o.uv=(p[i]+vec2f(1.0))/2.0;return o;
}
@group(0) @binding(0) var frame_tex:texture_2d<f32>;
@group(0) @binding(1) var frame_sampler:sampler;
@fragment fn fs_main(i:VSOut)->@location(0) vec4f { return textureSample(frame_tex,frame_sampler,vec2f(i.uv.x,1.0-i.uv.y)); }
`;

export async function createRgbaFramePresenter(canvas,{foundation=null,filter='nearest'}={}){
  const ownsFoundation=!foundation;foundation??=await createRender360WebGPUFoundation({canvas});if(!foundation.context)throw new Error('WebGPU frame presenter requires canvas context');
  const {device,context,format,pipelineCache}=foundation;const shader=device.createShaderModule({label:'Render360 RGBA frame presenter',code:PRESENT_WGSL});
  const pipeline=await pipelineCache.renderPipeline(`rgba-present:${format}`,{layout:'auto',vertex:{module:shader,entryPoint:'vs_main'},fragment:{module:shader,entryPoint:'fs_main',targets:[{format}]},primitive:{topology:'triangle-list'}});
  const sampler=device.createSampler({magFilter:filter,minFilter:filter});let texture=null,bindGroup=null,width=0,height=0,lastGeneration=-1;
  function ensureTexture(w,h){if(texture&&w===width&&h===height)return;texture?.destroy?.();width=w;height=h;texture=device.createTexture({label:'Render360 title frontbuffer upload',size:{width:w,height:h,depthOrArrayLayers:1},format:'rgba8unorm',usage:R360_GPU_TEXTURE_USAGE.TEXTURE_BINDING|R360_GPU_TEXTURE_USAGE.COPY_DST});bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()},{binding:1,resource:sampler}]});lastGeneration=-1;}
  function present(frame,{scale=1}={}){if(!frame?.rgba||!frame.width||!frame.height)throw new TypeError('RGBA frame required');scale=Math.min(1,Math.max(0.5,Number(scale)||1));const outputWidth=Math.max(1,Math.round((frame.width>>>0)*scale)),outputHeight=Math.max(1,Math.round((frame.height>>>0)*scale));if(canvas.width!==outputWidth)canvas.width=outputWidth;if(canvas.height!==outputHeight)canvas.height=outputHeight;ensureTexture(frame.width>>>0,frame.height>>>0);const generation=Number(frame.generation??0);if(generation!==lastGeneration){device.queue.writeTexture({texture},{data:frame.rgba,bytesPerRow:(frame.width>>>0)*4,rowsPerImage:frame.height>>>0},{width:frame.width>>>0,height:frame.height>>>0,depthOrArrayLayers:1});lastGeneration=generation;}const encoder=device.createCommandEncoder({label:'Render360 frame present'});const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);return {presented:true,backend:'webgpu-real-title-frontbuffer',width:outputWidth,height:outputHeight,sourceWidth:frame.width,sourceHeight:frame.height,resolutionScale:scale,generation,hash:frame.hash??0};}
  return {foundation,present,destroy(){texture?.destroy?.();if(ownsFoundation)foundation.destroy?.();}};
}

export function webGPUFoundationContract(){return {xenosEDRAMMirrorBytes:EDRAM_BYTES,rawVertexStorageFetch:true,renderTargetCache:true,linearEDRAMResolveCompute:true,asyncRenderPipelines:true,asyncComputePipelines:true,adaptivePresentationResolution:true,deviceLossTelemetry:true,sharedMemoryMaximumBytes:DEFAULT_XBOX_MEMORY_PAGES*65536,fullXenosCommandProcessor:false,fullMemexport:false,fullEDRAMResolve:false,countsAsRealFrame:false};}
