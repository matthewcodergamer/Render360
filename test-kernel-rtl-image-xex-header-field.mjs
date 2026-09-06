import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};
    imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const bootstrap=await WebAssembly.instantiate(mod,imports);
wasi.initialize(bootstrap);
const e=bootstrap.exports;
const pick=name=>e[name]??e[`_${name}`];
const need=name=>{const fn=pick(name);if(typeof fn!=='function')throw new Error(`missing export ${name}`);return fn;};

const alloc=need('r360_sparse_guest_memory_alloc');
const map=need('r360_sparse_guest_memory_map');
const write8=need('r360_sparse_guest_memory_write_u8');
const service=need('r360_kernel_service_call');
const serviceStatus=need('r360_kernel_service_status');

const base=0x51000000;
const backing=alloc(1)>>>0;
if(!backing||(map(base,1,backing,0,3)>>>0)!==1)throw new Error('unable to map synthetic guest XEX header');
const put8=(address,value)=>{if((write8(address>>>0,value&0xff)>>>0)!==1)throw new Error(`write failed @ 0x${(address>>>0).toString(16)}`);};
const put32=(address,value)=>{const v=value>>>0;for(let i=0;i<4;i++)put8(address+i,(v>>>(24-i*8))&0xff);};

// Minimal guest XEX2 header with three optional headers, exercising all three
// pointer/value modes used by Xenia UserModule::GetOptHeader.
put32(base+0x00,0x58455832); // XEX2
put32(base+0x08,0x80);
put32(base+0x14,3);
put32(base+0x18,0x00010100); // XEX_HEADER_ENTRY_POINT, key & 0xff == 0
put32(base+0x1c,0x8236ef38);
put32(base+0x20,0x00010201); // XEX_HEADER_IMAGE_BASE_ADDRESS, key & 0xff == 1
put32(base+0x24,0x82000000);
put32(base+0x28,0x00040006); // XEX_HEADER_EXECUTION_INFO, offset-backed
put32(base+0x2c,0x60);
put32(base+0x60,0x11223344);

function rtlField(field){
  const result=service(1,0x12b,base,field>>>0,0,0,0,0,0,0)>>>0;
  const status=serviceStatus()>>>0;
  if(status!==1)throw new Error(`RtlImageXexHeaderField status ${status} for 0x${field.toString(16)}`);
  return result;
}

if(rtlField(0x00010100)!==0x8236ef38)throw new Error('inline-value optional header mismatch');
if(rtlField(0x00010201)!==base+0x24)throw new Error('value-address optional header mismatch');
if(rtlField(0x00040006)!==base+0x60)throw new Error('offset-backed optional header mismatch');
if(rtlField(0x00040201)!==0)throw new Error('missing optional header must return null');

console.log('RTL_IMAGE_XEX_HEADER_FIELD_INLINE_VALUE=PASS');
console.log('RTL_IMAGE_XEX_HEADER_FIELD_VALUE_ADDRESS=PASS');
console.log('RTL_IMAGE_XEX_HEADER_FIELD_OFFSET_POINTER=PASS');
console.log('RTL_IMAGE_XEX_HEADER_FIELD_MISSING_NULL=PASS');
