import {installRender360Buffer} from './render360-byte-buffer.mjs?v=44.4';
import {createBrowserTitlePpcSession,createBrowserTitleThreadScheduler,loadRender360Bootstrap} from './render360-browser-title-runtime.mjs?v=44.9';
import {handoffDefaultXex} from './render360-title-controller.mjs?v=44.9';
import {extractXex2EncryptedImageKey} from './render360-iso-title-controller.mjs?v=44.4';
import {submitCapturedTitleGpuTraffic} from './render360-title-gpu-traffic.mjs?v=44.4';
import {inspectCapturedXenosShaders} from './render360-xenos-shader-runtime.mjs?v=44.4';
import {validateCapturedXenosShadersWebGPU} from './render360-webgpu-title-shaders.mjs?v=44.4';
import {captureTitleFrontbuffer,hideTitleFrontbuffer,presentTitleFrontbuffer} from './render360-title-frontbuffer.mjs?v=44.4';

installRender360Buffer();

const MAX_XEX_BYTES=256*1024*1024;
const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];
let bootstrapPromise=null;
let activeRun=0;
let activeScheduler=null;

function stage(onStage,stage,message,extra={}){onStage?.({stage,message,...extra});}
async function getBootstrap(onStage=null){
  const wasCached=Boolean(bootstrapPromise);
  stage(onStage,'runtime',wasCached?'Checking generated WASM CPU runtime…':'Loading generated WASM CPU runtime…');
  if(!bootstrapPromise)bootstrapPromise=loadRender360Bootstrap();
  try{
    const bootstrap=await bootstrapPromise;
    stage(onStage,'runtime','Generated WASM CPU runtime ready');
    return bootstrap;
  }catch(error){
    bootstrapPromise=null;
    throw error;
  }
}
function stopActive(){try{activeScheduler?.stop?.();}catch{}activeScheduler=null;hideTitleFrontbuffer();}

async function readDirectXex(file,onStage){
  if(file.size<0x18)throw new Error('XEX file is too small');
  if(file.size>MAX_XEX_BYTES)throw new Error(`XEX exceeds the current browser staging limit (${Math.ceil(MAX_XEX_BYTES/1048576)} MB)`);
  stage(onStage,'extract',`Reading ${file.name}…`,{done:0,total:file.size});
  const bytes=new Uint8Array(await file.arrayBuffer());
  stage(onStage,'extract','XEX ready',{done:file.size,total:file.size});
  return {bytes,inputKind:'xex',package:null};
}

async function readStfsDefaultXex(core,file,onStage){
  stage(onStage,'mount','Mounting Xbox 360 package…',{done:0,total:file.size});
  const mount=await core.mountStfs(file,{extractDefaultXex:false});
  if(!mount.mounted)throw new Error(`STFS package did not mount (${mount.stfs?.statusName||'unknown status'})`);
  if(!mount.defaultXex)throw new Error('This package does not contain default.xex');
  const total=Number(mount.defaultXex.length||0);
  if(!total||total>MAX_XEX_BYTES)throw new Error(`Package default.xex exceeds the current browser staging limit (${Math.ceil(MAX_XEX_BYTES/1048576)} MB)`);
  stage(onStage,'extract','Extracting default.xex…',{done:0,total});
  const extracted=await core.extractStfsEntry(file,mount.defaultXex.index,{
    captureLimit:total,
    onProgress:p=>stage(onStage,'extract','Extracting default.xex…',{done:p.bytesDone||0,total:p.bytesTotal||total}),
  });
  if(!extracted.complete||!extracted.fullyCaptured)throw new Error(`default.xex extraction stopped at ${extracted.bytesDone||0}/${extracted.bytesTotal||total} bytes`);
  stage(onStage,'extract',`default.xex ready · ${core.stfsExtractionMode||'STFS'}`,{done:total,total});
  return {bytes:extracted.captured,inputKind:'stfs',package:{mount,extract:extracted}};
}

