import {installRender360Buffer} from './render360-byte-buffer.mjs';
import {createRender360BrowserImports,attachRender360BrowserInstance,validateRender360BrowserImports} from './render360-browser-wasi.mjs';
import {createPersistentPpcSession,persistentPpcSessionContract} from './render360-browser-ppc-session.mjs';
import {createGuestThreadScheduler,guestThreadSchedulerContract} from './render360-browser-thread-scheduler.mjs';
installRender360Buffer();

export const PPC_BOOTSTRAP_URL='./xenia_ppc_bootstrap.wasm';
export const PPC_BOOTSTRAP_META_URL='./xenia_ppc_bootstrap.meta.json';
const RENDER360_RELEASE=73;
const BOOTSTRAP_SINGLETON_KEY=Symbol.for('render360.ppc.bootstrap.singleton');

const REQUIRED_BOOTSTRAP_EXPORTS=[
  'memory','r360_ppc_probe_load_at','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity',
  'r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_gpr',
  'r360_ppc_probe_set_execute_on_translate','r360_ppc_probe_execute_on_translate',
  'r360_ppc_context_size','r360_ppc_context_offset_gpr','r360_ppc_context_offset_lr','r360_ppc_context_offset_ctr',
  'r360_wasm_backend_call_status','r360_wasm_backend_call_function_count','r360_wasm_backend_call_function_address',
  'r360_wasm_backend_call_function_generation','r360_wasm_backend_call_module_ptr','r360_wasm_backend_call_module_size',
  'r360_wasm_backend_call_lowered_instructions','r360_wasm_backend_call_context_ptr',
  'r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_xex_guest_mapper_reserve_input','r360_xex_guest_mapper_input_max_capacity',
  'r360_pe_guest_load','r360_pe_guest_load_at_entry','r360_pe_guest_entry_address','r360_pe_guest_pe_entry_address','r360_title_handoff_translate_entry','r360_title_handoff_translate_scanned_entry',
  'r360_kernel_import_register','r360_kernel_service_call','r360_kernel_runtime_reset',
  'r360_generated_guest_load_scalar','r360_generated_guest_load_status',
  'r360_sparse_guest_memory_last_fault_address','r360_sparse_guest_memory_last_fault_code',
  'r360_guest_thread_create','r360_guest_thread_current','r360_guest_thread_set_current','r360_guest_thread_terminate','r360_guest_thread_next_runnable',
  'r360_guest_thread_state','r360_guest_thread_exit_code','r360_guest_thread_entry','r360_guest_thread_context','r360_guest_thread_flags',
  'r360_guest_thread_stack_size','r360_guest_thread_stack_base','r360_guest_thread_stack_top','r360_guest_thread_stack_mapped','r360_guest_tls_alloc',
  'r360_title_gpu_ring_base','r360_title_gpu_ring_size_log2','r360_title_gpu_ring_word_capacity',
  'r360_title_gpu_write_pointer','r360_title_gpu_status','r360_title_gpu_ring_word',
  'r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit',
  'r360_xenos_status','r360_xenos_packets','r360_xenos_draws','r360_xenos_presents','r360_xenos_swaps','r360_xenos_real_title_frame_ready',
  'r360_xenos_last_opcode','r360_xenos_last_fault_word','r360_xenos_frame_generation','r360_xenos_frame_hash',
  'r360_xenos_shader_dwords','r360_xenos_shader_interpreter_reset','r360_xenos_shader_interpreter_analyze',
  'r360_xenos_shader_interpreter_execute','r360_xenos_shader_interpreter_status','r360_xenos_shader_interpreter_ucode_dwords',
  'r360_xenos_shader_interpreter_uses_texture_fetch','r360_xenos_shader_interpreter_execution_count',
  'r360_xenos_spirv_reset','r360_xenos_spirv_translate','r360_xenos_spirv_status','r360_xenos_spirv_buffer','r360_xenos_spirv_size','r360_xenos_spirv_word',
  'r360_xenos_frontbuffer_snapshot_capture','r360_xenos_frontbuffer_snapshot_status','r360_xenos_frontbuffer_snapshot_buffer',
  'r360_xenos_frontbuffer_snapshot_size','r360_xenos_frontbuffer_snapshot_width','r360_xenos_frontbuffer_snapshot_height',
  'r360_xenos_frontbuffer_snapshot_hash','r360_xenos_frontbuffer_snapshot_generation','r360_xenos_frontbuffer_snapshot_format',
  'r360_xenos_frontbuffer_snapshot_tiled','r360_xenos_frontbuffer_snapshot_pitch','r360_xenos_frontbuffer_snapshot_source_address',
  'r360_xenos_frontbuffer_snapshot_source_bytes'
];
const pick=(e,n)=>e[n]??e[`_${n}`];

