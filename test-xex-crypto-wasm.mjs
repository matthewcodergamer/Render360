import fs from 'node:fs';
import crypto from 'node:crypto';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`Xenia bootstrap WASM not found: ${wasmPath}`);
const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports = wasi.getImportObject(module);
for (const imp of WebAssembly.Module.imports(module)) {
  if (imp.module === 'env' && imp.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const pick=n=>instance.exports[n]??instance.exports[`_${n}`];
const names=['memory','r360_xex_crypto_buffer','r360_xex_crypto_capacity','r360_xex_crypto_status','r360_xex_crypto_bytes_done','r360_xex_crypto_reset','r360_xex_crypto_begin_session','r360_xex_crypto_decrypt_chunk'];
for(const n of names)if(!pick(n))throw new Error(`missing crypto export ${n}`);
const e=Object.fromEntries(names.filter(n=>n!=='memory').map(n=>[n,pick(n)]));
const memory=pick('memory'),ptr=e.r360_xex_crypto_buffer()>>>0,cap=e.r360_xex_crypto_capacity()>>>0;
const heap=()=>new Uint8Array(memory.buffer);
const zeroIV=Buffer.alloc(16);
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]);
const devkit=Buffer.alloc(16);
function aesCbcEncrypt(key,data){
  if(data.length%16)throw new Error('test vector not block aligned');
  const c=crypto.createCipheriv('aes-128-cbc',key,zeroIV);c.setAutoPadding(false);return Buffer.concat([c.update(data),c.final()]);
}
function runCase(master,useDevkit,seed){
  const session=Buffer.from(Array.from({length:16},(_,i)=>(seed+i*19)&255));
  const encryptedSecurityKey=aesCbcEncrypt(master,session);
  const plain=Buffer.from(Array.from({length:96},(_,i)=>(seed*3+i*11)&255));
  const cipher=aesCbcEncrypt(session,plain);
  e.r360_xex_crypto_reset();
  heap().set(encryptedSecurityKey,ptr);
  if((e.r360_xex_crypto_begin_session(useDevkit)>>>0)!==1)throw new Error('session derivation failed');
  let off=0;for(const n of [16,32,16,32]){
    heap().set(cipher.subarray(off,off+n),ptr);
    if((e.r360_xex_crypto_decrypt_chunk(n)>>>0)!==1)throw new Error(`decrypt chunk failed at ${off}`);
    const got=Buffer.from(heap().slice(ptr,ptr+n));
    if(!got.equals(plain.subarray(off,off+n)))throw new Error(`CBC output mismatch at ${off}`);
    off+=n;
  }
  if((e.r360_xex_crypto_bytes_done()>>>0)!==plain.length)throw new Error('CBC byte accounting mismatch');
}
runCase(retail,0,0x21);
runCase(retail,0,0x73);
console.log('XEX_RETAIL_SESSION_KEY_DERIVATION=PASS');
console.log('XEX_AES_CBC_STREAMING_DECRYPT=PASS');
console.log('XEX_AES_CBC_REUSE_CHANGED_KEYS_DATA=PASS');
runCase(devkit,1,0x4D);
console.log('XEX_DEVKIT_SESSION_KEY_DERIVATION=PASS');

e.r360_xex_crypto_reset();
heap().set(Buffer.alloc(16),ptr);
if((e.r360_xex_crypto_decrypt_chunk(16)>>>0)!==102)throw new Error('decrypt before session must fail');
console.log('XEX_AES_SESSION_STATE_FAIL_CLOSED=PASS');
if((e.r360_xex_crypto_begin_session(0)>>>0)!==1)throw new Error('zero-key vector session setup failed');
if((e.r360_xex_crypto_decrypt_chunk(15)>>>0)!==103)throw new Error('non-block-aligned AES input must fail');
if((e.r360_xex_crypto_decrypt_chunk(cap+16)>>>0)!==103)throw new Error('AES staging overflow must fail');
console.log('XEX_AES_BLOCK_BOUNDS_FAIL_CLOSED=PASS');
console.log('XEX_NORMAL_ENCRYPTION_FOUNDATION=PASS');