async function translateOnlyXex({core,bootstrap,bytes,onStage}){
  stage(onStage,'translate','Preparing retail XEX image…');
  let securityKey=null;
  try{securityKey=extractXex2EncryptedImageKey(bytes);}catch(error){throw new Error(`XEX security metadata could not be read: ${error.message}`);}
  const setExecute=pick(bootstrap,'r360_ppc_probe_set_execute_on_translate');
  const getExecute=pick(bootstrap,'r360_ppc_probe_execute_on_translate');
  if(typeof setExecute!=='function'||typeof getExecute!=='function')throw new Error('Published browser bootstrap does not support side-effect-free title translation');
  const previous=getExecute()>>>0;
  if((setExecute(0)>>>0)!==0)throw new Error('Unable to enter translation-only PPC mode');
  let result;
  try{result=await handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true});}
  finally{setExecute(previous?1:0);}
  if((result.executionStatus>>>0)!==4)throw new Error(`Title translation unexpectedly executed guest PPC (status ${result.executionStatus>>>0})`);
  stage(onStage,'translate',`Translated entry 0x${(result.entry>>>0).toString(16).toUpperCase()} · ${result.translatedFunctionCount||0} functions`);
  return {...result,runtimeBoundary:'translation-only',entryExecutedDuringTranslation:false};
}

async function executeNativeHirCompatibility({core,bootstrap,bytes,onStage}){
  stage(onStage,'execute','Generated-WASM entry is not callable; entering native HIR compatibility executor…');
  let securityKey=null;
  try{securityKey=extractXex2EncryptedImageKey(bytes);}catch(error){throw new Error(`XEX security metadata could not be read: ${error.message}`);}
  const setExecute=pick(bootstrap,'r360_ppc_probe_set_execute_on_translate');
  const getExecute=pick(bootstrap,'r360_ppc_probe_execute_on_translate');
  if(typeof setExecute!=='function'||typeof getExecute!=='function')throw new Error('Published browser bootstrap does not support native HIR compatibility execution');
  const resetKernel=pick(bootstrap,'r360_kernel_runtime_reset');
  if(typeof resetKernel==='function')resetKernel();
  const previous=getExecute()>>>0;
  if((setExecute(1)>>>0)!==1)throw new Error('Unable to enable native HIR compatibility execution');
  let result;
  try{
    result=await handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true,prepareMainThreadContext:true});
  }finally{
    setExecute(previous?1:0);
  }
  const status=result.executionStatus>>>0;
  const exact=result.executionBlockerOpcode?` · opcode ${result.executionBlockerOpcode} @ 0x${(result.executionBlockerAddress>>>0).toString(16).toUpperCase()}`:'';
  result.compatibilityExecution={used:true,reason:'generated-wasm-entry-not-callable',entry:result.entry>>>0,executionStatus:status,executionInstructions:result.executionInstructions>>>0,runtimeBoundary:result.runtimeBoundary,blockerKind:result.executionBlockerKind>>>0,blockerOpcode:result.executionBlockerOpcode>>>0,blockerAddress:result.executionBlockerAddress>>>0,reachedKernelBlocker:result.reachedKernelBlocker??null};
  stage(onStage,'execute',`Native HIR compatibility execution · ${Number(result.executionInstructions||0).toLocaleString()} instructions · ${result.runtimeBoundary}${exact}`);
  return result;
}

async function attachScheduler({bootstrap,result,onStage,config={}}){
  const reset=pick(bootstrap,'r360_kernel_runtime_reset');
  if(typeof reset!=='function')throw new Error('Published browser bootstrap is missing kernel runtime reset');
  reset();
  const ppcSession=await createBrowserTitlePpcSession({bootstrap,clearContext:true});
  if(!ppcSession.functionCount)throw new Error(`No callable generated WASM function was registered for title entry 0x${(result.entry>>>0).toString(16)}`);
  const scheduler=await createBrowserTitleThreadScheduler({bootstrap,session:ppcSession,maxSlicesPerPump:Math.max(1,Math.min(4,Number(config.schedulerQuantum||1)))});
  const primaryThread=scheduler.createThread({entry:result.entry>>>0,context:0,stackSize:0x80000,flags:0});
  const schedulerReport=await scheduler.pumpOnce({maxSlices:1});
  if(!schedulerReport.slices.length)throw new Error('Native guest-thread scheduler found no runnable title entry');
  stage(onStage,'execute',`Guest scheduler started · ${ppcSession.functionCount} generated functions`);
  return {ppcSession,scheduler,primaryThread,schedulerReport};
}

