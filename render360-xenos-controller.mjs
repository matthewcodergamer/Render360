import {xenosFrameView} from './render360-webgpu-xenos.mjs';

const pick=(e,n)=>e[n]??e[`_${n}`];

export function submitGuestXenosWords({guestMemory,guestAddress,wordCount,xenosInstance}){
  if(!(guestMemory instanceof WebAssembly.Memory))throw new TypeError('guestMemory must be WebAssembly.Memory');
  const e=xenosInstance.exports;const ringPtr=pick(e,'r360_xenos_ring_buffer')()>>>0;const cap=pick(e,'r360_xenos_ring_capacity')()>>>0;
  if(!Number.isInteger(guestAddress)||!Number.isInteger(wordCount)||guestAddress<0||wordCount<=0||wordCount>cap)throw new RangeError('invalid guest Xenos range');
  const byteCount=wordCount*4;if(guestAddress+byteCount>guestMemory.buffer.byteLength)throw new RangeError('guest Xenos range outside memory');
  const src=new DataView(guestMemory.buffer,guestAddress,byteCount);const dst=new Uint32Array(e.memory.buffer,ringPtr,cap);
  // Xbox 360 PPC guest command words are stored big-endian; the Xenos semantic
  // module consumes host uint32 values after the same byte swap Xenia performs.
  for(let i=0;i<wordCount;i++)dst[i]=src.getUint32(i*4,false);
  const ok=pick(e,'r360_xenos_submit')(wordCount)>>>0;if(!ok){const status=pick(e,'r360_xenos_status')()>>>0;const fault=pick(e,'r360_xenos_last_fault_word')()>>>0;throw new Error(`Xenos command stream rejected status=${status} word=${fault}`);}
  return xenosFrameView(xenosInstance);
}

export function writeGuestCommandWord(memory,address,value){
  if(address<0||address+4>memory.buffer.byteLength)throw new RangeError('guest command write outside memory');
  new DataView(memory.buffer).setUint32(address,value>>>0,false);
}
