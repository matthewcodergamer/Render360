import fs from 'node:fs';
import crypto from 'node:crypto';

const {instance}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const e=instance.exports;
const required=[
  'memory','r360_io_ptr','r360_io_capacity','r360_xex_prepare_reset',
  'r360_xex_prepare_normal_frame_begin','r360_xex_prepare_normal_frame_accept',
  'r360_xex_prepare_status','r360_xex_prepare_source_offset','r360_xex_prepare_source_bytes',
  'r360_xex_prepare_output_bytes','r360_xex_prepare_bytes_done','r360_xex_prepare_output_done',
  'r360_xex_prepare_normal_window_size','r360_xex_prepare_normal_blocks_done',
  'r360_xex_prepare_last_output_kind','r360_xex_prepare_last_output_bytes'
];
for(const n of required)if(!(n in e))throw new Error(`missing NORMAL frame export ${n}`);
const io=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0;
const mem=()=>new Uint8Array(e.memory.buffer);
const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const asc=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);
const stage=x=>{if(x.length>cap)throw new Error('stage overflow');mem().set(x,io)};
const sha=x=>crypto.createHash('sha1').update(x).digest();

function block(nextSize,nextHash,chunks,{padding=0}={}){
  const chunkBytes=chunks.reduce((n,c)=>n+2+c.length,0)+2;
  const b=Buffer.alloc(24+chunkBytes+padding);
  p32(b,0,nextSize);Buffer.from(nextHash??Buffer.alloc(20)).copy(b,4);
  let p=24;
  for(const c of chunks){p16(b,p,c.length);p+=2;Buffer.from(c).copy(b,p);p+=c.length}
  p16(b,p,0);p+=2;
  for(let i=0;i<padding;i++)b[p+i]=(0xA0+i*7)&255;
  return b;
}
function makeNormalPayload(){
  const a=Buffer.from(Array.from({length:53},(_,i)=>(0x31+i*11)&255));
  const b=Buffer.from(Array.from({length:97},(_,i)=>(0x72+i*5)&255));
  const c=Buffer.from(Array.from({length:41},(_,i)=>(0x19+i*17)&255));
  const last=block(0,Buffer.alloc(20),[c],{padding:9});
  const lastHash=sha(last);
  const first=block(last.length,lastHash,[a,b],{padding:5});
  const firstHash=sha(first);
  return {payload:Buffer.concat([first,last]),first,firstHash,last,lastHash,expected:Buffer.concat([a,b,c])};
}
function header({payload,firstHash,firstSize,enc=0,comp=2,window=0x20000,infoSize=36,base=0x82000000}={}){
  const x=new Uint8Array(0x400),s=0x100,ffi=0x60,exec=0x90;
  asc(x,0,'XEX2');p32(x,4,1);p32(x,8,0x400);p32(x,0x10,s);p32(x,0x14,4);
  let h=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x20],[0x10201,base],[0x40006,exec]]){p32(x,h,k);p32(x,h+4,v);h+=8}
  p32(x,ffi,infoSize);p16(x,ffi+4,enc);p16(x,ffi+6,comp);p32(x,ffi+8,window);p32(x,ffi+12,firstSize);Buffer.from(firstHash??Buffer.alloc(20)).copy(x,ffi+16);
  p32(x,exec,0xAABBCCDD);p32(x,exec+0x0c,0x584108CE);
  p32(x,s,0x1cc);p32(x,s+4,0x30000);p32(x,s+0x110,base);p32(x,s+0x178,0xffffffff);p32(x,s+0x17c,0x08000000);p32(x,s+0x180,3);
  for(const[t,i]of[[1,0],[3,1],[2,2]])p32(x,s+0x184+i*0x18,0x10|t);
  return x;
}

function runFrame(h,payload,chunkPattern=[1,7,13,29,5,61]){
  stage(h);let st=e.r360_xex_prepare_normal_frame_begin(h.length,0x400+payload.length)>>>0;
  if(st!==1)throw new Error(`NORMAL frame begin failed ${st}`);
  if((e.r360_xex_prepare_source_offset()>>>0)!==0x400||(e.r360_xex_prepare_source_bytes()>>>0)!==payload.length)throw new Error('NORMAL source accounting mismatch');
  if((e.r360_xex_prepare_normal_window_size()>>>0)!==0x20000)throw new Error('NORMAL window mismatch');
  const out=[];let p=0,ci=0,guard=0;
  while(p<payload.length){
    if(++guard>10000)throw new Error('NORMAL frame loop runaway');
    const n=Math.min(payload.length-p,chunkPattern[ci++%chunkPattern.length]);
    const chunk=payload.subarray(p,p+n);stage(chunk);st=e.r360_xex_prepare_normal_frame_accept(n)>>>0;
    const outn=e.r360_xex_prepare_last_output_bytes()>>>0;
    const kind=e.r360_xex_prepare_last_output_kind()>>>0;
    if(outn){if(kind!==1)throw new Error('NORMAL compacted bytes not marked as data');out.push(Buffer.from(mem().slice(io,io+outn)))}
    p+=n;
    if(st>=100)break;
  }
  return {status:st,output:Buffer.concat(out)};
}

