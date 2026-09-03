import assert from 'node:assert/strict';
import {
  AsyncPipelineCache,
  XenosEDRAMMirror,
  XenosEDRAMResolveEngine,
  XenosRenderTargetCache,
  XenosVertexFetchArena,
  createRgbaFramePresenter,
  createXboxSharedMemory,
  probeWebGPUArchitecture,
  webGPUFoundationContract,
  xenosRawVertexFetchWGSL,
} from './render360-webgpu-runtime.mjs';
import {BlockCachedRangeSource,createBlobRangeSource,streamingSourceContract} from './render360-streaming-source.mjs';
import {browserThreadingCapabilities,workerPoolContract,xenonWorkerPlan} from './render360-web-worker-pool.mjs';
import {createXenosWebGPUPresenter,xenosFrameView} from './render360-webgpu-xenos.mjs';

let renderCompiles=0,computeCompiles=0,bufferWrites=0,textureWrites=0,textureCreates=0,submits=0,dispatches=0,draws=0;
const queue={
  writeBuffer(){bufferWrites++;},
  writeTexture(){textureWrites++;},
  submit(){submits++;},
};
const device={
  queue,
  limits:{maxStorageBufferBindingSize:128*1024*1024,maxBufferSize:256*1024*1024},
  createBuffer(desc){return {desc,destroyed:false,destroy(){this.destroyed=true;}};},
  createTexture(desc){textureCreates++;return {desc,destroyed:false,createView(){return {texture:this};},destroy(){this.destroyed=true;}};},
  createShaderModule(desc){return {desc};},
  async createRenderPipelineAsync(desc){renderCompiles++;await Promise.resolve();return {desc,getBindGroupLayout(){return {kind:'render-layout'};}};},
  createRenderPipeline(desc){renderCompiles++;return {desc,getBindGroupLayout(){return {kind:'render-layout'};}};},
  async createComputePipelineAsync(desc){computeCompiles++;await Promise.resolve();return {desc,getBindGroupLayout(){return {kind:'compute-layout'};}};},
  createComputePipeline(desc){computeCompiles++;return {desc,getBindGroupLayout(){return {kind:'compute-layout'};}};},
  createBindGroup(desc){return {desc};},
  createSampler(desc){return {desc};},
  createCommandEncoder(){return {
    beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(){dispatches++;},end(){}};},
    beginRenderPass(){return {setPipeline(){},setBindGroup(){},draw(){draws++;},end(){}};},
    finish(){return {};},
  };},
};

const cache=new AsyncPipelineCache(device);
const descriptor={layout:'auto'};
const [rp1,rp2]=await Promise.all([cache.renderPipeline('same',descriptor),cache.renderPipeline('same',descriptor)]);
assert.equal(rp1,rp2);
assert.equal(renderCompiles,1,'render pipeline cache must de-duplicate in-flight async compilation');
await Promise.all([cache.computePipeline('same',descriptor),cache.computePipeline('same',descriptor)]);
assert.equal(computeCompiles,1,'compute pipeline cache must de-duplicate in-flight async compilation');
assert.ok(cache.inspect().hits>=2);

const edram=new XenosEDRAMMirror(device);
assert.equal(edram.bytes,10*1024*1024);
edram.write(4,new Uint8Array([1,2,3,4]));
assert.equal(edram.inspect().bytesWritten,4);
assert.throws(()=>edram.write(edram.bytes-1,new Uint8Array(4)),/outside/);

const targets=new XenosRenderTargetCache(device,{maxEntries:2});
const a1=targets.acquire({key:'a',width:64,height:64});
const a2=targets.acquire({key:'a',width:64,height:64});
assert.equal(a1.texture,a2.texture,'same render target key/dimensions must reuse texture');
targets.acquire({key:'b',width:32,height:32});
targets.acquire({key:'a',width:64,height:64});
targets.acquire({key:'c',width:16,height:16});
assert.equal(targets.inspect().entries,2,'render target cache must enforce max entries');
assert.ok(targets.entries.has('a'),'recently reused target should survive LRU eviction');

const vertex=new XenosVertexFetchArena(device,{bytes:4096});
vertex.upload(16,new Uint8Array(32));
assert.equal(vertex.inspect().highWater,48);
assert.equal(vertex.binding(16,32).size,32);
assert.match(xenosRawVertexFetchWGSL(),/var<storage, read>/);
assert.match(xenosRawVertexFetchWGSL(),/r360_vertex_vec4/);