function updatePersistentCpu(state){
  if(state.result?.compatibilityExecution?.used){
    const status=state.result.executionStatus>>>0;
    const exact=state.result.executionBlockerOpcode?` · HIR opcode ${state.result.executionBlockerOpcode} @ 0x${(state.result.executionBlockerAddress>>>0).toString(16).toUpperCase()}`:'';
    const compatibilityBlocker=state.result.reachedKernelBlocker??(status===1?{kind:state.result.runtimeBoundary==='unresolved-guest-call'?'native-hir-unresolved-call':'native-hir-unsupported-boundary',entry:state.result.entry>>>0,hirBlockerKind:state.result.executionBlockerKind>>>0,hirOpcode:state.result.executionBlockerOpcode>>>0,guestAddress:state.result.executionBlockerAddress>>>0,message:`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`}:(status===2?{kind:'native-hir-no-return-boundary',entry:state.result.entry>>>0,message:`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`}:null));
    state.schedulerBlocker=compatibilityBlocker;
    state.persistentCpu={ready:status===3||Boolean(state.result.executionInstructions),schedulerReady:false,functionCount:0,pumpCount:1,totalSlices:Number(state.result.executionInstructions||0),completedThreads:status===3?1:0,paused:false,blocker:compatibilityBlocker,mode:'native-hir-compatibility-fallback'};
    return state.persistentCpu;
  }
  const inspect=state.threadScheduler?.inspect?.()??null;
  state.persistentCpu={ready:Boolean(state.ppcSession)&&!state.schedulerBlocker,schedulerReady:Boolean(state.threadScheduler),functionCount:state.ppcSession?.functionCount??0,pumpCount:inspect?.pumpCount??state.schedulerReport?.pumpCount??0,totalSlices:inspect?.sliceCount??state.schedulerReport?.totalSlices??0,completedThreads:inspect?.completedThreads??state.schedulerReport?.completedThreads??0,paused:Boolean(inspect?.paused),blocker:state.schedulerBlocker||inspect?.lastBlocker||null};
  return state.persistentCpu;
}

async function inspectRuntime(state,{forceFrontbuffer=false}={}){
  let gpuTraffic=null;
  try{gpuTraffic=submitCapturedTitleGpuTraffic({bootstrap:state.bootstrap});}catch(error){gpuTraffic={submitted:false,ready:false,reason:error?.message||String(error)};}
  let shaderRuntime=null;
  try{shaderRuntime=inspectCapturedXenosShaders({bootstrap:state.bootstrap,execute:true});}catch(error){shaderRuntime={available:true,error:error?.message||String(error)};}
  let shaderWebGPU=state.shaderWebGPU??null;
  if(state.config?.renderer!=='webgl2'&&shaderRuntime?.bothSpirvTranslated&&!shaderWebGPU?.bothAccepted){try{shaderWebGPU=await validateCapturedXenosShadersWebGPU({bootstrap:state.bootstrap});}catch(error){shaderWebGPU={available:false,bothAccepted:false,reason:error?.message||String(error)};}}
  let frontbufferFrame=state.frontbufferFrame??null,presentation=state.presentation??null;
  const swaps=gpuTraffic?.swaps||0;
  if(swaps>0&&(forceFrontbuffer||swaps!==state.lastSwapCount)){
    try{frontbufferFrame=captureTitleFrontbuffer({bootstrap:state.bootstrap});if(frontbufferFrame.captured)presentation=presentTitleFrontbuffer(frontbufferFrame);}catch(error){frontbufferFrame={available:true,captured:false,realTitleFrameReady:false,reason:error?.message||String(error)};}
  }
  Object.assign(state,{gpuTraffic,shaderRuntime,shaderWebGPU,frontbufferFrame,presentation,lastSwapCount:swaps});return state;
}

function publish(state){
  globalThis.render360ModernTitle={fileName:state.file?.name||'',inputKind:state.inputKind,result:state.result,persistentCpu:state.persistentCpu,ppcSession:state.ppcSession,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,schedulerBlocker:state.schedulerBlocker,runtimeLoop:state.runtimeLoop,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,shaderWebGPU:state.shaderWebGPU,frontbufferFrame:state.frontbufferFrame,presentation:state.presentation,bootstrap:state.bootstrap,core:state.core,config:state.config,stop:()=>state.threadScheduler?.stop?.(),inspectScheduler:()=>state.threadScheduler?.inspect?.()??null};
}

