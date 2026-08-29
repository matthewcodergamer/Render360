import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const im of WebAssembly.Module.imports(module))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const e=instance.exports;const f=n=>e[n]??e[`_${n}`];
for(const n of ['r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_status','r360_pe_guest_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_scanned_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_ppc_probe_guest_base','r360_ppc_probe_loaded_size','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_instructions','r360_ppc_probe_correctness_r3'])if(typeof f(n)!=='function')throw new Error(`missing scanned-entry export ${n}`);

const p16=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const be32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};

function makeProgramPE(base){
  const a=new Uint8Array(0x400),nt=0x80,opt=nt+24,sh=opt+224;
  p16(a,0,0x5A4D);p32(a,0x3c,nt);p32(a,nt,0x00004550);
  p16(a,nt+4,0x01F2);p16(a,nt+6,1);p16(a,nt+20,224);p16(a,nt+22,0x0102);
  p16(a,opt,0x10B);p32(a,opt+16,0x1000);p32(a,opt+28,base);p32(a,opt+32,0x1000);p32(a,opt+36,0x200);p32(a,opt+56,0x2000);p32(a,opt+60,0x200);p16(a,opt+68,14);
  a.set(Buffer.from('.text\0\0\0','ascii'),sh);p32(a,sh+8,0x200);p32(a,sh+12,0x1000);p32(a,sh+16,0x200);p32(a,sh+20,0x200);p32(a,sh+36,0x60000020);
  // The third instruction is intentionally beyond the historical 8-byte
  // handoff. A real scanned function must execute it before returning.
  be32(a,0x200,0x38600001); // li r3,1
  be32(a,0x204,0x38600002); // li r3,2
  be32(a,0x208,0x38600003); // li r3,3 -- beyond byte 8
  be32(a,0x20c,0x4E800020); // blr
  return a;
}

const base=0x86000000,entry=(base+0x1000)>>>0;
const pe=makeProgramPE(base);const input=f('r360_xex_guest_mapper_input_buffer')()>>>0,cap=f('r360_xex_guest_mapper_input_capacity')()>>>0;
if(!input||pe.length>cap)throw new Error('scanned-entry PE staging unavailable');
new Uint8Array(e.memory.buffer,input,pe.length).set(pe);
if((f('r360_pe_guest_load')(input,pe.length)>>>0)!==1)throw new Error(`scanned-entry PE load failed 0x${(f('r360_pe_guest_status')()>>>0).toString(16)}`);
if((f('r360_pe_guest_entry_address')()>>>0)!==entry)throw new Error('scanned-entry PE entry mismatch');

f('r360_title_handoff_reset')();
const hir=f('r360_title_handoff_translate_scanned_entry')()>>>0;
if(!hir)throw new Error(`scanned title entry failed 0x${(f('r360_title_handoff_status')()>>>0).toString(16)}`);
if((f('r360_title_handoff_status')()>>>0)!==1)throw new Error('scanned handoff status mismatch');
if((f('r360_title_handoff_entry_address')()>>>0)!==entry)throw new Error('scanned handoff entry mismatch');
const loaded=f('r360_title_handoff_bytes')()>>>0;
if(loaded<=8)throw new Error(`scanned entry still bounded to historical byte probe (${loaded})`);
if((f('r360_ppc_probe_loaded_size')()>>>0)!==loaded)throw new Error('scanned entry loaded-span telemetry mismatch');
if((f('r360_ppc_probe_correctness_status')()>>>0)!==3)throw new Error('scanned title entry did not reach guest return');
if((f('r360_ppc_probe_correctness_instructions')()>>>0)<4)throw new Error('scanned title entry executed too few HIR instructions');
if(BigInt.asUintN(64,f('r360_ppc_probe_correctness_r3')())!==3n)throw new Error('scanned title entry did not execute instruction beyond byte 8');
console.log('TITLE_SCANNED_ENTRY_RX_PAGING=PASS');
console.log('TITLE_SCANNED_ENTRY_XENIA_FUNCTION_SCAN=PASS');
console.log('TITLE_SCANNED_ENTRY_BEYOND_8_BYTES=PASS');
console.log('TITLE_SCANNED_ENTRY_EXECUTION=PASS');
