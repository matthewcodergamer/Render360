// Render360 WebGPU Xenos backend: replays the command stream the core
// records (src/xenia_web_bootstrap/webgpu_backend.cpp) into WebGPU, as
// Xenia's VulkanCommandProcessor replays its DeferredCommandBuffer.
// docs/gpu/WEBGPU_BACKEND.md describes the design.

export const GPU_STREAM_UPLOAD=1;
export const GPU_STREAM_SHADER=2;
export const GPU_STREAM_PIPELINE=3;
export const GPU_STREAM_RENDER_TARGETS=4;
export const GPU_STREAM_DRAW=5;
export const GPU_STREAM_SWAP=6;

const BUFFER_USAGE={MAP_READ:0x1,COPY_SRC:0x4,COPY_DST:0x8,INDEX:0x10,UNIFORM:0x40,STORAGE:0x80};
const TEXTURE_USAGE={COPY_SRC:0x1,COPY_DST:0x2,TEXTURE_BINDING:0x4,RENDER_ATTACHMENT:0x10};
const SHADER_STAGE={VERTEX:0x1,FRAGMENT:0x2};
const SHARED_MEMORY_BYTES=512*1024*1024;  // Xenia SharedMemory::kBufferSize
const STAGING_BYTES=16*1024*1024;

// Shared memory buffer size the adapter allows: Xenia's 512 MiB, or the
// largest power of two below the device's limits (physical addresses above
// it then cannot be used by GPU emulation, which is reported).
export function sharedMemoryBytesForLimits(limits){
  const max=Math.min(limits.maxBufferSize,limits.maxStorageBufferBindingSize);
  let bytes=SHARED_MEMORY_BYTES;
  while(bytes>max)bytes/=2;
  return bytes;
}

export class XenosWebGpuBackend{
  constructor(device,exports,{sharedMemoryBytes=sharedMemoryBytesForLimits(device.limits)}={}){
    this.device=device;
    this.exports=exports;
    this.sharedMemoryBytes=sharedMemoryBytes;
    // The GPU copy of guest physical memory (Xenia's shared memory buffer).
    this.sharedMemory=device.createBuffer({label:'Render360 shared memory',size:sharedMemoryBytes,
      usage:BUFFER_USAGE.STORAGE|BUFFER_USAGE.COPY_DST|BUFFER_USAGE.COPY_SRC});
    // Upload staging: writeBuffer is ordered before the next submit, so the
    // region is reusable once the commands copying out of it are submitted.
    this.staging=device.createBuffer({label:'Render360 upload staging',size:STAGING_BYTES,
      usage:BUFFER_USAGE.COPY_SRC|BUFFER_USAGE.COPY_DST});
    this.stagingOffset=0;
    this.encoder=null;
    this.stats={uploads:0,uploadedBytes:0,droppedUploads:0,submits:0,shaders:0,pipelines:0,
      pipelineFailures:0,draws:0,skippedDraws:0,renderPasses:0,swaps:0,targetsCreated:0};
    this.convert=null;
    this.shaders=new Map();     // stream id -> {stage, module, bindings, outputs}
    this.pipelines=new Map();   // stream id -> {pipeline, layouts, description} or {error}
    this.layouts=new Map();     // layout key -> GPUBindGroupLayout
    this.bindGroups=new Map();  // layout key -> GPUBindGroup (shared memory, placeholders)
    this.targets=new Map();     // render target key -> {texture, view, format, width, height}
    this.boundTargets=null;     // WebGpuRenderTargetsKey of op 4
    this.pass=null;
    this.lastSwap=null;
    this.uniforms=new XenosUniformRing(device);
    this.indices=new XenosRing(device,'Render360 indices',BUFFER_USAGE.INDEX,8*1024*1024);
  }

  // Loads the SPIR-V to WGSL converter (Naga); needed before shaders replay.
  async init(){
    const {loadSpirvToWgslConverter}=await import('./render360-spirv-wgsl-runtime.mjs');
    this.convert=(await loadSpirvToWgslConverter()).convert;
    return this;
  }

  encoderForCommands(){
    if(!this.encoder)this.encoder=this.device.createCommandEncoder({label:'Render360 Xenos'});
    return this.encoder;
  }

