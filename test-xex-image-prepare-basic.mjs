import fs from 'node:fs';

const {instance}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const e=instance.exports;
const required=[
  'memory','r360_io_ptr','r360_io_capacity','r360_xex_prepare_reset',
  'r360_xex_prepare_basic_begin','r360_xex_prepare_basic_accept_data',
  'r360_xex_prepare_basic_consume_zero','r360_xex_prepare_basic_data_remaining',
  'r360_xex_prepare_basic_zero_remaining','r360_xex_prepare_status',
  'r360_xex_prepare_source_offset','r360_xex_prepare_source_bytes',
  'r360_xex_prepare_output_bytes','r360_xex_prepare_bytes_done',
  'r360_xex_prepare_output_done','r360_xex_prepare_basic_block_count',
  'r360_xex_prepare_basic_block_index','r360_xex_prepare_last_output_kind',
  'r360_xex_prepare_last_output_bytes','r360_xex_prepare_encryption_type',
  'r360_xex_prepare_compression_type'
];
for(const n of required)if(!(n in e))throw new Error(`missing BASIC prepare export ${n}`);

const io=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0;
const mem=()=>new Uint8Array(e.memory.buffer);
const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const asc=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);
const stage=x=>{if(x.length>cap)throw new Error('stage overflow');mem().set(x,io)};
const sum=(xs,f)=>xs.reduce((n,x)=>n+f(x),0)>>>0;

function header({enc=0,comp=1,base=0x82000000,blocks=[[0x3000,0x1000],[0x1800,0],[0x2800,0x800]],infoSize=null,pages=3}={}){
  const x=new Uint8Array(0x400),s=0x100,ffi=0x60,exec=0x90;
  asc(x,0,'XEX2');p32(x,4,1);p32(x,8,0x400);p32(x,0x10,s);p32(x,0x14,4);
  let h=0x18;
  for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x20],[0x10201,base],[0x40006,exec]]){p32(x,h,k);p32(x,h+4,v);h+=8}
  p32(x,ffi,infoSize??(8+blocks.length*8));p16(x,ffi+4,enc);p16(x,ffi+6,comp);
  for(let i=0;i<blocks.length;i++){p32(x,ffi+8+i*8,blocks[i][0]);p32(x,ffi+12+i*8,blocks[i][1])}
  p32(x,exec,0xAABBCCDD);p32(x,exec+0x0c,0x584108CE);
  p32(x,s,0x1cc);p32(x,s+4,pages*0x10000);p32(x,s+0x110,base);
  p32(x,s+0x178,0xffffffff);p32(x,s+0x17c,0x08000000);p32(x,s+0x180,pages);
  for(let i=0;i<pages;i++)p32(x,s+0x184+i*0x18,0x10|([1,3,2][i%3]));
  return x;
}

const blocks=[[0x3000,0x1000],[0x1800,0],[0x2800,0x800]];
const sourceBytes=sum(blocks,b=>b[0]);
const outputBytes=sum(blocks,b=>b[0]+b[1]);
const h=header({blocks});
const fileLength=0x400+sourceBytes;
const source=new Uint8Array(sourceBytes);for(let i=0;i<source.length;i++)source[i]=(0x37+i*29)&255;
const expected=[];let sourceCursor=0;
for(const[dataSize,zeroSize]of blocks){expected.push(source.slice(sourceCursor,sourceCursor+dataSize));expected.push(new Uint8Array(zeroSize));sourceCursor+=dataSize}
const expectedBuffer=Buffer.concat(expected.map(x=>Buffer.from(x)));

stage(h);let st=e.r360_xex_prepare_basic_begin(h.length,fileLength)>>>0;
if(st!==1)throw new Error(`BASIC begin failed ${st}`);
if((e.r360_xex_prepare_encryption_type()>>>0)!==0||(e.r360_xex_prepare_compression_type()>>>0)!==1)throw new Error('BASIC route classification mismatch');
if((e.r360_xex_prepare_source_offset()>>>0)!==0x400)throw new Error('BASIC source offset mismatch');
if((e.r360_xex_prepare_source_bytes()>>>0)!==sourceBytes)throw new Error('BASIC source accounting mismatch');
if((e.r360_xex_prepare_output_bytes()>>>0)!==outputBytes)throw new Error('BASIC output accounting mismatch');
if((e.r360_xex_prepare_basic_block_count()>>>0)!==blocks.length)throw new Error('BASIC block count mismatch');
console.log('XEX_PREPARE_BASIC_TABLE_BOUNDS=PASS');
console.log('XEX_PREPARE_BASIC_SOURCE_ACCOUNTING=PASS');
console.log('XEX_PREPARE_BASIC_OUTPUT_ACCOUNTING=PASS');

