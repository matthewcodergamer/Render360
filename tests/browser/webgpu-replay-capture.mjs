// Browser side of test-webgpu-replay-capture-browser.mjs: replays a GPU
// command stream captured by run-title.mjs --gpu-capture (served from the
// local data root, never the repository) and compares the color render
// target at EDRAM base 0 with the software renderer's frame.
import {XenosWebGpuBackend} from '../../render360-webgpu-backend.mjs';

async function decodePng(url){
  const bitmap=await createImageBitmap(await (await fetch(url)).blob());
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
  ctx.drawImage(bitmap,0,0);
  return {width:bitmap.width,height:bitmap.height,pixels:ctx.getImageData(0,0,bitmap.width,bitmap.height).data};
}

async function readBuffer(device,buffer,offset,size){
  const read=device.createBuffer({size,usage:0x1|0x8});
  const e=device.createCommandEncoder();e.copyBufferToBuffer(buffer,offset,read,0,size);device.queue.submit([e.finish()]);
  await read.mapAsync(1);const out=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();return out;
}

export default async function run(captureUrl,referenceUrl,drawLimit,debugEdram){
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)return {ok:false,error:'no WebGPU adapter'};
  const device=await adapter.requestDevice({requiredFeatures:['float32-filterable'].filter(f=>adapter.features.has(f)),requiredLimits:{
    maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}});
  const errors=[];
  device.onuncapturederror=e=>{if(errors.length<20)errors.push(e.error.message.slice(0,400));};
  const backend=await new XenosWebGpuBackend(device,null).init();
  if(drawLimit!==undefined&&drawLimit!==null)backend.drawLimit=drawLimit;
  backend.debugEdram=!!debugEdram;
  const words=new Uint32Array(await (await fetch(captureUrl)).arrayBuffer());
  const started=performance.now();
  backend.replayWords(words);
  backend.submit();
  await device.queue.onSubmittedWorkDone();
  const replayMs=performance.now()-started;
  const shaderErrors=[...backend.shaders.values()].filter(s=>s.error).map(s=>`${s.id}: ${s.error.slice(0,300)}`).slice(0,5);
  const pipelineErrors=[...backend.pipelines.entries()].filter(([,p])=>p.error).map(([id,p])=>`${id}: ${p.error.slice(0,300)}`).slice(0,5);
  const loadShaderErrors=[...backend.loadShaders.entries()].filter(([,l])=>l.error).map(([i,l])=>`${i}: ${l.error.slice(0,300)}`).slice(0,5);
  const result={ok:true,stats:backend.stats,loadShaderErrors,replayMs:Math.round(replayMs),shaderErrors,pipelineErrors,errors,
    targets:[...backend.targets.values()].map(t=>`${t.key} ${t.format} ${t.width}x${t.height}`)};
  // The swapped front buffer (resolved into shared memory, loaded by the
  // texture cache), else the color render target at EDRAM base 0.
  // Debug: the EDRAM buffer against the color render target at base 0
  // (Xenia's layout, 32bpp), at X shifts, to locate resolve offsets.
  if(globalThis.location?.search?.includes('edram')||backend.debugEdram){
    const rt=[...backend.targets.values()].find(t=>!t.depth&&t.base===0);
    const img=await backend.readTarget(rt);
    const ed=new Uint32Array((await readBuffer(device,backend.edram,0,backend.edram.size)).buffer);
    const sx=rt.msaa>=2?2:1,sy=rt.msaa>=1?2:1,scores={};
    for(const shift of [-64,-32,0,32,64]){
      let same=0,n=0;
      for(let y=0;y<rt.height;y+=37)for(let x=64;x<rt.width-64;x+=41){
        const X=x+shift,s0x=X*sx,s0y=y*sy,tile=Math.floor(s0y/16)*rt.pitchTiles+Math.floor(s0x/80);
        const o=((rt.base+tile)%2048)*1280+(s0y%16)*80+(s0x%80);
        const a=(y*rt.width+x)*4,v=img.pixels[a]|img.pixels[a+1]<<8|img.pixels[a+2]<<16|img.pixels[a+3]<<24;
        n++;if((ed[o]>>>0)===(v>>>0))same++;
      }
      scores[shift]=+(same/n).toFixed(3);
    }
    result.edramMatchByShift=scores;
  }
  const front=(backend.frontTexture?.format==='rgba8unorm'?backend.frontTexture:null)||
    [...backend.targets.values()].find(t=>!t.depth&&t.base===0&&t.format==='rgba8unorm');
  result.front=front===backend.frontTexture?'front buffer':'render target';
  if(front&&referenceUrl){
    const got=await backend.readTarget(front),want=await decodePng(referenceUrl);
    // The front buffer as presented: the swap's host swizzle.
    if(front===backend.frontTexture){
      const sw=backend.frontSwizzle??0x688,px=got.pixels;
      for(let i=0;i<px.length;i+=4){
        const t=[px[i],px[i+1],px[i+2],px[i+3]],c=k=>{const v=(sw>>>(3*k))&7;return v>=5?255:v===4?0:t[v];};
        px[i]=c(0);px[i+1]=c(1);px[i+2]=c(2);px[i+3]=c(3);
      }
    }
    const w=Math.min(got.width,want.width),h=Math.min(got.height,want.height);
    let diff=0,close=0,lit=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const a=(y*got.width+x)*4,b=(y*want.width+x)*4;
      let d=0;for(let c=0;c<3;c++)d+=Math.abs(got.pixels[a+c]-want.pixels[b+c]);
      diff+=d;if(d<=24)close++;if(got.pixels[a]|got.pixels[a+1]|got.pixels[a+2])lit++;
    }
    result.compare={size:`${w}x${h}`,meanAbsDiff:+(diff/(w*h*3)).toFixed(2),closePixels:+(close/(w*h)).toFixed(4),litPixels:+(lit/(w*h)).toFixed(4)};
    // The frame for viewing: PNG data URL of the WebGPU render target.
    // Opaque for viewing (render target alpha is the game's, often 0).
    for(let i=3;i<got.pixels.length;i+=4)got.pixels[i]=255;
    const canvas=new OffscreenCanvas(got.width,got.height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(got.pixels.buffer),got.width,got.height),0,0);
    const blob=await canvas.convertToBlob({type:'image/png'});
    const png=new Uint8Array(await blob.arrayBuffer());let text='';
    for(let i=0;i<png.length;i+=32768)text+=String.fromCharCode(...png.subarray(i,i+32768));
    result.png=btoa(text);
  }
  if(errors.length||!backend.stats.draws)result.ok=false;
  return result;
}