  submit(){
    this.endPass();
    this.uniforms.flush();this.indices.flush();
    if(this.encoder){this.device.queue.submit([this.encoder.finish()]);this.encoder=null;this.stats.submits++;}
    this.stagingOffset=0;
  }

  // Replays and clears the core's recorded commands.
  replay(){
    const e=this.exports,count=e.r360_gpu_stream_words()>>>0;
    if(!count)return;
    const base=e.r360_gpu_stream_data()>>>0;
    this.replayWords(new Uint32Array(e.memory.buffer,base,count));
    e.r360_gpu_stream_reset();
  }

  // Replays stream words (from the core's memory, or a capture).
  replayWords(words){
    const bytes=new Uint8Array(words.buffer,words.byteOffset,words.byteLength);
    for(let i=0;i<words.length;){
      const op=words[i]&0xFF,n=words[i]>>>8,p=words.subarray(i+1,i+1+n);
      if(op===GPU_STREAM_UPLOAD)this.upload(p[0],p[1],bytes.subarray((i+3)*4,(i+3)*4+p[1]));
      else if(op===GPU_STREAM_SHADER)this.defineShader(p);
      else if(op===GPU_STREAM_PIPELINE)this.definePipeline(p);
      else if(op===GPU_STREAM_RENDER_TARGETS){this.endPass();this.boundTargets=parseRenderTargets(p);}
      else if(op===GPU_STREAM_DRAW)this.draw(p);
      else if(op===GPU_STREAM_SWAP){this.stats.swaps++;this.lastSwap=p.slice();this.submit();}
      else throw new Error(`Render360 GPU stream: unknown op ${op} at word ${i}`);
      i+=1+n;
    }
  }

  // Shader op: translated SPIR-V, converted to WGSL by Naga.
  defineShader(p){
    if(!this.convert)throw new Error('Render360 WebGPU backend: init() before replaying shaders');
    const [id,stage,textureCount,samplerCount,spirvWords]=p;
    const spirv=new Uint8Array(p.buffer,p.byteOffset+(5+textureCount+samplerCount)*4,spirvWords*4).slice();
    const shader={id,stage,textures:Array.from(p.subarray(5,5+textureCount)),
      samplers:Array.from(p.subarray(5+textureCount,5+textureCount+samplerCount))};
    try{
      shader.wgsl=this.convert(spirv);
      shader.bindings=parseWgslBindings(shader.wgsl);
      shader.module=this.device.createShaderModule({label:`Render360 Xenos ${stage?'pixel':'vertex'} shader ${id}`,code:shader.wgsl});
    }catch(error){shader.error=String(error?.message||error);}
    this.shaders.set(id,shader);
    this.stats.shaders++;
  }

  // Pipeline op: the WebGpuPipelineDescription, as Xenia's
  // VulkanPipelineCache::EnsurePipelineCreated turns it into a pipeline.
  definePipeline(p){
    const id=p[0],d=parsePipelineDescription(p.subarray(1));
    const entry={description:d};
    try{
      const vs=this.shaders.get(d.vertexShader),ps=d.pixelShader?this.shaders.get(d.pixelShader):null;
      if(!vs?.module)throw new Error(`vertex shader ${d.vertexShader}: ${vs?.error||'missing'}`);
      if(d.pixelShader&&!ps?.module)throw new Error(`pixel shader ${d.pixelShader}: ${ps?.error||'missing'}`);
      // Bind groups (Xenia's descriptor sets): 0 shared memory, 1 constant
      // buffers, 2 vertex textures, 3 pixel textures.
      entry.layouts=[0,1,2,3].map(g=>this.groupLayout(g,[vs,ps].filter(Boolean)));
      const layout=this.device.createPipelineLayout({bindGroupLayouts:entry.layouts.map(l=>l.layout)});
      const targets=[];
      for(let i=0;i<4;i++){
        if(!d.colorFormats[i])continue;
        const format=colorFormat(d.colorFormats[i]-1);
        while(targets.length<i)targets.push(null);
        const target={format,writeMask:(d.colorWriteMasks>>>(i*4))&0xF};
        const blend=blendState(d.blendControl[i]);
        if(blend&&blendableFormat(format))target.blend=blend;
        targets.push(target);
      }
      const descriptor={label:`Render360 Xenos pipeline ${id}`,layout,
        vertex:{module:vs.module,entryPoint:'main'},
        primitive:{topology:['point-list','line-list','line-strip','triangle-list','triangle-strip'][d.topology],
          cullMode:['none','front','back'][d.cullMode],frontFace:d.frontFaceCw?'cw':'ccw'},
        multisample:{count:1}};
      if(ps||targets.length)descriptor.fragment={module:(ps||vs).module,entryPoint:'main',targets};
      if(!ps)delete descriptor.fragment;
      if(d.depthFormat){
        const stencil=d.stencil,on=(stencil&1)!==0;
        const face=(func,fail,zpass,zfail)=>({compare:COMPARE[func],failOp:STENCIL_OP[fail],depthFailOp:STENCIL_OP[zfail],passOp:STENCIL_OP[zpass]});
        const front=on?face((stencil>>>8)&7,(stencil>>>11)&7,(stencil>>>14)&7,(stencil>>>17)&7):{};
        const back=on?((stencil>>>7)&1?face((stencil>>>20)&7,(stencil>>>23)&7,(stencil>>>26)&7,(stencil>>>29)&7):front):{};
        descriptor.depthStencil={format:this.depthFormat(d.depthFormat-1),depthWriteEnabled:!!d.depthWrite,
          depthCompare:COMPARE[d.depthCompare],stencilFront:front,stencilBack:back,
          stencilReadMask:on?(d.stencilMasks>>>8)&0xFF:0xFF,stencilWriteMask:on?(d.stencilMasks>>>16)&0xFF:0};
      }
      entry.pipeline=this.device.createRenderPipeline(descriptor);
      this.stats.pipelines++;
    }catch(error){entry.error=String(error?.message||error);this.stats.pipelineFailures++;}
    this.pipelines.set(id,entry);
  }

