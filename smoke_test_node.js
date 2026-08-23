const fs=require('fs');
const path=require('path');

function put32be(mem,off,v){mem[off]=(v>>>24)&255;mem[off+1]=(v>>>16)&255;mem[off+2]=(v>>>8)&255;mem[off+3]=v&255}
function put16be(mem,off,v){mem[off]=(v>>>8)&255;mem[off+1]=v&255}

(async()=>{
  const wasm=fs.readFileSync(path.join(__dirname,'../render360_xenia_core.wasm'));
  const {instance}=await WebAssembly.instantiate(wasm,{}), e=instance.exports;
  if(e.r360_build_version()!==28)throw new Error('build version mismatch');
  if(e.r360_abi_version()!==0x00030000)throw new Error('ABI mismatch');
  const ptr=e.r360_io_ptr()>>>0, mem=new Uint8Array(e.memory.buffer);

  for(const [magic,want] of [['XEX2',2],['LIVE',10],['PIRS',11]]){
    mem.fill(0,ptr,ptr+32);mem.set(Buffer.from(magic),ptr);
    const got=e.r360_probe_container(32);if(got!==want)throw new Error(`${magic}: ${got} != ${want}`);
  }
  mem.fill(0,ptr,ptr+32);mem.set(Buffer.from([0x7f,0x45,0x4c,0x46]),ptr);
  if(e.r360_probe_container(32)!==20)throw new Error('ELF probe failed');

  const x=ptr;
  mem.fill(0,x,x+0x300);mem.set(Buffer.from('XEX2'),x);
  put32be(mem,x+0x04,1);          // module flags
  put32be(mem,x+0x08,0x280);      // header size
  put32be(mem,x+0x10,0x80);       // security offset
  put32be(mem,x+0x14,4);          // optional header count
  let h=x+0x18;
  put32be(mem,h+0x00,0x00010100);put32be(mem,h+0x04,0x82001234);h+=8;
  put32be(mem,h+0x00,0x00010201);put32be(mem,h+0x04,0x82000000);h+=8;
  put32be(mem,h+0x00,0x00040006);put32be(mem,h+0x04,0x40);h+=8;
  put32be(mem,h+0x00,0x000003FF);put32be(mem,h+0x04,0x58);
  put32be(mem,x+0x40,0xAABBCCDD);put32be(mem,x+0x4C,0x584108CE);
  put32be(mem,x+0x58,8);put16be(mem,x+0x5C,1);put16be(mem,x+0x5E,2);
  put32be(mem,x+0x80+0x004,0x01000000);
  put32be(mem,x+0x80+0x110,0x82000000);
  put32be(mem,x+0x80+0x178,0xFFFFFFFF);
  put32be(mem,x+0x80+0x17C,0x00000001);
  put32be(mem,x+0x80+0x180,12);

  if(e.r360_inspect_xex(0x300)!==1)throw new Error('XEX inspection failed');
  const checks=[
    ['title',e.r360_xex_title_id()>>>0,0x584108CE],
    ['entry',e.r360_xex_entry_point()>>>0,0x82001234],
    ['base',e.r360_xex_image_base()>>>0,0x82000000],
    ['compression',e.r360_xex_compression_type()>>>0,2],
    ['encryption',e.r360_xex_encryption_type()>>>0,1],
    ['image size',e.r360_xex_image_size()>>>0,0x01000000],
    ['load address',e.r360_xex_load_address()>>>0,0x82000000],
    ['page descriptors',e.r360_xex_page_descriptor_count()>>>0,12],
  ];
  for(const [name,got,want] of checks){if(got!==want)throw new Error(`${name}: 0x${got.toString(16)} != 0x${want.toString(16)}`)}
  if(e.r360_xam_scalar_value(0x3CB)!==6)throw new Error('XGetAVPack mismatch');
  if((e.r360_xam_scalar_value(0x123)>>>0)!==0xFFFFFFFF)throw new Error('unknown XAM must remain strict');
  console.log('PASS', {build:e.r360_build_version(),abi:e.r360_abi_version().toString(16),features:e.r360_feature_bits().toString(16),title:(e.r360_xex_title_id()>>>0).toString(16)});
})().catch(e=>{console.error(e);process.exit(1)});
