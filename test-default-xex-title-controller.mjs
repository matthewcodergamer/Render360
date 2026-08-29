import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';
import { handoffDefaultXex } from './render360-title-controller.mjs';

const {instance:core}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const mod=await WebAssembly.compile(fs.readFileSync(process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);
const p16le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};const p32le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};const p16be=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]);const zero=Buffer.alloc(16);const aes=(k,d)=>{const c=crypto.createCipheriv('aes-128-cbc',k,zero);c.setAutoPadding(false);return Buffer.concat([c.update(d),c.final()])};
function pe(base){const a=Buffer.alloc(0x400),nt=0x80,opt=nt+24,sh=opt+224;a.write('MZ',0,'ascii');p32le(a,0x3c,nt);p32le(a,nt,0x00004550);p16le(a,nt+4,0x01F2);p16le(a,nt+6,1);p16le(a,nt+20,224);p16le(a,nt+22,0x0102);p16le(a,opt,0x10B);p32le(a,opt+16,0x1000);p32le(a,opt+28,base);p32le(a,opt+32,0x1000);p32le(a,opt+36,0x200);p32le(a,opt+56,0x2000);p32le(a,opt+60,0x200);p16le(a,opt+68,14);a.write('.text\0\0\0',sh,'ascii');p32le(a,sh+8,0x200);p32le(a,sh+12,0x1000);p32le(a,sh+16,0x200);p32le(a,sh+20,0x200);p32le(a,sh+36,0x60000020);p32be(a,0x200,0x38600001);p32be(a,0x204,0x4E800020);return a;}
function xex(base,encryptedBody){const h=Buffer.alloc(0x400),s=0x100,ffi=0x60,exec=0x90;h.write('XEX2',0,'ascii');p32be(h,4,1);p32be(h,8,0x400);p32be(h,0x10,s);p32be(h,0x14,4);let p=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x1000],[0x10201,base],[0x40006,exec]]){p32be(h,p,k);p32be(h,p+4,v);p+=8}p32be(h,ffi,8);p16be(h,ffi+4,1);p16be(h,ffi+6,0);p32be(h,exec,0xAABBCCDD);p32be(h,exec+0x0c,0x584108CE);p32be(h,s,0x19c);p32be(h,s+4,0x400);p32be(h,s+0x110,base);p32be(h,s+0x178,0xffffffff);p32be(h,s+0x17c,0x08000000);p32be(h,s+0x180,1);p32be(h,s+0x184,0x10|1);return Buffer.concat([h,encryptedBody]);}
async function run(seed,base){const plain=pe(base),session=Buffer.from(Array.from({length:16},(_,i)=>(seed+i*29)&255)),encryptedSecurityKey=aes(retail,session),cipher=aes(session,plain),defaultXex=xex(base,cipher);const r=await handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey,entryBytes:8});if(r.status!==1||r.entry!==((base+0x1000)>>>0)||!r.hir||r.handoffBytes!==8||r.preparedBytes!==plain.length)throw new Error(`controller telemetry mismatch ${JSON.stringify(r)}`);return r;}
const a=await run(0x21,0x84000000),b=await run(0x73,0x85000000);if(a.entry===b.entry)throw new Error('controller relocation critic ineffective');
console.log('DEFAULT_XEX_HEADER_SPLIT=PASS');
console.log('DEFAULT_XEX_RETAIL_PREPARATION=PASS');
console.log('DEFAULT_XEX_PE_GUEST_MAPPING=PASS');
console.log('DEFAULT_XEX_ENTRY_XENIA_HANDOFF=PASS');
console.log('DEFAULT_XEX_CONTROLLER_RELOCATION=PASS');
console.log('ONE_CALL_DEFAULT_XEX_HANDOFF=PASS');
