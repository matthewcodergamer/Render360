const fs=require('fs');
const path=require('path');
function put32be(mem,off,v){mem[off]=(v>>>24)&255;mem[off+1]=(v>>>16)&255;mem[off+2]=(v>>>8)&255;mem[off+3]=v&255}
function put64be(mem,off,v){const hi=Math.floor(v/0x100000000),lo=v>>>0;put32be(mem,off,hi);put32be(mem,off+4,lo)}
function put16be(mem,off,v){mem[off]=(v>>>8)&255;mem[off+1]=v&255}
function put16le(mem,off,v){mem[off]=v&255;mem[off+1]=(v>>>8)&255}
function put24le(mem,off,v){mem[off]=v&255;mem[off+1]=(v>>>8)&255;mem[off+2]=(v>>>16)&255}
function ascii(mem,off,s){mem.set(Buffer.from(s,'ascii'),off)}
function utf16be(mem,off,text){for(let i=0;i<text.length;i++){const v=text.charCodeAt(i);mem[off+i*2]=(v>>>8)&255;mem[off+i*2+1]=v&255}}
function u64(lo,hi){return (hi>>>0)*0x100000000+(lo>>>0)}
function makeSyntheticStfs(){
  // Header rounds from 0x971A to 0xA000. Read-only STFS layout:
  // hash L0 @ A000, data block0 @ B000, block1 @ C000,
  // data block2 @ D000 and block3 @ E000.
  const bytes=new Uint8Array(0xF000);
  ascii(bytes,0,'LIVE');
  put32be(bytes,0x340,0x971A); // XContentHeader.header_size
  put32be(bytes,0x344,0x000D0000); // content type
  put32be(bytes,0x348,2); // metadata version
  put64be(bytes,0x34C,0x3000); // content size diagnostic
  put32be(bytes,0x354,0xAABBCCDD); // execution media id
  put32be(bytes,0x360,0x584108CE); // execution title id
  const d=0x379;
  bytes[d+0]=0x24;bytes[d+1]=0;bytes[d+2]=1; // read_only_format
  put16le(bytes,d+3,2); // file table has two blocks
  put24le(bytes,d+5,0); // starts at STFS data block 0
  put32be(bytes,d+0x1C,4); // total blocks
  put32be(bytes,d+0x20,0); // free blocks
  put32be(bytes,0x39D,0); // data_file_count
  put32be(bytes,0x3A9,0); // XContentVolumeType::kStfs
  utf16be(bytes,0x411,'Render360 Native Mount');

  // L0 hash record for data block 0 -> next directory block 2.
  put32be(bytes,0xA000+0x14,2);

  // Directory block 0: one ordinary root file. The next table block is #2.
  let e=0xB000;
  ascii(bytes,e,'readme.txt');bytes[e+0x28]=0x40+10;
  put24le(bytes,e+0x29,1);put24le(bytes,e+0x2C,1);put24le(bytes,e+0x2F,1);
  put16be(bytes,e+0x32,0xFFFF);put32be(bytes,e+0x34,0x10);

  // Directory block 2: root default.xex at data block 3.
  e=0xD000;
  ascii(bytes,e,'default.xex');bytes[e+0x28]=0x40+11;
  put24le(bytes,e+0x29,1);put24le(bytes,e+0x2C,1);put24le(bytes,e+0x2F,3);
  put16be(bytes,e+0x32,0xFFFF);put32be(bytes,e+0x34,0x1000);

  // First data block of default.xex. V30 only proves embedded XEX magic here.
  ascii(bytes,0xE000,'XEX2');
  return bytes;
}
(async()=>{
  const wasm=fs.readFileSync(path.join(__dirname,'../render360_xenia_core.wasm'));
  const {instance}=await WebAssembly.instantiate(wasm,{}),e=instance.exports;
  if(e.r360_build_version()!==30)throw new Error('build version mismatch');
  if(e.r360_abi_version()!==0x00030002)throw new Error('ABI mismatch');
  if((e.r360_feature_bits()>>>0)!==0x7FF)throw new Error('feature bits mismatch');
  const ptr=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0;
  const memory=()=>new Uint8Array(e.memory.buffer);
  const copyToIo=(src)=>{if(src.length>cap)throw new Error('test staging overflow');memory().set(src,ptr)};

  for(const [magic,want] of [['XEX2',2],['LIVE',10],['PIRS',11],['CON ',12]]){
    const b=Buffer.alloc(16);b.write(magic);copyToIo(b);const got=e.r360_probe_container(b.length)>>>0;if(got!==want)throw new Error(`${magic}: ${got} != ${want}`);
  }

  // Synthetic direct XEX inspection remains strict and intact.
  const x=new Uint8Array(0x300);ascii(x,0,'XEX2');put32be(x,4,1);put32be(x,8,0x280);put32be(x,0x10,0x80);put32be(x,0x14,4);
  let h=0x18;put32be(x,h,0x00010100);put32be(x,h+4,0x82001234);h+=8;put32be(x,h,0x00010201);put32be(x,h+4,0x82000000);h+=8;put32be(x,h,0x00040006);put32be(x,h+4,0x40);h+=8;put32be(x,h,0x000003FF);put32be(x,h+4,0x58);
  put32be(x,0x40,0xAABBCCDD);put32be(x,0x4C,0x584108CE);put32be(x,0x58,8);put16be(x,0x5C,1);put16be(x,0x5E,2);put32be(x,0x84,0x01000000);put32be(x,0x190,0x82000000);put32be(x,0x1F8,0xFFFFFFFF);put32be(x,0x1FC,1);put32be(x,0x200,12);
  copyToIo(x);if((e.r360_inspect_xex(x.length)>>>0)!==1)throw new Error('XEX inspection failed');if((e.r360_xex_entry_point()>>>0)!==0x82001234)throw new Error('XEX entry mismatch');

  // Drive the native pull-I/O STFS mount exactly as the browser bridge does.
  const image=makeSyntheticStfs();
  let status=e.r360_stfs_mount_begin(image.length>>>0,0)>>>0;
  let requests=0;
  while((e.r360_stfs_request_pending()>>>0)!==0){
    if(++requests>32)throw new Error('STFS request loop runaway');
    const off=u64(e.r360_stfs_request_offset_lo(),e.r360_stfs_request_offset_hi());
    const size=e.r360_stfs_request_size()>>>0;
    const chunk=image.slice(off,off+size);
    if(chunk.length!==size)throw new Error(`synthetic short read @0x${off.toString(16)}`);
    copyToIo(chunk);
    status=e.r360_stfs_submit_read(chunk.length)>>>0;
  }
  if(status!==2)throw new Error(`STFS native mount status ${status}`);
  if((e.r360_stfs_title_id()>>>0)!==0x584108CE)throw new Error('STFS title mismatch');
  if((e.r360_stfs_media_id()>>>0)!==0xAABBCCDD)throw new Error('STFS media mismatch');
  if((e.r360_stfs_directory_blocks_read()>>>0)!==2)throw new Error('STFS directory chain did not traverse two blocks');
  if((e.r360_stfs_entry_count()>>>0)!==2)throw new Error('STFS entry count mismatch');
  const dx=e.r360_stfs_default_xex_index()>>>0;if(dx!==1)throw new Error(`default.xex index ${dx}`);
  if((e.r360_stfs_default_xex_kind()>>>0)!==2)throw new Error('embedded XEX2 probe failed');
  const np=e.r360_stfs_entry_name_ptr(dx)>>>0,nl=e.r360_stfs_entry_name_length(dx)>>>0;
  const nm=Buffer.from(memory().slice(np,np+nl)).toString('ascii');if(nm!=='default.xex')throw new Error(`default name ${nm}`);
  const dp=e.r360_stfs_display_name_ptr()>>>0,dl=e.r360_stfs_display_name_length()>>>0;
  const display=Buffer.from(memory().slice(dp,dp+dl)).toString('ascii');if(display!=='Render360 Native Mount')throw new Error(`display name ${display}`);

  e.r360_runtime_reset();e.r360_runtime_set_input(0x11);e.r360_runtime_set_session(10,3,0x584108CE);for(let i=0;i<120;i++)e.r360_runtime_tick(16667);
  if((e.r360_runtime_ticks_lo()>>>0)!==120)throw new Error('runtime tick loop failed');
  if((e.r360_runtime_session_stage()>>>0)!==3)throw new Error('runtime session stage failed');
  if((e.r360_runtime_work_lo()>>>0)!==(120*(256+3*32)))throw new Error('runtime work mismatch');
  if(e.r360_xam_scalar_value(0x3CB)!==6)throw new Error('XGetAVPack mismatch');
  if((e.r360_xam_scalar_value(0x123)>>>0)!==0xFFFFFFFF)throw new Error('unknown XAM must remain strict');

  console.log('PASS',{
    build:e.r360_build_version(),abi:e.r360_abi_version().toString(16),features:e.r360_feature_bits().toString(16),
    stfsRequests:requests,entries:e.r360_stfs_entry_count(),defaultXexKind:e.r360_stfs_default_xex_kind(),title:(e.r360_stfs_title_id()>>>0).toString(16)
  });
})().catch(err=>{console.error(err);process.exit(1)});
