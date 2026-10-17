// Render360 WebGPU Xenos backend: replays the command stream the core
// records (src/xenia_web_bootstrap/webgpu_backend.cpp) into WebGPU, as
// Xenia's VulkanCommandProcessor replays its DeferredCommandBuffer.
// docs/gpu/WEBGPU_BACKEND.md describes the design.

export const GPU_STREAM_UPLOAD=1;

const BUFFER_USAGE={MAP_READ:0x1,COPY_SRC:0x4,COPY_DST:0x8,STORAGE:0x80};
const SHARED_MEMORY_BYTES=512*1024*1024;  // Xenia SharedMemory::kBufferSize
const STAGING_BYTES=16*1024*1024;

// Shared memory buffer size the adapter allows: Xenia's 512 MiB, or the
// largest power of two below the device's limits (physical addresses above
// it then cannot be used by GPU emulation, which is reported).
export function sharedMemoryBytesForLimits(limits){
  const max=Math.min(limits.maxBufferSize,limits.maxStorageBufferBindingSize);
  let bytes=SHARED_MEMORY_BYTES;
  while(bytes>max)bytes/=2;
  return bytes;
}

export class XenosWebGpuBackend{
  constructor(device,exports,{sharedMemoryBytes=sharedMemoryBytesForLimits(device.limits)}={}){
    this.device=device;
    this.exports=exports;
    this.sharedMemoryBytes=sharedMemoryBytes;
    // The GPU copy of guest physical memory (Xenia's shared memory buffer).
    this.sharedMemory=device.createBuffer({label:'Render360 shared memory',size:sharedMemoryBytes,
      usage:BUFFER_USAGE.STORAGE|BUFFER_USAGE.COPY_DST|BUFFER_USAGE.COPY_SRC});
    // Upload staging: writeBuffer is ordered before the next submit, so the
    // region is reusable once the commands copying out of it are submitted.
    this.staging=device.createBuffer({label:'Render360 upload staging',size:STAGING_BYTES,
      usage:BUFFER_USAGE.COPY_SRC|BUFFER_USAGE.COPY_DST});
    this.stagingOffset=0;
    this.encoder=null;
    this.stats={uploads:0,uploadedBytes:0,droppedUploads:0,submits:0};
  }

  encoderForCommands(){
    if(!this.encoder)this.encoder=this.device.createCommandEncoder({label:'Render360 Xenos'});
    return this.encoder;
  }

  submit(){
    if(this.encoder){this.device.queue.submit([this.encoder.finish()]);this.encoder=null;this.stats.submits++;}
    this.stagingOffset=0;
  }

  // Replays and clears the core's recorded commands.
  replay(){
    const e=this.exports,count=e.r360_gpu_stream_words()>>>0;
    if(!count)return;
    const base=e.r360_gpu_stream_data()>>>0;
    const words=new Uint32Array(e.memory.buffer,base,count);
    for(let i=0;i<count;){
      const op=words[i]&0xFF,n=words[i]>>>8;
      if(op===GPU_STREAM_UPLOAD)this.upload(words[i+1],words[i+2],base+(i+3)*4);
      else throw new Error(`Render360 GPU stream: unknown op ${op} at word ${i}`);
      i+=1+n;
    }
    e.r360_gpu_stream_reset();
  }

  upload(dest,length,bytePointer){
    if(dest+length>this.sharedMemoryBytes){this.stats.droppedUploads++;return;}
    if(this.stagingOffset+length>STAGING_BYTES)this.submit();
    if(length>STAGING_BYTES){
      // Larger than the staging buffer: write directly (ordered before the
      // next submit; nothing recorded after it reads the old contents).
      this.device.queue.writeBuffer(this.sharedMemory,dest,this.exports.memory.buffer,bytePointer,length);
    }else{
      this.device.queue.writeBuffer(this.staging,this.stagingOffset,this.exports.memory.buffer,bytePointer,length);
      this.encoderForCommands().copyBufferToBuffer(this.staging,this.stagingOffset,this.sharedMemory,dest,length);
      this.stagingOffset+=length;
    }
    this.stats.uploads++;
    this.stats.uploadedBytes+=length;
  }

  // Reads `length` bytes of the GPU shared memory (tests and resolve checks).
  async readSharedMemory(offset,length){
    this.submit();
    const read=this.device.createBuffer({size:length,usage:BUFFER_USAGE.MAP_READ|BUFFER_USAGE.COPY_DST});
    const encoder=this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.sharedMemory,offset,read,0,length);
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const bytes=new Uint8Array(read.getMappedRange()).slice();
    read.unmap();read.destroy();
    return bytes;
  }
}
