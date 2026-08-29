import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';

const coreBytes=fs.readFileSync('render360_xenia_core.wasm');
const {instance:core}=await WebAssembly.instantiate(coreBytes,{});
const c=core.exports;
const creq=['memory','r360_io_ptr','r360_io_capacity','r360_xex_prepare_reset','r360_xex_prepare_normal_frame_begin','r360_xex_prepare_normal_frame_accept','r360_xex_prepare_status','r360_xex_prepare_output_bytes','r360_xex_prepare_output_done','r360_xex_prepare_last_output_kind','r360_xex_prepare_last_output_bytes','r360_xex_prepare_normal_window_size','r360_xex_decode','r360_xex_decode_entry_point','r360_xex_decode_page_descriptor_count','r360_xex_decode_page_type','r360_xex_decode_page_address','r360_xex_decode_page_bytes'];
for(const n of creq)if(!(n in c))throw new Error(`missing package-core export ${n}`);
const cio=c.r360_io_ptr()>>>0,ccap=c.r360_io_capacity()>>>0,cmem=()=>new Uint8Array(c.memory.buffer);
const stage=x=>{if(x.length>ccap)throw new Error('package-core stage overflow');cmem().set(x,cio)};
const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const asc=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);
const sha=x=>crypto.createHash('sha1').update(x).digest();

const bootstrapPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(bootstrapPath))throw new Error(`bootstrap missing: ${bootstrapPath}`);
const bmod=await WebAssembly.compile(fs.readFileSync(bootstrapPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(bmod);
for(const imp of WebAssembly.Module.imports(bmod))if(imp.module==='env'&&imp.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const b=await WebAssembly.instantiate(bmod,imports);wasi.initialize(b);
const pick=n=>b.exports[n]??b.exports[`_${n}`];
const breq=['memory','r360_lzx_input_buffer','r360_lzx_input_capacity','r360_lzx_output_buffer','r360_lzx_output_capacity','r360_lzx_reset','r360_lzx_decompress','r360_lzx_output_size','r360_xex_guest_mapper_reset','r360_xex_guest_mapper_map_section','r360_xex_guest_mapper_load','r360_xex_guest_mapper_set_entry','r360_xex_guest_mapper_finalize','r360_xex_guest_mapper_entry_address','r360_xex_guest_mapper_section_count','r360_xex_guest_mapper_mapped_bytes','r360_xex_guest_mapper_input_buffer','r360_sparse_guest_memory_read_u8','r360_sparse_guest_memory_write_u8','r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_status','r360_ppc_probe_guest_base','r360_ppc_probe_loaded_size','r360_ppc_probe_assembled_functions','r360_ppc_probe_hir_block_count','r360_ppc_probe_hir_instruction_count','r360_ppc_probe_last_guest_address','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_instructions','r360_ppc_probe_correctness_r3'];
for(const n of breq)if(!pick(n))throw new Error(`missing bootstrap export ${n}`);
const bmem=pick('memory'),bin=pick('r360_lzx_input_buffer')()>>>0,bincap=pick('r360_lzx_input_capacity')()>>>0,bout=pick('r360_lzx_output_buffer')()>>>0,boutcap=pick('r360_lzx_output_capacity')()>>>0;
const bheap=()=>new Uint8Array(bmem.buffer);

function makeLzxUncompressed(payload){
  if(!payload.length||payload.length>0xFFFFFF)throw new Error('bad LZX payload length');
  let bits='0'+'011'+payload.length.toString(2).padStart(24,'0');
  while(bits.length%16)bits+='0';
  const hdr=[];for(let i=0;i<bits.length;i+=16){const w=parseInt(bits.slice(i,i+16),2);hdr.push(w&255,(w>>>8)&255)}
  return Buffer.from([...hdr,1,0,0,0,1,0,0,0,1,0,0,0,...payload]);
}
function normalBlock(lzx){const out=Buffer.alloc(24+2+lzx.length+2);p32(out,0,0);p16(out,24,lzx.length);lzx.copy(out,26);p16(out,26+lzx.length,0);return out}
function header(blockHash,blockSize,{base=0x91000000,window=0x8000}={}){
  const x=new Uint8Array(0x400),s=0x100,ffi=0x60,exec=0x90;
  asc(x,0,'XEX2');p32(x,4,1);p32(x,8,0x400);p32(x,0x10,s);p32(x,0x14,4);
  let h=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x20],[0x10201,base],[0x40006,exec]]){p32(x,h,k);p32(x,h+4,v);h+=8}
  p32(x,ffi,36);p16(x,ffi+4,0);p16(x,ffi+6,2);p32(x,ffi+8,window);p32(x,ffi+12,blockSize);Buffer.from(blockHash).copy(x,ffi+16);
  p32(x,exec,0xAABBCCDD);p32(x,exec+0x0c,0x584108CE);
  p32(x,s,0x19c);p32(x,s+4,0x1000);p32(x,s+0x110,base);p32(x,s+0x178,0xffffffff);p32(x,s+0x17c,0x08000000);p32(x,s+0x180,1);p32(x,s+0x184,0x10|1);
  return x;
}
function makeImage(seed){const image=Buffer.alloc(0x1000);for(let i=0;i<image.length;i++)image[i]=(seed+i*29+(i>>>3)*7)&255;p32(image,0x20,0x38600001);p32(image,0x24,0x4E800020);return image}
function frame(h,block){
  stage(h);let st=c.r360_xex_prepare_normal_frame_begin(h.length,h.length+block.length)>>>0;if(st!==1)throw new Error(`frame begin failed ${st}`);
  if((c.r360_xex_prepare_normal_window_size()>>>0)!==0x8000)throw new Error('window mismatch');
  const outs=[];let p=0,ci=0;const pattern=[3,17,1,31,9,67,5,127];
  while(p<block.length){const n=Math.min(block.length-p,pattern[ci++%pattern.length]);stage(block.subarray(p,p+n));st=c.r360_xex_prepare_normal_frame_accept(n)>>>0;const outn=c.r360_xex_prepare_last_output_bytes()>>>0;if(outn){if((c.r360_xex_prepare_last_output_kind()>>>0)!==1)throw new Error('compacted output kind mismatch');outs.push(Buffer.from(cmem().slice(cio,cio+outn)))}p+=n;if(st>=100)break}
  return {status:st,deblocked:Buffer.concat(outs)};
}
function lzx(deblocked,size){if(deblocked.length>bincap||size>boutcap)throw new Error('bootstrap LZX capacity');pick('r360_lzx_reset')();bheap().set(deblocked,bin);const st=pick('r360_lzx_decompress')(deblocked.length,size,0x8000)>>>0;if(st!==0)throw new Error(`LZX failed ${st}`);if((pick('r360_lzx_output_size')()>>>0)!==size)throw new Error('LZX output accounting');return Buffer.from(bheap().slice(bout,bout+size))}
const perm=t=>t===1?5:t===2?3:t===3?1:0;
function mapPrepared(h,prepared){
  stage(h);if((c.r360_xex_decode(h.length)>>>0)!==1)throw new Error('prepared XEX metadata decode failed');
  pick('r360_xex_guest_mapper_reset')();const count=c.r360_xex_decode_page_descriptor_count()>>>0;if(!count)throw new Error('no decoded sections');let total=0;
  for(let i=0;i<count;i++){const type=c.r360_xex_decode_page_type(i)>>>0,address=c.r360_xex_decode_page_address(i)>>>0,size=c.r360_xex_decode_page_bytes(i)>>>0,p=perm(type);if(!p)throw new Error('unknown section type');if((pick('r360_xex_guest_mapper_map_section')(address,size,p)>>>0)!==1)throw new Error(`map section ${i} failed`);total+=size}
  const first=c.r360_xex_decode_page_address(0)>>>0,input=pick('r360_xex_guest_mapper_input_buffer')()>>>0;bheap().set(prepared,input);if((pick('r360_xex_guest_mapper_load')(first,input,prepared.length)>>>0)!==1)throw new Error('prepared image load failed');
  const entry=c.r360_xex_decode_entry_point()>>>0;if((pick('r360_xex_guest_mapper_set_entry')(entry)>>>0)!==1)throw new Error('prepared entry rejected');if((pick('r360_xex_guest_mapper_finalize')()>>>0)!==1)throw new Error('prepared mapper finalize failed');
  if((pick('r360_xex_guest_mapper_entry_address')()>>>0)!==entry)throw new Error('mapped entry mismatch');if((pick('r360_xex_guest_mapper_section_count')()>>>0)!==count)throw new Error('mapped section count mismatch');if((pick('r360_xex_guest_mapper_mapped_bytes')()>>>0)!==total)throw new Error('mapped byte total mismatch');
  if((pick('r360_sparse_guest_memory_read_u8')(entry)>>>0)!==prepared[0x20]||(pick('r360_sparse_guest_memory_read_u8')((entry+1)>>>0)>>>0)!==prepared[0x21])throw new Error('entry bytes did not survive preparation→mapping');if((pick('r360_sparse_guest_memory_write_u8')(first,0xAA)>>>0)!==0)throw new Error('final RX mapping remained writable');return entry;
}
function translatePreparedEntry(prepared,entry){
  const program=prepared.subarray(0x20,0x28),input=pick('r360_ppc_probe_input_buffer')()>>>0;pick('r360_ppc_probe_reset')();bheap().set(program,input);const loaded=pick('r360_ppc_probe_load_at')(entry,input,program.length)>>>0;if(loaded!==program.length)throw new Error(`load-at-entry failed ${loaded}`);const translated=pick('r360_ppc_probe_translate')()>>>0;
  const status=pick('r360_ppc_probe_status')()>>>0,base=pick('r360_ppc_probe_guest_base')()>>>0,loadedSize=pick('r360_ppc_probe_loaded_size')()>>>0,assembled=pick('r360_ppc_probe_assembled_functions')()>>>0,blocks=pick('r360_ppc_probe_hir_block_count')()>>>0,hir=pick('r360_ppc_probe_hir_instruction_count')()>>>0,last=pick('r360_ppc_probe_last_guest_address')()>>>0,correctness=pick('r360_ppc_probe_correctness_status')()>>>0,correctnessInstructions=pick('r360_ppc_probe_correctness_instructions')()>>>0,r3=BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')());
  if(status!==3||base!==entry||loadedSize!==program.length||translated===0||assembled===0||blocks===0||hir===0||last!==entry)throw new Error('decoder-derived entry did not complete Xenia PPC→HIR translation');if(correctness!==3||correctnessInstructions===0||r3!==1n)throw new Error(`prepared entry HIR execution mismatch r3=${r3}`);return {hir,r3};
}
function run(seed,base){const expected=makeImage(seed),stream=makeLzxUncompressed(expected),block=normalBlock(stream),h=header(sha(block),block.length,{base});const framed=frame(h,block);if(framed.status!==2)throw new Error(`NORMAL frame failed ${framed.status}`);if(!framed.deblocked.equals(stream))throw new Error('framing did not reproduce exact LZX stream');if((c.r360_xex_prepare_output_done()>>>0)!==stream.length||(c.r360_xex_prepare_output_bytes()>>>0)!==stream.length)throw new Error('framing accounting mismatch');const got=lzx(framed.deblocked,expected.length);if(!got.equals(expected))throw new Error('prepared executable mismatch');const entry=mapPrepared(h,got);if(entry!==((base+0x20)>>>0))throw new Error('entry was not decoder-derived');const translated=translatePreparedEntry(got,entry);return {expected,stream,block,h,entry,translated}}

