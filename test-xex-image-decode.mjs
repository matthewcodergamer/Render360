import fs from 'node:fs';

const wasm = fs.readFileSync('render360_xenia_core.wasm');
const { instance } = await WebAssembly.instantiate(wasm, {});
const e = instance.exports;

const required = [
  'memory','r360_io_ptr','r360_io_capacity','r360_xex_image_decode',
  'r360_xex_image_status','r360_xex_image_entry_point','r360_xex_image_base',
  'r360_xex_image_load_address','r360_xex_image_size','r360_xex_image_flags',
  'r360_xex_image_title_id','r360_xex_image_media_id',
  'r360_xex_image_encryption_type','r360_xex_image_compression_type',
  'r360_xex_image_page_size','r360_xex_image_page_descriptor_count',
  'r360_xex_image_mapped_span','r360_xex_image_page_type',
  'r360_xex_image_page_count','r360_xex_image_page_address',
  'r360_xex_image_page_bytes'
];
for (const name of required) {
  if (!(name in e)) throw new Error(`Missing XEX image decode ABI export: ${name}`);
}

const io = e.r360_io_ptr() >>> 0;
const cap = e.r360_io_capacity() >>> 0;
const memory = () => new Uint8Array(e.memory.buffer);
function stage(bytes) {
  if (bytes.length > cap) throw new Error('XEX critic staging overflow');
  memory().set(bytes, io);
}
function put16be(a,o,v){a[o]=(v>>>8)&255;a[o+1]=v&255;}
function put32be(a,o,v){a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255;}
function ascii(a,o,s){a.set(Buffer.from(s,'ascii'),o);}

function makeXex({
  imageBase=0x82000000,
  loadAddress=0x82000000,
  entryPoint=0x82001000,
  imageSize=0x30000,
  encryption=0,
  compression=0,
  descriptors=[[1,1],[3,1],[2,1]],
  securitySizeOverride=null,
}={}) {
  const securityOffset = 0x100;
  const securitySize = securitySizeOverride ?? (0x184 + descriptors.length * 0x18);
  const headerSize = 0x400;
  const x = new Uint8Array(0x500);
  ascii(x,0,'XEX2');
  put32be(x,4,1);
  put32be(x,8,headerSize);
  put32be(x,0x10,securityOffset);
  put32be(x,0x14,6);
  let h=0x18;
  const opt=(key,value)=>{put32be(x,h,key);put32be(x,h+4,value>>>0);h+=8;};
  opt(0x000003FF,0x60); // file format info
  opt(0x00010100,entryPoint);
  opt(0x00010201,imageBase);
  opt(0x000103FF,0x90); // imports blob
  opt(0x00030000,0x00000020); // system flags
  opt(0x00040006,0x70); // execution info
  put32be(x,0x60,8); put16be(x,0x64,encryption); put16be(x,0x66,compression);
  put32be(x,0x70,0xAABBCCDD); put32be(x,0x7C,0x584108CE);
  put32be(x,0x90,4);
  put32be(x,securityOffset+0x00,securitySize);
  put32be(x,securityOffset+0x04,imageSize);
  put32be(x,securityOffset+0x10C,0x00000400);
  put32be(x,securityOffset+0x110,loadAddress);
  put32be(x,securityOffset+0x178,0xFFFFFFFF);
  put32be(x,securityOffset+0x17C,0x08000000);
  put32be(x,securityOffset+0x180,descriptors.length);
  descriptors.forEach(([type,pages],i)=>{
    put32be(x,securityOffset+0x184+i*0x18,((pages<<4)|type)>>>0);
  });
  return x;
}

function decode(bytes) { stage(bytes); return e.r360_xex_image_decode(bytes.length)>>>0; }
function expectStatus(bytes,status,label){const got=decode(bytes);if(got!==status)throw new Error(`${label}: expected status ${status}, got ${got}`);}

