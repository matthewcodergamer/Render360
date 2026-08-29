import fs from 'node:fs';
import {WASI} from 'node:wasi';
const wasmPath=process.argv[2]||'build/xenos/xenos_foundation.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);const e=instance.exports;const f=n=>e[n]??e[`_${n}`];
const required=['r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_status','r360_xenos_register','r360_xenos_memory_writes','r360_xenos_interrupts','r360_xenos_last_interrupt_mask','r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_sparse_guest_memory_read_u32_be'];for(const n of required)if(typeof f(n)!=='function')throw new Error(`missing Xenos memory/control export ${n}`);
const packet3=(opcode,count)=>((3<<30)|(((count-1)&0x3fff)<<16)|((opcode&0x7f)<<8))>>>0;
const ringPtr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;if(!ringPtr||cap<32)throw new Error('Xenos ring unavailable');
const submit=words=>{f('r360_xenos_reset')();const r=new Uint32Array(e.memory.buffer,ringPtr,cap);r.fill(0);r.set(words.map(v=>v>>>0));const ok=f('r360_xenos_submit')(words.length)>>>0;if(!ok)throw new Error(`Xenos control submit failed status=${f('r360_xenos_status')()>>>0}`);};
const readBE=address=>{const scratch=ringPtr;if((f('r360_sparse_guest_memory_read_u32_be')(address>>>0,scratch)>>>0)!==1)throw new Error(`sparse read failed @ 0x${(address>>>0).toString(16)}`);return new Uint32Array(e.memory.buffer,scratch,1)[0]>>>0;};
f('r360_sparse_guest_memory_reset')();const dataBase=0x14000000;const backing=f('r360_sparse_guest_memory_alloc')(1)>>>0;if(!backing||(f('r360_sparse_guest_memory_map')(dataBase,1,backing,0,3)>>>0)!==1)throw new Error('control sparse map failed');
// Xenos address low bits encode endian mode. 2 is 8-in-32, producing the
// canonical guest big-endian bytes when the command payload is a logical dword.
submit([packet3(0x3d,2),(dataBase|2)>>>0,0x11223344]);if(readBE(dataBase)!==0x11223344)throw new Error('MEM_WRITE endian/writeback mismatch');console.log('XENOS_MEM_WRITE_SPARSE_GUEST=PASS');
// Type-0 seeds a register, then REG_TO_MEM writes it through the same GPU
// address/endian path into authoritative sparse guest RAM.
submit([0x00000120,0xA1B2C3D4,packet3(0x3e,2),0x120,(dataBase+4|2)>>>0]);if(readBE(dataBase+4)!==0xA1B2C3D4)throw new Error('REG_TO_MEM mismatch');console.log('XENOS_REG_TO_MEM_SPARSE_GUEST=PASS');
// Conditional register write: equality compare against a register must update
// the target only when the masked value matches the reference.
submit([0x00000131,0xAABBCCDD,packet3(0x45,6),3,0x131,0xAABBCCDD,0xFFFFFFFF,0x132,0x55667788]);if((f('r360_xenos_register')(0x132)>>>0)!==0x55667788)throw new Error('COND_WRITE register path mismatch');console.log('XENOS_COND_WRITE_REGISTER=PASS');
// Shader-done event writes completion data to guest memory and updates the
// hardware event initiator register, matching the synchronization seam used by
// the D3D runtime.
submit([packet3(0x58,3),1,(dataBase+8|2)>>>0,0xCAFEBABE]);if(readBE(dataBase+8)!==0xCAFEBABE)throw new Error('EVENT_WRITE_SHD memory writeback mismatch');if((f('r360_xenos_register')(0x21F9)>>>0)!==1)throw new Error('EVENT_WRITE_SHD initiator register mismatch');console.log('XENOS_EVENT_WRITE_SHD=PASS');
submit([packet3(0x54,1),0x15]);if((f('r360_xenos_interrupts')()>>>0)!==1||(f('r360_xenos_last_interrupt_mask')()>>>0)!==0x15)throw new Error('INTERRUPT telemetry mismatch');console.log('XENOS_INTERRUPT_PACKET=PASS');
console.log('XENOS_GPU_MEMORY_CONTROL_FOUNDATION=PASS');
