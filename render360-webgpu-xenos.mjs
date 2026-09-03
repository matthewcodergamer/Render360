import {createRender360WebGPUFoundation,R360_GPU_TEXTURE_USAGE} from './render360-webgpu-runtime.mjs';

export const R360_XENOS_WGSL = `
struct VSOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(@builtin(vertex_index) i:u32)->VSOut {
  var p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var o:VSOut; o.position=vec4f(p[i],0.0,1.0); o.uv=(p[i]+vec2f(1.0))/2.0; return o;
}
@group(0) @binding(0) var xenos_frame:texture_2d<f32>;
@group(0) @binding(1) var xenos_sampler:sampler;
@fragment fn fs_main(i:VSOut)->@location(0) vec4f {
  return textureSample(xenos_frame,xenos_sampler,vec2f(i.uv.x,1.0-i.uv.y));
}`;

export function xenosFrameView(instance) {
  const e=instance.exports; const f=n=>e[n]??e[`_${n}`];
  const ptr=f('r360_xenos_frame_buffer')()>>>0, size=f('r360_xenos_frame_size')()>>>0;
  const width=f('r360_xenos_frame_width')()>>>0, height=f('r360_xenos_frame_height')()>>>0;
  if (!ptr || !width || !height || size!==width*height*4) throw new Error('invalid Xenos frame export');
  if(ptr+size>e.memory.buffer.byteLength)throw new RangeError('Xenos frame export exceeds WASM memory');
  return {ptr,size,width,height,generation:f('r360_xenos_frame_generation')()>>>0,
    rgba:new Uint8Array(e.memory.buffer,ptr,size)};
}

export async function createXenosWebGPUPresenter(canvas, instance,{foundation=null,filter='nearest'}={}) {
  const ownsFoundation=!foundation;foundation??=await createRender360WebGPUFoundation({canvas,powerPreference:'high-performance'});
  const {device,context,format,pipelineCache}=foundation;if(!context)throw new Error('Xenos presenter requires a WebGPU canvas context');
  const shader=device.createShaderModule({label:'Render360 Xenos present shader',code:R360_XENOS_WGSL});
  const pipeline=await pipelineCache.renderPipeline(`xenos-present:${format}`,{layout:'auto',vertex:{module:shader,entryPoint:'vs_main'},fragment:{module:shader,entryPoint:'fs_main',targets:[{format}]},primitive:{topology:'triangle-list'}});
  const sampler=device.createSampler({magFilter:filter,minFilter:filter});
  let texture=null,bindGroup=null,lastGeneration=0xFFFFFFFF,width=0,height=0,presents=0,uploads=0;
  function ensureTexture(frame){
    if(texture&&width===frame.width&&height===frame.height)return;
    texture?.destroy?.();width=frame.width;height=frame.height;
    texture=device.createTexture({label:'Render360 Xenos semantic framebuffer',size:{width,height,depthOrArrayLayers:1},format:'rgba8unorm',usage:R360_GPU_TEXTURE_USAGE.TEXTURE_BINDING|R360_GPU_TEXTURE_USAGE.COPY_DST});
    bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()},{binding:1,resource:sampler}]});lastGeneration=0xFFFFFFFF;
  }
  function present(){
    if(foundation.state.lost)throw new Error(`WebGPU device lost: ${foundation.state.lostReason||'unknown'}`);
    const frame=xenosFrameView(instance);ensureTexture(frame);
    if(frame.generation!==lastGeneration){device.queue.writeTexture({texture},{data:frame.rgba,bytesPerRow:frame.width*4,rowsPerImage:frame.height},{width:frame.width,height:frame.height,depthOrArrayLayers:1});lastGeneration=frame.generation;uploads++;}
    const enc=device.createCommandEncoder({label:'Render360 Xenos present'});const pass=enc.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([enc.finish()]);presents++;return frame;
  }
  return {device,foundation,present,destroy(){texture?.destroy?.();if(ownsFoundation)foundation.destroy?.();},inspect(){return {backend:'webgpu-xenos-presenter',width,height,presents,uploads,lastGeneration,foundation:foundation.inspect()};}};
}
