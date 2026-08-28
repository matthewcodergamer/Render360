import fs from 'node:fs';

function put32be(mem, off, v){mem[off]=(v>>>24)&255;mem[off+1]=(v>>>16)&255;mem[off+2]=(v>>>8)&255;mem[off+3]=v&255}
function put64be(mem, off, v){put32be(mem,off,Math.floor(v/0x100000000));put32be(mem,off+4,v>>>0)}
function put16be(mem,off,v){mem[off]=(v>>>8)&255;mem[off+1]=v&255}
function put16le(mem,off,v){mem[off]=v&255;mem[off+1]=(v>>>8)&255}
function put24le(mem,off,v){mem[off]=v&255;mem[off+1]=(v>>>8)&255;mem[off+2]=(v>>>16)&255}
function ascii(mem,off,s){mem.set(Buffer.from(s,'ascii'),off)}
function utf16be(mem,off,text){for(let i=0;i<text.length;i++){const v=text.charCodeAt(i);mem[off+i*2]=(v>>>8)&255;mem[off+i*2+1]=v&255}}
function u64(lo,hi){return(hi>>>0)*0x100000000+(lo>>>0)}

function makeXex(){
  const x=new Uint8Array(0x1800);ascii(x,0,'XEX2');put32be(x,4,1);put32be(x,8,0x280);put32be(x,0x10,0x80);put32be(x,0x14,4);
  let h=0x18;put32be(x,h,0x00010100);put32be(x,h+4,0x82001234);h+=8;put32be(x,h,0x00010201);put32be(x,h+4,0x82000000);h+=8;put32be(x,h,0x00040006);put32be(x,h+4,0x40);h+=8;put32be(x,h,0x000003FF);put32be(x,h+4,0x58);
  put32be(x,0x40,0xAABBCCDD);put32be(x,0x4C,0x584108CE);put32be(x,0x58,8);put16be(x,0x5C,1);put16be(x,0x5E,2);put32be(x,0x84,0x01000000);put32be(x,0x190,0x82000000);put32be(x,0x1F8,0xFFFFFFFF);put32be(x,0x1FC,1);put32be(x,0x200,12);
  for(let i=0x1000;i<x.length;i++)x[i]=(i*17+0x36)&255;return x;
}
function makeStfs(){
  const bytes=new Uint8Array(0x10000),xex=makeXex();ascii(bytes,0,'LIVE');put32be(bytes,0x340,0x971A);put32be(bytes,0x344,0x000D0000);put32be(bytes,0x348,2);put64be(bytes,0x34C,xex.length);put32be(bytes,0x354,0xAABBCCDD);put32be(bytes,0x360,0x584108CE);
  const d=0x379;bytes[d]=0x24;bytes[d+1]=0;bytes[d+2]=1;put16le(bytes,d+3,2);put24le(bytes,d+5,0);put32be(bytes,d+0x1C,5);put32be(bytes,d+0x20,0);put32be(bytes,0x39D,0);put32be(bytes,0x3A9,0);utf16be(bytes,0x411,'Render360 Foundation Gate');
  put32be(bytes,0xA000+0x14,2);put32be(bytes,0xA000+3*0x18+0x14,4);
  let e=0xB000;ascii(bytes,e,'readme.txt');bytes[e+0x28]=0x40+10;put24le(bytes,e+0x29,1);put24le(bytes,e+0x2C,1);put24le(bytes,e+0x2F,1);put16be(bytes,e+0x32,0xFFFF);put32be(bytes,e+0x34,0x10);
  e=0xD000;ascii(bytes,e,'default.xex');bytes[e+0x28]=0x40+11;put24le(bytes,e+0x29,2);put24le(bytes,e+0x2C,2);put24le(bytes,e+0x2F,3);put16be(bytes,e+0x32,0xFFFF);put32be(bytes,e+0x34,xex.length);bytes.set(xex.subarray(0,0x1000),0xE000);bytes.set(xex.subarray(0x1000),0xF000);return{bytes,xex};
}

