import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`bootstrap WASM not found: ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const im of WebAssembly.Module.imports(module))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const pick=n=>instance.exports[n]??instance.exports[`_${n}`];
const req=['memory','r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_status','r360_pe_guest_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_title_handoff_hir_instructions','r360_ppc_probe_status','r360_ppc_probe_guest_base','r360_ppc_probe_loaded_size','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3'];
for(const n of req)if(typeof pick(n)!=='function'&&n!=='memory')throw new Error(`missing handoff export ${n}`);
const p16=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const be32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const eq=(a,b,m)=>{if((a>>>0)!==(b>>>0))throw new Error(`${m}: got 0x${(a>>>0).toString(16)} expected 0x${(b>>>0).toString(16)}`)};

function makeProgramPE(base){
  const a=new Uint8Array(0x400),nt=0x80,opt=nt+24,sh=opt+224;
  p16(a,0,0x5A4D);p32(a,0x3c,nt);p32(a,nt,0x00004550);
  p16(a,nt+4,0x01F2);p16(a,nt+6,1);p16(a,nt+20,224);p16(a,nt+22,0x0102);
  p16(a,opt,0x10B);p32(a,opt+16,0x1000);p32(a,opt+28,base);p32(a,opt+32,0x1000);p32(a,opt+36,0x200);p32(a,opt+56,0x2000);p32(a,opt+60,0x200);p16(a,opt+68,14);
  a.set(Buffer.from('.text\0\0\0','ascii'),sh);p32(a,sh+8,0x200);p32(a,sh+12,0x1000);p32(a,sh+16,0x200);p32(a,sh+20,0x200);p32(a,sh+36,0x60000020);
  // PowerPC: li r3,1 ; blr. Big-endian guest instruction bytes.
  be32(a,0x200,0x38600001);be32(a,0x204,0x4E800020);
  return a;
}

const input=pick('r360_xex_guest_mapper_input_buffer')()>>>0,cap=pick('r360_xex_guest_mapper_input_capacity')()>>>0;
const run=base=>{
  const pe=makeProgramPE(base);if(pe.length>cap)throw new Error('PE staging overflow');new Uint8Array(instance.exports.memory.buffer,input,pe.length).set(pe);
  if((pick('r360_pe_guest_load')(input,pe.length)>>>0)!==1)throw new Error(`PE guest load failed 0x${(pick('r360_pe_guest_status')()>>>0).toString(16)}`);
  const entry=(base+0x1000)>>>0;eq(pick('r360_pe_guest_entry_address')(),entry,'PE entry');
  pick('r360_title_handoff_reset')();const hir=pick('r360_title_handoff_translate_entry')(8)>>>0;if(!hir)throw new Error(`entry handoff failed 0x${(pick('r360_title_handoff_status')()>>>0).toString(16)}`);
  eq(pick('r360_title_handoff_status')(),1,'handoff status');eq(pick('r360_title_handoff_entry_address')(),entry,'handoff entry');eq(pick('r360_title_handoff_bytes')(),8,'handoff bytes');eq(pick('r360_title_handoff_hir_instructions')(),hir,'handoff HIR count');
  eq(pick('r360_ppc_probe_status')(),3,'PPC translated');eq(pick('r360_ppc_probe_guest_base')(),entry,'PPC relocated base');eq(pick('r360_ppc_probe_loaded_size')(),8,'PPC loaded bytes');eq(pick('r360_ppc_probe_correctness_status')(),3,'HIR execution status');
  if(BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')())!==1n)throw new Error('guest entry did not execute li r3,1');
  return {entry,hir};
};
const a=run(0x82000000),b=run(0x83000000);if(a.entry===b.entry||!a.hir||!b.hir)throw new Error('relocation reuse critic ineffective');
console.log('PREPARED_PE_ENTRY_BYTES_FROM_GUEST_MEMORY=PASS');
console.log('PREPARED_PE_ENTRY_RELOCATION=PASS');
console.log('PREPARED_PE_ENTRY_XENIA_TRANSLATION=PASS');
console.log('PREPARED_PE_ENTRY_HIR_EXECUTION=PASS');
console.log('PREPARED_PE_ENTRY_HANDOFF=PASS');

// The handoff is deliberately bounded/aligned; malformed byte requests fail closed.
pick('r360_title_handoff_reset')();if((pick('r360_title_handoff_translate_entry')(6)>>>0)!==0)throw new Error('unaligned handoff accepted');eq(pick('r360_title_handoff_status')(),0x82000002,'handoff alignment failure');
console.log('PREPARED_PE_ENTRY_HANDOFF_FAIL_CLOSED=PASS');
