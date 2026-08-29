import {Render360Core} from './wasm-core-v32.js';
import {createBrowserTitlePpcSession,handoffXboxIsoBrowser,loadRender360Bootstrap} from './render360-browser-title-runtime.mjs?v=44.2';
import {submitCapturedTitleGpuTraffic} from './render360-title-gpu-traffic.mjs';
import {inspectCapturedXenosShaders} from './render360-xenos-shader-runtime.mjs';
import {validateCapturedXenosShadersWebGPU} from './render360-webgpu-title-shaders.mjs';
import {captureTitleFrontbuffer,hideTitleFrontbuffer,presentTitleFrontbuffer} from './render360-title-frontbuffer.mjs';

const ENTRY_WINDOW_BYTES=64*1024;
const $=id=>document.getElementById(id);
const fmtHex=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const fmtBytes=value=>{const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`};

let corePromise=null;
let bootstrapPromise=null;
let activeRun=0;
let activeScheduler=null;

function setText(id,value){const el=$(id);if(el)el.textContent=String(value)}
function setGate(id,state,label){const el=$(id);if(!el)return;el.classList.remove('ready','blocked');if(state)el.classList.add(state);const em=el.querySelector('em');if(em)em.textContent=label}
function refreshModernStaticCopy(){
  const support=document.querySelector('.support-note');
  if(support)support.innerHTML='<b>Real-title inputs:</b> XBLA titles can use LIVE/PIRS/CON. Disc titles can use a lawful Xbox 360 ISO directly; the browser mounts XDVDFS as a File/Blob, locates default.xex, prepares the retail image and enters PPC/kernel/Xenos without copying the whole disc into WASM memory.';
  const active=document.querySelector('#statusSheet .port-row.active p');
  if(active)active.textContent='The modern browser bootstrap has XDVDFS ISO input, retail XEX preparation/PE mapping, side-effect-free Xenia PPC translation, a native cooperative Xbox guest-thread scheduler with persistent per-thread PPCContext snapshots, live kernel-import ABI routing, sparse guest RAM, native circular Xenos ring consumption, real XE_SWAP boundaries, upstream Xenia shader translation, Naga WGSL conversion, Safari WebGPU validation and a fail-closed VdSwap frontbuffer path. The browser keeps pumping runnable title threads between browser yields rather than stopping after the first entry slice.';
}
function hostLog(level,message){
  const text=`${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}  ${level.toUpperCase()}  ${message}`;
  console[level==='error'?'error':level==='warn'?'warn':'info'](`[Render360] ${message}`);
  const body=$('consoleBody');if(!body)return;
  const row=document.createElement('div');row.className=`log ${level}`;row.textContent=text;body.appendChild(row);body.scrollTop=body.scrollHeight;
  const count=$('logCount');if(count)count.textContent=String(body.children.length);
}
function stopActiveScheduler(){
  try{activeScheduler?.stop?.();}catch{}
  activeScheduler=null;
}
function showGame(file){
  stopActiveScheduler();
  hideTitleFrontbuffer();
  setText('gameName',file.name||'Xbox 360 ISO');setText('gameChipName',file.name||'Xbox 360 ISO');setText('gameType','Xbox ISO / XDVDFS');setText('gameSize',fmtBytes(file.size));setText('gameCore','Modern Xenia WASM');
  $('emptyState')?.classList.add('hidden');$('gameState')?.classList.remove('hidden');$('firstFrameGate')?.classList.remove('hidden');
  const inputGate=document.querySelector('.frame-gate-grid > div:first-child');if(inputGate){const b=inputGate.querySelector('b');const em=inputGate.querySelector('em');if(b)b.textContent='XDVDFS ISO input';if(em)em.textContent='READY';inputGate.classList.add('ready')}
  setGate('gateExtract','','MOUNTING');setGate('gateXex','','WAIT');setGate('gateCpu','','WAIT');setGate('gateKernel','','WAIT');setGate('gateGpu','','WAIT');setText('frameGateState','REAL TITLE BOOT');
}
function showFailure(error){
  setText('frameGateState','STOPPED');setText('boundaryTitle','Real title execution stopped');setText('boundaryText',error?.message||String(error));
  hostLog('error',`Modern ISO runtime stopped: ${error?.message||error}`);
}
async function getCore(){if(!corePromise)corePromise=(async()=>{const core=new Render360Core();await core.init();return core})();return corePromise}
async function getBootstrap(){if(!bootstrapPromise)bootstrapPromise=loadRender360Bootstrap();return bootstrapPromise}

function shaderSummary(shaderRuntime,shaderWebGPU=null){
  if(!shaderRuntime?.available||!shaderRuntime.capturedShaders)return '';
  const one=(name,s)=>!s?.captured?`${name} not captured`:s.executed?`${name} executed by upstream Xenia`:s.reason?`${name} ${s.reason}`:`${name} status 0x${(s.status>>>0).toString(16)}`;
  let webgpu='';
  if(shaderWebGPU?.bothAccepted)webgpu=' Safari WebGPU accepted both Naga-translated shader modules.';
  else if(shaderWebGPU?.available===false)webgpu=` WebGPU shader validation unavailable: ${shaderWebGPU.reason||'unknown reason'}.`;
  else if(shaderWebGPU?.available){
    const vs=shaderWebGPU.vertex?.webgpuAccepted===true?'VS accepted':`VS blocked${shaderWebGPU.vertex?.errors?.[0]?.message?`: ${shaderWebGPU.vertex.errors[0].message}`:''}`;
    const ps=shaderWebGPU.pixel?.webgpuAccepted===true?'PS accepted':`PS blocked${shaderWebGPU.pixel?.errors?.[0]?.message?`: ${shaderWebGPU.pixel.errors[0].message}`:''}`;
    webgpu=` WebGPU shader boundary: ${vs}; ${ps}.`;
  }else if(shaderWebGPU?.reason)webgpu=` WebGPU shader boundary: ${shaderWebGPU.reason}.`;
  if(shaderRuntime.bothSpirvTranslated)return ` Both captured title shaders translated through Xenia to SPIR-V.${shaderRuntime.bothExecuted?' Interpreter fallback also executed both stages.':''}${webgpu}`;
  if(shaderRuntime.bothExecuted)return ` Both captured title shaders executed through upstream Xenia (${one('VS',shaderRuntime.vertex)}; ${one('PS',shaderRuntime.pixel)}).${webgpu}`;
  return ` Shader boundary: ${one('VS',shaderRuntime.vertex)}; ${one('PS',shaderRuntime.pixel)}.${webgpu}`;
}

function summarizeGpuTraffic(gpu,shaderRuntime=null,frontbufferFrame=null,shaderWebGPU=null){
  if(!gpu)return false;
  if(gpu.submitted){
    const snapshotFrame=frontbufferFrame?.realTitleFrameReady===true;
    const coreFrame=gpu.realTitleFrameReady===true;
    const realFrame=snapshotFrame||coreFrame;
    const realSwap=(gpu.swaps||0)>0;
    setGate('gateGpu','ready',snapshotFrame?'REAL FRONTBUFFER':realFrame?'REAL FRAME':shaderWebGPU?.bothAccepted?'WEBGPU SHADERS':realSwap?'XE_SWAP SEEN':'PM4 ACCEPTED');
    setText('frameGateState',realFrame?'FIRST EXTRACTED-TITLE FRAME':realSwap?'REAL TITLE SWAP':shaderWebGPU?.bothAccepted?'WEBGPU SHADERS READY':'TITLE PM4 ACCEPTED');
    setText('boundaryTitle',snapshotFrame?'A real title VdSwap frontbuffer is on screen':realFrame?'A title-produced frame reached a real swap':realSwap?'Real title command traffic reached XE_SWAP':shaderWebGPU?.bothAccepted?'Captured title shaders compile in WebGPU':'Real title PM4 reached the Xenos decoder');
    const state=`Xenos accepted ${gpu.packets} packets, draws ${gpu.draws}, swaps ${gpu.swaps||0}, shader loads ${gpu.shaderLoads||0}, fetch groups ${gpu.fetchConstantGroups?.length||0}, backed textures ${gpu.backedTextureResources?.length||0}, memory writes ${gpu.memoryWrites||0}.`;
    const shaders=shaderSummary(shaderRuntime,shaderWebGPU);
    let frame='';
    if(snapshotFrame)frame=`Real frontbuffer ${frontbufferFrame.width}×${frontbufferFrame.height}, format ${frontbufferFrame.format}, ${frontbufferFrame.tiled?'Xenos tiled':'linear'}, pitch ${frontbufferFrame.pitchPixels}, source ${fmtHex(frontbufferFrame.sourceAddress)}, hash ${fmtHex(frontbufferFrame.hash)}. These pixels came from the mapped VdSwap frontbuffer, not the bounded software triangle.${shaders}`;
    else if(realFrame)frame=`The first extracted-title frame gate is genuinely satisfied from title-produced pixels.${shaders}`;
    else if(realSwap)frame=`Swap frontbuffer ${fmtHex(gpu.frontbufferPtr||0)} ${gpu.frontbufferWidth||0}×${gpu.frontbufferHeight||0} was produced by the title. Real frontbuffer capture did not promote because: ${frontbufferFrame?.reason||'the current bootstrap has no supported mapped frontbuffer snapshot yet'}.${shaders}`;
    else frame=`Guest execution is continuing until XE_SWAP or a concrete GPU/kernel/CPU blocker appears.${shaders}`;
    setText('boundaryText',`${gpu.nativeDrained?'Native circular ring consumption is active.':`Submitted ${gpu.wordCount} genuinely produced ring words from ${fmtHex(gpu.guestAddress)} (CP_RB_WPTR ${gpu.writePointer}).`} ${state} ${frame}`);
    return true;
  }
  if(gpu.ready&&gpu.lastFaultWord!==undefined){
    setGate('gateGpu','blocked',`PM4 0x${(gpu.lastOpcode>>>0).toString(16).toUpperCase()}`);setText('frameGateState','REAL PM4 BLOCKER');
    setText('boundaryTitle',`First real Xenos blocker: PM4 opcode 0x${(gpu.lastOpcode>>>0).toString(16).toUpperCase()}`);
    setText('boundaryText',`The title reached the native Xenos consumer. Xenos stopped at word ${gpu.lastFaultWord} with status ${gpu.xenosStatus}; ${gpu.packets} packets were accepted first.${shaderSummary(shaderRuntime,shaderWebGPU)} This is the exact next GPU implementation target.`);
    return true;
  }
  return false;
}

function summarizeResult(result,gpuTraffic=null,shaderRuntime=null,frontbufferFrame=null,shaderWebGPU=null,persistentCpu=null){
  const gpu=result.titleGpuTelemetry||result.browserHleTelemetry;
  setGate('gateExtract','ready','XDVDFS READY');setGate('gateXex','ready','PE MAPPED');
  const cpuReady=Boolean(persistentCpu?.ready||result.executionStatus);
  setGate('gateCpu',cpuReady?'ready':'blocked',persistentCpu?.schedulerReady?`${persistentCpu.totalSlices||persistentCpu.firstPumpSlices||0} SLICES`:persistentCpu?.ready?`${persistentCpu.functionCount} FUNCS`:result.executionStatus?`${result.executionInstructions||0} INSNS`:'NO EXEC');

  if(persistentCpu?.blocker){
    setGate('gateCpu','blocked','CPU BLOCKER');
    setText('frameGateState','REAL CPU BLOCKER');
    setText('boundaryTitle','Real title execution reached a CPU scheduler blocker');
    setText('boundaryText',`${persistentCpu.blocker.message||persistentCpu.blocker.error||String(persistentCpu.blocker)} Entry ${fmtHex(persistentCpu.blocker.entry||result.entry||0)}. This is fail-closed; no unsupported PPC path was skipped.`);
    return;
  }
  if(result.reachedKernelBlocker){
    const b=result.reachedKernelBlocker;
    setGate('gateKernel','blocked',`0x${(b.ordinal>>>0).toString(16).toUpperCase()}`);
    setGate('gateGpu','','WAIT');setText('frameGateState','KERNEL BLOCKER');
    setText('boundaryTitle',`Real title reached ${b.module||'kernel'} ordinal 0x${(b.ordinal>>>0).toString(16).toUpperCase()}`);
    setText('boundaryText',`The ISO mounted, default.xex was prepared and guest PPC reached a real imported service at ${fmtHex(b.thunkAddress)}. Implement this exact service next; no blanket-success stub was used.`);
    return;
  }

  setGate('gateKernel','ready',result.kernelCalls?`${result.kernelCalls} CALLS`:'ENTERED');
  if(summarizeGpuTraffic(gpuTraffic,shaderRuntime,frontbufferFrame,shaderWebGPU))return;
  if(gpu?.ringInitialized){
    const producer=gpu.writePointer??0;
    setGate('gateGpu','ready',producer?'WPTR CAPTURED':'RING CAPTURED');setText('frameGateState',producer?'REAL XENOS WPTR':'REAL XENOS RING');
    const range=gpu.ringInActiveWindow?'inside active guest window':'in sparse guest memory';
    setText('boundaryTitle',producer?'Real title wrote the Xenos producer pointer':'Real title initialized a Xenos command ring');
    setText('boundaryText',producer?`Captured ring ${fmtHex(gpu.ringBase)}, ${fmtBytes(gpu.ringBytes)}, CP_RB_WPTR ${producer}. Native circular consumption did not produce an accepted Xenos state because: ${gpuTraffic?.reason||'the produced range was not readable/decodable yet'}.`:`Captured VdInitializeRingBuffer from live PPC ABI: base ${fmtHex(gpu.ringBase)}, size ${fmtBytes(gpu.ringBytes)} (${gpu.ringWordCapacity.toLocaleString()} words), ${range}. Waiting for the title's genuine CP_RB_WPTR write before consuming PM4.`);
  }else{
    setGate('gateGpu','','WAIT');setText('frameGateState',String(result.runtimeBoundary||'TITLE EXECUTION').toUpperCase());
    setText('boundaryTitle',persistentCpu?.schedulerReady?'Native Xbox guest-thread scheduler is driving the title':'Real default.xex reached the browser runtime boundary');
    setText('boundaryText',`Runtime boundary: ${result.runtimeBoundary}. ${persistentCpu?.schedulerReady?`Scheduler pumps ${persistentCpu.pumpCount||0}, slices ${persistentCpu.totalSlices||0}, completed threads ${persistentCpu.completedThreads||0}. Browser yielding is active between pumps.`:`PPC instructions observed: ${result.executionInstructions||0}; imported kernel calls: ${result.kernelCalls||0}.`} No Xenos ring initialization has been observed yet, so GPU traffic is not being invented.`);
  }
}

