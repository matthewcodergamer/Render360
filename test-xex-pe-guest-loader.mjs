import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`bootstrap WASM not found: ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const im of WebAssembly.Module.imports(module)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const pick=n=>instance.exports[n]??instance.exports[`_${n}`];
const required=[
  'r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity',
  'r360_xex_guest_mapper_status','r360_pe_guest_reset','r360_pe_guest_load','r360_pe_guest_status',
  'r360_pe_guest_entry_address','r360_pe_guest_section_count','r360_pe_guest_raw_bytes',
  'r360_xex_guest_mapper_mapped_bytes','r360_sparse_guest_memory_read_u8',
  'r360_sparse_guest_memory_write_u8','r360_sparse_guest_memory_last_fault_code'
];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`missing PE guest loader export ${n}`);
const p16=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const ok=(v,m)=>{if((v>>>0)!==1)throw new Error(m)};
const no=(v,m)=>{if((v>>>0)!==0)throw new Error(m)};
const eq=(a,b,m)=>{if((a>>>0)!==(b>>>0))throw new Error(`${m}: got 0x${(a>>>0).toString(16)}, expected 0x${(b>>>0).toString(16)}`)};

function makePE(){
  const a=new Uint8Array(0x600),nt=0x80,opt=nt+24,sections=opt+224;
  p16(a,0,0x5A4D);p32(a,0x3c,nt);p32(a,nt,0x00004550);
  p16(a,nt+4,0x01F2);p16(a,nt+6,2);p16(a,nt+20,224);p16(a,nt+22,0x0102);
  p16(a,opt,0x10B);p32(a,opt+16,0x1000);p32(a,opt+28,0x82000000);
  p32(a,opt+32,0x1000);p32(a,opt+36,0x200);p32(a,opt+56,0x3000);p32(a,opt+60,0x200);p16(a,opt+68,14);
  a.set(Buffer.from('.text\0\0\0','ascii'),sections);p32(a,sections+8,0x300);p32(a,sections+12,0x1000);p32(a,sections+16,0x200);p32(a,sections+20,0x200);p32(a,sections+36,0x60000020);
  const d=sections+40;a.set(Buffer.from('.data\0\0\0','ascii'),d);p32(a,d+8,0x300);p32(a,d+12,0x2000);p32(a,d+16,0x200);p32(a,d+20,0x400);p32(a,d+36,0xC0000040);
  for(let i=0x200;i<0x400;i++)a[i]=(i*13+7)&255;
  for(let i=0x400;i<0x600;i++)a[i]=(i*5+3)&255;
  return a;
}

const input=pick('r360_xex_guest_mapper_input_buffer')()>>>0;
const cap=pick('r360_xex_guest_mapper_input_capacity')()>>>0;
const pe=makePE();if(!input||pe.length>cap)throw new Error('staging buffer too small');
new Uint8Array(instance.exports.memory.buffer,input,pe.length).set(pe);
pick('r360_pe_guest_reset')();
const loaded=pick('r360_pe_guest_load')(input,pe.length)>>>0;
if(loaded!==1){
  const loader=pick('r360_pe_guest_status')()>>>0;
  const mapper=pick('r360_xex_guest_mapper_status')()>>>0;
  throw new Error(`prepared PE guest load failed loader=0x${loader.toString(16)} mapper=0x${mapper.toString(16)}`);
}
eq(pick('r360_pe_guest_status')(),1,'loader status');
eq(pick('r360_pe_guest_entry_address')(),0x82001000,'decoder-derived entry');
eq(pick('r360_pe_guest_section_count')(),2,'mapped section count');
eq(pick('r360_pe_guest_raw_bytes')(),0x400,'raw bytes copied');
eq(pick('r360_xex_guest_mapper_mapped_bytes')(),0x2000,'page-rounded guest bytes');

const text0=(0x200*13+7)&255,data0=(0x400*5+3)&255;
eq(pick('r360_sparse_guest_memory_read_u8')(0x82001000),text0,'text byte came from PE raw data');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82002000),data0,'data byte came from PE raw data');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82001280),0,'text virtual tail zero fill');
no(pick('r360_sparse_guest_memory_write_u8')(0x82001000,0xaa),'RX text must reject write');
eq(pick('r360_sparse_guest_memory_last_fault_code')(),3,'RX fault code');
ok(pick('r360_sparse_guest_memory_write_u8')(0x82002000,0xcc),'RW data must remain writable');
eq(pick('r360_sparse_guest_memory_read_u8')(0x82002000),0xcc,'RW writeback');
console.log('PREPARED_PE_SECTION_BYTES=PASS');
console.log('PREPARED_PE_ZERO_FILL=PASS');
console.log('PREPARED_PE_RX_PERMISSION=PASS');
console.log('PREPARED_PE_RW_PERMISSION=PASS');
console.log('PREPARED_PE_ENTRY=PASS');
console.log('PREPARED_IMAGE_TO_GUEST_MAPPING=PASS');

// Fail closed if the PE section omits the readable permission that the mapper contract requires.
const bad=makePE();const sh=0x80+24+224;p32(bad,sh+36,0x20000020);new Uint8Array(instance.exports.memory.buffer,input,bad.length).set(bad);
no(pick('r360_pe_guest_load')(input,bad.length),'non-readable executable section must fail');
eq(pick('r360_pe_guest_status')(),0x81000004,'permission failure status');
console.log('PREPARED_PE_PERMISSION_FAIL_CLOSED=PASS');
