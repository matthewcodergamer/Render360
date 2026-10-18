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
export const GPU_STREAM_LOAD_SHADER=7;
export const GPU_STREAM_TEXTURE=8;
export const GPU_STREAM_TEXTURE_LOAD=9;
export const GPU_STREAM_EDRAM_DUMP=10;
export const GPU_STREAM_RESOLVE=11;
export const GPU_STREAM_CLEAR=12;

const EDRAM_TILES=2048,EDRAM_TILE_DWORDS=80*16;
// xenos::IsColorRenderTargetFormat64bpp.
const COLOR_64BPP=new Set([5,7,15]);

// WebGpuTextureFormat (src/xenia_web_bootstrap/webgpu_textures.h).
const TEXTURE_FORMATS=[null,'r8unorm','r8snorm','rg8unorm','rg8snorm','rgba8unorm','rgba8snorm','rgb10a2unorm',
  'r16float','rg16float','rgba16float','r32float','rg32float','rgba32float'];
const UNFILTERABLE_FORMATS=new Set(['r32float','rg32float','rgba32float']);

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
      pipelineFailures:0,draws:0,skippedDraws:0,renderPasses:0,swaps:0,targetsCreated:0,
      textures:0,textureLoads:0,textureFailures:0,textureLoadFailures:0,loadShaderFailures:0,unbindableTextures:0,
      dumps:0,resolves:0,resolveFailures:0,clears:0};
    // r32float and wider float textures are filterable only with this feature.
    this.float32Filterable=!!device.features?.has?.('float32-filterable');
    this.convert=null;
    this.shaders=new Map();     // stream id -> {stage, module, bindings, outputs}
    this.pipelines=new Map();   // stream id -> {pipeline, layouts, description} or {error}
    this.layouts=new Map();     // layout key -> GPUBindGroupLayout
    this.bindGroups=new Map();  // layout key -> GPUBindGroup (shared memory, placeholders)
    this.targets=new Map();     // render target key -> {texture, view, format, width, height}
    this.boundTargets=null;     // WebGpuRenderTargetsKey of op 4
    this.pass=null;
    this.lastSwap=null;
    this.loadShaders=new Map();  // TextureCache::LoadShaderIndex -> compute pipeline
    this.textures=new Map();     // stream texture id -> {texture, views, format}
    this.samplers=new Map();     // packed sampler parameters -> GPUSampler
    this.textureGroups=new Map();// bind groups of groups 2 / 3 by contents
    this.scratch=null;this.scratchRetired=[];
    // Xenia's EDRAM buffer (render target dumps for resolves) and the host
    // render target owning each tile (RenderTargetCache ownership).
    this.edram=device.createBuffer({label:'Render360 EDRAM',size:EDRAM_TILES*EDRAM_TILE_DWORDS*4,
      usage:BUFFER_USAGE.STORAGE|BUFFER_USAGE.COPY_SRC|BUFFER_USAGE.COPY_DST});
    this.tileOwner=new Array(EDRAM_TILES).fill(null);
    this.frontTexture=null;
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
    for(const b of this.scratchRetired)b.destroy();
    this.scratchRetired.length=0;
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
      else if(op===GPU_STREAM_SWAP){this.stats.swaps++;this.lastSwap=p.slice();this.frontTexture=this.textures.get(p[6])||null;this.frontSwizzle=p[7]??0x688;this.submit();}
      else if(op===GPU_STREAM_EDRAM_DUMP)this.dumpEdram(p);
      else if(op===GPU_STREAM_RESOLVE)this.resolve(p);
      else if(op===GPU_STREAM_CLEAR)this.clear(p);
      else if(op===GPU_STREAM_LOAD_SHADER)this.defineLoadShader(p);
      else if(op===GPU_STREAM_TEXTURE)this.defineTexture(p);
      else if(op===GPU_STREAM_TEXTURE_LOAD)this.loadTexture(p);
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
      cached={key,layout,entries:list,group:group===1?null:this.device.createBindGroup({layout,entries:list.map(e=>({binding:e.binding,resource:this.placeholderResource(e)}))})};
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
  target(base,guestFormat,depth,pitch,height,msaa=0){
    const key=`${depth?'d':'c'}:${base}:${guestFormat}:${pitch}:${msaa}`;
    let t=this.targets.get(key);
    if(t&&t.height>=height)return t;
    const format=depth?this.depthFormat(guestFormat):colorFormat(guestFormat);
    const texture=this.device.createTexture({label:`Render360 EDRAM ${key}`,format,size:{width:pitch,height:Math.max(height,t?.height||0,720)},
      usage:TEXTURE_USAGE.RENDER_ATTACHMENT|TEXTURE_USAGE.TEXTURE_BINDING|TEXTURE_USAGE.COPY_SRC|TEXTURE_USAGE.COPY_DST});
    // A taller target replaces the old one; its contents are kept by copying.
    const fresh={key,base,guestFormat,depth,texture,view:texture.createView(),format,width:pitch,height:texture.height,initialized:false,
      msaa,...tileGeometry(pitch,msaa,!depth&&COLOR_64BPP.has(guestFormat))};
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
      const t=this.target(k.colorBase[i],k.colorFormat[i],false,k.surfacePitch,k.height,k.msaaSamples);
      while(colorAttachments.length<i)colorAttachments.push(null);
      colorAttachments.push({view:t.view,loadOp:t.initialized?'load':'clear',clearValue:{r:0,g:0,b:0,a:0},storeOp:'store'});
      used.push(t);
    }
    const pass={colorAttachments};
    let depth=null;
    if(k.depthBase!==0xFFFFFFFF){
      depth=this.target(k.depthBase,k.depthFormat,true,k.surfacePitch,k.height,k.msaaSamples);
      pass.depthStencilAttachment={view:depth.view,depthLoadOp:depth.initialized?'load':'clear',depthClearValue:1,depthStoreOp:'store',
        stencilLoadOp:depth.initialized?'load':'clear',stencilClearValue:0,stencilStoreOp:'store'};
      used.push(depth);
    }
    if(!used.length)return null;
    for(const t of used){t.initialized=true;this.own(t,k.height);}
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
    if(this.drawLimit!==undefined&&this.stats.draws>=this.drawLimit){this.stats.skippedDraws++;return;}
    const entry=this.pipelines.get(h.pipeline);
    if(!entry?.pipeline){this.stats.skippedDraws++;return;}
    let o=DRAW_HEADER_WORDS;
    const constants=[h.systemWords,h.floatVertexWords,h.floatPixelWords,h.boolLoopWords,h.fetchWords].map(n=>{const c=p.subarray(o,o+n);o+=n;return c;});
    const bindingWords=p.subarray(o,o+h.bindingWords);o+=h.bindingWords;
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
    const textureGroups=this.textureBindGroups(entry,bindingWords);
    for(let g=0;g<4;g++){
      const group=g>=2?textureGroups[g-2]:entry.layouts[g].group;
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

  // Bind groups 2 (vertex) and 3 (pixel) of a draw: its textures (by
  // stream id, 0 for Xenia's null texture) and samplers.
  textureBindGroups(entry,words){
    const out=[];let o=0;
    for(let g=2;g<4;g++){
      const shader=this.shaders.get(g===2?entry.description.vertexShader:entry.description.pixelShader);
      const layout=entry.layouts[g];
      if(!shader||!layout.entries.length){out.push(layout.group);if(shader)o+=shader.textures.length+shader.samplers.length;continue;}
      const n=shader.textures.length,m=shader.samplers.length,ids=words.subarray(o,o+n+m);o+=n+m;
      const key=`${layout.key}|${ids.join(',')}`;
      let group=this.textureGroups.get(key);
      if(!group){
        if(this.textureGroups.size>4096)this.textureGroups.clear();
        group=this.device.createBindGroup({layout:layout.layout,entries:layout.entries.map(e=>{
          if(e.texture){
            const t=e.binding<n?this.textures.get(ids[e.binding]):null;
            const view=t&&!(UNFILTERABLE_FORMATS.has(t.format)&&!this.float32Filterable)?t.views[e.texture.viewDimension]:null;
            if(!view&&e.binding<n&&ids[e.binding])this.stats.unbindableTextures++;
            return {binding:e.binding,resource:view||this.placeholderResource(e)};
          }
          if(e.sampler&&e.binding>=n&&e.binding<n+m&&e.sampler.type==='filtering')return {binding:e.binding,resource:this.sampler(ids[e.binding])};
          return {binding:e.binding,resource:this.placeholderResource(e)};
        })});
        this.textureGroups.set(key,group);
      }
      out.push(group);
    }
    return out;
  }

  // VulkanTextureCache::UseSampler for packed sampler parameters
  // (webgpu_textures.cpp WebGpuSamplerParameters).
  sampler(parameters){
    let sampler=this.samplers.get(parameters);
    if(sampler)return sampler;
    const address=m=>m===0?'repeat':m===1?'mirror-repeat':'clamp-to-edge';
    const mag=(parameters>>>11)&1,min=(parameters>>>12)&1,mip=(parameters>>>13)&1;
    const aniso=(parameters>>>14)&7,baseMap=(parameters>>>17)&1,minLevel=(parameters>>>18)&15;
    const descriptor={addressModeU:address(parameters&7),addressModeV:address((parameters>>>3)&7),addressModeW:address((parameters>>>6)&7),
      magFilter:mag?'linear':'nearest',minFilter:min?'linear':'nearest',mipmapFilter:mip?'linear':'nearest',
      lodMinClamp:minLevel,lodMaxClamp:baseMap?minLevel+0.25:32};
    // Anisotropy needs every filter linear in WebGPU.
    if(aniso>=2&&mag&&min&&mip)descriptor.maxAnisotropy=Math.min(16,1<<(aniso-1));
    sampler=this.device.createSampler(descriptor);
    this.samplers.set(parameters,sampler);
    return sampler;
  }

  // One of Xenia's texture_load_* compute shaders. Naga rejects write-only
  // storage (NonReadable) and has no push constants in WGSL: the decoration
  // is dropped and the push constant block becomes a uniform buffer.
  defineLoadShader(p){
    const index=p[0],spirv=stripNonReadable(p.subarray(2,2+p[1]));
    const entry={};
    try{
      const wgsl=this.convert(new Uint8Array(spirv.buffer,spirv.byteOffset,spirv.byteLength))
        .replace(/var<(?:immediate|push_constant)>\s+(\w+)\s*:/,'@group(2) @binding(0) var<uniform> $1:');
      const module=this.device.createShaderModule({label:`Xenia texture load ${index}`,code:wgsl});
      const S=0x4;  // COMPUTE
      // Texture loads: group 0 destination, 1 source. Resolve copies (64 +
      // ResolveCopyShaderIndex): group 0 EDRAM, 1 shared memory destination.
      const resolve=index>=64;
      const layouts=[
        this.device.createBindGroupLayout({entries:[{binding:0,visibility:S,buffer:{type:resolve?'read-only-storage':'storage'}}]}),
        this.device.createBindGroupLayout({entries:[{binding:0,visibility:S,buffer:{type:resolve?'storage':'read-only-storage'}}]}),
        this.device.createBindGroupLayout({entries:[{binding:0,visibility:S,buffer:{type:'uniform',hasDynamicOffset:true}}]})];
      entry.layouts=layouts;
      entry.pipeline=this.device.createComputePipeline({label:`Xenia texture load ${index}`,
        layout:this.device.createPipelineLayout({bindGroupLayouts:layouts}),compute:{module,entryPoint:'main'}});
      entry.constants=this.device.createBindGroup({layout:layouts[2],entries:[{binding:0,resource:{buffer:this.uniforms.buffer,offset:0,size:256}}]});
    }catch(error){entry.error=String(error?.message||error);this.stats.loadShaderFailures++;}
    this.loadShaders.set(index,entry);
  }

  // Texture op: VulkanTextureCache::CreateTexture.
  defineTexture(p){
    const [id,formatIndex,dimension,width,height,depth,mips]=p;
    const format=TEXTURE_FORMATS[formatIndex];
    const old=this.textures.get(id);
    if(old)old.texture.destroy();
    if(!format){this.stats.textureFailures++;return;}
    const is3d=dimension===1;
    const texture=this.device.createTexture({label:`Xenos texture ${id}`,format,dimension:is3d?'3d':'2d',
      size:{width,height,depthOrArrayLayers:depth},mipLevelCount:mips,usage:TEXTURE_USAGE.TEXTURE_BINDING|TEXTURE_USAGE.COPY_DST|TEXTURE_USAGE.COPY_SRC});
    const views={};
    if(is3d)views['3d']=texture.createView({dimension:'3d'});
    else if(dimension===2)views.cube=texture.createView({dimension:'cube'});
    else views['2d-array']=texture.createView({dimension:'2d-array'});
    this.textures.set(id,{id,texture,views,format,dimension,width,height});
    this.textureGroups.clear();
    this.stats.textures++;
  }

  // Texture load op: Xenia's load shader dispatches into a scratch buffer
  // (VulkanTextureCache::LoadTextureDataFromResidentMemoryImpl), an
  // optional expansion pass, then copies into the texture.
  loadTexture(p){
    const [id,shaderIndex,expand,bufferSize,baseOffset,baseSize,mipsOffset,mipsSize,dispatchCount,copyCount]=p;
    const t=this.textures.get(id),shader=this.loadShaders.get(shaderIndex);
    if(!t||!shader?.pipeline){this.stats.textureLoadFailures++;return;}
    this.endPass();
    const expanded=expand>=1&&expand<=4;
    const scratchBytes=bufferSize*(expanded?3:1)+256;
    if(!this.scratch||this.scratch.size<scratchBytes){
      if(this.scratch)this.scratchRetired.push(this.scratch);
      let size=1<<20;while(size<scratchBytes)size*=2;
      this.scratch=this.device.createBuffer({label:'Render360 texture load scratch',size,usage:BUFFER_USAGE.STORAGE|BUFFER_USAGE.COPY_SRC});
    }
    if(!this.uniforms.fits([new Uint32Array(dispatchCount*64)]))this.submit();
    const dest=this.device.createBindGroup({layout:shader.layouts[0],entries:[{binding:0,resource:{buffer:this.scratch,offset:0,size:bufferSize}}]});
    const source=(offset,size)=>size?this.device.createBindGroup({layout:shader.layouts[1],entries:[{binding:0,resource:{buffer:this.sharedMemory,offset,size}}]}):null;
    const sources=[source(baseOffset,baseSize),source(mipsOffset,mipsSize)];
    const pass=this.encoderForCommands().beginComputePass({label:'Xenia texture load'});
    pass.setPipeline(shader.pipeline);
    pass.setBindGroup(0,dest);
    let o=10;
    for(let d=0;d<dispatchCount;d++,o+=14){
      const src=sources[p[o]];
      if(!src)continue;
      const offset=this.uniforms.push(p.subarray(o+1,o+11));
      pass.setBindGroup(1,src);
      pass.setBindGroup(2,shader.constants,[offset]);
      pass.dispatchWorkgroups(p[o+11],p[o+12],p[o+13]);
    }
    pass.end();
    let copySource=this.scratch,scale=1,copyBase=0;
    if(expand)({buffer:copySource,scale,base:copyBase}=this.expandTexels(expand,bufferSize));
    const encoder=this.encoderForCommands();
    for(let c=0;c<copyCount;c++,o+=8){
      const [offset,bytesPerRow,rowsPerImage,mipLevel,layers,width,height,depth]=p.subarray(o,o+8);
      encoder.copyBufferToTexture({buffer:copySource,offset:copyBase+offset*scale,bytesPerRow:bytesPerRow*scale,rowsPerImage},
        {texture:t.texture,mipLevel},{width,height,depthOrArrayLayers:t.dimension===1?depth:layers});
    }
    this.stats.textureLoads++;
  }

  // Expansion pass (webgpu_textures.h WebGpuTextureExpand): 16-bit packed
  // texels to RGBA8 after the scratch data (twice the size), or 16-bit
  // normalized components to float16 in place.
  expandTexels(mode,bufferSize){
    let entry=this.expandPipelines?.get(mode);
    if(!entry){
      this.expandPipelines??=new Map();
      const module=this.device.createShaderModule({label:`Render360 texel expand ${mode}`,code:expandShader(mode)});
      const pipeline=this.device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
      entry={pipeline};this.expandPipelines.set(mode,entry);
    }
    const inPlace=mode>=5,words=bufferSize/4;
    const out=inPlace?0:Math.ceil(bufferSize/256)*256;
    const group=this.device.createBindGroup({layout:entry.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.scratch,offset:0,size:bufferSize}},
      ...(inPlace?[]:[{binding:1,resource:{buffer:this.scratch,offset:out,size:bufferSize*2}}])]});
    const pass=this.encoderForCommands().beginComputePass({label:'Render360 texel expand'});
    pass.setPipeline(entry.pipeline);pass.setBindGroup(0,group);
    const groups=Math.ceil(words/64);
    pass.dispatchWorkgroups(Math.min(groups,65535),Math.ceil(groups/65535));
    pass.end();
    return inPlace?{buffer:this.scratch,scale:1,base:0}:{buffer:this.scratch,scale:2,base:out};
  }

  // The render target owns the EDRAM tiles it covers up to `height` pixels.
  own(t,height){
    const rows=Math.ceil(Math.min(height,t.height)/t.tileHeight);
    for(let r=0;r<rows;r++)for(let c=0;c<t.pitchTiles;c++)this.tileOwner[(t.base+r*t.pitchTiles+c)%EDRAM_TILES]=t;
  }

  // Edram dump op (VulkanRenderTargetCache::DumpRenderTargets): the owners
  // of the tile span write their pixels into the EDRAM buffer in Xenia's
  // layout (edram.xesli XeEdramOffsetBytes).
  dumpEdram(p){
    const [base,rowLength,rows,pitch]=p;
    const owners=new Set();
    for(let r=0;r<rows;r++)for(let c=0;c<rowLength;c++){const o=this.tileOwner[(base+r*pitch+c)%EDRAM_TILES];if(o)owners.add(o);}
    if(!owners.size)return;
    this.endPass();
    for(const t of owners){
      const delta=(base-t.base+EDRAM_TILES)%EDRAM_TILES;
      const row0=Math.floor(delta/t.pitchTiles),col0=delta%t.pitchTiles;
      const x0=col0*t.tileWidth,y0=row0*t.tileHeight;
      const width=Math.min(t.width-x0,Math.max(rowLength,1)*t.tileWidth),height=Math.min(t.height-y0,rows*t.tileHeight);
      if(width<=0||height<=0)continue;
      const pipeline=this.dumpPipeline(t.depth);
      const constants=new Uint32Array([t.base,t.pitchTiles,t.msaa,t.guestFormat,x0,y0,width,height,t.is64bpp?1:0,
        this.depthFormat(t.guestFormat)==='depth32float-stencil8'?1:0,0,0]);
      if(!this.uniforms.fits([constants]))this.submit();
      const offset=this.uniforms.push(constants);
      const entries=[{binding:0,resource:{buffer:this.edram}},{binding:1,resource:{buffer:this.uniforms.buffer,offset,size:48}}];
      if(t.depth){
        entries.push({binding:2,resource:t.texture.createView({aspect:'depth-only'})},{binding:3,resource:t.texture.createView({aspect:'stencil-only'})});
      }else entries.push({binding:2,resource:t.view});
      const group=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
      const pass=this.encoderForCommands().beginComputePass({label:'Render360 EDRAM dump'});
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));
      pass.end();
      this.stats.dumps++;
    }
  }

  dumpPipeline(depth){
    this.dumpPipelines??={};
    const key=depth?'depth':'color';
    if(!this.dumpPipelines[key]){
      const module=this.device.createShaderModule({label:`Render360 EDRAM dump ${key}`,code:edramDumpShader(depth)});
      this.dumpPipelines[key]=this.device.createComputePipeline({label:`Render360 EDRAM dump ${key}`,layout:'auto',compute:{module,entryPoint:'main'}});
    }
    return this.dumpPipelines[key];
  }

  // Resolve op: Xenia's resolve copy shader from the EDRAM buffer into the
  // shared memory buffer (VulkanRenderTargetCache::Resolve).
  resolve(p){
    const shader=this.loadShaders.get(64+p[0]);
    if(!shader?.pipeline){this.stats.resolveFailures++;return;}
    const [groupsX,groupsY,offset,size]=p.subarray(6,10);
    if(offset+size>this.sharedMemoryBytes){this.stats.resolveFailures++;return;}
    this.endPass();
    const constants=p.subarray(1,6);
    if(!this.uniforms.fits([constants]))this.submit();
    const at=this.uniforms.push(constants);
    const pass=this.encoderForCommands().beginComputePass({label:'Xenia resolve'});
    pass.setPipeline(shader.pipeline);
    pass.setBindGroup(0,this.device.createBindGroup({layout:shader.layouts[0],entries:[{binding:0,resource:{buffer:this.edram}}]}));
    pass.setBindGroup(1,this.device.createBindGroup({layout:shader.layouts[1],entries:[{binding:0,resource:{buffer:this.sharedMemory,offset,size}}]}));
    pass.setBindGroup(2,shader.constants,[at]);
    pass.dispatchWorkgroups(groupsX,groupsY,1);
    pass.end();
    this.stats.resolves++;
  }

  // Clear op: the host render targets at the cleared EDRAM region
  // (VulkanRenderTargetCache::PrepareHostRenderTargetsResolveClear and
  // PerformTransfersAndResolveClears).
  clear(p){
    const [isDepth,base,pitchTiles,msaa,format,x,y,width,height,lo,hi]=p;
    this.endPass();
    for(const t of this.targets.values()){
      if(!!t.depth!==!!isDepth||t.pitchTiles!==pitchTiles||t.msaa!==msaa||t.guestFormat!==format)continue;
      const delta=(base-t.base+EDRAM_TILES)%EDRAM_TILES;
      const x0=(delta%pitchTiles)*t.tileWidth+x,y0=Math.floor(delta/pitchTiles)*t.tileHeight+y;
      if(x0>=t.width||y0>=t.height)continue;
      const w=Math.min(width,t.width-x0),h=Math.min(height,t.height-y0);
      const whole=x0===0&&y0===0&&w>=t.width&&h>=t.height;
      const value=isDepth?depthClearValue(format,lo,this.depthFormat(format)):colorClearValue(format,lo,hi);
      const attachment=isDepth
        ?{depthStencilAttachment:{view:t.view,depthLoadOp:whole?'clear':'load',depthClearValue:value.depth,depthStoreOp:'store',
          stencilLoadOp:whole?'clear':'load',stencilClearValue:value.stencil,stencilStoreOp:'store'},colorAttachments:[]}
        :{colorAttachments:[{view:t.view,loadOp:whole?'clear':'load',clearValue:value,storeOp:'store'}]};
      const pass=this.encoderForCommands().beginRenderPass(attachment);
      if(!whole){
        pass.setPipeline(this.clearPipeline(t));
        const words=new Float32Array(isDepth?[value.depth,0,0,0]:[value.r,value.g,value.b,value.a]);
        if(!this.uniforms.fits([words])){pass.end();this.submit();this.clear(p);return;}
        const at=this.uniforms.push(new Uint32Array(words.buffer));
        pass.setBindGroup(0,this.clearGroup(t),[at]);
        pass.setScissorRect(x0,y0,w,h);
        if(isDepth)pass.setStencilReference(value.stencil);
        pass.draw(3);
      }
      pass.end();
      t.initialized=true;
      this.stats.clears++;
    }
  }

  clearPipeline(t){
    this.clearPipelines??=new Map();
    let pipeline=this.clearPipelines.get(t.format);
    if(!pipeline){
      const module=this.device.createShaderModule({label:'Render360 clear',code:CLEAR_SHADER});
      const layout=this.clearLayout();
      const descriptor={label:`Render360 clear ${t.format}`,layout:this.device.createPipelineLayout({bindGroupLayouts:[layout]}),
        vertex:{module,entryPoint:'vs'},primitive:{topology:'triangle-list'}};
      if(t.depth){
        descriptor.fragment={module,entryPoint:'fs_depth',targets:[]};
        const face={compare:'always',passOp:'replace',failOp:'replace',depthFailOp:'replace'};
        descriptor.depthStencil={format:t.format,depthWriteEnabled:true,depthCompare:'always',stencilFront:face,stencilBack:face,stencilWriteMask:0xFF};
      }else descriptor.fragment={module,entryPoint:'fs_color',targets:[{format:t.format}]};
      pipeline=this.device.createRenderPipeline(descriptor);
      this.clearPipelines.set(t.format,pipeline);
    }
    return pipeline;
  }
  clearLayout(){
    this.clearBindGroupLayout??=this.device.createBindGroupLayout({entries:[{binding:0,visibility:SHADER_STAGE.FRAGMENT,buffer:{type:'uniform',hasDynamicOffset:true}}]});
    return this.clearBindGroupLayout;
  }
  clearGroup(){
    this.clearBindGroup??=this.device.createBindGroup({layout:this.clearLayout(),entries:[{binding:0,resource:{buffer:this.uniforms.buffer,offset:0,size:16}}]});
    return this.clearBindGroup;
  }

  // Draws the front buffer of the last swap to a canvas context configured
  // on this device (the play path's present; Xenia's swap presenter).
  present(context,format){
    const front=this.frontTexture;
    if(!front)return false;
    this.presentPipelines??=new Map();
    let pipeline=this.presentPipelines.get(format);
    if(!pipeline){
      const module=this.device.createShaderModule({label:'Render360 present',code:PRESENT_SHADER});
      pipeline=this.device.createRenderPipeline({label:'Render360 present',layout:'auto',
        vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});
      this.presentPipelines.set(format,pipeline);
    }
    this.presentSwizzleBuffer??=this.device.createBuffer({size:16,usage:BUFFER_USAGE.UNIFORM|BUFFER_USAGE.COPY_DST});
    this.device.queue.writeBuffer(this.presentSwizzleBuffer,0,new Uint32Array([this.frontSwizzle??0x688,0,0,0]));
    if(this.presentSource!==front.texture||this.presentPipeline!==pipeline){
      this.presentSampler??=this.device.createSampler({magFilter:'linear',minFilter:'linear'});
      this.presentGroup=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:front.views['2d-array']},{binding:1,resource:this.presentSampler},
        {binding:2,resource:{buffer:this.presentSwizzleBuffer}}]});
      this.presentSource=front.texture;this.presentPipeline=pipeline;
    }
    const encoder=this.encoderForCommands();
    this.endPass();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,this.presentGroup);pass.draw(3);pass.end();
    this.submit();
    this.stats.presents=(this.stats.presents||0)+1;
    return true;
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

