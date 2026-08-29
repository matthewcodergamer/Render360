import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';
import { prepareEncryptedRetailNormal } from './retail-xex-normal-pipeline.mjs';

const {instance:core}=await WebAssembly.instantiate(fs.readFileSync('render360_xenia_core.wasm'),{});
const mod=await WebAssembly.compile(fs.readFileSync(process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod)){if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}}
const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);
const pick=n=>bootstrap.exports[n]??bootstrap.exports[`_${n}`];
for(const n of ['memory','r360_xex_crypto_buffer','r360_xex_crypto_reset','r360_xex_crypto_begin_session','r360_xex_crypto_decrypt_chunk','r360_xex_crypto_bytes_done','r360_xex_crypto_status','r360_lzx_input_buffer','r360_lzx_input_capacity','r360_lzx_output_buffer','r360_lzx_output_capacity','r360_lzx_reset','r360_lzx_decompress','r360_lzx_output_size'])if(!pick(n))throw new Error(`missing bootstrap export ${n}`);
for(const n of ['memory','r360_io_ptr','r360_io_capacity','r360_xex_decode','r360_xex_decode_encryption_type','r360_xex_decode_compression_type','r360_xex_decode_image_size','r360_xex_prepare_normal_frame_begin','r360_xex_prepare_normal_frame_accept','r360_xex_prepare_last_output_bytes','r360_xex_prepare_normal_window_size'])if(!(n in core.exports))throw new Error(`missing core export ${n}`);

const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};const asc=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);const sha=x=>crypto.createHash('sha1').update(x).digest();
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]);const iv=Buffer.alloc(16);
function enc(key,data){const c=crypto.createCipheriv('aes-128-cbc',key,iv);c.setAutoPadding(false);return Buffer.concat([c.update(data),c.final()]);}
function lzxUncompressed(payload){let bits='0'+'011'+payload.length.toString(2).padStart(24,'0');while(bits.length%16)bits+='0';const h=[];for(let i=0;i<bits.length;i+=16){const w=parseInt(bits.slice(i,i+16),2);h.push(w&255,(w>>>8)&255)}return Buffer.from([...h,1,0,0,0,1,0,0,0,1,0,0,0,...payload]);}
function normalBlock(lzx){const out=Buffer.alloc(24+2+lzx.length+2);p32(out,0,0);p16(out,24,lzx.length);lzx.copy(out,26);p16(out,26+lzx.length,0);return out;}
function header(hash,blockSize,imageSize,base=0x93000000){const x=Buffer.alloc(0x400),s=0x100,ffi=0x60,exec=0x90;asc(x,0,'XEX2');p32(x,4,1);p32(x,8,0x400);p32(x,0x10,s);p32(x,0x14,4);let h=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x1000],[0x10201,base],[0x40006,exec]]){p32(x,h,k);p32(x,h+4,v);h+=8}p32(x,ffi,36);p16(x,ffi+4,1);p16(x,ffi+6,2);p32(x,ffi+8,0x8000);p32(x,ffi+12,blockSize);hash.copy(x,ffi+16);p32(x,exec,0xAABBCCDD);p32(x,exec+0x0c,0x584108CE);p32(x,s,0x1cc);p32(x,s+4,imageSize);p32(x,s+0x110,base);p32(x,s+0x178,0xffffffff);p32(x,s+0x17c,0x08000000);p32(x,s+0x180,3);for(let i=0;i<3;i++)p32(x,s+0x184+i*0x18,0x10|(i===0?1:(i===1?3:2)));return x;}

async function run(seed,base){
  // 0x2004 gives a NORMAL block exactly divisible by 16, avoiding artificial padding.
  const image=Buffer.alloc(0x2004);for(let i=0;i<image.length;i++)image[i]=(seed+i*17+(i>>>4)*3)&255;
  const lzx=lzxUncompressed(image),plainBody=normalBlock(lzx);if(plainBody.length%16)throw new Error(`fixture body not AES aligned: ${plainBody.length}`);
  const h=header(sha(plainBody),plainBody.length,image.length,base);
  const session=Buffer.from(Array.from({length:16},(_,i)=>(seed+i*23)&255));
  const encryptedSecurityKey=enc(retail,session),cipherBody=enc(session,plainBody);
  pick('r360_xex_crypto_reset')();const cp=pick('r360_xex_crypto_buffer')()>>>0;new Uint8Array(pick('memory').buffer).set(encryptedSecurityKey,cp);
  const got=await prepareEncryptedRetailNormal({core,bootstrap,header:h,encryptedBody:cipherBody});
  if(!got.equals(image))throw new Error('encrypted retail NORMAL prepared image mismatch');
  return {image,h,cipherBody};
}
const a=await run(0x31,0x93000000),b=await run(0x79,0x94000000);if(a.image.equals(b.image)||a.cipherBody.equals(b.cipherBody))throw new Error('changed-input critic ineffective');
console.log('XEX_RETAIL_NORMAL_METADATA=PASS');
console.log('XEX_RETAIL_SESSION_TO_BODY_AES=PASS');
console.log('XEX_RETAIL_NORMAL_DECRYPT_TO_FRAMING=PASS');
console.log('XEX_RETAIL_NORMAL_FRAMING_TO_XENIA_LZX=PASS');
console.log('XEX_RETAIL_NORMAL_EXACT_PREPARED_IMAGE=PASS');
console.log('XEX_RETAIL_NORMAL_CHANGED_INPUT_REUSE=PASS');
console.log('FULL_RETAIL_XEX_IMAGE_PREPARATION=PASS');
