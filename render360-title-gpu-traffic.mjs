const pick=(e,n)=>e[n]??e[`_${n}`];

function requireExport(e,n){const f=pick(e,n);if(typeof f!=='function')throw new Error(`missing title GPU export ${n}`);return f;}
function optionalExport(e,n){const f=pick(e,n);return typeof f==='function'?f:null;}
function rangeEnd(address,bytes){if(!Number.isInteger(address)||address<0||address>0xffffffff)throw new RangeError('guest GPU address must be uint32');if(!Number.isInteger(bytes)||bytes<=0||bytes>0xffffffff)throw new RangeError('guest GPU byte count invalid');const end=address+bytes;if(end>0x100000000||end<=address)throw new RangeError('guest GPU range wraps uint32');return end;}
function hashWords(words){let h=2166136261>>>0;for(const word of words){for(let s=24;s>=0;s-=8){h^=(word>>>s)&255;h=Math.imul(h,16777619)>>>0;}}return h>>>0;}
function signExtend(value,bits){const shift=32-bits;return (value<<shift)>>shift;}

const TEXTURE_FORMAT_NAMES={0:'1_REVERSE',1:'1',2:'8',3:'1_5_5_5',4:'5_6_5',5:'6_5_5',6:'8_8_8_8',7:'2_10_10_10',8:'8_A',9:'8_B',10:'8_8',11:'Cr_Y1_Cb_Y0_REP',12:'Y1_Cr_Y0_Cb_REP',13:'16_16_EDRAM',14:'8_8_8_8_A',15:'4_4_4_4',16:'10_11_11',17:'11_11_10',18:'DXT1',19:'DXT2_3',20:'DXT4_5',21:'16_16_16_16_EDRAM',22:'24_8',23:'24_8_FLOAT',24:'16',25:'16_16',26:'16_16_16_16',27:'16_EXPAND',28:'16_16_EXPAND',29:'16_16_16_16_EXPAND',30:'16_FLOAT',31:'16_16_FLOAT',32:'16_16_16_16_FLOAT',33:'32',34:'32_32',35:'32_32_32_32',36:'32_FLOAT',37:'32_32_FLOAT',38:'32_32_32_32_FLOAT',39:'32_AS_8',40:'32_AS_8_8',41:'16_MPEG',42:'16_16_MPEG',43:'8_INTERLACED',44:'32_AS_8_INTERLACED',45:'32_AS_8_8_INTERLACED',46:'16_INTERLACED',47:'16_MPEG_INTERLACED',48:'16_16_MPEG_INTERLACED',49:'DXN',50:'8_8_8_8_AS_16_16_16_16',51:'DXT1_AS_16_16_16_16',52:'DXT2_3_AS_16_16_16_16',53:'DXT4_5_AS_16_16_16_16'};
const DIMENSION_NAMES=['1d','2d-or-stacked','3d','cube'];
const ENDIAN_NAMES=['none','8in16','8in32','16in32'];

// Exact decode of upstream Xenia xe_gpu_texture_fetch_t. Xenos texture fetch
// constants are six 32-bit words. Sizes are stored minus one and base/mip
// addresses omit the low 12 alignment bits.
export function decodeXenosTextureFetchConstant(words){
  if(!Array.isArray(words)&&!ArrayBuffer.isView(words))throw new TypeError('texture fetch constant must be six dwords');
  if(words.length!==6)throw new RangeError(`texture fetch constant requires 6 dwords, got ${words.length}`);
  const w=Array.from(words,v=>Number(v)>>>0),d0=w[0],d1=w[1],d2=w[2],d3=w[3],d4=w[4],d5=w[5];
  const type=d0&3,dimension=(d5>>>9)&3,format=d1&0x3f,endianness=(d1>>>6)&3;
  const baseAddress=((d1>>>12)<<12)>>>0,mipAddress=((d5>>>12)<<12)>>>0;
  let width=1,height=1,depth=1,stackDepth=1;
  if(dimension===0){width=(d2&0xffffff)+1;}
  else if(dimension===1||dimension===3){width=(d2&0x1fff)+1;height=((d2>>>13)&0x1fff)+1;const encodedStack=(d2>>>26)&0x3f;stackDepth=encodedStack+1;depth=dimension===3?6:(d0>>>10&0x7)?stackDepth:1;}
  else{width=(d2&0x7ff)+1;height=((d2>>>11)&0x7ff)+1;depth=((d2>>>22)&0x3ff)+1;}
  return {type,isTexture:type===2,dimension,dimensionName:DIMENSION_NAMES[dimension],format,formatName:TEXTURE_FORMAT_NAMES[format]??`format-${format}`,endianness,endiannessName:ENDIAN_NAMES[endianness],requestSize:(d1>>>8)&3,stacked:!!((d1>>>10)&1),nearestClampPolicy:(d1>>>11)&1,baseAddress,mipAddress,width,height,depth,stackDepth,pitchPixels:((d0>>>22)&0x1ff)<<5,tiled:!!(d0>>>31),numFormat:d3&1,swizzle:(d3>>>1)&0xfff,expAdjust:signExtend((d3>>>13)&0x3f,6),magFilter:(d3>>>19)&3,minFilter:(d3>>>21)&3,mipFilter:(d3>>>23)&3,anisoFilter:(d3>>>25)&7,borderSize:(d3>>>31)&1,mipMinLevel:(d4>>>2)&0xf,mipMaxLevel:(d4>>>6)&0xf,lodBias:signExtend((d4>>>12)&0x3ff,10),packedMips:!!((d5>>>11)&1),words:w,wordHash:hashWords(w)};
}

