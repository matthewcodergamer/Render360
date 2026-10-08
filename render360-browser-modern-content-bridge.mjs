import {browserGuestRunOptions} from './render360-guest-fibers.mjs';
import {installRender360Buffer} from './render360-byte-buffer.mjs';
import {createBrowserTitlePpcSession,createBrowserTitleThreadScheduler,discardRender360Bootstrap,loadRender360Bootstrap} from './render360-browser-title-runtime.mjs';
import {wrapCoreTrap} from './render360-trap-report.mjs';
import {describeKernelBoundary,handoffDefaultXex} from './render360-title-controller.mjs';
import {extractXex2EncryptedImageKey} from './render360-iso-title-controller.mjs';
import {submitCapturedTitleGpuTraffic} from './render360-title-gpu-traffic.mjs';
import {inspectCapturedXenosShaders} from './render360-xenos-shader-runtime.mjs';
import {validateCapturedXenosShadersWebGPU} from './render360-webgpu-title-shaders.mjs';
import {captureTitleFrontbuffer,ensureTitleWebGPUCanvas,hideTitleFrontbuffer,presentTitleFrontbuffer,showTitleWebGPUCanvas} from './render360-title-frontbuffer.mjs';
import {createRgbaFramePresenter} from './render360-webgpu-runtime.mjs';
import {browserPerformanceDefaults,createAdaptivePerformancePolicy} from './render360-performance-policy.mjs';
import {prepareStfsGuestVfs,prepareXexGuestVfs,runWithGuestVfsRetries} from './render360-guest-vfs.mjs';

installRender360Buffer();

const MAX_XEX_BYTES=256*1024*1024;
const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];
let activeRun=0;
let activeScheduler=null;
let activePresenter=null;

function stage(onStage,stage,message,extra={}){onStage?.({stage,message,...extra});}
function guestRunOptions(bootstrap,onStage){
  return browserGuestRunOptions({bootstrap,onProgress:(message,extra)=>stage(onStage,'execute',message,extra)});
}
async function getBootstrap(onStage=null){
  const wasCached=Boolean(globalThis.render360PpcRuntimeIdentity?.verified);
  stage(onStage,'runtime',wasCached?'Checking generated WASM CPU runtime…':'Loading generated WASM CPU runtime…');
  const bootstrap=await loadRender360Bootstrap();
  stage(onStage,'runtime','Verified generated WASM CPU runtime ready');
  return bootstrap;
}
function stopActive(){try{activeScheduler?.stop?.();}catch{}activeScheduler=null;try{activePresenter?.destroy?.();}catch{}activePresenter=null;hideTitleFrontbuffer();}

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
  catch(error){
    const blocker=error?.render360??{kind:'title-translation-failure',message:error?.message||String(error)};
    stage(onStage,'blocked',error?.message||String(error),{blocker});
    throw error;
  }
  finally{setExecute(previous?1:0);}
  if((result.executionStatus>>>0)!==4)throw new Error(`Title translation unexpectedly executed guest PPC (status ${result.executionStatus>>>0})`);
  stage(onStage,'translate',`Translated entry 0x${(result.entry>>>0).toString(16).toUpperCase()} · ${result.translatedFunctionCount||0} functions`);
  return {...result,runtimeBoundary:'translation-only',entryExecutedDuringTranslation:false};
}

// Registers the title's files with the native kernel VFS (game:, d:,
// \Device\Cdrom0) so NtCreateFile/NtReadFile see the real package contents.
async function prepareGuestVfs({core,bootstrap,file,prepared,onStage}){
  try{
    if(prepared.inputKind==='stfs'&&prepared.package?.mount){
      stage(onStage,'extract','Indexing package files for the Xbox file system…');
      const vfs=await prepareStfsGuestVfs({core,bootstrap,file,mount:prepared.package.mount,defaultXex:prepared.bytes});
      stage(onStage,'extract',`Package file system ready · ${vfs.registered} entries · ${(vfs.eagerBytes/1048576).toFixed(1)} MB preloaded`);
      return vfs;
    }
    return prepareXexGuestVfs({bootstrap,defaultXex:prepared.bytes});
  }catch(error){
    console.warn('[Render360] Guest file system unavailable:',error);
    return {available:false,error:error?.message||String(error),fetchPending:async()=>false};
  }
}