const DRAW_HEADER_WORDS=26;
function parseDrawHeader(w){
  const f=new Float32Array(w.buffer,w.byteOffset,DRAW_HEADER_WORDS);
  return {pipeline:w[0],viewport:Array.from(w.subarray(1,5)),depthRange:[f[5],f[6]],scissor:Array.from(w.subarray(7,11)),
    stencilReference:w[11],blendConstant:[f[12],f[13],f[14],f[15]],systemWords:w[16],floatVertexWords:w[17],
    floatPixelWords:w[18],boolLoopWords:w[19],fetchWords:w[20],indexFormat:w[21],vertexCount:w[22],
    vertexTextureMask:w[23],pixelTextureMask:w[24],bindingWords:w[25]};
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

// SPIR-V without NonReadable decorations (OpDecorate / OpMemberDecorate 25).
export function stripNonReadable(words){
  const out=Array.from(words.subarray(0,5));
  for(let i=5;i<words.length;){
    const n=words[i]>>>16,op=words[i]&0xFFFF;
    if(!n)break;
    const drop=(op===71&&words[i+2]===25)||(op===72&&words[i+3]===25);
    if(!drop)for(let k=0;k<n;k++)out.push(words[i+k]);
    i+=n;
  }
  return new Uint32Array(out);
}

// WGSL of the texel expansion passes. Packed modes read 2 guest 16-bit
// texels per word (little-endian after the 16bpb load) and write 2 RGBA8
// words in the host component order of Xenia's Vulkan formats.
function expandShader(mode){
  const head=`@group(0) @binding(0) var<storage, read_write> src: array<u32>;\n`;
  const index=`let i = id.x + id.y * 65535u * 64u; if (i >= arrayLength(&src)) { return; }`;
  if(mode>=5){
    const conv=mode===5?'vec2<f32>(f32(v & 0xFFFFu), f32(v >> 16u)) / 65535.0'
      :'max(vec2<f32>(f32((bitcast<i32>(v) << 16u) >> 16u), f32(bitcast<i32>(v) >> 16u)) / 32767.0, vec2<f32>(-1.0))';
    return `${head}@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  ${index} let v = src[i]; src[i] = pack2x16float(${conv}); }`;
  }
  const unpack={
    1:'vec4<f32>(f32(t & 31u) / 31.0, f32((t >> 5u) & 63u) / 63.0, f32((t >> 11u) & 31u) / 31.0, 1.0)',
    2:'vec4<f32>(f32(t & 31u) / 31.0, f32((t >> 10u) & 63u) / 63.0, f32((t >> 5u) & 31u) / 31.0, 1.0)',
    3:'vec4<f32>(f32(t & 31u) / 31.0, f32((t >> 5u) & 31u) / 31.0, f32((t >> 10u) & 31u) / 31.0, f32(t >> 15u))',
    4:'vec4<f32>(f32(t & 15u), f32((t >> 4u) & 15u), f32((t >> 8u) & 15u), f32(t >> 12u)) / 15.0'}[mode];
  return `${head}@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
fn texel(t: u32) -> u32 { return pack4x8unorm(${unpack}); }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  ${index} let v = src[i]; dst[2u * i] = texel(v & 0xFFFFu); dst[2u * i + 1u] = texel(v >> 16u); }`;
}

// EDRAM tile geometry of a host render target in pixels (80x16 32bpp
// samples per tile, 40x16 at 64bpp; 2x MSAA doubles Y, 4x also X).
function tileGeometry(pitch,msaa,is64bpp){
  const sx=msaa>=2?2:1,sy=msaa>=1?2:1;
  const tileWidth=(is64bpp?40:80)/sx,tileHeight=16/sy;
  return {is64bpp,tileWidth,tileHeight,pitchTiles:Math.ceil(pitch/tileWidth)};
}

function float7e3To32(f10){
  f10&=0x3FF;if(!f10)return 0;
  let mantissa=f10&0x7F,exponent=f10>>>7;
  if(!exponent){let lz=7-(31-Math.clz32(mantissa));exponent=1-lz;mantissa=(mantissa<<lz)&0x7F;}
  const bits=((exponent+124)<<23)|(mantissa<<16);
  return new Float32Array(new Uint32Array([bits>>>0]).buffer)[0];
}
function float20e4To32(f24){
  f24&=0xFFFFFF;if(!f24)return 0;
  let mantissa=f24&0xFFFFF,exponent=f24>>>20;
  if(!exponent){let lz=20-(31-Math.clz32(mantissa));exponent=1-lz;mantissa=(mantissa<<lz)&0xFFFFF;}
  const bits=((exponent+112)<<23)|(mantissa<<3);
  return new Float32Array(new Uint32Array([bits>>>0]).buffer)[0];
}
function halfToFloat(h){
  const s=h&0x8000?-1:1,e=(h>>>10)&31,m=h&1023;
  if(!e)return s*m*2**-24;if(e===31)return m?NaN:s*Infinity;
  return s*(1+m/1024)*2**(e-15);
}

// Guest clear values to host clear colors (VulkanRenderTargetCache), for the
// host formats render360 picks (16-bit fixed formats stored as float in
// Xenia's -1...1 host scale).
function colorClearValue(format,lo,hi){
  const v=BigInt(lo>>>0)|(BigInt(hi>>>0)<<32n),bits=(shift,n)=>Number((v>>BigInt(shift))&((1n<<BigInt(n))-1n));
  const s16=x=>Math.max(((x<<16)>>16)/32767,-1);
  switch(format){
    case 0:case 1:return {r:bits(0,8)/255,g:bits(8,8)/255,b:bits(16,8)/255,a:bits(24,8)/255};
    case 2:case 10:return {r:bits(0,10)/1023,g:bits(10,10)/1023,b:bits(20,10)/1023,a:bits(30,2)/3};
    case 3:case 12:return {r:float7e3To32(bits(0,10)),g:float7e3To32(bits(10,10)),b:float7e3To32(bits(20,10)),a:bits(30,2)/3};
    case 4:return {r:s16(bits(0,16)),g:s16(bits(16,16)),b:0,a:0};
    case 5:return {r:s16(bits(0,16)),g:s16(bits(16,16)),b:s16(bits(32,16)),a:s16(bits(48,16))};
    case 6:return {r:halfToFloat(bits(0,16)),g:halfToFloat(bits(16,16)),b:0,a:0};
    case 7:return {r:halfToFloat(bits(0,16)),g:halfToFloat(bits(16,16)),b:halfToFloat(bits(32,16)),a:halfToFloat(bits(48,16))};
    case 14:{const f=new Float32Array(new Uint32Array([lo>>>0]).buffer)[0];return {r:f,g:0,b:0,a:0};}
    case 15:{const f=new Float32Array(new Uint32Array([lo>>>0,hi>>>0]).buffer);return {r:f[0],g:f[1],b:0,a:0};}
    default:return {r:0,g:0,b:0,a:0};
  }
}
function depthClearValue(format,value,hostFormat){
  const d24=(value>>>8)&0xFFFFFF;
  // D24FS8: Xenia's host depth takes [0, 2) to [0, 1).
  const depth=format===1?float20e4To32(d24)*0.5:d24/0xFFFFFF;
  return {depth:Math.min(1,Math.max(0,depth)),stencil:value&0xFF};
}

const CLEAR_SHADER=`@group(0) @binding(0) var<uniform> value: vec4<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32(i == 1u) * 4.0 - 1.0, f32(i == 2u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_color() -> @location(0) vec4<f32> { return value; }
@fragment fn fs_depth() -> @builtin(frag_depth) f32 { return value.x; }`;

// EDRAM dump of one host render target region (WGSL port of edram.xesli
// XeEdramOffsetBytes and the EDRAM pixel formats of pixel_formats.xesli).
function edramDumpShader(depth){
  return `struct Dump {
  base_tiles: u32, pitch_tiles: u32, msaa: u32, format: u32,
  x0: u32, y0: u32, width: u32, height: u32, is_64bpp: u32, depth_float32: u32, pad0: u32, pad1: u32,
}
@group(0) @binding(0) var<storage, read_write> edram: array<u32>;
@group(0) @binding(1) var<uniform> dump: Dump;
${depth?`@group(0) @binding(2) var depth_texture: texture_depth_2d;
@group(0) @binding(3) var stencil_texture: texture_2d<u32>;`:`@group(0) @binding(2) var color_texture: texture_2d<f32>;`}

fn edram_offset_dwords(pixel: vec2<u32>, sample: u32) -> u32 {
  var s = pixel << vec2<u32>(select(0u, 1u, dump.msaa >= 2u), select(0u, 1u, dump.msaa >= 1u));
  s += (vec2<u32>(sample) >> vec2<u32>(1u, 0u)) & vec2<u32>(1u);
  let ints_log2 = dump.is_64bpp;
  let tile_size = vec2<u32>(80u >> ints_log2, 16u);
  let tile = s / tile_size;
  var base = dump.base_tiles + tile.y * dump.pitch_tiles + tile.x;
  s -= tile * tile_size;
  ${depth?`let half = tile_size.x >> 1u;
  s.x = select(s.x + half, s.x - half, s.x >= half);`:''}
  let address = base * 1280u + ((s.y * tile_size.x + s.x) << ints_log2);
  return address % (1280u * 2048u);
}

fn f32_to_7e3(f: f32) -> u32 {
  if (!(f > 0.0)) { return 0u; }
  var u = bitcast<u32>(f);
  if (u >= 0x41FF8000u) { return 0x3FFu; }
  if (u < 0x3E800000u) {
    let shift = min(125u - (u >> 23u), 24u);
    u = (0x800000u | (u & 0x7FFFFFu)) >> shift;
  } else {
    u += 0xC2000000u;
  }
  u += 0x7FFFu + ((u >> 16u) & 1u);
  return (u >> 16u) & 0x3FFu;
}
fn f32_to_20e4(f: f32) -> u32 {
  if (!(f > 0.0)) { return 0u; }
  var u = bitcast<u32>(f);
  if (u >= 0x3FFFFFF8u) { return 0xFFFFFFu; }
  if (u < 0x38800000u) {
    let shift = min(113u - (u >> 23u), 24u);
    u = (0x800000u | (u & 0x7FFFFFu)) >> shift;
  } else {
    u += 0xC8000000u;
  }
  u += 3u + ((u >> 3u) & 1u);
  return (u >> 3u) & 0xFFFFFFu;
}
fn s16(f: f32) -> u32 { return u32(i32(round(clamp(f, -1.0, 1.0) * 32767.0))) & 0xFFFFu; }
fn to_unorm(f: f32, bits: u32) -> u32 { let m = f32((1u << bits) - 1u); return u32(round(clamp(f, 0.0, 1.0) * m)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= dump.width || id.y >= dump.height) { return; }
  let pixel = vec2<u32>(dump.x0 + id.x, dump.y0 + id.y);
  var lo = 0u;
  var hi = 0u;
  ${depth?`let d = textureLoad(depth_texture, vec2<i32>(pixel), 0);
  let stencil = textureLoad(stencil_texture, vec2<i32>(pixel), 0).x & 0xFFu;
  // D24FS8: Xenia's host depth takes [0, 2) to [0, 1).
  let d24 = select(u32(round(clamp(d, 0.0, 1.0) * 16777215.0)), f32_to_20e4(d * 2.0), dump.format == 1u);
  lo = (d24 << 8u) | stencil;`:`let c = textureLoad(color_texture, vec2<i32>(pixel), 0);
  switch dump.format {
    case 0u, 1u: { lo = pack4x8unorm(c); }
    case 2u, 10u: { lo = to_unorm(c.x, 10u) | (to_unorm(c.y, 10u) << 10u) | (to_unorm(c.z, 10u) << 20u) | (to_unorm(c.w, 2u) << 30u); }
    case 3u, 12u: { lo = f32_to_7e3(c.x) | (f32_to_7e3(c.y) << 10u) | (f32_to_7e3(c.z) << 20u) | (to_unorm(c.w, 2u) << 30u); }
    case 4u: { lo = s16(c.x) | (s16(c.y) << 16u); }
    case 5u: { lo = s16(c.x) | (s16(c.y) << 16u); hi = s16(c.z) | (s16(c.w) << 16u); }
    case 6u: { lo = pack2x16float(c.xy); }
    case 7u: { lo = pack2x16float(c.xy); hi = pack2x16float(c.zw); }
    case 14u: { lo = bitcast<u32>(c.x); }
    case 15u: { lo = bitcast<u32>(c.x); hi = bitcast<u32>(c.y); }
    default: { lo = pack4x8unorm(c); }
  }`}
  // One host sample: every guest sample of the pixel gets its value.
  let samples = select(select(1u, 2u, dump.msaa == 1u), 4u, dump.msaa >= 2u);
  for (var s = 0u; s < samples; s++) {
    let o = edram_offset_dwords(pixel, s);
    edram[o] = lo;
    if (dump.is_64bpp != 0u) { edram[o + 1u] = hi; }
  }
}`;
}

const PRESENT_SHADER=`struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2<f32>(f32(i == 1u) * 4.0 - 1.0, f32(i == 2u) * 4.0 - 1.0);
  return Out(vec4<f32>(p, 0.0, 1.0), vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5));
}
@group(0) @binding(0) var front: texture_2d_array<f32>;
@group(0) @binding(1) var front_sampler: sampler;
// Host swizzle of the swap fetch constant (3 bits per component: 0-3 RGBA,
// 4 zero, 5 one), as Xenia's swap texture view applies it.
@group(0) @binding(2) var<uniform> swizzle: vec4<u32>;
fn component(t: vec4<f32>, s: u32) -> f32 {
  if (s >= 5u) { return 1.0; }
  if (s == 4u) { return 0.0; }
  return t[s];
}
@fragment fn fs(i: Out) -> @location(0) vec4<f32> {
  let t = textureSample(front, front_sampler, i.uv, 0);
  let s = swizzle.x;
  return vec4<f32>(component(t, s & 7u), component(t, (s >> 3u) & 7u), component(t, (s >> 6u) & 7u), 1.0);
}`;
