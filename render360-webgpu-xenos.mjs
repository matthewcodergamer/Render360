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
  if (!ptr || size!==width*height*4) throw new Error('invalid Xenos frame export');
  return {ptr,size,width,height,generation:f('r360_xenos_frame_generation')()>>>0,
    rgba:new Uint8Array(e.memory.buffer,ptr,size)};
}

export async function createXenosWebGPUPresenter(canvas, instance) {
  if (!globalThis.navigator?.gpu) throw new Error('WebGPU unavailable');
  const adapter=await navigator.gpu.requestAdapter(); if(!adapter) throw new Error('no WebGPU adapter');
  const device=await adapter.requestDevice(); const context=canvas.getContext('webgpu');
  const format=navigator.gpu.getPreferredCanvasFormat(); context.configure({device,format,alphaMode:'opaque'});
  const shader=device.createShaderModule({code:R360_XENOS_WGSL});
  const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module:shader,entryPoint:'vs_main'},fragment:{module:shader,entryPoint:'fs_main',targets:[{format}]},primitive:{topology:'triangle-list'}});
  let texture=null, bindGroup=null, lastGeneration=0xFFFFFFFF;
  return {device, present(){const frame=xenosFrameView(instance); if(!texture||texture.width!==frame.width||texture.height!==frame.height){texture?.destroy();texture=device.createTexture({size:[frame.width,frame.height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});const sampler=device.createSampler({magFilter:'nearest',minFilter:'nearest'});bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()},{binding:1,resource:sampler}]});lastGeneration=0xFFFFFFFF;}if(frame.generation!==lastGeneration){device.queue.writeTexture({texture},frame.rgba,{bytesPerRow:frame.width*4},[frame.width,frame.height]);lastGeneration=frame.generation;}const enc=device.createCommandEncoder();const pass=enc.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([enc.finish()]);return frame;}};
}