async function executeNativeHirCompatibility({core,bootstrap,bytes,onStage,vfs=null}){
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
    result=await runWithGuestVfsRetries(
      ()=>handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true,prepareMainThreadContext:true,...guestRunOptions(bootstrap,onStage)}),
      {bootstrap,fetchPending:vfs?.fetchPending??(async()=>false),onRetry:(pending,attempt)=>stage(onStage,'extract',`Loading ${pending.path} for the title (${attempt})…`)},
    );
  }finally{
    setExecute(previous?1:0);
  }
  const status=result.executionStatus>>>0;
  const exact=result.executionBlockerOpcode?` · opcode ${result.executionBlockerOpcode} @ 0x${(result.executionBlockerAddress>>>0).toString(16).toUpperCase()}`:'';
  const fault=memoryFaultText(result);
  result.compatibilityExecution={used:true,reason:'generated-wasm-entry-not-callable',entry:result.entry>>>0,executionStatus:status,executionInstructions:result.executionInstructions>>>0,runtimeBoundary:result.runtimeBoundary,blockerKind:result.executionBlockerKind>>>0,blockerOpcode:result.executionBlockerOpcode>>>0,blockerAddress:result.executionBlockerAddress>>>0,reachedKernelBlocker:result.reachedKernelBlocker??null};
  stage(onStage,'execute',`Native HIR compatibility execution · ${Number(result.executionInstructions||0).toLocaleString()} instructions · ${result.runtimeBoundary}${exact}${fault}`);
  return result;
}

async function attachScheduler({bootstrap,result,onStage,config={},preparedSession=null}){
  const reset=pick(bootstrap,'r360_kernel_runtime_reset');
  if(typeof reset!=='function')throw new Error('Published browser bootstrap is missing kernel runtime reset');
  reset();
  const ppcSession=preparedSession??await createBrowserTitlePpcSession({bootstrap,clearContext:true});
  if(!ppcSession.functionCount)throw new Error(`No callable generated WASM function was registered for title entry 0x${(result.entry>>>0).toString(16)}`);
  const scheduler=await createBrowserTitleThreadScheduler({bootstrap,session:ppcSession,maxSlicesPerPump:Math.max(1,Math.min(4,Number(config.schedulerQuantum||1)))});
  const primaryThread=scheduler.createThread({entry:result.entry>>>0,context:0,stackSize:0x80000,flags:0});
  const schedulerReport=await scheduler.pumpOnce({maxSlices:1});
  if(!schedulerReport.slices.length)throw new Error('Native guest-thread scheduler found no runnable title entry');
  stage(onStage,'execute',`Guest scheduler started · ${ppcSession.functionCount} generated functions`);
  return {ppcSession,scheduler,primaryThread,schedulerReport};
}