const good=makeXex();
expectStatus(good,1,'valid XEX2');
if((e.r360_xex_image_status()>>>0)!==1)throw new Error('valid decode did not remain PASS');
if((e.r360_xex_image_entry_point()>>>0)!==0x82001000)throw new Error('entry point mismatch');
if((e.r360_xex_image_base()>>>0)!==0x82000000)throw new Error('image base mismatch');
if((e.r360_xex_image_load_address()>>>0)!==0x82000000)throw new Error('load address mismatch');
if((e.r360_xex_image_size()>>>0)!==0x30000)throw new Error('image size mismatch');
if((e.r360_xex_image_title_id()>>>0)!==0x584108CE)throw new Error('title id mismatch');
if((e.r360_xex_image_media_id()>>>0)!==0xAABBCCDD)throw new Error('media id mismatch');
if((e.r360_xex_image_encryption_type()>>>0)!==0||(e.r360_xex_image_compression_type()>>>0)!==0)throw new Error('format metadata mismatch');
if((e.r360_xex_image_page_size()>>>0)!==0x10000)throw new Error('Xenia 64K title page size mismatch');
if((e.r360_xex_image_page_descriptor_count()>>>0)!==3)throw new Error('descriptor count mismatch');
if((e.r360_xex_image_mapped_span()>>>0)!==0x30000)throw new Error('mapped span mismatch');
const expected=[
  [1,1,0x82000000,0x10000],
  [3,1,0x82010000,0x10000],
  [2,1,0x82020000,0x10000],
];
for(let i=0;i<expected.length;i++){
  const [type,count,address,size]=expected[i];
  if((e.r360_xex_image_page_type(i)>>>0)!==type||
     (e.r360_xex_image_page_count(i)>>>0)!==count||
     (e.r360_xex_image_page_address(i)>>>0)!==address||
     (e.r360_xex_image_page_bytes(i)>>>0)!==size){
    throw new Error(`descriptor ${i} mismatch`);
  }
}

// Xenia switches executable image pages above 0x90000000 to 4 KiB.
const high=makeXex({imageBase:0x91000000,loadAddress:0x91000000,entryPoint:0x91000040,imageSize:0x3000,descriptors:[[1,1],[3,1],[2,1]]});
expectStatus(high,1,'high image base');
if((e.r360_xex_image_page_size()>>>0)!==0x1000||(e.r360_xex_image_mapped_span()>>>0)!==0x3000)throw new Error('Xenia 4K title page layout mismatch');

// Normal encryption/basic or normal compression are known Xenia formats and
// are metadata-valid even though image preparation/decompression is a later gate.
expectStatus(makeXex({encryption:1,compression:1}),1,'normal encryption/basic compression metadata');
expectStatus(makeXex({encryption:1,compression:2}),1,'normal encryption/normal compression metadata');

const delta=makeXex({compression:3});
expectStatus(delta,106,'delta compression fail closed');
console.log('XEX_DELTA_COMPRESSION_FAIL_CLOSED=PASS');

const badType=makeXex({descriptors:[[4,1],[3,1],[2,1]]});
expectStatus(badType,107,'invalid page type fail closed');
console.log('XEX_PAGE_DESCRIPTOR_FAIL_CLOSED=PASS');

const shortSpan=makeXex({imageSize:0x40000});
expectStatus(shortSpan,107,'descriptor span shorter than image fail closed');
console.log('XEX_DESCRIPTOR_SPAN_FAIL_CLOSED=PASS');

const badEntry=makeXex({entryPoint:0x83000000});
expectStatus(badEntry,108,'entry outside image fail closed');
console.log('XEX_ENTRY_RANGE_FAIL_CLOSED=PASS');

const wrap=makeXex({imageBase:0xFFFFF000,loadAddress:0xFFFFF000,entryPoint:0xFFFFF100,imageSize:0x3000,descriptors:[[1,3]]});
expectStatus(wrap,108,'32-bit image wrap fail closed');
console.log('XEX_IMAGE_WRAP_FAIL_CLOSED=PASS');

const badSecurity=makeXex({securitySizeOverride:0x184});
expectStatus(badSecurity,107,'truncated descriptor security area fail closed');
console.log('XEX_SECURITY_BOUNDS_FAIL_CLOSED=PASS');

const truncated=good.slice(0,0x200);
expectStatus(truncated,102,'truncated header fail closed');
console.log('XEX_HEADER_BOUNDS_FAIL_CLOSED=PASS');

console.log('XEX_IMAGE_DECODE=PASS');
console.log('PASS: reconstructed-XEX metadata decode, Xenia page layout, section descriptors, entry/image bounds, known format classification and unsupported/corrupt forms are fail-closed.');
