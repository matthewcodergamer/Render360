// The prepared image must be laid out as Xenia's XexModule lays it out: the
// whole image span mapped (headers and gaps included) and protected from the
// XEX security-info page descriptors (CODE/READONLY read-only, DATA writable),
// not from PE section flags alone. Banjo-Tooie's startup stopped at a guest
// STORE with the PE-flag layout.
import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {readXexPageDescriptors} from './render360-title-controller.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const fail=m=>{console.error(`FAIL ${m}`);process.exit(1);};
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const e=instance.exports;

// Prepared (memory-layout) PE at 0x92000000 (4 KiB XEX pages): .text RX at
// +0x1000, .rdata at +0x2000 flagged read-only in the PE but DATA in the XEX.
const base=0x92000000;
const p16=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
function pe(){
  const a=new Uint8Array(0x3000),nt=0x80,opt=nt+24,sh=opt+224;
  a.set([0x4D,0x5A]);p32(a,0x3c,nt);p32(a,nt,0x00004550);p16(a,nt+4,0x01F2);p16(a,nt+6,2);p16(a,nt+20,224);p16(a,nt+22,0x0102);
  p16(a,opt,0x10B);p32(a,opt+16,0x1000);p32(a,opt+28,base);p32(a,opt+32,0x1000);p32(a,opt+36,0x200);p32(a,opt+56,0x3000);p32(a,opt+60,0x200);p16(a,opt+68,14);
  const section=(i,name,rva,flags)=>{const s=sh+i*40;for(let k=0;k<name.length;k++)a[s+k]=name.charCodeAt(k);p32(a,s+8,0x1000);p32(a,s+12,rva);p32(a,s+16,0x1000);p32(a,s+20,rva);p32(a,s+36,flags);};
  section(0,'.text',0x1000,0x60000020);
  section(1,'.rdata',0x2000,0x40000040);
  new DataView(a.buffer).setUint32(0x1000,0x4E800020,false); // blr
  return a;
}

// Minimal XEX2 header carrying the security info page descriptors.
function xexHeader(words){
  const h=new Uint8Array(0x400),v=new DataView(h.buffer),sec=0x100;
  h.set([0x58,0x45,0x58,0x32]);v.setUint32(0x10,sec,false);
  v.setUint32(sec+0x110,base,false);v.setUint32(sec+0x180,words.length,false);
  words.forEach((w,i)=>v.setUint32(sec+0x184+i*0x18,w,false));
  return h;
}

const pages=readXexPageDescriptors(xexHeader([(1<<4)|3,(1<<4)|1,(1<<4)|2]));
if(!pages||pages.pageSize!==0x1000||pages.words.length!==3)fail(`descriptor parse ${JSON.stringify(pages)}`);

function load(withXexPages){
  e.r360_sparse_guest_memory_reset();
  e.r360_pe_guest_reset();
  const image=pe();
  if((e.r360_xex_guest_mapper_reserve_input(image.length)>>>0)!==1)fail('reserve');
  const input=e.r360_xex_guest_mapper_input_buffer()>>>0;
  if(withXexPages){
    new Uint32Array(e.memory.buffer,input,pages.words.length).set(pages.words);
    if((e.r360_pe_guest_set_xex_pages(input,pages.words.length,pages.pageSize)>>>0)!==1)fail('set pages');
  }
  new Uint8Array(e.memory.buffer,input,image.length).set(image);
  if((e.r360_pe_guest_load_at_entry(input,image.length,base+0x1000)>>>0)!==1)fail(`load status 0x${(e.r360_pe_guest_status()>>>0).toString(16)}`);
}
const read32=a=>{const out=e.r360_xex_guest_mapper_input_buffer()>>>0;return (e.r360_sparse_guest_memory_read_u32_be(a,out)>>>0)===1?new DataView(e.memory.buffer).getUint32(out,true):null;};
const canWrite=a=>(e.r360_sparse_guest_memory_write_u32_be(a,0x12345678)>>>0)===1;

load(true);
if(!canWrite(base+0x2000))fail('XEX DATA page must be writable even though the PE section is read-only');
if(canWrite(base+0x1000))fail('XEX CODE page must stay read-only');
if(read32(base)!==0x4D5A0000)fail(`image header page must be mapped and loaded like Xenia (read ${read32(base)})`);
if(read32(base+0x1000)!==0x4E800020)fail('code bytes not loaded');

load(false);
if(canWrite(base+0x2000))fail('without XEX descriptors the PE flags still apply');

console.log('XEX_PAGE_PROTECTION_PASS');
