import {Render360Core} from './wasm-core-v32.js';
import {handoffXboxIsoBrowser, loadRender360Bootstrap} from './render360-browser-title-runtime.mjs';
import {submitCapturedTitleGpuTraffic} from './render360-title-gpu-traffic.mjs';
import {inspectCapturedXenosShaders} from './render360-xenos-shader-runtime.mjs';

const ENTRY_WINDOW_BYTES=64*1024;
const $=id=>document.getElementById(id);
const fmtHex=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const fmtBytes=value=>{const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`};

let corePromise=null;
let bootstrapPromise=null;
let activeRun=0;

function setText(id,value){const el=$(id);if(el)el.textContent=String(value)}
function setGate(id,state,label){const el=$(id);if(!el)return;el.classList.remove('ready','blocked');if(state)el.classList.add(state);const em=el.querySelector('em');if(em)em.textContent=label}
function refreshModernStaticCopy(){
  const support=document.querySelector('.support-note');
  if(support)support.innerHTML='<b>Real-title inputs:</b> XBLA titles can use LIVE/PIRS/CON. Disc titles can use a lawful Xbox 360 ISO directly; the browser mounts XDVDFS as a File/Blob, locates default.xex, prepares the retail image and enters PPC/kernel/Xenos without copying the whole disc into WASM memory.';
  const active=document.querySelector('#statusSheet .port-row.active p');
  if(active)active.textContent='The modern browser bootstrap has XDVDFS ISO input, retail XEX preparation/PE mapping, Xenia-scanned guest PPC, live kernel-import ABI routing, sparse guest RAM, native circular Xenos ring consumption, real XE_SWAP boundaries and upstream Xenia shader analysis/execution. A commercial frame is still fail-closed until title-produced pixels replace the bounded bring-up raster.';
}
function hostLog(level,message){
  const text=`${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}  ${level.toUpperCase()}  ${message}`;
  console[level==='error'?'error':level==='warn'?'warn':'info'](`[Render360] ${message}`);
  const body=$('consoleBody');if(!body)return;
  const row=document.createElement('div');row.className=`log ${level}`;row.textContent=text;body.appendChild(row);body.scrollTop=body.scrollHeight;
  const count=$('logCount');if(count)count.textContent=String(body.children.length);
}
function showGame(file){
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

function shaderSummary(shaderRuntime){
  if(!shaderRuntime?.available||!shaderRuntime.capturedShaders)return '';
  const one=(name,s)=>!s?.captured?`${name} not captured`:s.executed?`${name} executed by upstream Xenia`:s.reason?`${name} ${s.reason}`:`${name} status 0x${(s.status>>>0).toString(16)}`;
  if(shaderRuntime.bothExecuted)return ` Both captured title shaders executed through upstream Xenia (${one('VS',shaderRuntime.vertex)}; ${one('PS',shaderRuntime.pixel)}).`;
  if(shaderRuntime.textureFetchBlocker)return ` Shader boundary: ${one('VS',shaderRuntime.vertex)}; ${one('PS',shaderRuntime.pixel)}. Texture sampling is now the concrete shader blocker.`;
  return ` Shader boundary: ${one('VS',shaderRuntime.vertex)}; ${one('PS',shaderRuntime.pixel)}.`;
}

function summarizeGpuTraffic(gpu,shaderRuntime=null){
  if(!gpu)return false;
  if(gpu.submitted){
    const realFrame=gpu.realTitleFrameReady===true;
    const realSwap=(gpu.swaps||0)>0;
    setGate('gateGpu','ready',realFrame?'REAL FRAME':realSwap?'XE_SWAP SEEN':'PM4 ACCEPTED');
    setText('frameGateState',realFrame?'FIRST EXTRACTED-TITLE FRAME':realSwap?'REAL TITLE SWAP':'TITLE PM4 ACCEPTED');
    setText('boundaryTitle',realFrame?'A title-produced frame reached a real swap':realSwap?'Real title command traffic reached XE_SWAP':'Real title PM4 reached the Xenos decoder');
    const state=`Xenos accepted ${gpu.packets} packets, draws ${gpu.draws}, swaps ${gpu.swaps||0}, shader loads ${gpu.shaderLoads||0}, fetch groups ${gpu.fetchConstantGroups?.length||0}, backed textures ${gpu.backedTextureResources?.length||0}, memory writes ${gpu.memoryWrites||0}.`;
    const shaders=shaderSummary(shaderRuntime);
    const frame=realFrame?'The first extracted-title frame gate is genuinely satisfied from title-produced pixels.':realSwap?`Swap frontbuffer ${fmtHex(gpu.frontbufferPtr||0)} ${gpu.frontbufferWidth||0}×${gpu.frontbufferHeight||0} was produced by the title. The exported pixels are still the bounded bring-up raster, so the real frame gate remains closed.${shaders}`:`Continue guest execution until XE_SWAP or a concrete GPU/kernel blocker appears.${shaders}`;
    setText('boundaryText',`${gpu.nativeDrained?'Native circular ring consumption is active.':`Submitted ${gpu.wordCount} genuinely produced ring words from ${fmtHex(gpu.guestAddress)} (CP_RB_WPTR ${gpu.writePointer}).`} ${state} ${frame}`);
    hostLog('ok',`Real title PM4 accepted · ${gpu.packets} packets · ${gpu.draws} draws · ${gpu.swaps||0} swaps · ${shaderRuntime?.executedShaders||0} shaders executed`);
    return true;
  }
  if(gpu.ready&&gpu.lastFaultWord!==undefined){
    setGate('gateGpu','blocked',`PM4 0x${(gpu.lastOpcode>>>0).toString(16).toUpperCase()}`);setText('frameGateState','REAL PM4 BLOCKER');
    setText('boundaryTitle',`First real Xenos blocker: PM4 opcode 0x${(gpu.lastOpcode>>>0).toString(16).toUpperCase()}`);
    setText('boundaryText',`The title reached the native Xenos consumer. Xenos stopped at word ${gpu.lastFaultWord} with status ${gpu.xenosStatus}; ${gpu.packets} packets were accepted first.${shaderSummary(shaderRuntime)} This is the exact next GPU implementation target—no synthetic trace and no guessed command count.`);
    hostLog('warn',`Real PM4 blocker · opcode 0x${(gpu.lastOpcode>>>0).toString(16)} · word ${gpu.lastFaultWord} · status ${gpu.xenosStatus}`);
    return true;
  }
  return false;
}

function summarizeResult(result,gpuTraffic=null,shaderRuntime=null){
  const gpu=result.titleGpuTelemetry||result.browserHleTelemetry;
  setGate('gateExtract','ready','XDVDFS READY');setGate('gateXex','ready','PE MAPPED');
  setGate('gateCpu',result.executionStatus?'ready':'blocked',result.executionStatus?`${result.executionInstructions||0} INSNS`:'NO EXEC');

  if(result.reachedKernelBlocker){
    const b=result.reachedKernelBlocker;
    setGate('gateKernel','blocked',`0x${(b.ordinal>>>0).toString(16).toUpperCase()}`);
    setGate('gateGpu','','WAIT');setText('frameGateState','KERNEL BLOCKER');
    setText('boundaryTitle',`Real title reached ${b.module||'kernel'} ordinal 0x${(b.ordinal>>>0).toString(16).toUpperCase()}`);
    setText('boundaryText',`The ISO mounted, default.xex was prepared and guest PPC reached a real imported service at ${fmtHex(b.thunkAddress)}. Implement this exact service next; no blanket-success stub was used.`);
    hostLog('warn',`Real kernel blocker ${b.module||'unknown'} ordinal 0x${(b.ordinal>>>0).toString(16)} @ ${fmtHex(b.thunkAddress)}`);
    return;
  }

  setGate('gateKernel','ready',result.kernelCalls?`${result.kernelCalls} CALLS`:'ENTERED');
  if(summarizeGpuTraffic(gpuTraffic,shaderRuntime))return;
  if(gpu?.ringInitialized){
    const producer=gpu.writePointer??0;
    setGate('gateGpu','ready',producer?'WPTR CAPTURED':'RING CAPTURED');setText('frameGateState',producer?'REAL XENOS WPTR':'REAL XENOS RING');
    const range=gpu.ringInActiveWindow?'inside active guest window':'in sparse guest memory';
    setText('boundaryTitle',producer?'Real title wrote the Xenos producer pointer':'Real title initialized a Xenos command ring');
    setText('boundaryText',producer?`Captured ring ${fmtHex(gpu.ringBase)}, ${fmtBytes(gpu.ringBytes)}, CP_RB_WPTR ${producer}. Native circular consumption did not produce an accepted Xenos state because: ${gpuTraffic?.reason||'the produced range was not readable/decodable yet'}.`:`Captured VdInitializeRingBuffer from live PPC ABI: base ${fmtHex(gpu.ringBase)}, size ${fmtBytes(gpu.ringBytes)} (${gpu.ringWordCapacity.toLocaleString()} words), ${range}. Waiting for the title's genuine CP_RB_WPTR write before consuming PM4.`);
    hostLog('ok',`Xenos ring captured · base ${fmtHex(gpu.ringBase)} · ${fmtBytes(gpu.ringBytes)} · WPtr ${producer}`);
  }else{
    setGate('gateGpu','','WAIT');setText('frameGateState',String(result.runtimeBoundary||'TITLE EXECUTION').toUpperCase());
    setText('boundaryTitle','Real default.xex is executing in the browser runtime');
    setText('boundaryText',`Runtime boundary: ${result.runtimeBoundary}. PPC instructions observed: ${result.executionInstructions||0}; imported kernel calls: ${result.kernelCalls||0}. No Xenos ring initialization has been observed yet, so GPU traffic is not being invented.`);
    hostLog('ok',`Title runtime boundary ${result.runtimeBoundary} · ${result.executionInstructions||0} PPC instructions · ${result.kernelCalls||0} kernel calls`);
  }
}