async function inspectModernRuntime({bootstrap,state,forceFrontbuffer=false}){
  let gpuTraffic=null;
  try{gpuTraffic=submitCapturedTitleGpuTraffic({bootstrap});}
  catch(error){gpuTraffic={submitted:false,ready:false,reason:error?.message||String(error)};}

  let shaderRuntime=null;
  try{shaderRuntime=inspectCapturedXenosShaders({bootstrap,execute:true});}
  catch(error){shaderRuntime={available:true,error:error?.message||String(error)};}

  let shaderWebGPU=state.shaderWebGPU??null;
  if(shaderRuntime?.bothSpirvTranslated&&!shaderWebGPU?.bothAccepted){
    try{shaderWebGPU=await validateCapturedXenosShadersWebGPU({bootstrap});}
    catch(error){shaderWebGPU={available:false,bothAccepted:false,reason:error?.message||String(error)};}
  }

  let frontbufferFrame=state.frontbufferFrame??null;
  let presentation=state.presentation??null;
  const swapCount=gpuTraffic?.swaps||0;
  if(swapCount>0&&(forceFrontbuffer||swapCount!==state.lastSwapCount)){
    try{
      frontbufferFrame=captureTitleFrontbuffer({bootstrap});
      if(frontbufferFrame.captured){
        presentation=presentTitleFrontbuffer(frontbufferFrame);
        hostLog('ok',`Real VdSwap frontbuffer displayed · ${frontbufferFrame.width}×${frontbufferFrame.height} · hash ${fmtHex(frontbufferFrame.hash)}`);
      }else hostLog('warn',`VdSwap frontbuffer not displayable yet: ${frontbufferFrame.reason}`);
    }catch(error){
      frontbufferFrame={available:true,captured:false,realTitleFrameReady:false,reason:error?.message||String(error)};
      hostLog('warn',`Real frontbuffer capture stopped: ${frontbufferFrame.reason}`);
    }
  }
  return {gpuTraffic,shaderRuntime,shaderWebGPU,frontbufferFrame,presentation,lastSwapCount:swapCount};
}