function driveScheduler(run,state,onStage){
  activeScheduler=state.threadScheduler;
  const loop=state.threadScheduler.runLoop({
    onPump:async report=>{if(run!==activeRun){state.threadScheduler.stop();return;}state.schedulerReport=report;await inspectRuntime(state);updatePersistentCpu(state);publish(state);if(state.frontbufferFrame?.realTitleFrameReady)stage(onStage,'frame',`Real title frame ${state.frontbufferFrame.width}×${state.frontbufferFrame.height}`);},
    onError:async(error,blocker)=>{state.schedulerBlocker={kind:'commercial-cpu-scheduler-blocker',entry:blocker?.entry??state.result.entry??0,message:error?.message||String(error),...blocker};updatePersistentCpu(state);publish(state);stage(onStage,'blocked',state.schedulerBlocker.message,{blocker:state.schedulerBlocker});},
  });
  state.runtimeLoop=loop;publish(state);loop.then(()=>{if(run===activeRun){updatePersistentCpu(state);publish(state);}}).catch(error=>{if(run===activeRun)stage(onStage,'blocked',error?.message||String(error));});return loop;
}

export async function runModernXboxContent({core,file,type,onStage=null,config={}}={}){
  if(!core?.exports)throw new Error('Render360 package/XEX core is not initialized');
  if(!file||typeof file.slice!=='function')throw new TypeError('Xbox 360 File/Blob required');
  const kind=String(type||'').toLowerCase();
  if(!['xex','con','live','pirs'].includes(kind))throw new Error(`Modern content bridge does not support ${kind||'unknown'} input`);
  const run=++activeRun;stopActive();stage(onStage,'launch',`Starting ${file.name||'Xbox 360 title'}…`);
  const bootstrap=await getBootstrap(onStage);if(run!==activeRun)return null;
  const prepared=kind==='xex'?await readDirectXex(file,onStage):await readStfsDefaultXex(core,file,onStage);
let result=await translateOnlyXex({core,bootstrap,bytes:prepared.bytes,onStage});if(run!==activeRun)return null;
let threaded=null;
if(Number(result.translatedFunctionCount||0)>0){
  threaded=await attachScheduler({bootstrap,result,onStage,config});
}else{
  console.warn(`[Render360] Generated-WASM emitter produced 0 callable functions for 0x${(result.entry>>>0).toString(16)}; switching this STFS/XEX title to native HIR compatibility execution`);
  result=await executeNativeHirCompatibility({core,bootstrap,bytes:prepared.bytes,onStage});
}
if(run!==activeRun)return null;
const state={file,core,bootstrap,inputKind:prepared.inputKind,result,package:prepared.package,config,ppcSession:threaded?.ppcSession??null,threadScheduler:threaded?.scheduler??null,primaryThread:threaded?.primaryThread??null,schedulerReport:threaded?.schedulerReport??null,schedulerBlocker:null,runtimeLoop:null,persistentCpu:null,gpuTraffic:null,shaderRuntime:null,shaderWebGPU:null,frontbufferFrame:null,presentation:null,lastSwapCount:-1};
updatePersistentCpu(state);await inspectRuntime(state,{forceFrontbuffer:true});publish(state);if(state.threadScheduler)driveScheduler(run,state,onStage);
else if(state.schedulerBlocker)stage(onStage,'blocked',state.schedulerBlocker.message||String(state.schedulerBlocker),{blocker:state.schedulerBlocker});
return {result:state.result,persistentCpu:state.persistentCpu,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,frontbufferFrame:state.frontbufferFrame,inputKind:state.inputKind};
}

export function modernContentBridgeContract(){return {release:44,inputs:['xex','live','pirs','con'],stfsStreamingMount:true,wholePackageCopy:false,defaultXexBounded:true,translationSideEffects:false,generatedWasmExecution:true,nativeGuestThreadRegistry:true,cooperativeThreadScheduler:true,xenosTrafficInspection:true,realFrontbufferCapture:true,pauseResume:true,nativeHirCompatibilityFallback:true};}
