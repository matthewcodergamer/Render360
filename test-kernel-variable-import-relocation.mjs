import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';
import { handoffDefaultXex } from './render360-title-controller.mjs';

const {instance:core}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);

const p16le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const p16be=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]);
const zero=Buffer.alloc(16);
const aes=(k,d)=>{const c=crypto.createCipheriv('aes-128-cbc',k,zero);c.setAutoPadding(false);return Buffer.concat([c.update(d),c.final()])};

function pe(base){
  const a=Buffer.alloc(0x400),nt=0x80,opt=nt+24,sh=opt+224;
  a.write('MZ',0,'ascii');p32le(a,0x3c,nt);p32le(a,nt,0x00004550);
  p16le(a,nt+4,0x01F2);p16le(a,nt+6,1);p16le(a,nt+20,224);p16le(a,nt+22,0x0102);
  p16le(a,opt,0x10B);p32le(a,opt+16,0x1000);p32le(a,opt+28,base);p32le(a,opt+32,0x1000);p32le(a,opt+36,0x200);p32le(a,opt+56,0x2000);p32le(a,opt+60,0x200);p16le(a,opt+68,14);
  a.write('.text\0\0\0',sh,'ascii');p32le(a,sh+8,0x200);p32le(a,sh+12,0x1000);p32le(a,sh+16,0x200);p32le(a,sh+20,0x200);p32le(a,sh+36,0x60000020);
  // Read the XEX variable import slot, dereference the kernel variable cell,
  // then return the HMODULE image_base field in r3. This is the exact two-load
  // shape Braid uses at 0x82373744/0x82373748.
  [0x3D607200,0x816B1100,0x816B0000,0x806B001C,0x4E800020].forEach((w,i)=>p32be(a,0x200+i*4,w));
  // XEX import descriptor: type 0 (variable), ordinal 0x193
  // = xboxkrnl!XexExecutableModuleHandle.
  p32be(a,0x300,0x00010193);
  return a;
}

function xex(base,body){
  const h=Buffer.alloc(0x400),s=0x100,ffi=0x60,exec=0x90,imp=0xB0;
  h.write('XEX2',0,'ascii');p32be(h,4,1);p32be(h,8,0x400);p32be(h,0x10,s);p32be(h,0x14,5);
  let p=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x1000],[0x10201,base],[0x103ff,imp],[0x40006,exec]]){p32be(h,p,k);p32be(h,p+4,v);p+=8}
  p32be(h,ffi,8);p16be(h,ffi+4,1);p16be(h,ffi+6,0);
  p32be(h,exec,0xAABBCCDD);p32be(h,exec+0x0c,0x584108CE);
  p32be(h,imp,0x48);p32be(h,imp+4,16);p32be(h,imp+8,1);h.write('xboxkrnl.exe\0',imp+12,'ascii');
  const lib=imp+28;p32be(h,lib,0x2C);p32be(h,lib+0x18,1);p32be(h,lib+0x1c,0x10000);p32be(h,lib+0x20,0x10000);p16be(h,lib+0x24,0);p16be(h,lib+0x26,1);p32be(h,lib+0x28,base+0x1100);
  p32be(h,s,0x19c);p32be(h,s+4,0x2000);p32be(h,s+0x110,base);p32be(h,s+0x178,0xffffffff);p32be(h,s+0x17c,0x08000000);p32be(h,s+0x180,1);p32be(h,s+0x184,0x11);
  return Buffer.concat([h,body]);
}

const base=0x72000000;
const plain=pe(base);
const session=Buffer.from(Array.from({length:16},(_,i)=>(0x47+i*17)&255));
const encryptedSecurityKey=aes(retail,session);
const defaultXex=xex(base,aes(session,plain));
const result=await handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey,entryBytes:20,prepareMainThreadContext:true});
const variables=result.kernelVariableRegistration;
if(!variables||variables.patched!==1||variables.variableAddress!==0x50010000||!variables.hmoduleAddress)throw new Error(`variable relocation telemetry mismatch ${JSON.stringify(variables)}`);
if(result.kernelRegistration.registered!==0)throw new Error(`variable import incorrectly registered as function: ${JSON.stringify(result.kernelRegistration)}`);
if(result.executionStatus!==3||result.runtimeBoundary!=='guest-return'||result.executionR3Hex.toLowerCase()!=='0x72000000')throw new Error(`variable import execution mismatch ${JSON.stringify({executionStatus:result.executionStatus,runtimeBoundary:result.runtimeBoundary,executionR3Hex:result.executionR3Hex,memoryFaultAddress:result.memoryFaultAddress,memoryFaultCode:result.memoryFaultCode})}`);
const read=bootstrap.exports.r360_ppc_probe_read_guest_u32_be??bootstrap.exports._r360_ppc_probe_read_guest_u32_be;
if(typeof read!=='function')throw new Error('missing guest readback export');
if((read(base+0x1100)>>>0)!==(variables.variableAddress>>>0))throw new Error('XEX variable slot was not relocated');
if((read(variables.variableAddress)>>>0)!==(variables.hmoduleAddress>>>0))throw new Error('XexExecutableModuleHandle cell was not initialized');
if((read(variables.hmoduleAddress+0x1c)>>>0)!==base)throw new Error('HMODULE image_base mismatch');
if((read(variables.hmoduleAddress+0x3c)>>>0)!==base+0x1000)throw new Error('HMODULE entry_point mismatch');
if((read(variables.hmoduleAddress+0x58)>>>0)!==(variables.xexHeaderAddress>>>0))throw new Error('HMODULE xex_header_base mismatch');
if((read(variables.xexHeaderAddress)>>>0)!==0x58455832)throw new Error('guest XEX header copy mismatch');
console.log('XEX_KERNEL_VARIABLE_SLOT_RELOCATION=PASS');
console.log('XEX_EXECUTABLE_MODULE_HANDLE=PASS');
console.log('XEX_LDR_DATA_TABLE_ENTRY=PASS');
console.log('XEX_VARIABLE_RX_TEMP_WRITE_RESTORE=PASS');