const wasm=fs.readFileSync('render360_xenia_core.wasm');const{instance}=await WebAssembly.instantiate(wasm,{});const e=instance.exports;
const baseRequired=['memory','r360_io_ptr','r360_io_capacity','r360_probe_container','r360_inspect_xex','r360_xex_status','r360_xex_entry_point','r360_xex_image_base','r360_xex_title_id','r360_xex_media_id','r360_stfs_mount_begin','r360_stfs_submit_read','r360_stfs_request_pending','r360_stfs_request_offset_lo','r360_stfs_request_offset_hi','r360_stfs_request_size','r360_stfs_mount_status','r360_stfs_entry_count','r360_stfs_default_xex_index','r360_stfs_default_xex_kind'];
for(const name of baseRequired)if(!(name in e))throw new Error(`Missing package/XEX base ABI export: ${name}`);
const io=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0,memory=()=>new Uint8Array(e.memory.buffer);const stage=chunk=>{if(chunk.length>cap)throw new Error('I/O staging overflow');memory().set(chunk,io)};
const image=makeStfs();let status=e.r360_stfs_mount_begin(image.bytes.length>>>0,0)>>>0,mountReads=0;
while((e.r360_stfs_request_pending()>>>0)!==0){if(++mountReads>64)throw new Error('STFS mount request loop runaway');const off=u64(e.r360_stfs_request_offset_lo(),e.r360_stfs_request_offset_hi()),size=e.r360_stfs_request_size()>>>0,chunk=image.bytes.slice(off,off+size);if(chunk.length!==size)throw new Error(`STFS short read @0x${off.toString(16)}`);stage(chunk);status=e.r360_stfs_submit_read(chunk.length)>>>0}
if(status!==2||(e.r360_stfs_mount_status()>>>0)!==2)throw new Error(`STFS mount failed: ${status}`);if((e.r360_stfs_entry_count()>>>0)!==2)throw new Error('STFS directory enumeration mismatch');const xexIndex=e.r360_stfs_default_xex_index()>>>0;if(xexIndex!==1||(e.r360_stfs_default_xex_kind()>>>0)!==2)throw new Error('default.xex discovery/classification failed');
stage(image.xex);if((e.r360_inspect_xex(image.xex.length)>>>0)!==1)throw new Error('XEX structural inspection failed');if((e.r360_xex_entry_point()>>>0)!==0x82001234||(e.r360_xex_image_base()>>>0)!==0x82000000)throw new Error('XEX execution metadata mismatch');if((e.r360_xex_title_id()>>>0)!==0x584108CE||(e.r360_xex_media_id()>>>0)!==0xAABBCCDD)throw new Error('XEX execution info mismatch');
for(const[magic,expected]of[['XEX2',2],['LIVE',10],['PIRS',11],['CON ',12]]){const probe=new Uint8Array(16);ascii(probe,0,magic);stage(probe);if((e.r360_probe_container(probe.length)>>>0)!==expected)throw new Error(`${magic} classification failed`)}
const extraction=['r360_stfs_extract_begin','r360_stfs_extract_status','r360_stfs_extract_bytes_total','r360_stfs_extract_bytes_done','r360_stfs_extract_blocks_done'];const missing=extraction.filter(name=>!(name in e));
console.log('PACKAGE_XEX_BASE=PASS');console.log(`mount_reads=${mountReads}`);console.log('xex_entry=0x82001234');
if(missing.length){console.log('PACKAGE_XEX_FOUNDATION=BLOCKED');console.log(`missing_native_exports=${missing.join(',')}`);console.log('NEXT: implement native multi-block STFS entry extraction ABI, rebuild checked-in V32 WASM/embedded payload, then promote this audit to a required complete-extraction gate.');process.exit(0)}
console.log('PACKAGE_XEX_FOUNDATION=READY_FOR_EXTRACTION_RUNTIME_TEST');