function publishModernDebug(state){
  globalThis.render360ModernTitle={
    fileName:state.file?.name||'',
    result:state.result,
    persistentCpu:state.persistentCpu,
    ppcSession:state.ppcSession,
    threadScheduler:state.threadScheduler,
    primaryThread:state.primaryThread,
    schedulerReport:state.schedulerReport,
    schedulerBlocker:state.schedulerBlocker,
    runtimeLoop:state.runtimeLoop,
    gpuTraffic:state.gpuTraffic,
    shaderRuntime:state.shaderRuntime,
    shaderWebGPU:state.shaderWebGPU,
    frontbufferFrame:state.frontbufferFrame,
    presentation:state.presentation,
    bootstrap:state.bootstrap,
    core:state.core,
    entryWindowBytes:ENTRY_WINDOW_BYTES,
    stop:()=>state.threadScheduler?.stop?.(),
    inspectScheduler:()=>state.threadScheduler?.inspect?.()??null,
  };
}

function updatePersistentCpu(state){
  const scheduler=state.threadScheduler?.inspect?.()??null;
  state.persistentCpu={
    ready:Boolean(state.ppcSession)&&!state.schedulerBlocker,
    schedulerReady:Boolean(state.threadScheduler),
    functionCount:state.ppcSession?.functionCount??0,
    contextPtr:state.ppcSession?.contextPtr??0,
    contextSize:state.ppcSession?.contextSize??0,
    registryRefreshes:state.ppcSession?.registryRefreshes??0,
    preemptionBoundary:state.threadScheduler?.contract?.preemptionBoundary??state.ppcSession?.contract?.preemptionBoundary??'guest-function-return',
    midFunctionPreemption:Boolean(state.threadScheduler?.contract?.midFunctionPreemption),
    fullXboxThreadScheduler:Boolean(state.threadScheduler?.contract?.fullXboxThreadScheduler),
    pumpCount:scheduler?.pumpCount??state.schedulerReport?.pumpCount??0,
    totalSlices:scheduler?.sliceCount??state.schedulerReport?.totalSlices??0,
    firstPumpSlices:state.result?.commercialCpu?.firstPump?.slices?.length??0,
    completedThreads:scheduler?.completedThreads??state.schedulerReport?.completedThreads??0,
    blocker:state.schedulerBlocker||scheduler?.lastBlocker||null,
  };
  return state.persistentCpu;
}

