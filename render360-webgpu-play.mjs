// Render360 WebGPU play path: the core records draws, textures and resolves
// for render360-webgpu-backend.mjs (Xenia's Vulkan backend ported to
// WebGPU) and the software renderer does no work; each frame the stream is
// replayed and the swapped front buffer is drawn to the canvas.
//
// Opt-in while it is verified against the software renderer: `?gpu=xenos`
// in the page URL, or config.renderer === 'webgpu-xenos'.
import {XenosWebGpuBackend} from './render360-webgpu-backend.mjs';

export function webGpuPlayPathRequested(config){
  if(config?.renderer==='webgpu-xenos')return true;
  try{return new URLSearchParams(globalThis.location?.search||'').get('gpu')==='xenos';}catch{return false;}
}

export async function createXenosWebGpuPlayPath(bootstrap,canvas){
  const e=bootstrap.exports;
  if(typeof e.r360_gpu_set_mode!=='function')throw new Error('core has no WebGPU recorder');
  const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new Error('no WebGPU adapter');
  globalThis.render360GpuAdapterInfo={vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,device:adapter.info?.device,description:adapter.info?.description};
  const device=await adapter.requestDevice({
    requiredFeatures:['float32-filterable'].filter(f=>adapter.features.has(f)),
    requiredLimits:{maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}});
  const context=canvas.getContext('webgpu');
  const format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'opaque'});
  const backend=await new XenosWebGpuBackend(device,e).init();
  let lost=null,gpuMs=null,pendingGpu=false;
  device.lost.then(info=>{lost=info?.message||'device lost';});
  e.r360_gpu_set_mode(1);
  e.r360_xenos_soft_set_rasterize?.(0);
  // Replays at least this often (loading screens can go long without swaps;
  // the stream holds uploaded pages until it is replayed).
  const maxPendingWords=4*1024*1024;
  return {
    backend,
    get lost(){return lost;},
    slice(){if(!lost&&(e.r360_gpu_stream_words()>>>0)>maxPendingWords)backend.replay();},
    // Submit-to-completion time of the last frame's GPU work (ms), once.
    takeGpuMs(){const ms=gpuMs;gpuMs=null;return ms;},
    frame(){
      if(lost)return false;
      const t0=performance.now();
      backend.replay();
      const front=backend.frontTexture;
      if(front&&(canvas.width!==front.width||canvas.height!==front.height)){canvas.width=front.width;canvas.height=front.height;}
      canvas.style.display='block';
      const presented=backend.present(context,format);
      if(!pendingGpu){
        pendingGpu=true;
        device.queue.onSubmittedWorkDone().then(()=>{gpuMs=performance.now()-t0;pendingGpu=false;},()=>{pendingGpu=false;});
      }
      return presented;
    },
    destroy(){
      e.r360_gpu_set_mode(0);
      e.r360_xenos_soft_set_rasterize?.(1);
      try{device.destroy();}catch{}
    },
  };
}
