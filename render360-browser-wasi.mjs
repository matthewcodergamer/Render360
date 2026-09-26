const WASI_SUCCESS=0;
const WASI_EAGAIN=6;
const WASI_EBADF=8;
const WASI_EFAULT=21;
const WASI_ESPIPE=70;

function memoryView(holder){
  const memory=holder?.memory;
  if(!(memory instanceof WebAssembly.Memory))throw new Error('Render360 WASI host memory is not attached');
  return new DataView(memory.buffer);
}
function setU32(view,address,value){view.setUint32(address>>>0,value>>>0,true)}
function setU64(view,address,value){view.setBigUint64(address>>>0,BigInt.asUintN(64,BigInt(value)),true)}

export function createRender360BrowserImports({onStdout=null,onStderr=null}={}){
  const holder={memory:null};
  // Host files backing the guest virtual file system. Each descriptor maps to
  // a reader whose readSync(offset,length) returns bytes it can supply
  // synchronously (in-memory cache, FileReaderSync inside a worker, fs in the
  // Node runner) or null when the data needs an asynchronous fetch first.
  const hostFiles=new Map();
  let nextHostFd=1000;
  const write=(fd,iovs,iovsLen,nwritten)=>{
    const view=memoryView(holder);let total=0;const chunks=[];
    for(let i=0;i<(iovsLen>>>0);i++){
      const entry=(iovs>>>0)+i*8;
      const ptr=view.getUint32(entry,true),len=view.getUint32(entry+4,true);
      if((ptr>>>0)+len>holder.memory.buffer.byteLength)return 21; // EFAULT
      if(len){chunks.push(new Uint8Array(holder.memory.buffer,ptr,len).slice());total+=len;}
    }
    if(nwritten)setU32(view,nwritten,total);
    if(chunks.length){
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const text=new TextDecoder().decode(bytes).replace(/\0+$/,'');
      if(text){const sink=fd===2?onStderr:onStdout;if(typeof sink==='function')sink(text);else (fd===2?console.error:console.log)(text.replace(/\n$/,''));}
    }
    return WASI_SUCCESS;
  };
  const clockTimeGet=(clockId,_precision,timePtr)=>{
    const view=memoryView(holder);
    const nowNs=clockId===1&&typeof performance==='object'&&typeof performance.now==='function'
      ? BigInt(Math.floor(performance.now()*1e6))
      : BigInt(Date.now())*1000000n;
    setU64(view,timePtr,nowNs);return WASI_SUCCESS;
  };
  const environSizesGet=(countPtr,sizePtr)=>{const view=memoryView(holder);setU32(view,countPtr,0);setU32(view,sizePtr,0);return WASI_SUCCESS;};
  const environGet=()=>WASI_SUCCESS;
  const fdPread=(fd,iovs,iovsLen,offset,nreadPtr)=>{
    const reader=hostFiles.get(fd>>>0);
    if(!reader)return WASI_EBADF;
    const view=memoryView(holder);let total=0;let position=BigInt.asUintN(64,BigInt(offset));
    for(let i=0;i<(iovsLen>>>0);i++){
      const entry=(iovs>>>0)+i*8;
      const ptr=view.getUint32(entry,true),len=view.getUint32(entry+4,true);
      if(!len)continue;
      if(ptr+len>holder.memory.buffer.byteLength)return WASI_EFAULT;
      let bytes;
      try{bytes=reader.readSync(Number(position),len);}catch{bytes=null;}
      if(!bytes){if(total)break;return WASI_EAGAIN;}
      const count=Math.min(len,bytes.byteLength);
      new Uint8Array(holder.memory.buffer,ptr,count).set(bytes.subarray?bytes.subarray(0,count):new Uint8Array(bytes,0,count));
      total+=count;position+=BigInt(count);
      if(count<len)break;
    }
    if(nreadPtr)setU32(memoryView(holder),nreadPtr,total);
    return WASI_SUCCESS;
  };
  const fdClose=()=>WASI_SUCCESS;
  const fdSeek=(_fd,_offset,_whence,newOffsetPtr)=>{if(newOffsetPtr){const view=memoryView(holder);setU64(view,newOffsetPtr,0n);}return WASI_ESPIPE;};
  return {
    holder,
    registerHostFile(reader){if(typeof reader?.readSync!=='function')throw new TypeError('host file reader needs readSync(offset,length)');const fd=nextHostFd++;hostFiles.set(fd,reader);return fd;},
    releaseHostFile(fd){hostFiles.delete(fd>>>0);},
    imports:{
      env:{emscripten_notify_memory_growth:()=>{}},
      wasi_snapshot_preview1:{fd_write:write,fd_pread:fdPread,clock_time_get:clockTimeGet,fd_close:fdClose,environ_sizes_get:environSizesGet,environ_get:environGet,fd_seek:fdSeek},
    },
  };
}

export function attachRender360BrowserInstance(host,instance){
  if(!host?.holder||!instance?.exports)throw new TypeError('Render360 WASI host and WebAssembly instance are required');
  if(!(instance.exports.memory instanceof WebAssembly.Memory))throw new Error('Render360 bootstrap did not export WebAssembly memory');
  host.holder.memory=instance.exports.memory;
  const initialize=instance.exports._initialize??instance.exports.initialize;
  if(typeof initialize==='function')initialize();
  return instance;
}

export function validateRender360BrowserImports(module){
  if(!(module instanceof WebAssembly.Module))throw new TypeError('WebAssembly.Module required');
  const allowed=new Set([
    'env:emscripten_notify_memory_growth:function',
    'wasi_snapshot_preview1:fd_write:function',
    'wasi_snapshot_preview1:fd_pread:function',
    'wasi_snapshot_preview1:clock_time_get:function',
    'wasi_snapshot_preview1:fd_close:function',
    'wasi_snapshot_preview1:environ_sizes_get:function',
    'wasi_snapshot_preview1:environ_get:function',
    'wasi_snapshot_preview1:fd_seek:function',
  ]);
  const found=WebAssembly.Module.imports(module);
  const unsupported=found.filter(i=>!allowed.has(`${i.module}:${i.name}:${i.kind}`));
  if(unsupported.length)throw new Error(`Render360 browser bootstrap has unsupported host imports: ${unsupported.map(i=>`${i.module}.${i.name}:${i.kind}`).join(', ')}`);
  return {ok:true,imports:found.map(i=>`${i.module}.${i.name}`)};
}
