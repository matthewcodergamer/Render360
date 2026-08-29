import fs from 'node:fs';
import { WASI } from 'node:wasi';
const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);const e=instance.exports;const f=n=>e[n]??e[`_${n}`];
for(const n of ['r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_status','r360_xenos_packets','r360_xenos_register_writes','r360_xenos_draws','r360_xenos_presents','r360_xenos_last_opcode','r360_xenos_last_fault_word','r360_xenos_register','r360_xenos_edram_tile_address','r360_xenos_frame_buffer','r360_xenos_frame_size','r360_xenos_frame_width','r360_xenos_frame_height','r360_xenos_frame_generation','r360_xenos_frame_hash'])if(typeof f(n)!=='function')throw new Error(`missing Xenos export ${n}`);
f('r360_xenos_reset')();const ptr=f('r360_xenos_ring_buffer')()>>>0;const cap=f('r360_xenos_ring_capacity')()>>>0;if(!ptr||cap<16)throw new Error('ring buffer unavailable');
const ring=new Uint32Array(e.memory.buffer,ptr,cap);
// TYPE0 write RB_SURFACE_INFO and RB_COLOR_INFO, then PM4_DRAW_INDX_2 triangle-list.
ring[0]=(1<<16)|0x2000; ring[1]=64; ring[2]=0x00000000;
ring[3]=(0<<16)|0x2104; ring[4]=0xF;
ring[5]=(3<<30)|(0<<16)|(0x36<<8); ring[6]=0x00000004;
if(!(f('r360_xenos_submit')(7)>>>0))throw new Error(`Xenos submit failed status=${f('r360_xenos_status')()>>>0}`);
if((f('r360_xenos_register')(0x2000)>>>0)!==64||(f('r360_xenos_register')(0x2104)>>>0)!==0xF)throw new Error('register writes missing');
if((f('r360_xenos_draws')()>>>0)!==1||(f('r360_xenos_presents')()>>>0)!==1||(f('r360_xenos_last_opcode')()>>>0)!==0x36)throw new Error('draw/present telemetry mismatch');
const gen=f('r360_xenos_frame_generation')()>>>0,hash=f('r360_xenos_frame_hash')()>>>0;if(gen!==1||!hash)throw new Error('frame generation/hash missing');
const framePtr=f('r360_xenos_frame_buffer')()>>>0,size=f('r360_xenos_frame_size')()>>>0;if(size!==64*64*4)throw new Error('frame size mismatch');const frame=new Uint8Array(e.memory.buffer,framePtr,size);let nonBg=0;for(let i=0;i<size;i+=4)if(frame[i]!==0x10||frame[i+1]!==0x10||frame[i+2]!==0x18)nonBg++;if(nonBg<100)throw new Error('draw produced no visible raster');
console.log('XENOS_PM4_RINGBUFFER=PASS');console.log('XENOS_REGISTER_SEMANTICS=PASS');console.log('XENOS_DRAW_TO_EDRAM=PASS');console.log('XENOS_EDRAM_RESOLVE=PASS');
// Match Xenia command-processor semantics that matter for real title setup:
// type-0 may repeatedly target one register, and type-1 writes two independent
// register indices. Also accept all-zero padding as an empty packet.
f('r360_xenos_reset')();const r1=new Uint32Array(e.memory.buffer,f('r360_xenos_ring_buffer')()>>>0,cap);
r1[0]=(1<<16)|(1<<15)|0x1234;r1[1]=0x11111111;r1[2]=0x22222222;
const regA=0x321,regB=0x456;r1[3]=(1<<30)|(regB<<11)|regA;r1[4]=0xA1B2C3D4;r1[5]=0x10203040;r1[6]=0;
if(!(f('r360_xenos_submit')(7)>>>0))throw new Error(`type0/type1 submit failed status=${f('r360_xenos_status')()>>>0}`);
if((f('r360_xenos_register')(0x1234)>>>0)!==0x22222222)throw new Error('type0 write-one-register semantics missing');
if((f('r360_xenos_register')(regA)>>>0)!==0xA1B2C3D4||(f('r360_xenos_register')(regB)>>>0)!==0x10203040)throw new Error('type1 dual-register semantics missing');
if((f('r360_xenos_register_writes')()>>>0)!==4)throw new Error('type0/type1 register write telemetry mismatch');
console.log('XENOS_TYPE0_REPEAT_REGISTER=PASS');console.log('XENOS_TYPE1_DUAL_REGISTER=PASS');console.log('XENOS_ZERO_PADDING_PACKET=PASS');
// 2048-tile circular EDRAM addressing, based on Xenia's documented Xenos layout.
if((f('r360_xenos_edram_tile_address')(2047,80,80,0)>>>0)!==0)throw new Error('EDRAM wraparound failed');if((f('r360_xenos_edram_tile_address')(3,0,0,0)>>>0)!==0xFFFFFFFF)throw new Error('zero pitch did not fail closed');
console.log('XENOS_EDRAM_TILE_WRAP=PASS');
// Unsupported opcode must fail closed and identify the offending packet.
f('r360_xenos_reset')();const r2=new Uint32Array(e.memory.buffer,f('r360_xenos_ring_buffer')()>>>0,cap);r2[0]=(3<<30)|(0<<16)|(0x7E<<8);r2[1]=1;if((f('r360_xenos_submit')(2)>>>0)!==0||(f('r360_xenos_status')()>>>0)!==2)throw new Error('unknown PM4 opcode did not fail closed');
console.log('XENOS_UNSUPPORTED_FAIL_CLOSED=PASS');console.log('XENOS_SEMANTIC_FOUNDATION=PASS');