export async function runModernXboxIso(file){
  if(!file||typeof file.slice!=='function')throw new TypeError('Xbox ISO File/Blob required');
  const run=++activeRun;showGame(file);
  setText('boundaryTitle','Mounting real XDVDFS ISO…');setText('boundaryText','Reading the disc filesystem directly from the selected File/Blob, locating default.xex, then entering the modern retail XEX → PPC/kernel path. The whole ISO is not copied into memory.');
  hostLog('info',`Modern ISO handoff started · ${file.name||'Xbox ISO'} · ${fmtBytes(file.size)}`);
  try{
    const [core,bootstrap]=await Promise.all([getCore(),getBootstrap()]);if(run!==activeRun)return null;
    setGate('gateExtract','','DEFAULT.XEX');setText('boundaryTitle','default.xex found — preparing retail image…');setText('boundaryText','Decrypting/decompressing and mapping the real title image, then executing its Xenia-scanned entry function from RX sparse guest memory.');
    const {result}=await handoffXboxIsoBrowser({core,file,bootstrap,entryBytes:ENTRY_WINDOW_BYTES});if(run!==activeRun)return result;
    let gpuTraffic=null;
    if(result.titleGpuTelemetry){try{gpuTraffic=submitCapturedTitleGpuTraffic({bootstrap});}catch(error){gpuTraffic={submitted:false,ready:false,reason:error?.message||String(error)};hostLog('warn',`Captured PM4 state unavailable: ${gpuTraffic.reason}`)}}
    let shaderRuntime=null;
    try{shaderRuntime=inspectCapturedXenosShaders({bootstrap,execute:true});}catch(error){shaderRuntime={available:true,error:error?.message||String(error)};hostLog('warn',`Xenia shader interpreter stopped: ${shaderRuntime.error}`)}
    summarizeResult(result,gpuTraffic,shaderRuntime);
    globalThis.render360ModernTitle={fileName:file.name||'',result,gpuTraffic,shaderRuntime,bootstrap,core,entryWindowBytes:ENTRY_WINDOW_BYTES};
    return {...result,gpuTraffic,shaderRuntime};
  }catch(error){if(run===activeRun)showFailure(error);throw error}
}

export function modernIsoBridgeContract(){return {input:'browser File/Blob .iso',filesystem:'XDVDFS',entryExecution:'Xenia-scanned RX function',entryWindowBytes:ENTRY_WINDOW_BYTES,usesNativeTitleGpuTelemetry:true,nativeCircularRingConsumption:true,requiresRealXeSwapForFrameBoundary:true,usesUpstreamXeniaShaderInterpreter:true,requiresTitleProducedPixelsForRealFrame:true,failClosedOnUnsupportedPm4:true};}

refreshModernStaticCopy();
const input=$('gameInput');
if(input){
  input.addEventListener('change',event=>{
    const file=event.target?.files?.[0];if(!file||!(/\.iso$/i.test(file.name||'')))return;
    event.stopImmediatePropagation();
    runModernXboxIso(file).catch(()=>{});
  },true);
}