  depthFormat(guest){
    // kD24FS8 (20e4 float depth): 32-bit float depth where the device has it.
    return guest===1&&this.device.features?.has?.('depth32float-stencil8')?'depth32float-stencil8':'depth24plus-stencil8';
  }

  // A bind group layout (and its constant bind group when it has one) for
  // the WGSL declarations of the pipeline's shaders in `group`.
  groupLayout(group,shaders){
    const entries=new Map();
    if(group===1){
      // Constant buffers at dynamic offsets in the uniform ring.
      for(let b=0;b<5;b++)entries.set(b,{binding:b,visibility:SHADER_STAGE.VERTEX|SHADER_STAGE.FRAGMENT,buffer:{type:'uniform',hasDynamicOffset:true}});
    }else{
      for(const shader of shaders)for(const decl of shader.bindings){
        if(decl.group!==group)continue;
        const visibility=shader.stage?SHADER_STAGE.FRAGMENT:SHADER_STAGE.VERTEX;
        const prior=entries.get(decl.binding);
        if(prior){prior.visibility|=visibility;continue;}
        const entry={binding:decl.binding,visibility};
        if(decl.kind==='storage'){
          if(decl.write&&!shader.stage)throw new Error('vertex shader memory export is not supported yet');
          entry.buffer={type:decl.write?'storage':'read-only-storage'};
        }else if(decl.kind==='uniform')entry.buffer={type:'uniform'};
        else if(decl.kind==='sampler')entry.sampler={type:decl.comparison?'comparison':'filtering'};
        else if(decl.kind==='texture')entry.texture={sampleType:decl.sampleType,viewDimension:decl.viewDimension,multisampled:false};
        else throw new Error(`unsupported WGSL binding ${decl.type}`);
        entries.set(decl.binding,entry);
      }
    }
    const list=[...entries.values()].sort((a,b)=>a.binding-b.binding);
    const key=`${group}:${JSON.stringify(list)}`;
    let cached=this.layouts.get(key);
    if(!cached){
      const layout=this.device.createBindGroupLayout({label:`Render360 Xenos group ${group}`,entries:list});
      cached={key,layout,group:group===1?null:this.device.createBindGroup({layout,entries:list.map(e=>({binding:e.binding,resource:this.placeholderResource(e)}))})};
      if(group===1)cached.group=this.uniforms.bindGroup(layout);
      this.layouts.set(key,cached);
    }
    return cached;
  }