const produced=[];let consumed=0,guard=0;
while((e.r360_xex_prepare_status()>>>0)===1){
  if(++guard>2000)throw new Error('BASIC preparation loop runaway');
  const zero=e.r360_xex_prepare_basic_zero_remaining()>>>0;
  if(zero){
    st=e.r360_xex_prepare_basic_consume_zero(Math.min(zero,0x333))>>>0;
    const n=e.r360_xex_prepare_last_output_bytes()>>>0;
    if((e.r360_xex_prepare_last_output_kind()>>>0)!==2||!n)throw new Error('BASIC zero event mismatch');
    produced.push(Buffer.alloc(n));
    continue;
  }
  const data=e.r360_xex_prepare_basic_data_remaining()>>>0;
  if(!data)throw new Error('BASIC working state has neither data nor zero work');
  const n=Math.min(data,0x777);
  const chunk=source.slice(consumed,consumed+n);stage(chunk);
  const before=Buffer.from(mem().slice(io,io+n));
  st=e.r360_xex_prepare_basic_accept_data(n)>>>0;
  const after=Buffer.from(mem().slice(io,io+n));
  if(!before.equals(after))throw new Error('BASIC identity data was modified');
  if((e.r360_xex_prepare_last_output_kind()>>>0)!==1||(e.r360_xex_prepare_last_output_bytes()>>>0)!==n)throw new Error('BASIC data event mismatch');
  produced.push(before);consumed+=n;
}
if(st!==2||(e.r360_xex_prepare_status()>>>0)!==2)throw new Error(`BASIC preparation did not complete: ${st}`);
if((e.r360_xex_prepare_bytes_done()>>>0)!==sourceBytes||(e.r360_xex_prepare_output_done()>>>0)!==outputBytes)throw new Error('BASIC final accounting mismatch');
if(consumed!==sourceBytes)throw new Error('BASIC source cursor mismatch');
if(!Buffer.concat(produced).equals(expectedBuffer))throw new Error('BASIC reconstructed output differs from Xenia data+zero semantics');
console.log('XEX_PREPARE_BASIC_PAYLOAD_PRESERVED=PASS');
console.log('XEX_PREPARE_BASIC_ZERO_FILL=PASS');
console.log('XEX_PREPARE_BASIC_STREAMING=PASS');

stage(header({blocks,enc:1}));if((e.r360_xex_prepare_basic_begin(0x400,fileLength)>>>0)!==102)throw new Error('encrypted BASIC must fail until encryption path is implemented');
console.log('XEX_PREPARE_BASIC_ENCRYPTION_FAIL_CLOSED=PASS');
stage(header({blocks,comp:0}));if((e.r360_xex_prepare_basic_begin(0x400,fileLength)>>>0)!==103)throw new Error('NONE compression must not enter BASIC path');
console.log('XEX_PREPARE_BASIC_ROUTING_FAIL_CLOSED=PASS');
stage(header({blocks,infoSize:9}));if((e.r360_xex_prepare_basic_begin(0x400,fileLength)>>>0)!==105)throw new Error('misaligned BASIC table must fail');
console.log('XEX_PREPARE_BASIC_FORMAT_FAIL_CLOSED=PASS');
stage(h);if((e.r360_xex_prepare_basic_begin(h.length,fileLength-1)>>>0)!==106)throw new Error('truncated BASIC payload must fail');
console.log('XEX_PREPARE_BASIC_TRUNCATION_FAIL_CLOSED=PASS');
const overflowBlocks=[[0x10,0x40000]];const overflowHeader=header({blocks:overflowBlocks,pages:3});stage(overflowHeader);if((e.r360_xex_prepare_basic_begin(0x400,0x410)>>>0)!==106)throw new Error('BASIC output beyond mapped image must fail');
console.log('XEX_PREPARE_BASIC_OUTPUT_RANGE_FAIL_CLOSED=PASS');

stage(h);if((e.r360_xex_prepare_basic_begin(h.length,fileLength)>>>0)!==1)throw new Error('BASIC state-order setup failed');
if((e.r360_xex_prepare_basic_accept_data(0x3000)>>>0)!==1)throw new Error('first BASIC block data should leave zero work');
if((e.r360_xex_prepare_basic_accept_data(1)>>>0)!==107)throw new Error('data must not skip a pending BASIC zero range');
console.log('XEX_PREPARE_BASIC_ORDER_FAIL_CLOSED=PASS');

stage(h);if((e.r360_xex_prepare_basic_begin(h.length,fileLength)>>>0)!==1)throw new Error('BASIC overshoot setup failed');
if((e.r360_xex_prepare_basic_accept_data(0x3001)>>>0)!==104)throw new Error('BASIC block data overshoot must fail');
console.log('XEX_PREPARE_BASIC_CHUNK_OVERFLOW_FAIL_CLOSED=PASS');
console.log('XEX_IMAGE_PREPARE_BASIC=PASS');