export function validateBrowserBootstrap(instance){
  if(!instance?.exports?.memory)throw new Error('Render360 browser bootstrap has no exported memory');
  const missing=REQUIRED_BOOTSTRAP_EXPORTS.filter(n=>n!=='memory'&&typeof pick(instance.exports,n)!=='function');
  if(missing.length)throw new Error(`Render360 browser bootstrap missing exports: ${missing.join(', ')}`);
  return {ok:true,exports:REQUIRED_BOOTSTRAP_EXPORTS.length,memoryBytes:instance.exports.memory.buffer.byteLength};
}

function byteView(bytes){
  if(bytes instanceof ArrayBuffer)return new Uint8Array(bytes);
  if(ArrayBuffer.isView(bytes))return new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  throw new TypeError('Render360 bootstrap bytes must be an ArrayBuffer or typed array');
}

function sha256Hex(digest){return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');}

export async function validatePpcBootstrapAsset(bytes,metadata,{cryptoImpl=globalThis.crypto}={}){
  const view=byteView(bytes);
  if(!metadata||typeof metadata!=='object')throw new Error('Render360 bootstrap provenance metadata is missing');
  if(!/^[0-9a-f]{40}$/i.test(String(metadata.sourceCommit||'')))throw new Error('Render360 bootstrap source commit is invalid');
  if(!/^\d+$/.test(String(metadata.sourceRun||'')))throw new Error('Render360 bootstrap source run is invalid');
  const release=Number(metadata.release);
  if(!Number.isSafeInteger(release)||release!==RENDER360_RELEASE)throw new Error(`Render360 bootstrap release mismatch: expected V${RENDER360_RELEASE}, received ${metadata.release??'missing'}`);
  if(!/^[0-9a-f]{64}$/i.test(String(metadata.sha256||'')))throw new Error('Render360 bootstrap SHA-256 is invalid');
  if(!Number.isSafeInteger(Number(metadata.bytes))||Number(metadata.bytes)!==view.byteLength){
    throw new Error(`Render360 bootstrap byte count mismatch: expected ${metadata.bytes}, received ${view.byteLength}`);
  }
  if(!cryptoImpl?.subtle?.digest)throw new Error('SHA-256 verification is unavailable');
  const actualSha256=sha256Hex(await cryptoImpl.subtle.digest('SHA-256',view));
  if(actualSha256!==String(metadata.sha256).toLowerCase()){
    throw new Error(`Render360 bootstrap SHA-256 mismatch: expected ${metadata.sha256}, received ${actualSha256}`);
  }
  return {
    verified:true,
    release,
    release,
    sourceCommit:String(metadata.sourceCommit).toLowerCase(),
    sourceRun:String(metadata.sourceRun),
    sha256:actualSha256,
    bytes:view.byteLength,
  };
}

async function instantiateVerifiedBootstrap({url,metadataUrl,fetchImpl,onStdout,onStderr,cryptoImpl}){
  if(typeof WebAssembly!=='object')throw new Error('WebAssembly is unavailable');
  if(typeof fetchImpl!=='function')throw new Error('fetch is unavailable');
  const [metadataResponse,response]=await Promise.all([
    fetchImpl(metadataUrl,{cache:'no-store'}),
    fetchImpl(url,{cache:'no-store'}),
  ]);
  if(!metadataResponse?.ok)throw new Error(`Render360 bootstrap metadata fetch failed: HTTP ${metadataResponse?.status??0}`);
  if(!response?.ok)throw new Error(`Render360 bootstrap fetch failed: HTTP ${response?.status??0}`);
  const [metadata,bytes]=await Promise.all([metadataResponse.json(),response.arrayBuffer()]);
  const identity=await validatePpcBootstrapAsset(bytes,metadata,{cryptoImpl});
  const host=createRender360BrowserImports({onStdout,onStderr});
  const module=await WebAssembly.compile(bytes);
  let instance;
  try{instance=await WebAssembly.instantiate(module,host.imports);}catch(error){throw new Error(`Render360 bootstrap instantiate failed: ${error?.message||error}`);}
  validateRender360BrowserImports(module);
  attachRender360BrowserInstance(host,instance);
  validateBrowserBootstrap(instance);
  globalThis.render360PpcRuntimeIdentity={...identity,url,metadataUrl,loadedAt:new Date().toISOString(),loadCount:1};
  return instance;
}

export async function loadRender360Bootstrap({
  url=PPC_BOOTSTRAP_URL,
  metadataUrl=PPC_BOOTSTRAP_META_URL,
  fetchImpl=globalThis.fetch,
  onStdout=null,
  onStderr=null,
  cryptoImpl=globalThis.crypto,
}={}){
  const canonical=url===PPC_BOOTSTRAP_URL&&metadataUrl===PPC_BOOTSTRAP_META_URL&&fetchImpl===globalThis.fetch;
  if(!canonical)return instantiateVerifiedBootstrap({url,metadataUrl,fetchImpl,onStdout,onStderr,cryptoImpl});
  const existing=globalThis[BOOTSTRAP_SINGLETON_KEY];
  if(existing?.promise)return existing.promise;
  const state={promise:null};
  state.promise=instantiateVerifiedBootstrap({url,metadataUrl,fetchImpl,onStdout,onStderr,cryptoImpl}).catch(error=>{
    if(globalThis[BOOTSTRAP_SINGLETON_KEY]===state)delete globalThis[BOOTSTRAP_SINGLETON_KEY];
    throw error;
  });
  globalThis[BOOTSTRAP_SINGLETON_KEY]=state;
  return state.promise;
}

export async function createBrowserTitlePpcSession({bootstrap,initialGprs={},clearContext=true}={}){
  validateBrowserBootstrap(bootstrap);
  return createPersistentPpcSession({bootstrap,initialGprs,clearContext});
}

export async function createBrowserTitleThreadScheduler({bootstrap,session=null,...options}={}){
  validateBrowserBootstrap(bootstrap);
  return createGuestThreadScheduler({bootstrap,session,...options});
}

export async function mountXboxIsoBrowser(file){
  if(!file||typeof file.slice!=='function'||!Number.isSafeInteger(Number(file.size)))throw new TypeError('Xbox ISO must be a browser File/Blob-like object');
  const {mountXdvdfs}=await import('./render360-xdvdfs.mjs');
  const volume=await mountXdvdfs(file);
  const node=await volume.stat('/default.xex');
  return {volume,defaultXex:node,layout:volume.layout,partitionOffset:volume.partitionOffset,telemetry:volume.telemetry};
}

/**
 * Mount and prepare a real Xbox 360 ISO for the browser runtime.
 *
 * Production mode first performs side-effect-free Xenia translation and uses
 * persistent generated WASM whenever the entry is fully lowerable. If Xenia
 * translated a genuine title function but the generated-WASM emitter produced
 * no callable entry, the ISO controller may use the broader native HIR
 * compatibility executor to expose the next real title/runtime boundary rather
 * than stopping at an emitter-coverage artifact.
 */
export async function handoffXboxIsoBrowser({
  core,
  file,
  bootstrap=null,
  bootstrapUrl=PPC_BOOTSTRAP_URL,
  scanEntryFunction=true,
  productionThreadedExecution=true,
  primaryThreadContext=0,
  primaryThreadStackSize=0x80000,
  primaryThreadFlags=0,
  ...options
}){
  if(!core?.exports)throw new Error('Render360 package/XEX core is not initialized');
  const runtime=bootstrap??await loadRender360Bootstrap({url:bootstrapUrl});
  const {handoffXboxIso}=await import('./render360-iso-title-controller.mjs');
  const executeDuringTranslation=productionThreadedExecution?false:(options.executeDuringTranslation??true);
  const result=await handoffXboxIso({core,bootstrap:runtime,isoSource:file,scanEntryFunction,executeDuringTranslation,...options});
  if(!productionThreadedExecution)return {bootstrap:runtime,result};

  if(result.compatibilityExecution?.used){
    const compatibility=result.compatibilityExecution;
    const completed=(result.executionStatus>>>0)===3;
    const schedulerBlocker=completed?null:{
      kind:'native-hir-compatibility-boundary',
      entry:result.entry>>>0,
      message:`Native HIR compatibility execution stopped at ${result.runtimeBoundary}`,
      executionStatus:result.executionStatus>>>0,
      executionInstructions:result.executionInstructions>>>0,
      reachedKernelBlocker:result.reachedKernelBlocker??null,
    };
    result.commercialCpu={
      mode:'native-hir-compatibility-fallback',
      translationSideEffects:true,
      primaryThread:null,
      firstPump:null,
      blocker:schedulerBlocker,
      callableFunctionCount:0,
      compatibility,
      schedulerContract:guestThreadSchedulerContract(),
    };
    return {bootstrap:runtime,result,ppcSession:null,threadScheduler:null,primaryThread:null,schedulerReport:null,schedulerBlocker};
  }

  const generatedFunctionCount=(pick(runtime.exports,'r360_wasm_backend_call_function_count')?.()??0)>>>0;
  if(!generatedFunctionCount){
    console.warn(`[Render360] Generated-WASM emitter produced 0 callable functions for 0x${(result.entry>>>0).toString(16)}; forcing native HIR compatibility execution`);
    const fallbackResult=await handoffXboxIso({core,bootstrap:runtime,isoSource:file,scanEntryFunction,executeDuringTranslation:true,executeHirCompatibilityFallback:false,...options});
    const completed=(fallbackResult.executionStatus>>>0)===3;
    const schedulerBlocker=completed?null:{
      kind:'native-hir-compatibility-boundary',
      entry:fallbackResult.entry>>>0,
      message:`Native HIR compatibility execution stopped at ${fallbackResult.runtimeBoundary}`,
      executionStatus:fallbackResult.executionStatus>>>0,
      executionInstructions:fallbackResult.executionInstructions>>>0,
      reachedKernelBlocker:fallbackResult.reachedKernelBlocker??null,
    };
    fallbackResult.compatibilityExecution={
      used:true,
      reason:'forced-native-hir-after-empty-generated-wasm',
      entry:fallbackResult.entry>>>0,
      executionStatus:fallbackResult.executionStatus>>>0,
      executionInstructions:fallbackResult.executionInstructions>>>0,
      runtimeBoundary:fallbackResult.runtimeBoundary,
      reachedKernelBlocker:fallbackResult.reachedKernelBlocker??null,
    };
    fallbackResult.commercialCpu={
      mode:'native-hir-compatibility-fallback',
      translationSideEffects:true,
      primaryThread:null,
      firstPump:null,
      blocker:schedulerBlocker,
      callableFunctionCount:0,
      compatibility:fallbackResult.compatibilityExecution,
      schedulerContract:guestThreadSchedulerContract(),
    };
    return {bootstrap:runtime,result:fallbackResult,ppcSession:null,threadScheduler:null,primaryThread:null,schedulerReport:null,schedulerBlocker};
  }

  const resetRuntime=pick(runtime.exports,'r360_kernel_runtime_reset');
  resetRuntime();
  let ppcSession=null;
  let threadScheduler=null;
  let primaryThread=null;
  let schedulerReport=null;
  let schedulerBlocker=null;
  try{
    ppcSession=await createPersistentPpcSession({bootstrap:runtime,clearContext:true});
    if(!ppcSession.functionCount)throw new Error(`No callable generated WASM function was registered for title entry 0x${(result.entry>>>0).toString(16)}`);
    threadScheduler=await createGuestThreadScheduler({bootstrap:runtime,session:ppcSession,maxSlicesPerPump:1});
    primaryThread=threadScheduler.createThread({entry:result.entry>>>0,context:primaryThreadContext>>>0,stackSize:primaryThreadStackSize>>>0,flags:primaryThreadFlags>>>0});
    schedulerReport=await threadScheduler.pumpOnce({maxSlices:1});
    if(!schedulerReport.slices.length)throw new Error('Native guest-thread scheduler found no runnable title entry');
    result.runtimeBoundary=schedulerReport.slices[0]?.terminated?'primary-thread-return':'cooperative-thread-boundary';
  }catch(error){
    schedulerBlocker={
      kind:'commercial-cpu-scheduler-blocker',
      entry:result.entry>>>0,
      message:error?.message||String(error),
      translatedFunctionCount:result.translatedFunctionCount>>>0,
      callableFunctionCount:ppcSession?.functionCount??0,
      scheduler:threadScheduler?.inspect?.()??null,
    };
    result.runtimeBoundary='commercial-cpu-scheduler-blocked';
  }
  result.commercialCpu={
    mode:'translation-only-then-native-thread-scheduler',
    translationSideEffects:false,
    primaryThread,
    firstPump:schedulerReport,
    blocker:schedulerBlocker,
    callableFunctionCount:ppcSession?.functionCount??0,
    schedulerContract:threadScheduler?.contract??guestThreadSchedulerContract(),
  };
  return {bootstrap:runtime,result,ppcSession,threadScheduler,primaryThread,schedulerReport,schedulerBlocker};
}

export function browserTitleRuntimeContract(){return {
  bootstrapUrl:PPC_BOOTSTRAP_URL,
  bootstrapMetadataUrl:PPC_BOOTSTRAP_META_URL,
  bootstrapIntegrity:'SHA-256 + byte count + source commit/run',
  singletonBootstrap:true,
  requiredExports:[...REQUIRED_BOOTSTRAP_EXPORTS],
  input:'File/Blob XDVDFS ISO',
  wholeIsoCopy:false,
  browserWasiHost:true,
  growablePreparedPeStaging:true,
  maxPreparedPeStagingBytes:256*1024*1024,
  titleEntryTranslation:'Xenia-scanned executable PE function, side-effect-free first',
  titleEntryExecution:'persistent generated WASM, with native HIR compatibility fallback when the emitter has no callable entry',
  persistentCpuSession:persistentPpcSessionContract(),
  guestThreadScheduler:guestThreadSchedulerContract(),
  preemptionBoundary:'guest-function-return',
  midFunctionPreemption:false,
  fullXboxThreadScheduler:false,
  titleGpu:'native circular PM4 ring + upstream Xenia interpreter + Xenos-to-SPIR-V accelerator',
  realFrontbuffer:'VdSwap fetch constant + mapped sparse Xbox memory',
  titleHle:'native WASM PPC ABI + sparse guest RAM + Xenos ring capture',
  legacyHleFallback:true,
};}
