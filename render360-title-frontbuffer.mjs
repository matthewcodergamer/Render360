const pick=(e,n)=>e?.[n]??e?.[`_${n}`];
const STATUS_NAMES={
  0:'idle',1:'ready',
  0xE3000001:'no-xe-swap',
  0xE3000002:'unsupported-frontbuffer-format',
  0xE3000003:'invalid-frontbuffer-fetch',
  0xE3000004:'frontbuffer-memory-unmapped',
  0xE3000005:'frontbuffer-dimension-mismatch',
  0xE3000006:'unsupported-frontbuffer-layout',
  0xE3000007:'frontbuffer-too-large',
};

const SNAPSHOT_EXPORTS=[
  'r360_xenos_frontbuffer_snapshot_capture',
  'r360_xenos_frontbuffer_snapshot_status',
  'r360_xenos_frontbuffer_snapshot_buffer',
  'r360_xenos_frontbuffer_snapshot_size',
  'r360_xenos_frontbuffer_snapshot_width',
  'r360_xenos_frontbuffer_snapshot_height',
  'r360_xenos_frontbuffer_snapshot_hash',
  'r360_xenos_frontbuffer_snapshot_generation',
  'r360_xenos_frontbuffer_snapshot_format',
  'r360_xenos_frontbuffer_snapshot_tiled',
  'r360_xenos_frontbuffer_snapshot_pitch',
  'r360_xenos_frontbuffer_snapshot_source_address',
  'r360_xenos_frontbuffer_snapshot_source_bytes',
];

export function hasTitleFrontbufferSnapshot(bootstrap){
  const e=bootstrap?.exports;
  return !!e&&!!e.memory&&SNAPSHOT_EXPORTS.every(n=>typeof pick(e,n)==='function');
}

export function captureTitleFrontbuffer({bootstrap}={}){
  if(!bootstrap?.exports)throw new TypeError('Xenia bootstrap required');
  if(!hasTitleFrontbufferSnapshot(bootstrap))return {available:false,captured:false,realTitleFrameReady:false,reason:'frontbuffer-snapshot-not-exported'};
  const e=bootstrap.exports,f=n=>pick(e,n);
  const ok=(f('r360_xenos_frontbuffer_snapshot_capture')()>>>0)===1;
  const status=f('r360_xenos_frontbuffer_snapshot_status')()>>>0;
  const reason=STATUS_NAMES[status]||`frontbuffer-status-0x${status.toString(16)}`;
  if(!ok)return {available:true,captured:false,realTitleFrameReady:false,status,reason};
  const ptr=f('r360_xenos_frontbuffer_snapshot_buffer')()>>>0;
  const size=f('r360_xenos_frontbuffer_snapshot_size')()>>>0;
  const width=f('r360_xenos_frontbuffer_snapshot_width')()>>>0;
  const height=f('r360_xenos_frontbuffer_snapshot_height')()>>>0;
  if(!ptr||!width||!height||size!==width*height*4)throw new Error(`invalid real title frontbuffer snapshot ptr=${ptr} size=${size} dimensions=${width}x${height}`);
  if(ptr+size>e.memory.buffer.byteLength)throw new RangeError('real title frontbuffer snapshot exceeds WASM memory');
  const rgba=new Uint8Array(e.memory.buffer,ptr,size).slice();
  return {
    available:true,captured:true,realTitleFrameReady:true,status,reason,
    ptr,size,width,height,rgba,
    hash:f('r360_xenos_frontbuffer_snapshot_hash')()>>>0,
    generation:f('r360_xenos_frontbuffer_snapshot_generation')()>>>0,
    format:f('r360_xenos_frontbuffer_snapshot_format')()>>>0,
    tiled:(f('r360_xenos_frontbuffer_snapshot_tiled')()>>>0)===1,
    pitchPixels:f('r360_xenos_frontbuffer_snapshot_pitch')()>>>0,
    sourceAddress:f('r360_xenos_frontbuffer_snapshot_source_address')()>>>0,
    sourceBytes:f('r360_xenos_frontbuffer_snapshot_source_bytes')()>>>0,
    provenance:'real Xenos VdSwap fetch constant -> mapped sparse Xbox memory -> Xenos linear/tiled decode',
  };
}

