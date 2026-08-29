import fs from 'node:fs';
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
const pick = n => instance.exports[n] ?? instance.exports[`_${n}`];
const required = ['memory','r360_lzx_input_buffer','r360_lzx_input_capacity','r360_lzx_output_buffer','r360_lzx_output_capacity','r360_lzx_status','r360_lzx_output_size','r360_lzx_reset','r360_lzx_decompress'];
for (const name of required) if (!pick(name)) throw new Error(`missing LZX export ${name}`);
const e = Object.fromEntries(required.filter(n=>n!=='memory').map(n=>[n,pick(n)]));
const memory = pick('memory');
const inputPtr=e.r360_lzx_input_buffer()>>>0, inputCap=e.r360_lzx_input_capacity()>>>0;
const outputPtr=e.r360_lzx_output_buffer()>>>0, outputCap=e.r360_lzx_output_capacity()>>>0;
if (inputCap < 64 || outputCap < 64) throw new Error('LZX probe buffers unexpectedly small');
const heap=()=>new Uint8Array(memory.buffer);

function makeUncompressedLzx(payload) {
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length > 0xFFFFFF) throw new Error('bad payload');
  // Regular LZX stream: intel flag 0, block type 3 (UNCOMPRESSED), 24-bit
  // block length. libmspack consumes the bitstream as little-endian 16-bit
  // words with MSB-first bit extraction, so serialize each 16-bit word LE.
  let bits = '0' + '011' + payload.length.toString(2).padStart(24,'0');
  while (bits.length % 16) bits += '0';
  const header=[];
  for (let i=0;i<bits.length;i+=16) {
    const word=parseInt(bits.slice(i,i+16),2);
    header.push(word&255,(word>>>8)&255);
  }
  const r=[1,0,0,0,1,0,0,0,1,0,0,0];
  return Uint8Array.from([...header,...r,...payload]);
}
function run(text) {
  const payload=new TextEncoder().encode(text);
  const compressed=makeUncompressedLzx(payload);
  e.r360_lzx_reset();
  heap().set(compressed,inputPtr);
  const st=e.r360_lzx_decompress(compressed.length,payload.length,0x8000)>>>0;
  if(st!==0) throw new Error(`upstream Xenia LZX failed ${text}: ${st}`);
  if((e.r360_lzx_status()>>>0)!==0 || (e.r360_lzx_output_size()>>>0)!==payload.length) throw new Error('LZX accounting mismatch');
  const got=heap().slice(outputPtr,outputPtr+payload.length);
  if(Buffer.compare(Buffer.from(got),Buffer.from(payload))!==0) throw new Error(`LZX output mismatch for ${text}`);
}

run('HELLO');
run('PORTAL');
console.log('XENIA_LZX_WASM_DECOMPRESS=PASS');
console.log('XENIA_LZX_REUSE_CHANGED_PAYLOAD=PASS');

// Invalid window sizes must be rejected by Xenia/libmspack, not normalized.
e.r360_lzx_reset();
const valid=makeUncompressedLzx(new TextEncoder().encode('BADWIN'));
heap().set(valid,inputPtr);
if((e.r360_lzx_decompress(valid.length,6,12345)>>>0)===0) throw new Error('invalid LZX window accepted');
console.log('XENIA_LZX_WINDOW_FAIL_CLOSED=PASS');

// Block type zero is invalid in regular LZX.
e.r360_lzx_reset();
const corrupt=makeUncompressedLzx(new TextEncoder().encode('BROKEN'));
corrupt[1]=0; // destroys the block-type bits in the first 16-bit word
heap().set(corrupt,inputPtr);
if((e.r360_lzx_decompress(corrupt.length,6,0x8000)>>>0)===0) throw new Error('corrupt LZX stream accepted');
console.log('XENIA_LZX_CORRUPT_STREAM_FAIL_CLOSED=PASS');

if((e.r360_lzx_decompress(inputCap+1,1,0x8000)>>>0)!==0xFFFFFFFE) throw new Error('input overflow did not fail closed');
if((e.r360_lzx_decompress(1,outputCap+1,0x8000)>>>0)!==0xFFFFFFFE) throw new Error('output overflow did not fail closed');
console.log('XENIA_LZX_PROBE_BOUNDS_FAIL_CLOSED=PASS');
console.log('XEX_NORMAL_LZX_FOUNDATION=PASS');