  // The shared memory buffer, or a placeholder texture / sampler until the
  // texture cache is ported.
  placeholderResource(entry){
    if(entry.buffer)return {buffer:this.sharedMemory};
    if(entry.sampler){
      const key=`sampler:${entry.sampler.type}`;
      if(!this.bindGroups.has(key))this.bindGroups.set(key,this.device.createSampler(entry.sampler.type==='comparison'?{compare:'less'}:{magFilter:'linear',minFilter:'linear'}));
      return this.bindGroups.get(key);
    }
    const {sampleType,viewDimension}=entry.texture,key=`texture:${sampleType}:${viewDimension}`;
    if(!this.bindGroups.has(key)){
      const format=sampleType==='sint'?'rgba8sint':sampleType==='uint'?'rgba8uint':sampleType==='depth'?'depth32float':'rgba8unorm';
      const layers=viewDimension==='cube'?6:1;
      const texture=this.device.createTexture({label:`Render360 placeholder ${viewDimension}`,format,
        dimension:viewDimension==='3d'?'3d':'2d',size:{width:1,height:1,depthOrArrayLayers:layers},usage:TEXTURE_USAGE.TEXTURE_BINDING|TEXTURE_USAGE.COPY_DST});
      if(format!=='depth32float'){
        const texel=new Uint8Array(4*layers).fill(255);
        this.device.queue.writeTexture({texture},texel,{bytesPerRow:4,rowsPerImage:1},{width:1,height:1,depthOrArrayLayers:layers});
      }
      this.bindGroups.set(key,texture.createView({dimension:viewDimension}));
    }
    return this.bindGroups.get(key);
  }

  // Host render target for an EDRAM base / format / pitch (Xenia's
  // RenderTargetCache key without the resolution scale).
  target(base,guestFormat,depth,pitch,height){
    const key=`${depth?'d':'c'}:${base}:${guestFormat}:${pitch}`;
    let t=this.targets.get(key);
    if(t&&t.height>=height)return t;
    const format=depth?this.depthFormat(guestFormat):colorFormat(guestFormat);
    const texture=this.device.createTexture({label:`Render360 EDRAM ${key}`,format,size:{width:pitch,height:Math.max(height,t?.height||0,720)},
      usage:TEXTURE_USAGE.RENDER_ATTACHMENT|TEXTURE_USAGE.TEXTURE_BINDING|TEXTURE_USAGE.COPY_SRC|TEXTURE_USAGE.COPY_DST});
    // A taller target replaces the old one; its contents are kept by copying.
    const fresh={key,base,guestFormat,depth,texture,view:texture.createView(),format,width:pitch,height:texture.height,initialized:false};
    if(t){
      this.endPass();
      this.encoderForCommands().copyTextureToTexture({texture:t.texture},{texture},{width:t.width,height:t.height});
      fresh.initialized=t.initialized;t.texture.destroy();
    }
    this.targets.set(key,fresh);
    this.stats.targetsCreated++;
    return fresh;
  }

  // Begins a render pass on the bound render targets.
  beginPass(){
    if(this.pass)return this.pass;
    const k=this.boundTargets;
    if(!k||!k.surfacePitch)return null;
    const colorAttachments=[];
    const used=[];
    for(let i=0;i<4;i++){
      if(k.colorBase[i]===0xFFFFFFFF)continue;
      const t=this.target(k.colorBase[i],k.colorFormat[i],false,k.surfacePitch,k.height);
      while(colorAttachments.length<i)colorAttachments.push(null);
      colorAttachments.push({view:t.view,loadOp:t.initialized?'load':'clear',clearValue:{r:0,g:0,b:0,a:0},storeOp:'store'});
      used.push(t);
    }
    const pass={colorAttachments};
    let depth=null;
    if(k.depthBase!==0xFFFFFFFF){
      depth=this.target(k.depthBase,k.depthFormat,true,k.surfacePitch,k.height);
      pass.depthStencilAttachment={view:depth.view,depthLoadOp:depth.initialized?'load':'clear',depthClearValue:1,depthStoreOp:'store',
        stencilLoadOp:depth.initialized?'load':'clear',stencilClearValue:0,stencilStoreOp:'store'};
      used.push(depth);
    }
    if(!used.length)return null;
    for(const t of used)t.initialized=true;
    this.passSize={width:used[0].width,height:Math.min(...used.map(t=>t.height))};
    this.pass=this.encoderForCommands().beginRenderPass(pass);
    this.passState={pipeline:null,groups:[]};
    this.stats.renderPasses++;
    return this.pass;
  }

