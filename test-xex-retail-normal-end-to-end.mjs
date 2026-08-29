import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';
import { prepareRetailXexImage } from './retail-xex-image-pipeline.mjs';

const {instance:core}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const mod=await WebAssembly.compile(fs.readFileSync(process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod)){if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}}
const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);

const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};const asc=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);const sha=x=>crypto.createHash('sha1').update(x).digest();
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]);const iv=Buffer.alloc(16);
function enc(key,data){const c=crypto.createCipheriv('aes-128-cbc',key,iv);c.setAutoPadding(false);return Buffer.concat([c.update(data),c.final()]);}
function session(seed){const key=Buffer.from(Array.from({length:16},(_,i)=>(seed+i*23)&255));return {key,encryptedSecurityKey:enc(retail,key)}}
function pageType(i){return [1,3,2][i%3]}
function baseHeader({encType=1,comp=0,base=0x93000000,imageSize=0x3000,pages=3,ffiSize=8,entryOffset=0x20}){const x=Buffer.alloc(0x400),s=0x100,ffi=0x60,exec=0x90;asc(x,0,'XEX2');p32(x,4,1);p32(x,8,0x400);p32(x,0x10,s);p32(x,0x14,4);let h=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+entryOffset],[0x10201,base],[0x40006,exec]]){p32(x,h,k);p32(x,h+4,v);h+=8}p32(x,ffi,ffiSize);p16(x,ffi+4,encType);p16(x,ffi+6,comp);p32(x,exec,0xAABBCCDD);p32(x,exec+0x0c,0x584108CE);p32(x,s,0x184+pages*0x18);p32(x,s+4,imageSize);p32(x,s+0x110,base);p32(x,s+0x178,0xffffffff);p32(x,s+0x17c,0x08000000);p32(x,s+0x180,pages);for(let i=0;i<pages;i++)p32(x,s+0x184+i*0x18,0x10|pageType(i));return x;}
function lzxUncompressed(payload){let bits='0'+'011'+payload.length.toString(2).padStart(24,'0');while(bits.length%16)bits+='0';const h=[];for(let i=0;i<bits.length;i+=16){const w=parseInt(bits.slice(i,i+16),2);h.push(w&255,(w>>>8)&255)}return Buffer.from([...h,1,0,0,0,1,0,0,0,1,0,0,0,...payload]);}
function normalBlock(lzx){const out=Buffer.alloc(24+2+lzx.length+2);p32(out,0,0);p16(out,24,lzx.length);lzx.copy(out,26);p16(out,26+lzx.length,0);return out;}
function bytes(n,seed){const b=Buffer.alloc(n);for(let i=0;i<n;i++)b[i]=(seed+i*17+(i>>>4)*3)&255;return b;}

async function encryptedNone(){const plain=bytes(0x3000,0x11),h=baseHeader({comp:0,imageSize:plain.length,pages:3,base:0x93000000});const s=session(0x11);const got=await prepareRetailXexImage({core,bootstrap,header:h,body:enc(s.key,plain),encryptedSecurityKey:s.encryptedSecurityKey});if(!got.equals(plain))throw new Error('encrypted NONE mismatch');console.log('XEX_RETAIL_ENCRYPTED_NONE=PASS');}

async function encryptedBasic(){const blocks=[[0x1000,0x1000],[0x1000,0],[0x1000,0]],source=bytes(0x3000,0x33),expected=Buffer.concat([source.subarray(0,0x1000),Buffer.alloc(0x1000),source.subarray(0x1000)]);const h=baseHeader({comp:1,imageSize:expected.length,pages:4,base:0x94000000,ffiSize:8+blocks.length*8});for(let i=0;i<blocks.length;i++){p32(h,0x68+i*8,blocks[i][0]);p32(h,0x6c+i*8,blocks[i][1]);}const s=session(0x33);const got=await prepareRetailXexImage({core,bootstrap,header:h,body:enc(s.key,source),encryptedSecurityKey:s.encryptedSecurityKey});if(!got.equals(expected))throw new Error('encrypted BASIC mismatch');console.log('XEX_RETAIL_ENCRYPTED_BASIC=PASS');}

async function encryptedNormal(seed,base){const image=bytes(0x2004,seed),lzx=lzxUncompressed(image),plainBody=normalBlock(lzx);if(plainBody.length%16)throw new Error(`NORMAL fixture not AES aligned ${plainBody.length}`);const h=baseHeader({comp:2,imageSize:image.length,pages:3,base,ffiSize:36,entryOffset:0x1000});p32(h,0x68,0x8000);p32(h,0x6c,plainBody.length);sha(plainBody).copy(h,0x70);const s=session(seed);const cipher=enc(s.key,plainBody);const got=await prepareRetailXexImage({core,bootstrap,header:h,body:cipher,encryptedSecurityKey:s.encryptedSecurityKey});if(!got.equals(image))throw new Error('encrypted NORMAL mismatch');return {image,cipher};}

await encryptedNone();await encryptedBasic();const a=await encryptedNormal(0x51,0x95000000),b=await encryptedNormal(0x7d,0x96000000);if(a.image.equals(b.image)||a.cipher.equals(b.cipher))throw new Error('NORMAL changed-input critic ineffective');
console.log('XEX_RETAIL_NORMAL_METADATA=PASS');
console.log('XEX_RETAIL_SESSION_TO_BODY_AES=PASS');
console.log('XEX_RETAIL_NORMAL_DECRYPT_TO_FRAMING=PASS');
console.log('XEX_RETAIL_NORMAL_FRAMING_TO_XENIA_LZX=PASS');
console.log('XEX_RETAIL_NORMAL_EXACT_PREPARED_IMAGE=PASS');
console.log('XEX_RETAIL_NORMAL_CHANGED_INPUT_REUSE=PASS');
console.log('FULL_RETAIL_XEX_IMAGE_PREPARATION=PASS');
