import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);const e=instance.exports;const f=n=>e[n]??e[`_${n}`];
const req=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_read_guest_u32_be','r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_draws','r360_xenos_presents','r360_xenos_frame_generation','r360_xenos_frame_hash'];for(const n of req)if(typeof f(n)!=='function')throw new Error(`missing first-frame export ${n}`);
const wordsToBytes=(...words)=>Uint8Array.from(words.flatMap(w=>[(w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255]));
// Guest PPC program: stw r5..r11 into 7 consecutive command words at r4, then blr.
const ppc=wordsToBytes(0x90A40000,0x90C40004,0x90E40008,0x9104000C,0x91240010,0x91440014,0x91640018,0x4E800020);
const guestCommandAddress=0x80000400;
const pm4=[(1<<16)|0x2000,64,0,(0<<16)|0x2104,0xF,(3<<30)|(0x36<<8),4];
function executeGuestProducer(commandWords){
  f('r360_ppc_probe_reset')();
  const input=f('r360_ppc_probe_input_buffer')()>>>0,cap=f('r360_ppc_probe_input_capacity')()>>>0;
  if(ppc.length>cap)throw new Error('PPC program exceeds input capacity');
  new Uint8Array(e.memory.buffer,input,ppc.length).set(ppc);
  f('r360_ppc_probe_set_initial_gpr')(4,BigInt(guestCommandAddress));
  for(let n=0;n<7;n++)f('r360_ppc_probe_set_initial_gpr')(5+n,BigInt(commandWords[n]>>>0));
  const loaded=f('r360_ppc_probe_load')(input,ppc.length)>>>0;
  if(loaded!==ppc.length)throw new Error(`guest PPC load failed loaded=${loaded}`);
  if((f('r360_ppc_probe_translate')()>>>0)===0)throw new Error('guest PPC translation failed');
  if((f('r360_ppc_probe_correctness_status')()>>>0)!==3)throw new Error('guest PPC did not execute to return boundary');
  const produced=[];for(let n=0;n<7;n++)produced.push(f('r360_ppc_probe_read_guest_u32_be')(guestCommandAddress+n*4)>>>0);return produced;
}
function submitProduced(produced){
  f('r360_xenos_reset')();
  const ringPtr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;
  if(produced.length>cap)throw new Error('produced command stream exceeds ring');
  const ring=new Uint32Array(e.memory.buffer,ringPtr,cap);for(let n=0;n<produced.length;n++)ring[n]=produced[n]>>>0;
  return f('r360_xenos_submit')(produced.length)>>>0;
}
const produced=executeGuestProducer(pm4);
for(let n=0;n<pm4.length;n++)if(produced[n]!==pm4[n])throw new Error(`translated PPC command mismatch word ${n}: got=0x${produced[n].toString(16)} expected=0x${pm4[n].toString(16)}`);
console.log('TRANSLATED_PPC_GPU_COMMAND_PRODUCTION=PASS');
if(!submitProduced(produced))throw new Error('guest-produced Xenos stream rejected');
if((f('r360_xenos_draws')()>>>0)!==1||(f('r360_xenos_presents')()>>>0)!==1)throw new Error('guest-produced stream did not draw/present');
const generation=f('r360_xenos_frame_generation')()>>>0,hash=f('r360_xenos_frame_hash')()>>>0;if(generation!==1||!hash)throw new Error('guest-produced frame missing');
console.log('TRANSLATED_PPC_TO_XENOS_DRAW=PASS');console.log('GUEST_PRODUCED_EDRAM_FRAME=PASS');
// Provenance negative control: translated PPC creates a corrupted primitive; Xenos must reject it and produce no frame.
const bad=[...pm4];bad[6]=0x3F;const badProduced=executeGuestProducer(bad);
if(submitProduced(badProduced)!==0)throw new Error('corrupted guest-produced GPU stream rendered');
if((f('r360_xenos_frame_generation')()>>>0)!==0||(f('r360_xenos_presents')()>>>0)!==0)throw new Error('frame appeared without a valid guest draw');
console.log('GUEST_FRAME_PROVENANCE_NEGATIVE_CONTROL=PASS');console.log('FIRST_GENUINE_GUEST_FRAME=PASS');