async function driveRemainingTitleThreads({run,state}){
  if(!state.threadScheduler||state.schedulerBlocker)return null;
  activeScheduler=state.threadScheduler;
  const loop=state.threadScheduler.runLoop({
    onPump:async report=>{
      if(run!==activeRun){state.threadScheduler.stop();return;}
      state.schedulerReport=report;
      Object.assign(state,await inspectModernRuntime({bootstrap:state.bootstrap,state}));
      updatePersistentCpu(state);
      summarizeResult(state.result,state.gpuTraffic,state.shaderRuntime,state.frontbufferFrame,state.shaderWebGPU,state.persistentCpu);
      publishModernDebug(state);
    },
    onError:async(error,blocker)=>{
      state.schedulerBlocker={kind:'commercial-cpu-scheduler-blocker',entry:blocker?.entry??state.result.entry??0,message:error?.message||String(error),...blocker};
      updatePersistentCpu(state);
      summarizeResult(state.result,state.gpuTraffic,state.shaderRuntime,state.frontbufferFrame,state.shaderWebGPU,state.persistentCpu);
      publishModernDebug(state);
      hostLog('warn',`Real CPU scheduler blocker · ${state.schedulerBlocker.message}`);
    },
  });
  state.runtimeLoop=loop;
  publishModernDebug(state);
  loop.then(()=>{
    if(run!==activeRun)return;
    updatePersistentCpu(state);
    publishModernDebug(state);
    if(!state.schedulerBlocker&&!state.frontbufferFrame?.realTitleFrameReady){
      const inspect=state.threadScheduler.inspect();
      hostLog('info',`Guest-thread scheduler idle · ${inspect.sliceCount} slices · ${inspect.completedThreads} completed threads`);
    }
  }).catch(error=>{
    if(run===activeRun)hostLog('warn',`Guest-thread loop stopped: ${error?.message||error}`);
  });
  return loop;
}

