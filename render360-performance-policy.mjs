const DEFAULT_SCALE_STEPS=Object.freeze([1,0.9,0.8,0.75,2/3]);
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

function normalizedSteps(steps,minScale,maxScale){
  const values=[...new Set((steps??DEFAULT_SCALE_STEPS).map(Number).filter(Number.isFinite).map(v=>clamp(v,minScale,maxScale)))];
  values.push(clamp(maxScale,minScale,maxScale),clamp(minScale,minScale,maxScale));
  return [...new Set(values)].sort((a,b)=>b-a);
}

export function browserPerformanceDefaults({navigatorImpl=globalThis.navigator}={}){
  const concurrency=Math.max(1,Number(navigatorImpl?.hardwareConcurrency||1));
  const deviceMemory=Number(navigatorImpl?.deviceMemory||0);
  const mobileClass=deviceMemory>0?deviceMemory<=4:concurrency<=6;
  return {
    targetFps:30,
    targetFrameMs:1000/30,
    minScale:2/3,
    maxScale:1,
    initialScale:mobileClass?0.9:1,
    schedulerQuantum:mobileClass?1:2,
    hardwareConcurrency:concurrency,
    deviceMemoryGiB:deviceMemory||null,
    mobileClass,
  };
}

/**
 * Browser-safe performance controller for Render360.
 *
 * It intentionally changes only host-side cost knobs. It never changes guest
 * timing, PPC results, kernel return values, memory contents or GPU semantics.
 * Resolution moves down quickly under sustained frame/memory pressure and back
 * up slowly after a stable recovery, avoiding the oscillation that makes a
 * nominally higher FPS feel worse than a locked 30 FPS.
 */
export function createAdaptivePerformancePolicy({
  targetFps=30,
  minScale=2/3,
  maxScale=1,
  initialScale=maxScale,
  scaleSteps=DEFAULT_SCALE_STEPS,
  emaAlpha=0.22,
  downFpsRatio=0.90,
  upFpsRatio=0.985,
  memoryHighRatio=0.82,
  memoryCriticalRatio=0.90,
  cooldownMs=1500,
  recoverySamples=18,
}={}){
  targetFps=Math.max(1,Number(targetFps)||30);
  minScale=clamp(Number(minScale)||2/3,0.35,1);
  maxScale=clamp(Number(maxScale)||1,minScale,1);
  const steps=normalizedSteps(scaleSteps,minScale,maxScale);
  let scale=clamp(Number(initialScale)||maxScale,minScale,maxScale);
  scale=steps.reduce((best,v)=>Math.abs(v-scale)<Math.abs(best-scale)?v:best,steps[0]);
  let emaFps=0,emaFrameMs=0,samples=0,recovery=0,lastChangeAt=-Infinity;
  let pressure='unknown',reason='initial';
  let lastMemoryRatio=0;

  const stepIndex=()=>Math.max(0,steps.findIndex(v=>Math.abs(v-scale)<1e-6));
  const lower=(count=1)=>{
    const i=stepIndex();
    const next=steps[Math.min(steps.length-1,i+Math.max(1,count))];
    if(next===scale)return false;
    scale=next;return true;
  };
  const raise=()=>{
    const i=stepIndex();
    const next=steps[Math.max(0,i-1)];
    if(next===scale)return false;
    scale=next;return true;
  };

  function observe({fps=null,frameMs=null,memoryBytes=0,memoryBudgetBytes=0,now=globalThis.performance?.now?.()??Date.now()}={}){
    const numericFps=Number(fps);
    const numericFrame=Number(frameMs);
    if(Number.isFinite(numericFps)&&numericFps>0){
      emaFps=emaFps?emaFps*(1-emaAlpha)+numericFps*emaAlpha:numericFps;
      const derivedFrame=1000/numericFps;
      emaFrameMs=emaFrameMs?emaFrameMs*(1-emaAlpha)+derivedFrame*emaAlpha:derivedFrame;
      samples++;
    }else if(Number.isFinite(numericFrame)&&numericFrame>0){
      emaFrameMs=emaFrameMs?emaFrameMs*(1-emaAlpha)+numericFrame*emaAlpha:numericFrame;
      const derivedFps=1000/numericFrame;
      emaFps=emaFps?emaFps*(1-emaAlpha)+derivedFps*emaAlpha:derivedFps;
      samples++;
    }

    const mem=Number(memoryBytes),budget=Number(memoryBudgetBytes);
    lastMemoryRatio=mem>0&&budget>0?mem/budget:0;
    const criticalMemory=lastMemoryRatio>=memoryCriticalRatio;
    const highMemory=lastMemoryRatio>=memoryHighRatio;
    const lowFps=samples>=3&&emaFps>0&&emaFps<targetFps*downFpsRatio;
    const recovered=samples>=3&&emaFps>=targetFps*upFpsRatio&&!highMemory;
    let changed=false;
    const canChange=Number(now)-lastChangeAt>=cooldownMs;

    if(criticalMemory&&canChange){
      changed=lower(2);pressure='critical';reason='memory-critical';recovery=0;
    }else if((highMemory||lowFps)&&canChange){
      changed=lower(1);pressure=highMemory?'high':'frame';reason=highMemory?'memory-high':'frame-budget';recovery=0;
    }else if(recovered){
      pressure='stable';reason='recovery';recovery++;
      if(recovery>=recoverySamples&&canChange){changed=raise();recovery=0;}
    }else{
      pressure=samples?'normal':'unknown';reason='steady';recovery=0;
    }
    if(changed)lastChangeAt=Number(now);
    return {changed,...snapshot()};
  }

  function snapshot(){
    return {
      targetFps,targetFrameMs:1000/targetFps,
      resolutionScale:scale,minScale,maxScale,scaleSteps:[...steps],
      emaFps:Number(emaFps.toFixed(2)),emaFrameMs:Number(emaFrameMs.toFixed(2)),
      samples,recoverySamples:recovery,memoryRatio:Number(lastMemoryRatio.toFixed(4)),
      pressure,reason,
      schedulerQuantum:pressure==='critical'||pressure==='frame'?1:(pressure==='stable'?2:1),
    };
  }

  function setScale(value){
    const wanted=clamp(Number(value)||scale,minScale,maxScale);
    scale=steps.reduce((best,v)=>Math.abs(v-wanted)<Math.abs(best-wanted)?v:best,steps[0]);
    recovery=0;
    return snapshot();
  }

  return {observe,snapshot,setScale,get resolutionScale(){return scale;}};
}

export function performancePolicyContract(){
  return {
    guestSemanticsChanged:false,
    targetFrameRate:30,
    adaptiveResolution:true,
    hysteresis:true,
    memoryPressureAware:true,
    scaleFloor:2/3,
    intended720pTiers:['1280x720','1152x648','1024x576','960x540','853x480'],
    cpuTiering:'generated-Wasm cache/hotness is handled by the PPC session',
  };
}
