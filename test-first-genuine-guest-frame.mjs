import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);const e=instance.exports;const f=n=>e[n]??e[`_${n}`];
const req=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_read_guest_u32_be','r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_draws','r360_xenos_presents','r360_xenos_swaps','r360_xenos_frontbuffer_ptr','r360_xenos_frontbuffer_width','r360_xenos_frontbuffer_height','r360_xenos_frame_generation','r360_xenos_frame_hash'];for(const n of req)if(typeof f(n)!=='function')throw new Error(`missing first-frame export ${n}`);
const wordsToBytes=(...words)=>Uint8Array.from(words.flatMap(w=>[(w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255]));
const dform=(op,rt,ra,imm)=>((op<<26)|(rt<<21)|(ra<<16)|(imm&0xffff))>>>0;const stw=(rs,ra,d)=>dform(36,rs,ra,d),blr=0x4E800020;
// Guest PPC itself writes the full command stream, including the real VdSwap
// XE_SWAP packet. This proves frame-boundary provenance is downstream of guest
// execution rather than a JS-authored present call.
const commandWordCount=12;
const ppc=wordsToBytes(...Array.from({length:commandWordCount},(_,i)=>stw(5+i,4,i*4)),blr);
const guestCommandAddress=0x80000400;
const pm4=[(1<<16)|0x2000,64,0,0x2104,0xF,((3<<30)|(0x36<<8))>>>0,4,((3<<30)|(3<<16)|(0x64<<8))>>>0,0x50415753,0x00123000,1280,720].map(x=>x>>>0);
function executeGuestProducer(commandWords){
  f('r360_ppc_probe_reset')();
  const input=f('r360_ppc_probe_input_buffer')()>>>0,cap=f('r360_ppc_probe_input_capacity')()>>>0;
  if(ppc.length>cap)throw new Error('PPC program exceeds input capacity');
  new Uint8Array(e.memory.buffer,input,ppc.length).set(ppc);
  f('r360_ppc_probe_set_initial_gpr')(4,BigInt(guestCommandAddress));
  for(let n=0;n<commandWordCount;n++)if((f('r360_ppc_probe_set_initial_gpr')(5+n,BigInt(commandWords[n]>>>0))>>>0)!==1)throw new Error(`set r${5+n} failed`);
  const loaded=f('r360_ppc_probe_load')(input,ppc.length)>>>0;
  if(loaded!==ppc.length)throw new Error(`guest PPC load failed loaded=${loaded}`);
  if((f('r360_ppc_probe_translate')()>>>0)===0)throw new Error('guest PPC translation failed');
  if((f('r360_ppc_probe_correctness_status')()>>>0)!==3)throw new Error('guest PPC did not execute to return boundary');
  return Array.from({length:commandWordCount},(_,n)=>f('r360_ppc_probe_read_guest_u32_be')(guestCommandAddress+n*4)>>>0);
}
function submitProduced(produced){
  f('r360_xenos_reset')();
  const ringPtr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;
  if(produced.length>cap)throw new Error('produced command stream exceeds ring');
  const ring=new Uint32Array(e.memory.buffer,ringPtr,cap);ring.fill(0);ring.set(produced);
  return f('r360_xenos_submit')(produced.length)>>>0;
}
const produced=executeGuestProducer(pm4);
for(let n=0;n<pm4.length;n++)if(produced[n]!==pm4[n])throw new Error(`translated PPC command mismatch word ${n}: got=0x${produced[n].toString(16)} expected=0x${pm4[n].toString(16)}`);
console.log('TRANSLATED_PPC_GPU_COMMAND_PRODUCTION=PASS');
if(!submitProduced(produced))throw new Error('guest-produced Xenos stream rejected');
if((f('r360_xenos_draws')()>>>0)!==1||(f('r360_xenos_swaps')()>>>0)!==1||(f('r360_xenos_presents')()>>>0)!==1)throw new Error('guest-produced stream did not draw then swap');
if((f('r360_xenos_frontbuffer_ptr')()>>>0)!==0x00123000||(f('r360_xenos_frontbuffer_width')()>>>0)!==1280||(f('r360_xenos_frontbuffer_height')()>>>0)!==720)throw new Error('guest-produced swap metadata mismatch');
const generation=f('r360_xenos_frame_generation')()>>>0,hash=f('r360_xenos_frame_hash')()>>>0;if(generation!==1||!hash)throw new Error('guest-produced swap frame missing');
console.log('TRANSLATED_PPC_TO_XENOS_DRAW=PASS');console.log('GUEST_PRODUCED_XE_SWAP_FRAME_BOUNDARY=PASS');
// Negative control: the bad draw occurs before XE_SWAP, so the command stream
// must fail closed without manufacturing a present/frame.
const bad=[...pm4];bad[6]=0x3F;const badProduced=executeGuestProducer(bad);
if(submitProduced(badProduced)!==0)throw new Error('corrupted guest-produced GPU stream rendered');
if((f('r360_xenos_frame_generation')()>>>0)!==0||(f('r360_xenos_presents')()>>>0)!==0||(f('r360_xenos_swaps')()>>>0)!==0)throw new Error('frame appeared before a valid guest swap');
console.log('GUEST_FRAME_PROVENANCE_NEGATIVE_CONTROL=PASS');console.log('FIRST_GUEST_SWAP_FRAME_FOUNDATION=PASS');