  endPass(){
    if(this.pass){this.pass.end();this.pass=null;}
  }

  // Draw op: header, system / float / bool-loop / fetch constants, indices.
  draw(p){
    const h=parseDrawHeader(p);
    const entry=this.pipelines.get(h.pipeline);
    if(!entry?.pipeline){this.stats.skippedDraws++;return;}
    let o=DRAW_HEADER_WORDS;
    const constants=[h.systemWords,h.floatVertexWords,h.floatPixelWords,h.boolLoopWords,h.fetchWords].map(n=>{const c=p.subarray(o,o+n);o+=n;return c;});
    const indexWords=h.indexFormat===2?h.vertexCount:h.indexFormat===1?(h.vertexCount+1)>>>1:0;
    const indexData=p.subarray(o,o+indexWords);
    // Constants and indices are written before the pass using them is
    // submitted (both rings flush on submit).
    if(!this.uniforms.fits(constants)||!this.indices.fits(indexData.byteLength))this.submit();
    const pass=this.beginPass();
    if(!pass){this.stats.skippedDraws++;return;}
    const offsets=constants.map(c=>this.uniforms.push(c));
    const W=this.passSize.width,H=this.passSize.height;
    const vx=Math.max(0,Math.min(h.viewport[0],W)),vy=Math.max(0,Math.min(h.viewport[1],H));
    const vw=Math.min(h.viewport[2],W-vx),vh=Math.min(h.viewport[3],H-vy);
    const sx=Math.min(h.scissor[0],W),sy=Math.min(h.scissor[1],H);
    const sw=Math.min(h.scissor[2],W-sx),sh=Math.min(h.scissor[3],H-sy);
    if(vw<=0||vh<=0||sw<=0||sh<=0){this.stats.skippedDraws++;return;}
    const s=this.passState;
    if(s.pipeline!==entry.pipeline){pass.setPipeline(entry.pipeline);s.pipeline=entry.pipeline;}
    for(let g=0;g<4;g++){
      const group=entry.layouts[g].group;
      if(g===1)pass.setBindGroup(1,group,offsets);
      else if(s.groups[g]!==group){pass.setBindGroup(g,group);s.groups[g]=group;}
    }
    let z0=Math.max(0,Math.min(1,h.depthRange[0])),z1=Math.max(0,Math.min(1,h.depthRange[1]));
    if(z0>z1)[z0,z1]=[z1,z0];
    pass.setViewport(vx,vy,vw,vh,z0,z1);
    pass.setScissorRect(sx,sy,sw,sh);
    pass.setStencilReference(h.stencilReference);
    pass.setBlendConstant({r:h.blendConstant[0],g:h.blendConstant[1],b:h.blendConstant[2],a:h.blendConstant[3]});
    if(h.indexFormat){
      const bytes=new Uint8Array(indexData.buffer,indexData.byteOffset,h.indexFormat===2?h.vertexCount*4:h.vertexCount*2);
      const offset=this.indices.push(bytes);
      pass.setIndexBuffer(this.indices.buffer,h.indexFormat===2?'uint32':'uint16',offset,bytes.byteLength);
      pass.drawIndexed(h.vertexCount);
    }else{
      pass.draw(h.vertexCount);
    }
    this.stats.draws++;
  }

