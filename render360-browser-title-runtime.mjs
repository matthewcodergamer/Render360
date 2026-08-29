import {installRender360Buffer} from './render360-byte-buffer.mjs?v=44.1';
import {createRender360BrowserImports,attachRender360BrowserInstance,validateRender360BrowserImports} from './render360-browser-wasi.mjs?v=44.1';
import {createPersistentPpcSession,persistentPpcSessionContract} from './render360-browser-ppc-session.mjs?v=44.1';
import {createGuestThreadScheduler,guestThreadSchedulerContract} from './render360-browser-thread-scheduler.mjs?v=44.1';
installRender360Buffer();

const REQUIRED_BOOTSTRAP_EXPORTS=[
  'memory','r360_ppc_probe_load_at','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity',
  'r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status',
  'r360_ppc_probe_set_execute_on_translate','r360_ppc_probe_execute_on_translate',
  'r360_ppc_context_size','r360_ppc_context_offset_gpr','r360_ppc_context_offset_lr','r360_ppc_context_offset_ctr',
  'r360_wasm_backend_call_status','r360_wasm_backend_call_function_count','r360_wasm_backend_call_function_address',
  'r360_wasm_backend_call_function_generation','r360_wasm_backend_call_module_ptr','r360_wasm_backend_call_module_size',
  'r360_wasm_backend_call_lowered_instructions','r360_wasm_backend_call_context_ptr',
  'r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_xex_guest_mapper_reserve_input','r360_xex_guest_mapper_input_max_capacity',
  'r360_pe_guest_load','r360_pe_guest_entry_address','r360_title_handoff_translate_entry','r360_title_handoff_translate_scanned_entry',
  'r360_kernel_import_register','r360_kernel_service_call','r360_kernel_runtime_reset',
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

export async function loadRender360Bootstrap({url='./xenia_ppc_bootstrap.wasm?v=44.1',fetchImpl=globalThis.fetch,onStdout=null,onStderr=null}={}){
  if(typeof WebAssembly!=='object')throw new Error('WebAssembly is unavailable');
  if(typeof fetchImpl!=='function')throw new Error('fetch is unavailable');
  const response=await fetchImpl(url,{cache:'no-store'});
  if(!response?.ok)throw new Error(`Render360 bootstrap fetch failed: HTTP ${response?.status??0}`);
  const host=createRender360BrowserImports({onStdout,onStderr});
  let module,instance;
  try{
    const result=await WebAssembly.instantiateStreaming(response.clone(),host.imports);
    module=result.module;instance=result.instance;
  }catch(streamError){
    const bytes=await response.arrayBuffer();
    module=await WebAssembly.compile(bytes);
    try{instance=await WebAssembly.instantiate(module,host.imports);}catch(error){throw new Error(`Render360 bootstrap instantiate failed: ${error?.message||error}; streaming error: ${streamError?.message||streamError}`);}
  }
  validateRender360BrowserImports(module);
  attachRender360BrowserInstance(host,instance);
  validateBrowserBootstrap(instance);
  return instance;
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
  const {mountXdvdfs}=await import('./render360-xdvdfs.mjs?v=44.1');
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
  bootstrapUrl='./xenia_ppc_bootstrap.wasm?v=44.1',
  scanEntryFunction=true,
  productionThreadedExecution=true,
  primaryThreadContext=0,
  primaryThreadStackSize=0x80000,
  primaryThreadFlags=0,
  ...options
}){
  if(!core?.exports)throw new Error('Render360 package/XEX core is not initialized');
  const runtime=bootstrap??await loadRender360Bootstrap({url:bootstrapUrl});
  const {handoffXboxIso}=await import('./render360-iso-title-controller.mjs?v=44.1');
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
  bootstrapUrl:'./xenia_ppc_bootstrap.wasm?v=44.1',
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