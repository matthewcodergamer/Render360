import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);const e=instance.exports;const f=n=>e[n]??e[`_${n}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_read_guest_u32_be','r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_frame_buffer','r360_xenos_frame_size','r360_xenos_frame_width','r360_xenos_frame_height','r360_xenos_frame_generation','r360_xenos_frame_hash','r360_xenos_draws','r360_xenos_presents','r360_xenos_swaps','r360_xenos_frontbuffer_ptr','r360_xenos_frontbuffer_width','r360_xenos_frontbuffer_height'];for(const n of required)if(typeof f(n)!=='function')throw new Error(`missing provenance export ${n}`);
const be=(...w)=>Uint8Array.from(w.flatMap(x=>[(x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255]));
const dform=(op,rt,ra,imm)=>((op<<26)|(rt<<21)|(ra<<16)|(imm&0xffff))>>>0,stw=(rs,ra,d)=>dform(36,rs,ra,d),blr=0x4E800020;
const good=[0x00012000,64,0,0x00002104,0xF,0xC0003600,4,((3<<30)|(3<<16)|(0x64<<8))>>>0,0x50415753,0x00123000,1280,720].map(x=>x>>>0);
const program=be(...Array.from({length:good.length},(_,i)=>stw(5+i,4,i*4)),blr);
const commandAddress=0x80000400;
function produce(words){
  f('r360_ppc_probe_reset')();const p=f('r360_ppc_probe_input_buffer')()>>>0;new Uint8Array(e.memory.buffer,p,program.length).set(program);f('r360_ppc_probe_set_initial_gpr')(4,BigInt(commandAddress));
  for(let i=0;i<good.length;i++)if((f('r360_ppc_probe_set_initial_gpr')(5+i,BigInt(words[i]>>>0))>>>0)!==1)throw new Error(`critic set r${5+i} failed`);
  if((f('r360_ppc_probe_load')(p,program.length)>>>0)!==program.length)throw new Error('critic producer load failed');if(!(f('r360_ppc_probe_translate')()>>>0))throw new Error('critic producer translate failed');if((f('r360_ppc_probe_correctness_status')()>>>0)!==3)throw new Error('critic producer did not return');return Array.from({length:good.length},(_,i)=>f('r360_ppc_probe_read_guest_u32_be')(commandAddress+i*4)>>>0);
}
function submit(words){f('r360_xenos_reset')();const ptr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;if(words.length>cap)throw new Error('critic ring overflow');const ring=new Uint32Array(e.memory.buffer,ptr,cap);ring.fill(0);ring.set(words.map(x=>x>>>0));return f('r360_xenos_submit')(words.length)>>>0;}
const produced=produce(good);for(let i=0;i<good.length;i++)if(produced[i]!==good[i])throw new Error(`critic provenance mismatch at ${i}`);console.log('FRAME_CRITIC_TRANSLATED_PPC_PROVENANCE=PASS');
if(!submit(produced))throw new Error('critic rejected valid guest stream');if((f('r360_xenos_draws')()>>>0)!==1||(f('r360_xenos_swaps')()>>>0)!==1||(f('r360_xenos_presents')()>>>0)!==1)throw new Error('critic draw/swap/present count mismatch');
if((f('r360_xenos_frontbuffer_ptr')()>>>0)!==0x00123000||(f('r360_xenos_frontbuffer_width')()>>>0)!==1280||(f('r360_xenos_frontbuffer_height')()>>>0)!==720)throw new Error('critic swap metadata mismatch');
const width=f('r360_xenos_frame_width')()>>>0,height=f('r360_xenos_frame_height')()>>>0,size=f('r360_xenos_frame_size')()>>>0,ptr=f('r360_xenos_frame_buffer')()>>>0,gen=f('r360_xenos_frame_generation')()>>>0,hash=f('r360_xenos_frame_hash')()>>>0;if(!ptr||!width||!height||size!==width*height*4||gen!==1||!hash)throw new Error('critic framebuffer contract invalid');const pixels=new Uint8Array(e.memory.buffer,ptr,size);let nonzero=0;for(let i=0;i<pixels.length;i++)nonzero|=pixels[i];if(!nonzero)throw new Error('critic framebuffer is all zero');console.log('FRAME_CRITIC_GUEST_EDRAM_PIXELS=PASS');
const corrupt=[...good];corrupt[6]=0x3F;const corruptProduced=produce(corrupt);if(submit(corruptProduced)!==0)throw new Error('critic accepted unsupported guest primitive');if((f('r360_xenos_frame_generation')()>>>0)!==0||(f('r360_xenos_presents')()>>>0)!==0||(f('r360_xenos_swaps')()>>>0)!==0)throw new Error('critic detected fake frame before valid swap');console.log('FRAME_CRITIC_NO_FAKE_PRESENT=PASS');
const truncated=good.slice(0,11);if(submit(truncated)!==0)throw new Error('critic accepted truncated XE_SWAP stream');if((f('r360_xenos_frame_generation')()>>>0)!==0||(f('r360_xenos_presents')()>>>0)!==0)throw new Error('critic frame generated from truncated swap');console.log('FRAME_CRITIC_TRUNCATION_FAIL_CLOSED=PASS');
console.log('FIRST_GUEST_SWAP_PROVENANCE_CRITIC=PASS');
