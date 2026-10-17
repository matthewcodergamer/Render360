// WebGPU backend shared memory (src/xenia_web_bootstrap/webgpu_backend.cpp, a
// port of Xenia's SharedMemory): a requested range uploads exactly the pages
// that are not valid on the GPU, CPU writes invalidate pages through the
// sparse memory GPU watch, and GPU-written ranges need no upload.
import './test-node-wasi-safe.mjs';
import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const imports=wasi.getImportObject(module);
imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const e=instance.exports;

const expect=(cond,message)=>{if(!cond)throw new Error(message);};
const PAGE=4096,BASE=0x00100000;  // physical == virtual outside kernel physical ranges
e.r360_sparse_guest_memory_reset();
const backing=e.r360_sparse_guest_memory_alloc(4);
expect(backing&&e.r360_sparse_guest_memory_map(BASE,4,backing,0,3),'map 4 pages');
for(let p=0;p<4;p++)expect(e.r360_sparse_guest_memory_write_u32_be(BASE+p*PAGE,0x11110000+p),'write');
e.r360_gpu_shared_memory_clear();

// Stream: [op | words << 8] payload; upload payload = dest, length, bytes.
function uploads(){
  const words=e.r360_gpu_stream_words()>>>0,ptr=e.r360_gpu_stream_data()>>>0;
  const w=new Uint32Array(e.memory.buffer,ptr,words),out=[];
  for(let i=0;i<words;){
    const op=w[i]&0xFF,n=w[i]>>>8;
    if(op===1){
      const dest=w[i+1],length=w[i+2];
      const bytes=new Uint8Array(e.memory.buffer,ptr+(i+3)*4,length);
      const firstWords=[];for(let p=0;p<length/PAGE;p++)firstWords.push((bytes[p*PAGE]<<24|bytes[p*PAGE+1]<<16|bytes[p*PAGE+2]<<8|bytes[p*PAGE+3])>>>0);
      out.push({dest,length,firstWords});
    }
    i+=1+n;
  }
  e.r360_gpu_stream_reset();
  return out;
}

expect(e.r360_gpu_shared_memory_request(BASE,4*PAGE)===1,'request');
let u=uploads();
expect(u.length===1&&u[0].dest===BASE&&u[0].length===4*PAGE,`first request uploads the range once: ${JSON.stringify(u)}`);
expect(u[0].firstWords.join()===[0x11110000,0x11110001,0x11110002,0x11110003].join(),'uploaded bytes');

e.r360_gpu_shared_memory_request(BASE,4*PAGE);
expect(uploads().length===0,'valid pages are not uploaded again');

e.r360_sparse_guest_memory_write_u32_be(BASE+2*PAGE+8,0xABCDEF01);
e.r360_gpu_shared_memory_request(BASE,4*PAGE);
u=uploads();
expect(u.length===1&&u[0].dest===BASE+2*PAGE&&u[0].length===PAGE,`a CPU write reuploads only its page: ${JSON.stringify(u)}`);

e.r360_sparse_guest_memory_write_u32_be(BASE+3*PAGE,0x22222222);
e.r360_gpu_shared_memory_written_by_gpu(BASE+3*PAGE,PAGE);
e.r360_gpu_shared_memory_request(BASE,4*PAGE);
expect(uploads().length===0,'a GPU-written range needs no upload');

e.r360_sparse_guest_memory_write_u32_be(BASE,0x33333333);
e.r360_sparse_guest_memory_write_u32_be(BASE+PAGE,0x44444444);
e.r360_gpu_shared_memory_request(BASE+16,PAGE);  // spans pages 0 and 1
u=uploads();
expect(u.length===1&&u[0].dest===BASE&&u[0].length===2*PAGE&&u[0].firstWords.join()===[0x33333333,0x44444444].join(),
       `dirty neighbours upload as one range: ${JSON.stringify(u)}`);

expect(e.r360_gpu_shared_memory_request(0x1FFFF000,0x2000)===0,'ranges past 512 MiB are refused');
console.log(`uploaded ${e.r360_gpu_shared_memory_uploaded_kb()} KiB in ${e.r360_gpu_shared_memory_upload_ranges()} ranges`);
console.log('WEBGPU_SHARED_MEMORY_PASS');