  // RGBA8 pixels of a color render target (tests and the frame preview).
  async readTarget(t){
    this.submit();
    if(t.format!=='rgba8unorm')throw new Error(`readTarget: ${t.format} not supported`);
    const bytesPerRow=Math.ceil(t.width*4/256)*256;
    const read=this.device.createBuffer({size:bytesPerRow*t.height,usage:BUFFER_USAGE.MAP_READ|BUFFER_USAGE.COPY_DST});
    const encoder=this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture:t.texture},{buffer:read,bytesPerRow},{width:t.width,height:t.height});
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const mapped=new Uint8Array(read.getMappedRange()),out=new Uint8Array(t.width*t.height*4);
    for(let y=0;y<t.height;y++)out.set(mapped.subarray(y*bytesPerRow,y*bytesPerRow+t.width*4),y*t.width*4);
    read.unmap();read.destroy();
    return {width:t.width,height:t.height,pixels:out};
  }

  upload(dest,length,bytes){
    if(dest+length>this.sharedMemoryBytes){this.stats.droppedUploads++;return;}
    if(this.stagingOffset+length>STAGING_BYTES)this.submit();
    length=(length+3)&~3;
    if(length>STAGING_BYTES){
      // Larger than the staging buffer: write directly (ordered before the
      // next submit; nothing recorded after it reads the old contents).
      this.endPass();
      this.device.queue.writeBuffer(this.sharedMemory,dest,bytes.buffer,bytes.byteOffset,length);
    }else{
      // Copies happen outside render passes; draws after this one see the data.
      this.endPass();
      this.device.queue.writeBuffer(this.staging,this.stagingOffset,bytes.buffer,bytes.byteOffset,length);
      this.encoderForCommands().copyBufferToBuffer(this.staging,this.stagingOffset,this.sharedMemory,dest,length);
      this.stagingOffset+=length;
    }
    this.stats.uploads++;
    this.stats.uploadedBytes+=length;
  }

  // Reads `length` bytes of the GPU shared memory (tests and resolve checks).
  async readSharedMemory(offset,length){
    this.submit();
    const read=this.device.createBuffer({size:length,usage:BUFFER_USAGE.MAP_READ|BUFFER_USAGE.COPY_DST});
    const encoder=this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.sharedMemory,offset,read,0,length);
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const bytes=new Uint8Array(read.getMappedRange()).slice();
    read.unmap();read.destroy();
    return bytes;
  }
}

const COMPARE=['never','less','equal','less-equal','greater','not-equal','greater-equal','always'];
const STENCIL_OP=['keep','zero','replace','increment-clamp','decrement-clamp','invert','increment-wrap','decrement-wrap'];
const BLEND_FACTOR={0:'zero',1:'one',4:'src',5:'one-minus-src',6:'src-alpha',7:'one-minus-src-alpha',8:'dst',9:'one-minus-dst',
  10:'dst-alpha',11:'one-minus-dst-alpha',12:'constant',13:'one-minus-constant',14:'constant',15:'one-minus-constant',16:'src-alpha-saturated'};
const BLEND_ALPHA_FACTOR={...BLEND_FACTOR,4:'src-alpha',5:'one-minus-src-alpha',8:'dst-alpha',9:'one-minus-dst-alpha'};
const BLEND_OP=['add','subtract','min','max','reverse-subtract'];

// xenos::ColorRenderTargetFormat to the host format Xenia's Vulkan render
// target cache picks (16_16(_16_16) use float here: WebGPU has no
// renderable snorm16; the system constants scale them as Xenia does).
export function colorFormat(guest){
  switch(guest){
    case 0:case 1:return 'rgba8unorm';
    case 2:case 10:return 'rgb10a2unorm';
    case 3:case 12:case 5:case 7:return 'rgba16float';
    case 4:case 6:return 'rg16float';
    case 14:return 'r32float';
    case 15:return 'rg32float';
    default:throw new Error(`unknown color render target format ${guest}`);
  }
}
function blendableFormat(format){return format!=='r32float'&&format!=='rg32float';}

// RB_BLENDCONTROL to a blend state (undefined: replace, blending off).
function blendState(control){
  const cs=control&31,cop=(control>>>5)&7,cd=(control>>>8)&31,as=(control>>>16)&31,aop=(control>>>21)&7,ad=(control>>>24)&31;
  if(cs===1&&cd===0&&cop===0&&as===1&&ad===0&&aop===0)return undefined;
  const component=(src,op,dst,map)=>{
    const operation=BLEND_OP[op]||'add';
    // WebGPU min / max ignore the factors and require one.
    if(operation==='min'||operation==='max')return {operation,srcFactor:'one',dstFactor:'one'};
    return {operation,srcFactor:map[src]||'zero',dstFactor:map[dst]||'zero'};
  };
  return {color:component(cs,cop,cd,BLEND_FACTOR),alpha:component(as,aop,ad,BLEND_ALPHA_FACTOR)};
}

function parsePipelineDescription(w){
  return {vertexShader:w[0],pixelShader:w[1],topology:w[2],cullMode:w[3],frontFaceCw:w[4],depthCompare:w[5],depthWrite:w[6],
    stencil:w[7],stencilMasks:w[8],colorFormats:Array.from(w.subarray(9,13)),colorWriteMasks:w[13],
    blendControl:Array.from(w.subarray(14,18)),depthFormat:w[18],msaaSamples:w[19]};
}