export async function runModernXboxIso(file){
  if(!file||typeof file.slice!=='function')throw new TypeError('Xbox ISO File/Blob required');
  const run=++activeRun;showGame(file);
  setText('boundaryTitle','Mounting real XDVDFS ISO…');setText('boundaryText','Reading the disc filesystem directly from the selected File/Blob, locating default.xex, then entering the modern retail XEX → PPC/kernel path. The whole ISO is not copied into memory.');
  hostLog('info',`Modern ISO handoff started · ${file.name||'Xbox ISO'} · ${fmtBytes(file.size)}`);
  try{
    const [core,bootstrap]=await Promise.all([getCore(),getBootstrap()]);if(run!==activeRun)return null;
    setGate('gateExtract','','DEFAULT.XEX');setText('boundaryTitle','default.xex found — preparing retail image…');setText('boundaryText','Decrypting/decompressing and mapping the real title image, translating it without side effects, then running it through the native Xbox guest-thread scheduler.');
    const handoff=await handoffXboxIsoBrowser({core,file,bootstrap,entryBytes:ENTRY_WINDOW_BYTES});if(run!==activeRun)return handoff.result;
    const {result,threadScheduler,primaryThread,schedulerReport,schedulerBlocker}=handoff;
    let ppcSession=handoff.ppcSession??null;

    if(!ppcSession&&(result.translatedFunctionCount||0)>0){
      try{ppcSession=await createBrowserTitlePpcSession({bootstrap,clearContext:false});}
      catch(error){hostLog('warn',`Persistent Xenia PPC session unavailable: ${error?.message||error}`);}
    }

    const state={
      file,core,bootstrap,result,ppcSession,threadScheduler:threadScheduler??null,primaryThread:primaryThread??null,
      schedulerReport:schedulerReport??null,schedulerBlocker:schedulerBlocker??null,runtimeLoop:null,
      persistentCpu:null,gpuTraffic:null,shaderRuntime:null,shaderWebGPU:null,frontbufferFrame:null,presentation:null,lastSwapCount:-1,
    };
    updatePersistentCpu(state);
    if(state.threadScheduler){
      hostLog(state.schedulerBlocker?'warn':'ok',state.schedulerBlocker?`Native guest-thread scheduler blocked: ${state.schedulerBlocker.message}`:`Native Xbox guest-thread scheduler active · ${state.persistentCpu.functionCount} generated functions · first pump ${state.schedulerReport?.slices?.length||0} slice(s)`);
    }

    Object.assign(state,await inspectModernRuntime({bootstrap,state,forceFrontbuffer:true}));
    summarizeResult(result,state.gpuTraffic,state.shaderRuntime,state.frontbufferFrame,state.shaderWebGPU,state.persistentCpu);
    publishModernDebug(state);

    if(state.threadScheduler&&!state.schedulerBlocker){
      await driveRemainingTitleThreads({run,state});
      hostLog('ok','Commercial-title driver attached · runnable Xbox threads will continue between Safari browser yields');
    }

    return {...result,persistentCpu:state.persistentCpu,ppcSession:state.ppcSession,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,schedulerBlocker:state.schedulerBlocker,runtimeLoop:state.runtimeLoop,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,shaderWebGPU:state.shaderWebGPU,frontbufferFrame:state.frontbufferFrame,presentation:state.presentation};
  }catch(error){if(run===activeRun)showFailure(error);throw error}
}

