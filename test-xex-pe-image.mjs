import fs from 'node:fs';

const {instance}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const e=instance.exports;
const required=[
  'memory','r360_io_ptr','r360_io_capacity','r360_xex_pe_reset','r360_xex_pe_decode',
  'r360_xex_pe_status','r360_xex_pe_machine','r360_xex_pe_section_count',
  'r360_xex_pe_entry_rva','r360_xex_pe_image_base','r360_xex_pe_section_alignment',
  'r360_xex_pe_file_alignment','r360_xex_pe_size_of_image','r360_xex_pe_size_of_headers',
  'r360_xex_pe_subsystem','r360_xex_pe_section_virtual_address',
  'r360_xex_pe_section_virtual_size','r360_xex_pe_section_raw_address',
  'r360_xex_pe_section_raw_size','r360_xex_pe_section_characteristics'
];
for(const n of required)if(!(n in e))throw new Error(`missing PE export ${n}`);
const io=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0;
const mem=()=>new Uint8Array(e.memory.buffer);
const p16=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const stage=a=>{if(a.length>cap)throw new Error('PE stage overflow');mem().set(a,io)};

function makePE(){
  const a=new Uint8Array(0x600),nt=0x80,opt=nt+24,sections=opt+224;
  p16(a,0,0x5A4D);p32(a,0x3c,nt);p32(a,nt,0x00004550);
  p16(a,nt+4,0x01F2);p16(a,nt+6,2);p16(a,nt+20,224);p16(a,nt+22,0x0102);
  p16(a,opt,0x10B);p32(a,opt+16,0x1000);p32(a,opt+28,0x82000000);
  p32(a,opt+32,0x1000);p32(a,opt+36,0x200);p32(a,opt+56,0x3000);p32(a,opt+60,0x200);p16(a,opt+68,14);
  a.set(Buffer.from('.text\0\0\0','ascii'),sections);p32(a,sections+8,0x180);p32(a,sections+12,0x1000);p32(a,sections+16,0x200);p32(a,sections+20,0x200);p32(a,sections+36,0x60000020);
  const d=sections+40;a.set(Buffer.from('.data\0\0\0','ascii'),d);p32(a,d+8,0x100);p32(a,d+12,0x2000);p32(a,d+16,0x200);p32(a,d+20,0x400);p32(a,d+36,0xC0000040);
  for(let i=0x200;i<0x400;i++)a[i]=(i*13+7)&255;
  for(let i=0x400;i<0x600;i++)a[i]=(i*5+3)&255;
  return a;
}
function decode(a){stage(a);return e.r360_xex_pe_decode(a.length)>>>0}
const good=makePE();
if(decode(good)!==1)throw new Error(`valid Xbox PE failed ${e.r360_xex_pe_status()>>>0}`);
if((e.r360_xex_pe_machine()>>>0)!==0x1F2||(e.r360_xex_pe_subsystem()>>>0)!==14)throw new Error('Xbox PE identity mismatch');
if((e.r360_xex_pe_section_count()>>>0)!==2||(e.r360_xex_pe_entry_rva()>>>0)!==0x1000||(e.r360_xex_pe_image_base()>>>0)!==0x82000000)throw new Error('PE core metadata mismatch');
if((e.r360_xex_pe_section_alignment()>>>0)!==0x1000||(e.r360_xex_pe_file_alignment()>>>0)!==0x200||(e.r360_xex_pe_size_of_image()>>>0)!==0x3000||(e.r360_xex_pe_size_of_headers()>>>0)!==0x200)throw new Error('PE layout metadata mismatch');
if((e.r360_xex_pe_section_virtual_address(0)>>>0)!==0x1000||(e.r360_xex_pe_section_raw_address(0)>>>0)!==0x200||(e.r360_xex_pe_section_characteristics(0)>>>0)!==0x60000020)throw new Error('.text metadata mismatch');
if((e.r360_xex_pe_section_virtual_address(1)>>>0)!==0x2000||(e.r360_xex_pe_section_raw_address(1)>>>0)!==0x400||(e.r360_xex_pe_section_characteristics(1)>>>0)!==0xC0000040)throw new Error('.data metadata mismatch');
console.log('XEX_PE_DOS_SIGNATURE=PASS');
console.log('XEX_PE_NT_SIGNATURE=PASS');
console.log('XEX_PE_POWERPCBE_MACHINE=PASS');
console.log('XEX_PE_32BIT_OPTIONAL_HEADER=PASS');
console.log('XEX_PE_XBOX_SUBSYSTEM=PASS');
console.log('XEX_PE_SECTION_TABLE=PASS');
console.log('XEX_PE_SECTION_RAW_BOUNDS=PASS');
console.log('XEX_PE_SECTION_VIRTUAL_BOUNDS=PASS');
console.log('XEX_PE_ENTRY_EXECUTABLE=PASS');

function expect(mut,status,label){const a=makePE();mut(a);const got=decode(a);if(got!==status)throw new Error(`${label}: expected ${status}, got ${got}`)}
expect(a=>p16(a,0,0),101,'DOS signature');
expect(a=>p32(a,0x3c,0x5f0),102,'NT range');
expect(a=>p32(a,0x80,0),103,'NT signature');
expect(a=>p16(a,0x84,0x14c),104,'machine');
expect(a=>p16(a,0x80+20,0),105,'optional header size');
expect(a=>p16(a,0x80+24+68,2),106,'subsystem');
expect(a=>p16(a,0x80+6,97),107,'section count');
expect(a=>p32(a,0x80+24+224+20,0x580),108,'raw overrun');
expect(a=>p32(a,0x80+24+224+12,0x2f00),108,'virtual overrun');
expect(a=>p32(a,0x80+24+16,0x2000),109,'entry not executable');
console.log('XEX_PE_MALFORMED_FAIL_CLOSED=PASS');
console.log('XEX_PE_IMAGE=PASS');