const good=makeNormalPayload();const h=header({payload:good.payload,firstHash:good.firstHash,firstSize:good.first.length});
const result=runFrame(h,good.payload);
if(result.status!==2||(e.r360_xex_prepare_status()>>>0)!==2)throw new Error(`NORMAL framing failed ${result.status}`);
if(!result.output.equals(good.expected))throw new Error('NORMAL deblocked compressed stream mismatch');
if((e.r360_xex_prepare_bytes_done()>>>0)!==good.payload.length)throw new Error('NORMAL source completion mismatch');
if((e.r360_xex_prepare_output_done()>>>0)!==good.expected.length||(e.r360_xex_prepare_output_bytes()>>>0)!==good.expected.length)throw new Error('NORMAL output completion mismatch');
if((e.r360_xex_prepare_normal_blocks_done()>>>0)!==2)throw new Error('NORMAL block count mismatch');
console.log('XEX_NORMAL_BLOCK_BOUNDS=PASS');
console.log('XEX_NORMAL_SHA1_CHAIN=PASS');
console.log('XEX_NORMAL_BE16_CHUNK_FRAMING=PASS');
console.log('XEX_NORMAL_STREAM_COMPACTION=PASS');
console.log('XEX_NORMAL_EXACT_ACCOUNTING=PASS');

const corrupt=Buffer.from(good.payload);corrupt[30]^=0x40;let bad=runFrame(h,corrupt,[17]);if(bad.status!==110)throw new Error(`NORMAL hash corruption must fail 110, got ${bad.status}`);console.log('XEX_NORMAL_HASH_FAIL_CLOSED=PASS');

const truncatedHeader=header({payload:good.payload,firstHash:good.firstHash,firstSize:good.first.length});stage(truncatedHeader);if((e.r360_xex_prepare_normal_frame_begin(0x400,0x400+good.first.length-1)>>>0)!==109)throw new Error('first NORMAL block beyond source must fail');console.log('XEX_NORMAL_SOURCE_RANGE_FAIL_CLOSED=PASS');

const badTermLast=Buffer.from(good.last);const termOffset=24+2+41;badTermLast[termOffset]=0;badTermLast[termOffset+1]=4;const badTermLastHash=sha(badTermLast);const badTermFirst=block(badTermLast.length,badTermLastHash,[Buffer.from([1,2,3])]);const badTermPayload=Buffer.concat([badTermFirst,badTermLast]);const badTermHeader=header({firstHash:sha(badTermFirst),firstSize:badTermFirst.length});bad=runFrame(badTermHeader,badTermPayload,[11]);if(bad.status!==108)throw new Error(`missing NORMAL terminator must fail 108, got ${bad.status}`);console.log('XEX_NORMAL_TERMINATOR_FAIL_CLOSED=PASS');

const over=Buffer.alloc(24+2+3);p32(over,0,0);p16(over,24,20);over.fill(0x55,26);const overHeader=header({firstHash:sha(over),firstSize:over.length});bad=runFrame(overHeader,over,[over.length]);if(bad.status!==108)throw new Error(`NORMAL chunk overrun must fail 108, got ${bad.status}`);console.log('XEX_NORMAL_CHUNK_RANGE_FAIL_CLOSED=PASS');

stage(header({firstHash:good.firstHash,firstSize:good.first.length,enc:1}));if((e.r360_xex_prepare_normal_frame_begin(0x400,0x400+good.payload.length)>>>0)!==102)throw new Error('encrypted NORMAL must fail until session-key path exists');console.log('XEX_NORMAL_ENCRYPTION_FAIL_CLOSED=PASS');
stage(header({firstHash:good.firstHash,firstSize:good.first.length,comp:1}));if((e.r360_xex_prepare_normal_frame_begin(0x400,0x400+good.payload.length)>>>0)!==103)throw new Error('BASIC must not enter NORMAL frame path');console.log('XEX_NORMAL_ROUTING_FAIL_CLOSED=PASS');
stage(header({firstHash:good.firstHash,firstSize:good.first.length,window:0x12345}));if((e.r360_xex_prepare_normal_frame_begin(0x400,0x400+good.payload.length)>>>0)!==108)throw new Error('invalid LZX window must fail');console.log('XEX_NORMAL_WINDOW_FAIL_CLOSED=PASS');
console.log('XEX_NORMAL_FRAMING=PASS');