export function modernIsoBridgeContract(){return {
  input:'browser File/Blob .iso',
  filesystem:'XDVDFS',
  entryTranslation:'Xenia-scanned RX function without production side effects',
  entryExecution:'native Xbox guest thread -> persistent generated WASM',
  entryWindowBytes:ENTRY_WINDOW_BYTES,
  usesNativeTitleGpuTelemetry:true,
  persistentPpcContext:true,
  persistentGeneratedFunctionCache:true,
  nativeGuestThreadRegistry:true,
  cooperativeThreadScheduler:true,
  autoPumpsRunnableThreads:true,
  browserYieldBetweenPumps:true,
  cpuResumeBoundary:'guest-function-return',
  cfgFuelBoundedFallback:true,
  midFunctionPreemption:false,
  fullXboxThreadScheduler:false,
  nativeCircularRingConsumption:true,
  requiresRealXeSwapForFrameBoundary:true,
  usesUpstreamXeniaShaderInterpreter:true,
  usesXeniaSpirvTranslation:true,
  usesNagaWgslTranslation:true,
  validatesCapturedShadersWithWebGPU:true,
  webgpuShaderValidationCountsAsRealFrame:false,
  realFrontbufferSource:'VdSwap fetch constant + mapped sparse Xbox memory',
  frontbufferFormats:['8_8_8_8','2_10_10_10_AS_16_16_16_16'],
  requiresTitleProducedPixelsForRealFrame:true,
  syntheticRasterAcceptedForRealFrame:false,
  failClosedOnUnsupportedCpu:true,
  failClosedOnUnsupportedPm4:true,
};}

refreshModernStaticCopy();
const input=$('gameInput');
if(input){
  input.addEventListener('change',event=>{
    const file=event.target?.files?.[0];if(!file||!(/\.iso$/i.test(file.name||'')))return;
    event.stopImmediatePropagation();
    runModernXboxIso(file).catch(()=>{});
  },true);
}