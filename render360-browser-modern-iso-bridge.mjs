import {Render360Core} from './wasm-core-v32.js';
import {handoffXboxIsoBrowser, loadRender360Bootstrap} from './render360-browser-title-runtime.mjs';

const ENTRY_WINDOW_BYTES=64*1024;
const $=id=>document.getElementById(id);
const fmtHex=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const fmtBytes=value=>{const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`};

let corePromise=null;
let bootstrapPromise=null;
let activeRun=0;

function setText(id,value){const el=$(id);if(el)el.textContent=String(value)}
function setGate(id,state,label){const el=$(id);if(!el)return;el.classList.remove('ready','blocked');if(state)el.classList.add(state);const em=el.querySelector('em');if(em)em.textContent=label}
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
  setGate('gateExtract','','MOUNTING');setGate('gateXex','','WAIT');setGate('gateCpu','','WAIT');setGate('gateKernel','','WAIT');setGate('gateGpu','','WAIT');setText('frameGateState','REAL TITLE BOOT');
}
function showFailure(error){
  setText('frameGateState','STOPPED');setText('boundaryTitle','Real title execution stopped');setText('boundaryText',error?.message||String(error));
  hostLog('error',`Modern ISO runtime stopped: ${error?.message||error}`);
}
async function getCore(){if(!corePromise)corePromise=(async()=>{const core=new Render360Core();await core.init();return core})();return corePromise}
async function getBootstrap(){if(!bootstrapPromise)bootstrapPromise=loadRender360Bootstrap();return bootstrapPromise}

function summarizeResult(result){
  const hle=result.browserHleTelemetry;
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
  if(hle?.ringInitialized){
    setGate('gateGpu','ready','RING CAPTURED');setText('frameGateState','REAL XENOS RING');
    const range=hle.ringInActiveWindow?'inside active guest window':'outside current 64 KiB guest window';
    setText('boundaryTitle','Real title initialized a Xenos command ring');
    setText('boundaryText',`Captured VdInitializeRingBuffer from live PPC ABI: base ${fmtHex(hle.ringBase)}, size ${fmtBytes(hle.ringBytes)} (${hle.ringWordCapacity.toLocaleString()} words), ${range}. The next non-fake gate is the title's live producer/write pointer so only genuinely written PM4 words are submitted.`);
    hostLog('ok',`Xenos ring captured · base ${fmtHex(hle.ringBase)} · ${fmtBytes(hle.ringBytes)} · rptr writeback ${fmtHex(hle.rptrWriteback||0)}`);
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
    setGate('gateExtract','','DEFAULT.XEX');setText('boundaryTitle','default.xex found — preparing retail image…');setText('boundaryText',`Decrypting/decompressing and mapping the real title image, then translating up to ${fmtBytes(ENTRY_WINDOW_BYTES)} from its entry window.`);
    const {result}=await handoffXboxIsoBrowser({core,file,bootstrap,entryBytes:ENTRY_WINDOW_BYTES});if(run!==activeRun)return result;
    summarizeResult(result);
    globalThis.render360ModernTitle={fileName:file.name||'',result,bootstrap,core,entryWindowBytes:ENTRY_WINDOW_BYTES};
    return result;
  }catch(error){if(run===activeRun)showFailure(error);throw error}
}

export function modernIsoBridgeContract(){return {input:'browser File/Blob .iso',filesystem:'XDVDFS',entryWindowBytes:ENTRY_WINDOW_BYTES,usesRealTitleHleTelemetry:true,requiresProducerWritePointerBeforePm4Submit:true};}

const input=$('gameInput');
if(input){
  input.addEventListener('change',event=>{
    const file=event.target?.files?.[0];if(!file||!(/\.iso$/i.test(file.name||'')))return;
    // This capture listener intentionally owns ISO selection before the legacy
    // V32 UI handler can replace the result with its obsolete "future path"
    // message. Non-ISO STFS/XEX inputs continue through the existing app.
    event.stopImmediatePropagation();
    runModernXboxIso(file).catch(()=>{});
  },true);
}