const a=run(0x21,0x91000000),bcase=run(0x7B,0x92000000);if(a.expected.equals(bcase.expected)||a.entry===bcase.entry)throw new Error('changed-input/relocation critic ineffective');
console.log('XEX_NORMAL_FRAME_TO_LZX_STREAM=PASS');
console.log('XEX_NORMAL_LZX_EXACT_PREPARED_IMAGE=PASS');
console.log('XEX_NORMAL_LZX_CHANGED_IMAGE_REUSE=PASS');
console.log('XEX_PREPARED_IMAGE_TO_SPARSE_MAPPER=PASS');
console.log('XEX_PREPARED_ENTRY_BYTES_PRESERVED=PASS');
console.log('XEX_PREPARED_MAPPING_PERMISSIONS=PASS');
console.log('XEX_PREPARED_IMAGE_RELOCATION_REUSE=PASS');
console.log('XEX_PREPARED_ENTRY_XENIA_TRANSLATION=PASS');
console.log('XEX_PREPARED_ENTRY_HIR_EXECUTION=PASS');
console.log('XEX_PREPARED_ENTRY_RELOCATION_REUSE=PASS');

const corrupt=Buffer.from(a.block);corrupt[40]^=0x80;const bad=frame(a.h,corrupt);if(bad.status!==110)throw new Error(`corrupt framed block must fail hash, got ${bad.status}`);
console.log('XEX_NORMAL_END_TO_END_HASH_FAIL_CLOSED=PASS');
const badLzx=Buffer.from(a.stream);badLzx[1]=0;pick('r360_lzx_reset')();bheap().set(badLzx,bin);if((pick('r360_lzx_decompress')(badLzx.length,0x1000,0x8000)>>>0)===0)throw new Error('corrupt deblocked LZX accepted');
console.log('XEX_NORMAL_END_TO_END_LZX_FAIL_CLOSED=PASS');
console.log('XEX_NORMAL_UNENCRYPTED_END_TO_END=PASS');
console.log('XEX_PREPARED_REAL_MAPPER_INTEGRATION=PASS');
console.log('XEX_PREPARED_ENTRY_PIPELINE=PASS');