function probeReadableGuestByte(e,address){
  if(!address)return false;
  const read=optionalExport(e,'r360_sparse_guest_memory_read_u8'),fault=optionalExport(e,'r360_sparse_guest_memory_last_fault_code');
  if(!read||!fault)return null;
  read(address>>>0);
  return (fault()>>>0)===0;
}

function readShaderProvenance(e,type){
  const dwords=optionalExport(e,'r360_xenos_shader_dwords'),hash=optionalExport(e,'r360_xenos_shader_hash'),address=optionalExport(e,'r360_xenos_shader_guest_address'),source=optionalExport(e,'r360_xenos_shader_source'),buffer=optionalExport(e,'r360_xenos_shader_buffer');
  if(!dwords||!hash||!address||!source||!buffer)return {available:false,type,dwordCount:0,hash:0,guestAddress:0,source:0,words:[]};
  const dwordCount=dwords(type)>>>0,ptr=buffer(type)>>>0;
  const words=dwordCount&&ptr?Array.from(new Uint32Array(e.memory.buffer,ptr,dwordCount),v=>v>>>0):[];
  return {available:true,type,dwordCount,hash:hash(type)>>>0,guestAddress:address(type)>>>0,source:source(type)>>>0,words};
}

function readFetchConstantGroups(e){
  const read=optionalExport(e,'r360_xenos_fetch_constant_word');if(!read)return [];
  const groups=[];
  for(let group=0;group<32;group++){
    const words=Array.from({length:6},(_,word)=>read(group,word)>>>0);
    if(words.some(Boolean)){
      const texture=decodeXenosTextureFetchConstant(words);
      const baseMapped=texture.isTexture?probeReadableGuestByte(e,texture.baseAddress):false;
      const mipMapped=texture.isTexture&&texture.mipAddress?probeReadableGuestByte(e,texture.mipAddress):null;
      groups.push({group,words,wordHash:hashWords(words),texture:{...texture,baseMapped,mipMapped,resourceBacked:baseMapped===true&&(mipMapped!==false)}});
    }
  }
  return groups;
}

export function readXenosTitleState({bootstrap}){
  if(!bootstrap?.exports)throw new TypeError('bootstrap instance required');
  const e=bootstrap.exports;
  const optional=n=>{const fn=optionalExport(e,n);return fn?fn()>>>0:0};
  const indirect=optionalExport(e,'r360_xenos_indirect_buffers'),loads=optionalExport(e,'r360_xenos_shader_loads'),faultDepth=optionalExport(e,'r360_xenos_last_fault_depth'),invalidate=optionalExport(e,'r360_xenos_last_invalidate_mask');
  const vertexShader=readShaderProvenance(e,0),pixelShader=readShaderProvenance(e,1),fetchConstantGroups=readFetchConstantGroups(e);
  const textureResources=fetchConstantGroups.filter(g=>g.texture?.isTexture).map(g=>({group:g.group,...g.texture}));
  const backedTextureResources=textureResources.filter(r=>r.resourceBacked);
  const swaps=optional('r360_xenos_swaps'),frontbufferPtr=optional('r360_xenos_frontbuffer_ptr'),frontbufferWidth=optional('r360_xenos_frontbuffer_width'),frontbufferHeight=optional('r360_xenos_frontbuffer_height'),frameProvenance=optional('r360_xenos_frame_provenance'),realTitleFrameReady=optional('r360_xenos_real_title_frame_ready')===1;
  return {vertexShader,pixelShader,fetchConstantGroups,textureResources,backedTextureResources,shaderLoads:loads?loads()>>>0:0,indirectBuffers:indirect?indirect()>>>0:0,memoryWrites:optional('r360_xenos_memory_writes'),interrupts:optional('r360_xenos_interrupts'),lastInterruptMask:optional('r360_xenos_last_interrupt_mask'),lastFaultDepth:faultDepth?faultDepth()>>>0:0,lastInvalidateMask:invalidate?invalidate()>>>0:0,swaps,frontbufferPtr,frontbufferWidth,frontbufferHeight,frameProvenance,realTitleFrameReady,hasRealSwap:swaps>0,hasTitleShaders:vertexShader.dwordCount>0||pixelShader.dwordCount>0,hasBothTitleShaders:vertexShader.dwordCount>0&&pixelShader.dwordCount>0,hasFetchResources:fetchConstantGroups.length>0,hasDecodedTextureResources:textureResources.length>0,hasBackedTextureResources:backedTextureResources.length>0};
}