function parseRenderTargets(w){
  return {surfacePitch:w[0],msaaSamples:w[1],height:w[2],colorBase:Array.from(w.subarray(3,7)),
    colorFormat:Array.from(w.subarray(7,11)),depthBase:w[11],depthFormat:w[12]};
}

const DRAW_HEADER_WORDS=25;
function parseDrawHeader(w){
  const f=new Float32Array(w.buffer,w.byteOffset,DRAW_HEADER_WORDS);
  return {pipeline:w[0],viewport:Array.from(w.subarray(1,5)),depthRange:[f[5],f[6]],scissor:Array.from(w.subarray(7,11)),
    stencilReference:w[11],blendConstant:[f[12],f[13],f[14],f[15]],systemWords:w[16],floatVertexWords:w[17],
    floatPixelWords:w[18],boolLoopWords:w[19],fetchWords:w[20],indexFormat:w[21],vertexCount:w[22],
    vertexTextureMask:w[23],pixelTextureMask:w[24]};
}

// Resource declarations of Naga's WGSL: group, binding, kind and type.
export function parseWgslBindings(wgsl){
  const out=[];
  const re=/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+\w+\s*:\s*([^;]+);/g;
  for(let m;(m=re.exec(wgsl));){
    const group=+m[1],binding=+m[2],space=(m[3]||'').replace(/\s/g,''),type=m[4].trim();
    const decl={group,binding,type};
    if(space.startsWith('storage')){decl.kind='storage';decl.write=space.includes('read_write');}
    else if(space==='uniform')decl.kind='uniform';
    else if(type==='sampler'||type==='sampler_comparison'){decl.kind='sampler';decl.comparison=type==='sampler_comparison';}
    else if(type.startsWith('texture_')){
      decl.kind='texture';
      const t=/^texture_(depth_)?(multisampled_)?(1d|2d_array|2d|3d|cube_array|cube)(?:<(\w+)>)?/.exec(type);
      if(!t)throw new Error(`unsupported WGSL texture type ${type}`);
      decl.viewDimension=t[3].replace('_','-');
      decl.sampleType=t[1]?'depth':t[4]==='i32'?'sint':t[4]==='u32'?'uint':'float';
    }else decl.kind='unknown';
    out.push(decl);
  }
  return out;
}

// A CPU-side ring written to a GPU buffer in one writeBuffer on flush.
class XenosRing{
  constructor(device,label,usage,size,align=4){
    this.device=device;this.size=size;this.align=align;
    this.buffer=device.createBuffer({label,size,usage:usage|BUFFER_USAGE.COPY_DST});
    this.cpu=new Uint8Array(size);this.offset=0;
  }
  fits(bytes){return this.offset+((bytes+this.align-1)&~(this.align-1))<=this.size;}
  push(bytes){
    const at=this.offset;
    this.cpu.set(bytes,at);
    this.offset=at+((bytes.byteLength+this.align-1)&~(this.align-1));
    return at;
  }
  flush(){
    if(this.offset)this.device.queue.writeBuffer(this.buffer,0,this.cpu,0,this.offset);
    this.offset=0;
  }
}

// The five constant buffers of a draw at dynamic offsets (Xenia's uniform
// buffer pool). Bindings are 4 KiB windows: the largest constant buffer
// (256 float4 registers) fits, and the ring keeps 4 KiB of slack at its end.
const CONSTANT_WINDOW=4096;
class XenosUniformRing extends XenosRing{
  constructor(device){
    const align=device.limits.minUniformBufferOffsetAlignment||256;
    super(device,'Render360 constants',BUFFER_USAGE.UNIFORM,8*1024*1024+CONSTANT_WINDOW,align);
    this.limit=8*1024*1024;
  }
  fits(constants){
    let total=0;for(const c of constants)total+=(c.byteLength+this.align-1)&~(this.align-1);
    return this.offset+total<=this.limit;
  }
  push(words){return super.push(new Uint8Array(words.buffer,words.byteOffset,words.byteLength));}
  bindGroup(layout){
    return this.device.createBindGroup({label:'Render360 constants',layout,
      entries:[0,1,2,3,4].map(b=>({binding:b,resource:{buffer:this.buffer,offset:0,size:CONSTANT_WINDOW}}))});
  }
}
