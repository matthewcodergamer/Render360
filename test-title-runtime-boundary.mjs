import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';
import { handoffDefaultXex } from './render360-title-controller.mjs';

const {instance:core}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const mod=await WebAssembly.compile(fs.readFileSync(process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);
const p16le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};const p32le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};const p16be=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]),zero=Buffer.alloc(16);const aes=(k,d)=>{const c=crypto.createCipheriv('aes-128-cbc',k,zero);c.setAutoPadding(false);return Buffer.concat([c.update(d),c.final()])};
function pe(base,words){const a=Buffer.alloc(0x400),nt=0x80,opt=nt+24,sh=opt+224;a.write('MZ',0,'ascii');p32le(a,0x3c,nt);p32le(a,nt,0x00004550);p16le(a,nt+4,0x01F2);p16le(a,nt+6,1);p16le(a,nt+20,224);p16le(a,nt+22,0x0102);p16le(a,opt,0x10B);p32le(a,opt+16,0x1000);p32le(a,opt+28,base);p32le(a,opt+32,0x1000);p32le(a,opt+36,0x200);p32le(a,opt+56,0x2000);p32le(a,opt+60,0x200);p16le(a,opt+68,14);a.write('.text\0\0\0',sh,'ascii');p32le(a,sh+8,0x200);p32le(a,sh+12,0x1000);p32le(a,sh+16,0x200);p32le(a,sh+20,0x200);p32le(a,sh+36,0x60000020);words.forEach((w,i)=>p32be(a,0x200+i*4,w));return a;}
function xex(base,body){const h=Buffer.alloc(0x400),s=0x100,ffi=0x60,exec=0x90;h.write('XEX2',0,'ascii');p32be(h,4,1);p32be(h,8,0x400);p32be(h,0x10,s);p32be(h,0x14,4);let p=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x1000],[0x10201,base],[0x40006,exec]]){p32be(h,p,k);p32be(h,p+4,v);p+=8}p32be(h,ffi,8);p16be(h,ffi+4,1);p16be(h,ffi+6,0);p32be(h,exec,0xAABBCCDD);p32be(h,exec+0x0c,0x584108CE);p32be(h,s,0x19c);p32be(h,s+4,0x2000);p32be(h,s+0x110,base);p32be(h,s+0x178,0xffffffff);p32be(h,s+0x17c,0x08000000);p32be(h,s+0x180,1);p32be(h,s+0x184,0x11);return Buffer.concat([h,body]);}
async function run(words,entryBytes,seed,base){const plain=pe(base,words),session=Buffer.from(Array.from({length:16},(_,i)=>(seed+i*31)&255)),encryptedSecurityKey=aes(retail,session),defaultXex=xex(base,aes(session,plain));return handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey,entryBytes});}

const clean=await run([0x38600001,0x4E800020],8,0x19,0x88000000);
if(clean.executionStatus!==3||clean.runtimeBoundary!=='guest-return'||clean.executionR3Hex!=='0x1')throw new Error(`clean boundary mismatch ${JSON.stringify(clean)}`);
console.log('ENTRY_RUNTIME_CLEAN_RETURN=PASS');

// lis r12,0x9000 ; mtctr r12 ; bctrl ; blr. The indirect target 0x90000000
// is deliberately outside the active bounded guest code window, so translation
// succeeds while runtime resolution must stop at the unresolved call boundary.
const blocked=await run([0x3D809000,0x7D8903A6,0x4E800421,0x4E800020],16,0x61,0x89000000);
if(
  !blocked.hir ||
  blocked.executionStatus !== 1 ||
  blocked.runtimeBoundary !== 'unresolved-guest-call' ||
  blocked.executionBlockerKind !== 2 ||
  blocked.executionBlockerOpcode !== 9 ||
  blocked.executionBlockerAddress !== 0x89001008
) throw new Error(`runtime blocker was not surfaced exactly ${JSON.stringify(blocked)}`);
console.log('ENTRY_RUNTIME_UNRESOLVED_CALL_BOUNDARY=PASS');
console.log('FIRST_RUNTIME_BLOCKER_TELEMETRY=PASS');
// Bootstrap rebuild trigger: endian-aware guest LOAD/STORE plus constant-time sparse guest writes.