function currentXenosResult({bootstrap,source,throwOnReject=false}){
  const e=bootstrap.exports;
  const status=requireExport(e,'r360_xenos_status')()>>>0,packets=requireExport(e,'r360_xenos_packets')()>>>0,draws=requireExport(e,'r360_xenos_draws')()>>>0,presents=requireExport(e,'r360_xenos_presents')()>>>0,generation=requireExport(e,'r360_xenos_frame_generation')()>>>0,frameHash=requireExport(e,'r360_xenos_frame_hash')()>>>0,lastOpcode=requireExport(e,'r360_xenos_last_opcode')()>>>0,lastFaultWord=requireExport(e,'r360_xenos_last_fault_word')()>>>0;
  const titleState=readXenosTitleState({bootstrap});
  const titleStatus=optionalExport(e,'r360_title_gpu_status')?.()>>>0||0,guestAddress=optionalExport(e,'r360_title_gpu_ring_base')?.()>>>0||0,ringCapacity=optionalExport(e,'r360_title_gpu_ring_word_capacity')?.()>>>0||0,writePointer=optionalExport(e,'r360_title_gpu_write_pointer')?.()>>>0||0;
  const submitted=status===1;
  const result={ready:true,reason:submitted?'native-mmio-ring-drained':'native-mmio-xenos-rejected',status:titleStatus,guestAddress,ringCapacity,writePointer,wordCount:0,words:[],wordHash:0,source,nativeDrained:true,submitted,xenosStatus:status,packets,draws,presents,frameGeneration:generation,frameHash,lastOpcode,lastFaultWord,...titleState};
  if(!submitted&&throwOnReject)throw new Error(`title Xenos stream rejected status=${result.xenosStatus} word=${result.lastFaultWord} depth=${result.lastFaultDepth}`);
  return result;
}

export function readTitleGpuWords({bootstrap,guestAddress,wordCount}){
  if(!bootstrap?.exports)throw new TypeError('bootstrap instance required');
  if(!Number.isInteger(wordCount)||wordCount<=0)throw new RangeError('GPU word count must be positive');
  const e=bootstrap.exports;const cap=requireExport(e,'r360_xenos_ring_capacity')()>>>0;if(wordCount>cap)throw new RangeError(`title GPU stream exceeds Xenos ring ${wordCount}/${cap}`);
  rangeEnd(guestAddress,wordCount*4);
  const read=requireExport(e,'r360_ppc_probe_read_guest_u32_be');const words=Array.from({length:wordCount},(_,i)=>read((guestAddress+i*4)>>>0)>>>0);
  return {guestAddress:guestAddress>>>0,wordCount,words,wordHash:hashWords(words)};
}

function submitWords({bootstrap,trace,source,throwOnReject=false}){
  const e=bootstrap.exports;
  const reset=requireExport(e,'r360_xenos_reset'),ringBuffer=requireExport(e,'r360_xenos_ring_buffer'),submit=requireExport(e,'r360_xenos_submit');
  const status=requireExport(e,'r360_xenos_status'),packets=requireExport(e,'r360_xenos_packets'),draws=requireExport(e,'r360_xenos_draws'),presents=requireExport(e,'r360_xenos_presents'),generation=requireExport(e,'r360_xenos_frame_generation'),frameHash=requireExport(e,'r360_xenos_frame_hash'),lastOpcode=requireExport(e,'r360_xenos_last_opcode'),lastFault=requireExport(e,'r360_xenos_last_fault_word');
  reset();const ptr=ringBuffer()>>>0,cap=requireExport(e,'r360_xenos_ring_capacity')()>>>0;if(!ptr)throw new Error('Xenos ring pointer unavailable');if(trace.wordCount>cap)throw new RangeError(`title GPU stream exceeds Xenos decoder ring ${trace.wordCount}/${cap}`);
  const ring=new Uint32Array(e.memory.buffer,ptr,cap);ring.fill(0);for(let i=0;i<trace.words.length;i++)ring[i]=trace.words[i]>>>0;
  const ok=submit(trace.wordCount)>>>0;const titleState=readXenosTitleState({bootstrap});const result={source,...trace,submitted:ok===1,xenosStatus:status()>>>0,packets:packets()>>>0,draws:draws()>>>0,presents:presents()>>>0,frameGeneration:generation()>>>0,frameHash:frameHash()>>>0,lastOpcode:lastOpcode()>>>0,lastFaultWord:lastFault()>>>0,...titleState};
  if(!result.submitted&&throwOnReject)throw new Error(`title Xenos stream rejected status=${result.xenosStatus} word=${result.lastFaultWord} depth=${result.lastFaultDepth}`);return result;
}

