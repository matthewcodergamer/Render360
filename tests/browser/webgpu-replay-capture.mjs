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

export default async function run(captureUrl,referenceUrl){
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)return {ok:false,error:'no WebGPU adapter'};
  const device=await adapter.requestDevice({requiredLimits:{
    maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}});
  const errors=[];
  device.onuncapturederror=e=>{if(errors.length<20)errors.push(e.error.message.slice(0,400));};
  const backend=await new XenosWebGpuBackend(device,null).init();
  const words=new Uint32Array(await (await fetch(captureUrl)).arrayBuffer());
  const started=performance.now();
  backend.replayWords(words);
  backend.submit();
  await device.queue.onSubmittedWorkDone();
  const replayMs=performance.now()-started;
  const shaderErrors=[...backend.shaders.values()].filter(s=>s.error).map(s=>`${s.id}: ${s.error.slice(0,300)}`).slice(0,5);
  const pipelineErrors=[...backend.pipelines.entries()].filter(([,p])=>p.error).map(([id,p])=>`${id}: ${p.error.slice(0,300)}`).slice(0,5);
  const result={ok:true,stats:backend.stats,replayMs:Math.round(replayMs),shaderErrors,pipelineErrors,errors,
    targets:[...backend.targets.values()].map(t=>`${t.key} ${t.format} ${t.width}x${t.height}`)};
  const front=[...backend.targets.values()].find(t=>!t.depth&&t.base===0&&t.format==='rgba8unorm');
  if(front&&referenceUrl){
    const got=await backend.readTarget(front),want=await decodePng(referenceUrl);
    const w=Math.min(got.width,want.width),h=Math.min(got.height,want.height);
    let diff=0,close=0,lit=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const a=(y*got.width+x)*4,b=(y*want.width+x)*4;
      let d=0;for(let c=0;c<3;c++)d+=Math.abs(got.pixels[a+c]-want.pixels[b+c]);
      diff+=d;if(d<=24)close++;if(got.pixels[a]|got.pixels[a+1]|got.pixels[a+2])lit++;
    }
    result.compare={size:`${w}x${h}`,meanAbsDiff:+(diff/(w*h*3)).toFixed(2),closePixels:+(close/(w*h)).toFixed(4),litPixels:+(lit/(w*h)).toFixed(4)};
    // The frame for viewing: PNG data URL of the WebGPU render target.
    const canvas=new OffscreenCanvas(got.width,got.height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(got.pixels.buffer),got.width,got.height),0,0);
    const blob=await canvas.convertToBlob({type:'image/png'});
    result.png=btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()).reduce((a,b)=>(a.push(b),a),[])));
  }
  if(errors.length||!backend.stats.draws)result.ok=false;
  return result;
}