const resolve=new XenosEDRAMResolveEngine(device,{edram,pipelineCache:cache,renderTargets:targets});
const resolved=await resolve.resolveLinearRGBA({width:8,height:8,baseByteOffset:0,key:'resolve'});
assert.equal(resolved.resolve,'canonical-linear-rgba8');
assert.equal(resolve.inspect().resolves,1);
assert.ok(dispatches>=1&&submits>=1&&bufferWrites>=2,'compute eDRAM resolve must encode and submit work');

const sourceBytes=Uint8Array.from({length:64},(_,i)=>i);
const blobSource=createBlobRangeSource(new Blob([sourceBytes]));
const ranged=new BlockCachedRangeSource(blobSource,{blockBytes:16,maxBlocks:2});
assert.deepEqual([...await ranged.read(14,8)],[14,15,16,17,18,19,20,21]);
const before=ranged.inspect();
assert.deepEqual([...await ranged.read(15,2)],[15,16]);
const after=ranged.inspect();
assert.ok(after.hits>before.hits,'second overlapping read should hit cached blocks');
assert.equal(streamingSourceContract().wholeGameBufferRequired,false);

const architecture=probeWebGPUArchitecture();
assert.equal(architecture.edramBytes,10*1024*1024);
assert.equal(webGPUFoundationContract().fullXenosCommandProcessor,false);
assert.equal(webGPUFoundationContract().linearEDRAMResolveCompute,true);
assert.equal(workerPoolContract().fullXenonSmtScheduler,false);
assert.equal(xenonWorkerPlan().guestLogicalThreads,6);
assert.equal(typeof browserThreadingCapabilities().ready,'boolean');

if(typeof SharedArrayBuffer==='function'){
  const memory=createXboxSharedMemory({initialPages:1,maximumPages:2,requireIsolation:false});
  assert.ok(memory instanceof WebAssembly.Memory);
  assert.ok(memory.buffer instanceof SharedArrayBuffer);
}

const wasmMemory=new WebAssembly.Memory({initial:1});
const framePtr=64,width=2,height=2,size=16;
new Uint8Array(wasmMemory.buffer,framePtr,size).set(Uint8Array.from({length:size},(_,i)=>i));
const exports={memory:wasmMemory,
  r360_xenos_frame_buffer:()=>framePtr,r360_xenos_frame_size:()=>size,
  r360_xenos_frame_width:()=>width,r360_xenos_frame_height:()=>height,
  r360_xenos_frame_generation:()=>7};
const frame=xenosFrameView({exports});
assert.equal(frame.generation,7);assert.deepEqual([...frame.rgba.slice(0,4)],[0,1,2,3]);

const context={configure(){},getCurrentTexture(){return {createView(){return {kind:'swap-view'};}};}};
const foundation={device,context,format:'bgra8unorm',pipelineCache:cache,state:{lost:false},inspect(){return {mock:true};},destroy(){throw new Error('shared foundation must not be destroyed by presenter');}};
const rgbaPresenter=await createRgbaFramePresenter({width:2,height:2},{foundation});
const textureWritesBefore=textureWrites;
const rgbaResult=rgbaPresenter.present({...frame,hash:0x1234});
assert.equal(rgbaResult.backend,'webgpu-real-title-frontbuffer');
rgbaPresenter.present({...frame,hash:0x1234});
assert.equal(textureWrites,textureWritesBefore+1,'RGBA presenter must not re-upload an unchanged generation');
rgbaPresenter.destroy();

const xenosPresenter=await createXenosWebGPUPresenter({},{exports},{foundation});
const xenosWritesBefore=textureWrites;
xenosPresenter.present();xenosPresenter.present();
assert.equal(textureWrites,xenosWritesBefore+1,'Xenos presenter must generation-cache WebGPU uploads');
assert.ok(draws>=4,'WebGPU presenters must encode real draw passes');
xenosPresenter.destroy();

console.log('WEBGPU_ASYNC_PIPELINE_CACHE=PASS');
console.log('XENOS_EDRAM_10MIB_MIRROR=PASS');
console.log('XENOS_LINEAR_EDRAM_COMPUTE_RESOLVE=PASS');
console.log('XENOS_RAW_STORAGE_VERTEX_FETCH=PASS');
console.log('XENOS_RENDER_TARGET_CACHE=PASS');
console.log('RANGE_STREAMING_SOURCE=PASS');
console.log('SHARED_MEMORY_WORKER_FOUNDATION=PASS');
console.log('WEBGPU_REAL_FRONTBUFFER_PRESENTER=PASS');
console.log('WEBGPU_BROWSER_RUNTIME_FOUNDATION=PASS');