export function submitTitleGpuTraffic({bootstrap,guestAddress,wordCount,throwOnReject=false}){
  const trace=readTitleGpuWords({bootstrap,guestAddress,wordCount});
  return submitWords({bootstrap,trace,source:'mapped-xex-ppc-guest-memory',throwOnReject});
}

export function readCapturedTitleGpuWords({bootstrap}){
  if(!bootstrap?.exports)throw new TypeError('bootstrap instance required');
  const e=bootstrap.exports;
  const status=requireExport(e,'r360_title_gpu_status')()>>>0;
  const guestAddress=requireExport(e,'r360_title_gpu_ring_base')()>>>0;
  const ringCapacity=requireExport(e,'r360_title_gpu_ring_word_capacity')()>>>0;
  const writePointer=requireExport(e,'r360_title_gpu_write_pointer')()>>>0;
  if(status<1||!guestAddress||!ringCapacity)return {ready:false,reason:'ring-not-initialized',status,guestAddress,ringCapacity,writePointer,wordCount:0,words:[],wordHash:0};
  if(status<2||!writePointer)return {ready:false,reason:'producer-write-pointer-not-observed',status,guestAddress,ringCapacity,writePointer,wordCount:0,words:[],wordHash:0};
  if(writePointer>ringCapacity)return {ready:false,reason:'write-pointer-out-of-range',status,guestAddress,ringCapacity,writePointer,wordCount:0,words:[],wordHash:0};
  const xenosCapacity=requireExport(e,'r360_xenos_ring_capacity')()>>>0;
  if(writePointer>xenosCapacity)return {ready:false,reason:'captured-ring-exceeds-decoder-capacity',status,guestAddress,ringCapacity,writePointer,decoderCapacity:xenosCapacity,wordCount:0,words:[],wordHash:0};
  const read=requireExport(e,'r360_title_gpu_ring_word');
  const scratch=requireExport(e,'r360_ppc_probe_input_buffer')()>>>0;
  if(!scratch)throw new Error('title GPU ring scratch pointer unavailable');
  const scratch32=new Uint32Array(e.memory.buffer,scratch,1);
  const words=[];
  for(let i=0;i<writePointer;i++){
    scratch32[0]=0;
    if((read(i,scratch)>>>0)!==1)return {ready:false,reason:'captured-ring-word-unmapped',status,guestAddress,ringCapacity,writePointer,faultIndex:i,wordCount:words.length,words,wordHash:hashWords(words)};
    words.push(scratch32[0]>>>0);
  }
  return {ready:true,reason:'captured-title-ring-ready',status,guestAddress,ringCapacity,writePointer,wordCount:words.length,words,wordHash:hashWords(words)};
}

export function submitCapturedTitleGpuTraffic({bootstrap,throwOnReject=false}={}){
  if(!bootstrap?.exports)throw new TypeError('bootstrap instance required');
  const e=bootstrap.exports;
  // Modern bootstraps synchronously drain the actual circular title ring from
  // the translated PPC CP_RB_WPTR MMIO write. Never reset or replay that state
  // from JavaScript: doing so destroys real register/shader/resource history.
  const xenosStatus=optionalExport(e,'r360_xenos_status')?.()>>>0||0;
  const packets=optionalExport(e,'r360_xenos_packets')?.()>>>0||0;
  if(xenosStatus!==0||packets>0)return currentXenosResult({bootstrap,source:'native-cp-rb-wptr-drain',throwOnReject});
  // Compatibility fallback for older published bootstraps with telemetry-only
  // ring capture and no native MMIO consumer.
  const trace=readCapturedTitleGpuWords({bootstrap});
  if(!trace.ready)return {...trace,submitted:false,source:'captured-title-xenos-ring'};
  return submitWords({bootstrap,trace,source:'captured-title-xenos-ring',throwOnReject});
}