export function ensureTitleFrameCanvas(){
  if(typeof document==='undefined')return null;
  let canvas=document.getElementById('titleFrameCanvas');
  if(canvas)return canvas;
  canvas=document.createElement('canvas');
  canvas.id='titleFrameCanvas';
  canvas.setAttribute('aria-label','Render360 real Xbox 360 title framebuffer');
  Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'none',zIndex:'3',pointerEvents:'none',background:'#000'});
  const gpu=document.getElementById('gpuCanvas');
  if(gpu?.parentNode)gpu.parentNode.insertBefore(canvas,gpu.nextSibling);
  else document.getElementById('app')?.prepend(canvas);
  return canvas;
}

export function ensureTitleWebGPUCanvas(){
  if(typeof document==='undefined')return null;
  let canvas=document.getElementById('titleFrameWebGPUCanvas');
  if(canvas)return canvas;
  canvas=document.createElement('canvas');
  canvas.id='titleFrameWebGPUCanvas';
  canvas.setAttribute('aria-label','Render360 WebGPU Xbox 360 title framebuffer');
  Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'none',zIndex:'4',pointerEvents:'none',background:'#000'});
  const gpu=document.getElementById('gpuCanvas');
  if(gpu?.parentNode)gpu.parentNode.insertBefore(canvas,gpu.nextSibling);
  else document.getElementById('app')?.prepend(canvas);
  return canvas;
}

export function showTitleWebGPUCanvas(frame,{canvas=ensureTitleWebGPUCanvas(),resolutionScale=1}={}){
  if(!canvas)throw new Error('WebGPU title framebuffer canvas unavailable');
  const scale=Math.min(1,Math.max(0.5,Number(resolutionScale)||1));
  const outputWidth=frame?.width?Math.max(1,Math.round(frame.width*scale)):0;
  const outputHeight=frame?.height?Math.max(1,Math.round(frame.height*scale)):0;
  if(outputWidth&&canvas.width!==outputWidth)canvas.width=outputWidth;
  if(outputHeight&&canvas.height!==outputHeight)canvas.height=outputHeight;
  canvas.dataset.render360ResolutionScale=String(scale);
  canvas.style.display='block';
  const fallback=typeof document!=='undefined'?document.getElementById('titleFrameCanvas'):null;
  if(fallback)fallback.style.display='none';
  if(frame?.generation!==undefined)canvas.dataset.render360Generation=String(frame.generation>>>0);
  if(frame?.hash!==undefined)canvas.dataset.render360Hash=`0x${(frame.hash>>>0).toString(16)}`;
  return canvas;
}

export function presentTitleFrontbuffer(frame,{canvas=ensureTitleFrameCanvas()}={}){
  if(!frame?.captured||!frame.rgba)throw new TypeError('captured real title frontbuffer required');
  if(!canvas)throw new Error('title framebuffer canvas unavailable');
  if(canvas.width!==frame.width)canvas.width=frame.width;
  if(canvas.height!==frame.height)canvas.height=frame.height;
  const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
  if(!ctx)throw new Error('2D title framebuffer context unavailable');
  const clamped=new Uint8ClampedArray(frame.rgba.buffer,frame.rgba.byteOffset,frame.rgba.byteLength);
  ctx.putImageData(new ImageData(clamped,frame.width,frame.height),0,0);
  canvas.style.display='block';
  const webgpu=typeof document!=='undefined'?document.getElementById('titleFrameWebGPUCanvas'):null;
  if(webgpu)webgpu.style.display='none';
  canvas.dataset.render360Generation=String(frame.generation>>>0);
  canvas.dataset.render360Hash=`0x${(frame.hash>>>0).toString(16)}`;
  return {presented:true,backend:'canvas2d-real-title-frontbuffer',width:frame.width,height:frame.height,generation:frame.generation,hash:frame.hash};
}

export function hideTitleFrontbuffer(){
  if(typeof document==='undefined')return;
  for(const id of ['titleFrameCanvas','titleFrameWebGPUCanvas']){const canvas=document.getElementById(id);if(canvas)canvas.style.display='none';}
}

export function titleFrontbufferContract(){
  return {source:'VdSwap fetch constant 0 + sparse guest memory',formats:['8_8_8_8','2_10_10_10_AS_16_16_16_16'],layouts:['linear','Xenos tiled 2D'],swizzle:true,endian:true,presenters:['WebGPU','Canvas2D fallback'],syntheticRasterAccepted:false,countsAsRealTitleFrame:true};
}
