const pick=(e,n)=>e[n]??e[`_${n}`];

function requireExport(e,n){const f=pick(e,n);if(typeof f!=='function')throw new Error(`missing title GPU export ${n}`);return f;}
function rangeEnd(address,bytes){if(!Number.isInteger(address)||address<0||address>0xffffffff)throw new RangeError('guest GPU address must be uint32');if(!Number.isInteger(bytes)||bytes<=0||bytes>0xffffffff)throw new RangeError('guest GPU byte count invalid');const end=address+bytes;if(end>0x100000000||end<=address)throw new RangeError('guest GPU range wraps uint32');return end;}
function hashWords(words){let h=2166136261>>>0;for(const word of words){for(let s=24;s>=0;s-=8){h^=(word>>>s)&255;h=Math.imul(h,16777619)>>>0;}}return h>>>0;}

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
  const ok=submit(trace.wordCount)>>>0;const result={source,...trace,submitted:ok===1,xenosStatus:status()>>>0,packets:packets()>>>0,draws:draws()>>>0,presents:presents()>>>0,frameGeneration:generation()>>>0,frameHash:frameHash()>>>0,lastOpcode:lastOpcode()>>>0,lastFaultWord:lastFault()>>>0};
  if(!result.submitted&&throwOnReject)throw new Error(`title Xenos stream rejected status=${result.xenosStatus} word=${result.lastFaultWord}`);return result;
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
  const trace=readCapturedTitleGpuWords({bootstrap});
  if(!trace.ready)return {...trace,submitted:false,source:'captured-title-xenos-ring'};
  return submitWords({bootstrap,trace,source:'captured-title-xenos-ring',throwOnReject});
}
