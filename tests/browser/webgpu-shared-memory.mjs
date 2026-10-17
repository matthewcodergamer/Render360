// Browser side of test-webgpu-shared-memory-browser.mjs: the core records
// shared memory uploads, the WebGPU backend replays them, and the GPU buffer
// read back matches guest memory, including after a CPU write that
// invalidates one page.
import {createRender360BrowserImports,attachRender360BrowserInstance} from '../../render360-browser-wasi.mjs';
import {XenosWebGpuBackend} from '../../render360-webgpu-backend.mjs';

export default async function run(wasmPath){
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)return {ok:false,error:'no WebGPU adapter'};
  const device=await adapter.requestDevice({requiredLimits:{
    maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}});
  const host=createRender360BrowserImports();
  const module=await WebAssembly.compileStreaming(fetch(wasmPath));
  const instance=attachRender360BrowserInstance(host,await WebAssembly.instantiate(module,host.imports));
  const e=instance.exports;
  const backend=new XenosWebGpuBackend(device,e);

  const PAGE=4096,BASE=0x00100000;
  e.r360_sparse_guest_memory_reset();
  const backing=e.r360_sparse_guest_memory_alloc(4);
  e.r360_sparse_guest_memory_map(BASE,4,backing,0,3);
  for(let p=0;p<4;p++)for(let w=0;w<PAGE/4;w+=97)e.r360_sparse_guest_memory_write_u32_be(BASE+p*PAGE+w*4,(p<<24|w)>>>0);
  e.r360_gpu_shared_memory_clear();

  // Expected bytes: the words written above, big-endian, zero elsewhere.
  const expected=()=>{
    const out=new Uint8Array(4*PAGE);
    for(let p=0;p<4;p++)for(let w=0;w<PAGE/4;w+=97){const v=(p<<24|w)>>>0,o=p*PAGE+w*4;out[o]=v>>>24;out[o+1]=v>>>16&255;out[o+2]=v>>>8&255;out[o+3]=v&255;}
    return out;
  };
  const want=expected();
  const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);

  e.r360_gpu_shared_memory_request(BASE,4*PAGE);
  backend.replay();
  const first=await backend.readSharedMemory(BASE,4*PAGE);
  if(!same(first,want))return {ok:false,error:'shared memory differs from guest memory after the first upload'};

  e.r360_sparse_guest_memory_write_u32_be(BASE+PAGE+8,0xCAFEF00D);
  want.set([0xCA,0xFE,0xF0,0x0D],PAGE+8);
  const uploadsBefore=backend.stats.uploads;
  e.r360_gpu_shared_memory_request(BASE,4*PAGE);
  backend.replay();
  const second=await backend.readSharedMemory(BASE,4*PAGE);
  if(!same(second,want))return {ok:false,error:'shared memory differs after the CPU write'};
  return {ok:true,uploads:backend.stats.uploads,secondUploads:backend.stats.uploads-uploadsBefore,
    uploadedBytes:backend.stats.uploadedBytes,sharedMemoryMiB:backend.sharedMemoryBytes/1048576,
    adapter:adapter.info?.architecture||''};
}