const MEMORY_FAULTS=['','unmapped address','read-protected address','write-protected address','invalid access'];
function memoryFaultText(result){
  const code=result?.memoryFaultCode>>>0;
  if(!code)return '';
  return ` · ${MEMORY_FAULTS[code]||`fault ${code}`} 0x${(result.memoryFaultAddress>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
}

function updatePersistentCpu(state){
  if(state.result?.compatibilityExecution?.used){
    const status=state.result.executionStatus>>>0;
    const exact=state.result.executionBlockerOpcode?` · HIR opcode ${state.result.executionBlockerOpcode} @ 0x${(state.result.executionBlockerAddress>>>0).toString(16).toUpperCase()}`:'';
    const fault=memoryFaultText(state.result);
    const compatibilityBlocker=state.result.reachedKernelBlocker??(status===1?{kind:state.result.runtimeBoundary==='unresolved-guest-call'?'native-hir-unresolved-call':'native-hir-unsupported-boundary',entry:state.result.entry>>>0,hirBlockerKind:state.result.executionBlockerKind>>>0,hirOpcode:state.result.executionBlockerOpcode>>>0,guestAddress:state.result.executionBlockerAddress>>>0,memoryFault:state.result.memoryFaultCode?{code:state.result.memoryFaultCode>>>0,address:state.result.memoryFaultAddress>>>0}:null,message:describeKernelBoundary(state.result.kernelBoundary)||`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}${fault}`,kernelBoundary:state.result.kernelBoundary??null}:(status===2?{kind:'native-hir-no-return-boundary',entry:state.result.entry>>>0,message:describeKernelBoundary(state.result.kernelBoundary)||`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`,kernelBoundary:state.result.kernelBoundary??null}:null));
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
    try{
      frontbufferFrame=captureTitleFrontbuffer({bootstrap:state.bootstrap});
      if(frontbufferFrame.captured){
        let webgpuError=null;
        if(state.config?.renderer!=='webgl2'&&globalThis.navigator?.gpu){
          try{
            if(!state.webgpuPresenter){
              const canvas=ensureTitleWebGPUCanvas();
              if(!canvas)throw new Error('WebGPU title canvas unavailable');
              showTitleWebGPUCanvas(frontbufferFrame,{canvas,resolutionScale:state.config?.resolutionScale??1});
              state.webgpuPresenter=await createRgbaFramePresenter(canvas);
              activePresenter=state.webgpuPresenter;
            }else showTitleWebGPUCanvas(frontbufferFrame,{resolutionScale:state.config?.resolutionScale??1});
            presentation=state.webgpuPresenter.present(frontbufferFrame,{scale:state.config?.resolutionScale??1});
          }catch(error){webgpuError=error;try{state.webgpuPresenter?.destroy?.();}catch{}state.webgpuPresenter=null;activePresenter=null;}
        }
        if(!presentation||presentation.generation!==(frontbufferFrame.generation>>>0)){
          presentation=presentTitleFrontbuffer(frontbufferFrame);
          if(webgpuError)presentation={...presentation,webgpuFallbackReason:webgpuError?.message||String(webgpuError)};
        }
      }
    }catch(error){frontbufferFrame={available:true,captured:false,realTitleFrameReady:false,reason:error?.message||String(error)};}
  }
  const now=globalThis.performance?.now?.()??Date.now();
  let performanceSample=state.performancePolicy?.snapshot?.()??null;
  if(state.performancePolicy&&swaps>0&&swaps!==state.lastPerformanceSwapCount){
    let fps=null;
    if(Number.isFinite(state.lastPerformanceSampleAt)&&state.lastPerformanceSwapCount>=0&&now>state.lastPerformanceSampleAt){
      fps=(swaps-state.lastPerformanceSwapCount)*1000/(now-state.lastPerformanceSampleAt);
      if(!Number.isFinite(fps)||fps<=0||fps>240)fps=null;
    }
    const budgetMb=Number(state.config?.performanceMemoryBudgetMB||0);
    performanceSample=state.performancePolicy.observe({fps,memoryBytes:state.bootstrap?.exports?.memory?.buffer?.byteLength||0,memoryBudgetBytes:budgetMb>0?budgetMb*1048576:0,now});
    if(performanceSample.changed){
      state.config.resolutionScale=performanceSample.resolutionScale;
      stage(state.onStage,'performance',`Adaptive resolution ${(performanceSample.resolutionScale*100).toFixed(0)}% · ${performanceSample.reason}`,{performance:performanceSample});
    }
    state.lastPerformanceSampleAt=now;state.lastPerformanceSwapCount=swaps;
  }
  Object.assign(state,{gpuTraffic,shaderRuntime,shaderWebGPU,frontbufferFrame,presentation,performanceSample,lastSwapCount:swaps});return state;
}

function publish(state){
  globalThis.render360ModernTitle={fileName:state.file?.name||'',inputKind:state.inputKind,result:state.result,persistentCpu:state.persistentCpu,ppcSession:state.ppcSession,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,schedulerBlocker:state.schedulerBlocker,runtimeLoop:state.runtimeLoop,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,shaderWebGPU:state.shaderWebGPU,frontbufferFrame:state.frontbufferFrame,presentation:state.presentation,performance:state.performanceSample,performancePolicy:state.performancePolicy,webgpuPresenter:state.webgpuPresenter,bootstrap:state.bootstrap,core:state.core,config:state.config,stop:()=>state.threadScheduler?.stop?.(),inspectScheduler:()=>state.threadScheduler?.inspect?.()??null};
}

function driveScheduler(run,state,onStage){
  activeScheduler=state.threadScheduler;
  const loop=state.threadScheduler.runLoop({
    onPump:async report=>{if(run!==activeRun){state.threadScheduler.stop();return;}state.schedulerReport=report;await inspectRuntime(state);updatePersistentCpu(state);publish(state);if(state.frontbufferFrame?.realTitleFrameReady)stage(onStage,'frame',`Real title frame ${state.frontbufferFrame.width}×${state.frontbufferFrame.height}`);},
    onError:async(error,blocker)=>{error=wrapCoreTrap(error,state.bootstrap,{onPoisoned:discardRender360Bootstrap,context:'scheduler'});if(error?.code==='R360_CORE_TRAP')state.threadScheduler?.stop?.();state.schedulerBlocker={kind:error?.kernelBoundary?.kind??'commercial-cpu-scheduler-blocker',entry:blocker?.entry??state.result.entry??0,message:error?.message||String(error),kernelBoundary:error?.kernelBoundary??null,...blocker};updatePersistentCpu(state);publish(state);stage(onStage,'blocked',state.schedulerBlocker.message,{blocker:state.schedulerBlocker});},
  });
  state.runtimeLoop=loop;publish(state);loop.then(()=>{if(run===activeRun){updatePersistentCpu(state);publish(state);}}).catch(error=>{error=wrapCoreTrap(error,state.bootstrap,{onPoisoned:discardRender360Bootstrap,context:'scheduler'});if(run===activeRun)stage(onStage,'blocked',error?.message||String(error),error?.render360?{blocker:error.render360}:{});});return loop;
}

export async function runModernXboxContent(options={}){
  const holder={bootstrap:null};
  try{return await runModernXboxContentInner(options,holder);}
  catch(error){
    const wrapped=wrapCoreTrap(error,holder.bootstrap,{onPoisoned:discardRender360Bootstrap,context:'title-launch'});
    if(wrapped!==error){stopActive();stage(options.onStage,'blocked',wrapped.message,{blocker:wrapped.render360});}
    throw wrapped;
  }
}

async function runModernXboxContentInner({core,file,type,onStage=null,config={}}={},holder={}){
  if(!core?.exports)throw new Error('Render360 package/XEX core is not initialized');
  if(!file||typeof file.slice!=='function')throw new TypeError('Xbox 360 File/Blob required');
  const kind=String(type||'').toLowerCase();
  if(!['xex','con','live','pirs'].includes(kind))throw new Error(`Modern content bridge does not support ${kind||'unknown'} input`);
  const run=++activeRun;stopActive();stage(onStage,'launch',`Starting ${file.name||'Xbox 360 title'}…`);
  const bootstrap=await getBootstrap(onStage);holder.bootstrap=bootstrap;if(run!==activeRun)return null;
  const prepared=kind==='xex'?await readDirectXex(file,onStage):await readStfsDefaultXex(core,file,onStage);
  const guestVfs=await prepareGuestVfs({core,bootstrap,file,prepared,onStage});if(run!==activeRun)return null;
let result=await translateOnlyXex({core,bootstrap,bytes:prepared.bytes,onStage});if(run!==activeRun)return null;
let threaded=null;
const generatedSession=await createBrowserTitlePpcSession({bootstrap,clearContext:true});
if(generatedSession.functionCount>0){
  const tiers=generatedSession.functionTiers||[];
  const cfgCount=tiers.filter(item=>item?.tier==='cfg-fallback').length;
  stage(onStage,'execute',`Generated-WASM session ready · ${generatedSession.functionCount} function${generatedSession.functionCount===1?'':'s'}${cfgCount?` · ${cfgCount} resumable CFG`:''}`);
  threaded=await attachScheduler({bootstrap,result,onStage,config,preparedSession:generatedSession});
}else{
  console.warn(`[Render360] Generated-WASM callable/CFG session produced 0 runnable functions for 0x${(result.entry>>>0).toString(16)}; switching this STFS/XEX title to native HIR compatibility execution`);
  result=await executeNativeHirCompatibility({core,bootstrap,bytes:prepared.bytes,onStage,vfs:guestVfs});
}
if(run!==activeRun)return null;
const perfDefaults=browserPerformanceDefaults();
const effectiveConfig={...config,targetFps:Number(config.targetFps||perfDefaults.targetFps),resolutionScale:Number(config.resolutionScale??perfDefaults.initialScale)};
const performancePolicy=createAdaptivePerformancePolicy({targetFps:effectiveConfig.targetFps,initialScale:effectiveConfig.resolutionScale,minScale:Number(config.minResolutionScale??perfDefaults.minScale),maxScale:Number(config.maxResolutionScale??perfDefaults.maxScale)});
effectiveConfig.resolutionScale=performancePolicy.resolutionScale;
const state={file,core,bootstrap,inputKind:prepared.inputKind,result,package:prepared.package,config:effectiveConfig,onStage,performancePolicy,performanceSample:performancePolicy.snapshot(),lastPerformanceSampleAt:NaN,lastPerformanceSwapCount:-1,ppcSession:threaded?.ppcSession??null,threadScheduler:threaded?.scheduler??null,primaryThread:threaded?.primaryThread??null,schedulerReport:threaded?.schedulerReport??null,schedulerBlocker:null,runtimeLoop:null,persistentCpu:null,gpuTraffic:null,shaderRuntime:null,shaderWebGPU:null,frontbufferFrame:null,presentation:null,webgpuPresenter:null,lastSwapCount:-1};
updatePersistentCpu(state);await inspectRuntime(state,{forceFrontbuffer:true});publish(state);if(state.threadScheduler)driveScheduler(run,state,onStage);
else if(state.schedulerBlocker)stage(onStage,'blocked',state.schedulerBlocker.message||String(state.schedulerBlocker),{blocker:state.schedulerBlocker});
return {result:state.result,persistentCpu:state.persistentCpu,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,frontbufferFrame:state.frontbufferFrame,performance:state.performanceSample,inputKind:state.inputKind};
}

export function modernContentBridgeContract(){return {release:75,inputs:['xex','live','pirs','con'],stfsStreamingMount:true,wholePackageCopy:false,defaultXexBounded:true,translationSideEffects:false,generatedWasmExecution:true,generatedWasmCfgFallbackRouting:true,compiledWasmReuse:true,hotFunctionTelemetry:true,nativeGuestThreadRegistry:true,cooperativeThreadScheduler:true,xenosTrafficInspection:true,realFrontbufferCapture:true,webgpuRealFrontbufferPresentation:true,adaptivePresentationResolution:true,targetFps:30,canvas2dFallback:true,pauseResume:true,nativeHirCompatibilityFallback:true};}
