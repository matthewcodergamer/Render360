import fs from 'node:fs';
const {instance}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const e=instance.exports;
const req=['memory','r360_io_ptr','r360_io_capacity','r360_xex_decode','r360_xex_decode_status','r360_xex_decode_entry_point','r360_xex_decode_image_base','r360_xex_decode_load_address','r360_xex_decode_image_size','r360_xex_decode_title_id','r360_xex_decode_media_id','r360_xex_decode_encryption_type','r360_xex_decode_compression_type','r360_xex_decode_page_size','r360_xex_decode_page_descriptor_count','r360_xex_decode_mapped_span','r360_xex_decode_page_type','r360_xex_decode_page_count','r360_xex_decode_page_address','r360_xex_decode_page_bytes'];
for(const n of req)if(!(n in e))throw new Error(`Missing XEX decode export: ${n}`);
const io=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0,mem=()=>new Uint8Array(e.memory.buffer);
const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const asc=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);
function makeXex({base=0x82000000,load=base,entry=base+0x1000,size=0x30000,enc=0,comp=0,desc=[[1,1],[3,1],[2,1]],secSize}={}){
  const s=0x100,ss=secSize??(0x184+desc.length*0x18),x=new Uint8Array(0x500);asc(x,0,'XEX2');p32(x,4,1);p32(x,8,0x400);p32(x,0x10,s);p32(x,0x14,6);let h=0x18;for(const [k,v] of [[0x3ff,0x60],[0x10100,entry],[0x10201,base],[0x103ff,0x90],[0x30000,0x20],[0x40006,0x70]]){p32(x,h,k);p32(x,h+4,v>>>0);h+=8}p32(x,0x60,8);p16(x,0x64,enc);p16(x,0x66,comp);p32(x,0x70,0xAABBCCDD);p32(x,0x7c,0x584108CE);p32(x,0x90,4);p32(x,s,ss);p32(x,s+4,size);p32(x,s+0x10c,0x400);p32(x,s+0x110,load);p32(x,s+0x178,0xffffffff);p32(x,s+0x17c,0x08000000);p32(x,s+0x180,desc.length);desc.forEach(([t,n],i)=>p32(x,s+0x184+i*0x18,((n<<4)|t)>>>0));return x;
}
function decode(x){if(x.length>cap)throw new Error('staging overflow');mem().set(x,io);return e.r360_xex_decode(x.length)>>>0}
function expect(x,status,label){const got=decode(x);if(got!==status)throw new Error(`${label}: expected ${status}, got ${got}`)}
const good=makeXex();expect(good,1,'valid XEX2');
if((e.r360_xex_decode_status()>>>0)!==1||(e.r360_xex_decode_entry_point()>>>0)!==0x82001000||(e.r360_xex_decode_image_base()>>>0)!==0x82000000||(e.r360_xex_decode_load_address()>>>0)!==0x82000000||(e.r360_xex_decode_image_size()>>>0)!==0x30000)throw new Error('core image metadata mismatch');
if((e.r360_xex_decode_title_id()>>>0)!==0x584108CE||(e.r360_xex_decode_media_id()>>>0)!==0xAABBCCDD)throw new Error('execution metadata mismatch');
if((e.r360_xex_decode_page_size()>>>0)!==0x10000||(e.r360_xex_decode_page_descriptor_count()>>>0)!==3||(e.r360_xex_decode_mapped_span()>>>0)!==0x30000)throw new Error('64K page layout mismatch');
for(const [i,t,a] of [[0,1,0x82000000],[1,3,0x82010000],[2,2,0x82020000]])if((e.r360_xex_decode_page_type(i)>>>0)!==t||(e.r360_xex_decode_page_count(i)>>>0)!==1||(e.r360_xex_decode_page_address(i)>>>0)!==a||(e.r360_xex_decode_page_bytes(i)>>>0)!==0x10000)throw new Error(`descriptor ${i} mismatch`);
expect(makeXex({base:0x91000000,entry:0x91000040,size:0x3000,desc:[[1,1],[3,1],[2,1]]}),1,'4K layout');if((e.r360_xex_decode_page_size()>>>0)!==0x1000)throw new Error('4K Xenia page-size mismatch');
expect(makeXex({enc:1,comp:1}),1,'known basic format');expect(makeXex({enc:1,comp:2}),1,'known normal format');
expect(makeXex({comp:3}),106,'delta fail closed');console.log('XEX_DELTA_COMPRESSION_FAIL_CLOSED=PASS');
expect(makeXex({desc:[[4,1],[3,1],[2,1]]}),107,'bad descriptor type');console.log('XEX_PAGE_DESCRIPTOR_FAIL_CLOSED=PASS');
expect(makeXex({size:0x40000}),107,'short descriptor span');console.log('XEX_DESCRIPTOR_SPAN_FAIL_CLOSED=PASS');
expect(makeXex({entry:0x83000000}),108,'entry range');console.log('XEX_ENTRY_RANGE_FAIL_CLOSED=PASS');
expect(makeXex({base:0xfffff000,entry:0xfffff100,size:0x3000,desc:[[1,3]]}),108,'image wrap');console.log('XEX_IMAGE_WRAP_FAIL_CLOSED=PASS');
expect(makeXex({secSize:0x184}),107,'security bounds');console.log('XEX_SECURITY_BOUNDS_FAIL_CLOSED=PASS');
expect(good.slice(0,0x200),102,'header truncation');console.log('XEX_HEADER_BOUNDS_FAIL_CLOSED=PASS');
console.log('XEX_IMAGE_DECODE=PASS');
