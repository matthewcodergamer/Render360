export function computePcGraphicsProfile({cssWidth=1280,cssHeight=720,dpr=1,deviceMemory=4,mobile=false}={}){
  const width=Math.max(1,Number(cssWidth)||1),height=Math.max(1,Number(cssHeight)||1),ratio=width/height;
  const memory=Number(deviceMemory)||4;
  const lowMemory=memory<=4;
  const maxSourcePixels=mobile?(lowMemory?960*540:1152*648):1600*900;
  const maxPresentPixels=mobile?(lowMemory?1280*720:1472*828):1920*1080;
  const requestedPixels=width*height*Math.max(1,Number(dpr)||1)**2;
  const sourceScale=Math.min(1,Math.sqrt(maxSourcePixels/(width*height)));
  const presentScale=Math.min(Math.max(1,Number(dpr)||1),Math.sqrt(maxPresentPixels/(width*height)));
  const sourceWidth=Math.max(320,Math.round(width*sourceScale));
  const sourceHeight=Math.max(180,Math.round(sourceWidth/ratio));
  const presentWidth=Math.max(sourceWidth,Math.round(width*presentScale));
  const presentHeight=Math.max(sourceHeight,Math.round(presentWidth/ratio));
  return {mobile,lowMemory,deviceMemory:memory,sourceWidth,sourceHeight,presentWidth,presentHeight,sourceScale:Number(sourceScale.toFixed(3)),presentScale:Number(presentScale.toFixed(3)),targetFps:mobile?30:60,maxSourcePixels,maxPresentPixels,requestedPixels:Math.round(requestedPixels)};
}

function isMobileLike(){return /iPhone|iPad|iPod|Android/i.test(globalThis.navigator?.userAgent||'')||globalThis.matchMedia?.('(pointer: coarse)')?.matches===true;}

function shader(){return `
struct VsOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i:u32)->VsOut {
  var positions=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var uvs=array<vec2f,3>(vec2f(0.0,1.0),vec2f(2.0,1.0),vec2f(0.0,-1.0));
  var out:VsOut;out.position=vec4f(positions[i],0.0,1.0);out.uv=uvs[i];return out;
}
@group(0) @binding(0) var sourceTexture:texture_2d<f32>;
@group(0) @binding(1) var sourceSampler:sampler;
@fragment fn fs(in:VsOut)->@location(0) vec4f { return textureSample(sourceTexture,sourceSampler,in.uv); }
`;}

export async function createPcWebGpuPresenter({visibleCanvas,emitStage=()=>{},deviceMemory=globalThis.navigator?.deviceMemory||4}={}){
  if(!visibleCanvas)throw new Error('PC WebGPU presentation needs the Render360 GPU canvas.');
  if(!globalThis.navigator?.gpu)throw new Error('WebGPU is required for the Portal presentation path.');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No WebGPU adapter is available for Portal.');
  const device=await adapter.requestDevice(),context=visibleCanvas.getContext('webgpu');if(!context)throw new Error('Render360 could not create the WebGPU presentation context.');
  const format=navigator.gpu.getPreferredCanvasFormat();
  const sourceCanvas=document.createElement('canvas');sourceCanvas.className='r360-pc-source-canvas';sourceCanvas.setAttribute('aria-hidden','true');
  sourceCanvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none;z-index:0';
  visibleCanvas.parentElement?.insertBefore(sourceCanvas,visibleCanvas);
  const cssWidth=Math.max(1,visibleCanvas.clientWidth||innerWidth||1280),cssHeight=Math.max(1,visibleCanvas.clientHeight||innerHeight||720);
  const profile=computePcGraphicsProfile({cssWidth,cssHeight,dpr:devicePixelRatio||1,deviceMemory,mobile:isMobileLike()});
  sourceCanvas.width=profile.sourceWidth;sourceCanvas.height=profile.sourceHeight;visibleCanvas.width=profile.presentWidth;visibleCanvas.height=profile.presentHeight;
  context.configure({device,format,alphaMode:'opaque'});
  const module=device.createShaderModule({code:shader()});
  const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});
  const sampler=device.createSampler({magFilter:'linear',minFilter:'linear'});
  let sourceTexture=null,bindGroup=null,lastW=0,lastH=0,raf=0,running=false,frames=0,lastPresented=0;
  function refreshTexture(){const w=Math.max(1,sourceCanvas.width),h=Math.max(1,sourceCanvas.height);if(sourceTexture&&w===lastW&&h===lastH)return;sourceTexture?.destroy?.();lastW=w;lastH=h;sourceTexture=device.createTexture({size:[w,h,1],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:sourceTexture.createView()},{binding:1,resource:sampler}]});}
  function present(now){
    if(!running)return;raf=requestAnimationFrame(present);if(!sourceCanvas.width||!sourceCanvas.height)return;
    const interval=1000/profile.targetFps;if(now-lastPresented<interval*.82)return;lastPresented=now;
    try{
      refreshTexture();device.queue.copyExternalImageToTexture({source:sourceCanvas},{texture:sourceTexture},[sourceCanvas.width,sourceCanvas.height]);
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);frames++;
      if(frames===1)emitStage({stage:'pc-webgpu-first-frame',message:`WebGPU presentation live · ${profile.sourceWidth}×${profile.sourceHeight} → ${profile.presentWidth}×${profile.presentHeight}`,profile});
    }catch(error){emitStage({stage:'pc-webgpu-present-error',message:error?.message||String(error)});}
  }
  emitStage({stage:'pc-webgpu-ready',message:`WebGPU presenter ready · Source ${profile.sourceWidth}×${profile.sourceHeight} · display ${profile.presentWidth}×${profile.presentHeight} · ${profile.targetFps} FPS target`,profile});
  return {kind:'render360-pc-webgpu-presenter',adapter,device,context,format,sourceCanvas,visibleCanvas,profile,start(){if(running)return;running=true;raf=requestAnimationFrame(present);},stop(){running=false;if(raf)cancelAnimationFrame(raf);raf=0;sourceTexture?.destroy?.();sourceTexture=null;try{context.unconfigure?.();}catch{}try{sourceCanvas.remove();}catch{}},descriptor(){return {kind:'webgpu-presentation',format,profile:{...profile},frames};}};
}
