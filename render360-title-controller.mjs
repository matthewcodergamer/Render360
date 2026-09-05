import { prepareRetailXexImage } from './retail-xex-image-pipeline.mjs';
import { decodeXexImportLibraries } from './render360-xex-imports.mjs';
import { buildKernelImportPlan } from './render360-kernel-imports.mjs';
import { installBrowserTitleHle, readBrowserTitleHleTelemetry } from './render360-browser-title-hle.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const pick=(bootstrap,n)=>bootstrap.exports[n]??bootstrap.exports[`_${n}`];
const maybe=(bootstrap,n)=>typeof pick(bootstrap,n)==='function'?pick(bootstrap,n):null;
const moduleId=name=>name.toLowerCase()==='xboxkrnl.exe'?1:name.toLowerCase()==='xam.xex'?2:0;
const XEX_HEADER_ENTRY_POINT=0x00010100;

function readXexEntryPoint(xex,headerSize){
  const count=be32(xex,0x14);
  if(headerSize<0x18||count>((headerSize-0x18)>>>3))throw new Error('XEX optional-header table out of bounds');
  for(let i=0,p=0x18;i<count;i++,p+=8){
    if(be32(xex,p)!==XEX_HEADER_ENTRY_POINT)continue;
    const entry=be32(xex,p+4);
    if(!entry)throw new Error('XEX entry point is zero');
    return entry>>>0;
  }
  throw new Error('XEX entry point optional header missing');
}

function hasNativeTitleGpuRuntime(bootstrap){
  return ['r360_title_gpu_ring_base','r360_title_gpu_ring_size_log2','r360_title_gpu_ring_bytes','r360_title_gpu_ring_word_capacity','r360_title_gpu_write_pointer','r360_title_gpu_status'].every(n=>!!maybe(bootstrap,n));
}

function readNativeTitleGpuTelemetry(bootstrap,entry){
  if(!hasNativeTitleGpuRuntime(bootstrap))return null;
  const get=n=>maybe(bootstrap,n)?.()>>>0;
  const ringBase=get('r360_title_gpu_ring_base');
  const ringSizeLog2=get('r360_title_gpu_ring_size_log2');
  const ringBytes=get('r360_title_gpu_ring_bytes');
  const ringWordCapacity=get('r360_title_gpu_ring_word_capacity');
  const writePointer=get('r360_title_gpu_write_pointer');
  const rptrWriteback=get('r360_title_gpu_rptr_writeback');
  const rptrBlockSizeLog2=get('r360_title_gpu_rptr_block_size_log2');
  const mmioWrites=get('r360_title_gpu_mmio_writes');
  const status=get('r360_title_gpu_status');
  const windowEnd=BigInt(entry>>>0)+65536n;
  const ringInActiveWindow=!!ringBase&&ringBase>=(entry>>>0)&&BigInt(ringBase)+BigInt(Math.max(4,ringBytes||4))<=windowEnd;
  return {kind:'native-wasm-title-gpu-runtime',ringInitialized:!!ringBase,ringBase,ringSizeLog2,ringBytes,ringWordCapacity,writePointer,rptrWriteback,rptrBlockSizeLog2,mmioWrites,status,ringInActiveWindow,producerObserved:status>=2&&writePointer>0};
}

function registerKernelImportPlan(bootstrap,kernelImports){
  const reset=maybe(bootstrap,'r360_kernel_import_reset');
  const register=maybe(bootstrap,'r360_kernel_import_register');
  if(!reset||!register)return {registered:0,available:false};
  reset();let registered=0;
  for(const item of kernelImports.plan){
    if(!item.isKernelModule||item.kind!=='function'||!item.thunkAddress)continue;
    const id=moduleId(item.module);if(!id)continue;
    const impl=item.implementation;
    const implemented=!!impl;
    const abiTarget=implemented?(typeof impl==='object'&&impl!==null&&'r3' in impl?Number(impl.r3)>>>0:0):0;
    if((register(item.thunkAddress>>>0,id,item.ordinal>>>0,implemented?1:0,abiTarget)>>>0)!==1)throw new Error(`failed to register kernel import ${item.module} ordinal 0x${item.ordinal.toString(16)}`);
    registered++;
  }
  return {registered,available:true};
}

function applyInitialGprs(bootstrap,initialGprs){
  const entries=initialGprs instanceof Map?[...initialGprs.entries()]:Array.isArray(initialGprs)?initialGprs.map((v,i)=>[i,v]):Object.entries(initialGprs??{});
  if(!entries.length)return 0;
  const set=maybe(bootstrap,'r360_ppc_probe_set_initial_gpr');if(!set)throw new Error('missing startup GPR export');let applied=0;
  for(const [rawIndex,rawValue] of entries){if(rawValue===undefined||rawValue===null)continue;const index=Number(rawIndex);if(!Number.isInteger(index)||index<0||index>=32)throw new RangeError(`invalid startup GPR index ${rawIndex}`);const value=BigInt.asUintN(64,BigInt(rawValue));if((set(index,value)>>>0)!==1)throw new Error(`failed to set startup GPR r${index}`);applied++;}
  return applied;
}

function prepareBrowserMainThreadContext(bootstrap,entry){
  const alloc=maybe(bootstrap,'r360_sparse_guest_memory_alloc');
  const map=maybe(bootstrap,'r360_sparse_guest_memory_map');
  const write8=maybe(bootstrap,'r360_sparse_guest_memory_write_u8');
  if(!alloc||!map||!write8)throw new Error('published browser bootstrap is missing sparse guest-memory main-thread support');

  // Match the important parts of Xenia's real ThreadState/XThread startup.
  // Xbox user stacks live in 0x70000000-0x7F000000 and r13 points at the
  // per-thread PCR. The fallback used to enter the XEX with every GPR zero.
  const pageSize=4096;
  const stackSlotBase=0x70000000;
  const stackGuardBytes=pageSize;
  const stackLimit=(stackSlotBase+stackGuardBytes)>>>0;
  const stackPages=128;
  // Xenia ThreadState starts r1 at the high stack boundary. Processor::Execute
  // then reserves 64 + 112 bytes before entering guest code. We previously
  // entered default.xex with an invented -0x100 stack pointer, which is not the
  // Xenia/Xbox entry ABI and can make title prologues consume zeroed slots.
  const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0;
  const xeniaCallFrameBytes=64+112;
  const xeniaInitialLr=0xBCBCBCBC;
  const stackTop=(stackBasePointer-xeniaCallFrameBytes)&~0xF;
  const pcrAddress=0x50000000;
  const tlsAddress=0x50001000;
  const threadAddress=0x50002000;
  const contextPages=3;
  const readWrite=3;

  // Compatibility fallback for the native-HIR title path. Braid's current
  // startup load is `lwz r11,0x46C0(r31)` while r31 is still zero, so its
  // effective address is 0x000046C0. The previous workaround mapped only one
  // 4 KiB page (0x0000-0x0FFF), leaving that exact address unmapped. Keep this
  // workaround bounded to Xenia's first 64 KiB low-memory region rather than
  // turning sparse memory into an unrestricted low-address alias.
  const lowMemoryPages=0x10000/pageSize;
  const lowMemoryBacking=alloc(lowMemoryPages)>>>0;
  if(!lowMemoryBacking||(map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map title low-memory compatibility aperture');

  const stackBacking=alloc(stackPages)>>>0;
  if(!stackBacking||(map(stackLimit,stackPages,stackBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread stack');
  const contextBacking=alloc(contextPages)>>>0;
  if(!contextBacking||(map(pcrAddress,contextPages,contextBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread PCR/TLS');

  const be32=(address,value)=>{
    const v=Number(value)>>>0;
    for(let i=0;i<4;i++){
      if((write8((address+i)>>>0,(v>>>(24-i*8))&0xFF)>>>0)!==1){
        throw new Error(`unable to initialize Xbox thread memory @ 0x${(address+i).toString(16)}`);
      }
    }
  };

  be32(pcrAddress+0x000,tlsAddress);
  be32(pcrAddress+0x030,pcrAddress);
  be32(pcrAddress+0x070,stackBasePointer);
  be32(pcrAddress+0x074,stackLimit);
  be32(pcrAddress+0x100,threadAddress);
  be32(pcrAddress+0x150,0);

  be32(threadAddress+0x05C,stackBasePointer);
  be32(threadAddress+0x060,stackLimit);
  be32(threadAddress+0x068,tlsAddress);
  be32(threadAddress+0x0D0,stackBasePointer);
  be32(threadAddress+0x14C,1);
  be32(threadAddress+0x150,entry>>>0);

  return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,xeniaInitialLr,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};
}

function stagePreparedPeImage(bootstrap,prepared,xexEntry){
  const inputBuffer=pick(bootstrap,'r360_xex_guest_mapper_input_buffer');
  const inputCapacity=pick(bootstrap,'r360_xex_guest_mapper_input_capacity');
  let input=inputBuffer()>>>0;
  let cap=inputCapacity()>>>0;
  let stagingGrew=false;

  if(prepared.length>cap){
    const reserve=maybe(bootstrap,'r360_xex_guest_mapper_reserve_input');
    const maxCapacity=maybe(bootstrap,'r360_xex_guest_mapper_input_max_capacity');
    const max=maxCapacity?(maxCapacity()>>>0):0;
    if(!reserve){
      throw new Error(`published browser bootstrap cannot grow PE staging for prepared image ${prepared.length}/${cap}; refresh to the synchronized runtime`);
    }
    if(max&&prepared.length>max){
      throw new Error(`prepared image exceeds bounded PE staging ceiling ${prepared.length}/${max}`);
    }
    if((reserve(prepared.length)>>>0)!==1){
      const status=maybe(bootstrap,'r360_xex_guest_mapper_status')?.()>>>0;
      throw new Error(`unable to reserve PE staging for prepared image ${prepared.length} bytes (status 0x${(status||0).toString(16)})`);
    }
    // ALLOW_MEMORY_GROWTH may replace memory.buffer and realloc may move the
    // native staging pointer. Never retain either view across the reserve.
    input=inputBuffer()>>>0;
    cap=inputCapacity()>>>0;
    stagingGrew=true;
  }

  if(!input||prepared.length>cap)throw new Error(`prepared image exceeds current PE staging capacity ${prepared.length}/${cap}`);
  new Uint8Array(bootstrap.exports.memory.buffer,input,prepared.length).set(prepared);
  if((pick(bootstrap,'r360_pe_guest_load_at_entry')(input,prepared.length,xexEntry>>>0)>>>0)!==1)throw new Error(`prepared PE guest load failed 0x${(pick(bootstrap,'r360_pe_guest_status')()>>>0).toString(16)}`);
  return {input,capacity:cap,stagingGrew};
}

export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,scanEntryFunction=false,implementedKernelExports={},initialGprs={},installDefaultBrowserHle=true,prepareMainThreadContext=false}){
  const xex=Buffer.from(defaultXex);
  if(xex.length<0x18||xex.toString('ascii',0,4)!=='XEX2')throw new Error('default.xex is not XEX2');
  const headerSize=be32(xex,8);
  if(headerSize<0x18||headerSize>xex.length)throw new Error('default.xex header size out of bounds');
  const xexEntry=readXexEntryPoint(xex,headerSize);
  const importedLibraries=decodeXexImportLibraries(xex);
  const header=xex.subarray(0,headerSize),body=xex.subarray(headerSize);
  const prepared=await prepareRetailXexImage({core,bootstrap,header,body,encryptedSecurityKey,useDevkitKey});

  for(const n of ['r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_load_at_entry','r360_pe_guest_status','r360_pe_guest_entry_address','r360_pe_guest_pe_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_title_handoff_hir_instructions'])if(typeof pick(bootstrap,n)!=='function')throw new Error(`missing title-controller export ${n}`);
  const peStage=stagePreparedPeImage(bootstrap,prepared,xexEntry);
  const entry=pick(bootstrap,'r360_pe_guest_entry_address')()>>>0;
  const peEntry=pick(bootstrap,'r360_pe_guest_pe_entry_address')()>>>0;
  if(entry!==xexEntry)throw new Error(`XEX entry selection mismatch 0x${entry.toString(16)}/0x${xexEntry.toString(16)}`);
  if(peEntry!==entry)console.info(`[Render360] Xenia entry parity: XEX optional entry 0x${entry.toString(16).toUpperCase()} overrides PE entry 0x${peEntry.toString(16).toUpperCase()}`);

  // Modern bootstraps route decoded real-title imports through the live PPC
  // context directly into the native WASM kernel/Xenos service layer. Keep the
  // relocated PPC shim implementation only for older published bootstraps that
  // do not expose the native title-GPU runtime yet.
  const nativeTitleGpu=hasNativeTitleGpuRuntime(bootstrap);
  const browserHle=!nativeTitleGpu&&installDefaultBrowserHle?installBrowserTitleHle({bootstrap,entry}):null;
  const effectiveKernelExports=browserHle?{...browserHle.implementedKernelExports,...implementedKernelExports}:implementedKernelExports;
  const kernelImports=buildKernelImportPlan(xex,prepared,{implementedExports:effectiveKernelExports});
  const kernelRegistration=registerKernelImportPlan(bootstrap,kernelImports);

  pick(bootstrap,'r360_title_handoff_reset')();
  if(prepareMainThreadContext){const warm=maybe(bootstrap,'r360_ppc_probe_page_sparse_code');if(typeof warm==='function'&&(warm(entry)>>>0)===0)throw new Error('unable to initialize Xenia title decoder before main-thread context');pick(bootstrap,'r360_title_handoff_reset')();}
  const mainThreadContext=prepareMainThreadContext?prepareBrowserMainThreadContext(bootstrap,entry):null;
  let startupGprCount=0;
  if(mainThreadContext){
    // R360_XENIA_ENTRY_ABI_V51: match upstream Processor::Execute special state.
    const setInitialLr=maybe(bootstrap,'r360_ppc_probe_set_initial_lr');
    const readInitialLr=maybe(bootstrap,'r360_ppc_probe_initial_lr');
    if(!setInitialLr||!readInitialLr)throw new Error('published browser bootstrap is missing Xenia initial-LR support');
    if((setInitialLr(BigInt(mainThreadContext.xeniaInitialLr))>>>0)!==1)throw new Error('unable to initialize Xenia title-entry LR');
    if(Number(readInitialLr()&0xFFFFFFFFn)!==(mainThreadContext.xeniaInitialLr>>>0))throw new Error('Xenia title-entry LR verification failed');
    startupGprCount+=applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress});
  }
  startupGprCount+=applyInitialGprs(bootstrap,initialGprs);
  const scannedEntry=maybe(bootstrap,'r360_title_handoff_translate_scanned_entry');
  if(scanEntryFunction&&!scannedEntry)throw new Error('browser bootstrap is missing scanned title-entry execution');
  const hir=scanEntryFunction?(scannedEntry()>>>0):(pick(bootstrap,'r360_title_handoff_translate_entry')(entryBytes)>>>0);
  const entryExecutionMode=scanEntryFunction?'xenia-scanned-entry-function':'bounded-entry-byte-probe';
  if(!hir){
    const handoffStatus=pick(bootstrap,'r360_title_handoff_status')()>>>0;
    const probeStatus=maybe(bootstrap,'r360_ppc_probe_status')?.()>>>0||0;
    const scanDiagnostic=maybe(bootstrap,'r360_ppc_probe_scan_diagnostic')?.()>>>0||0;
    const scanAddress=maybe(bootstrap,'r360_ppc_probe_scan_address')?.()>>>0||0;
    const scanWindowEnd=maybe(bootstrap,'r360_ppc_probe_scan_window_end')?.()>>>0||0;
    const scanFunctionEnd=maybe(bootstrap,'r360_ppc_probe_scan_function_end')?.()>>>0||0;
    const scanHir=maybe(bootstrap,'r360_ppc_probe_scan_hir_instructions')?.()>>>0||0;
    const assembledFunctions=maybe(bootstrap,'r360_ppc_probe_assembled_functions')?.()>>>0||0;
    const hirBlocks=maybe(bootstrap,'r360_ppc_probe_hir_block_count')?.()>>>0||0;
    const scanReason=['idle','guard-rejected','scanner-failed','define-function-failed','zero-hir','translated'][scanDiagnostic]||'unknown';
    const hex=value=>`0x${(value>>>0).toString(16).toUpperCase()}`;
    const error=new Error(`title entry handoff failed ${hex(handoffStatus)} mode=${entryExecutionMode} scan=${scanReason}(${scanDiagnostic}) probe=${hex(probeStatus)} entry=${hex(entry)} scanAddress=${hex(scanAddress)} scanWindowEnd=${hex(scanWindowEnd)} scanFunctionEnd=${hex(scanFunctionEnd)} assembledFunctions=${assembledFunctions} hirBlocks=${hirBlocks} scanHIR=${scanHir}`);
    error.code='R360_TITLE_ENTRY_HANDOFF_FAILED';
    error.render360={kind:'ppc-entry-translation-failure',handoffStatus,probeStatus,scanDiagnostic,scanReason,scanAddress,scanWindowEnd,scanFunctionEnd,assembledFunctions,hirBlocks,scanHir,entry:entry>>>0,entryExecutionMode};
    throw error;
  }

  const execStatusFn=maybe(bootstrap,'r360_ppc_probe_correctness_status');
  const execInstructionsFn=maybe(bootstrap,'r360_ppc_probe_correctness_instructions');
  const execR3Fn=maybe(bootstrap,'r360_ppc_probe_correctness_r3');
  const execBlockerKindFn=maybe(bootstrap,'r360_ppc_probe_correctness_blocker_kind');
  const execBlockerOpcodeFn=maybe(bootstrap,'r360_ppc_probe_correctness_blocker_opcode');
  const execBlockerAddressFn=maybe(bootstrap,'r360_ppc_probe_correctness_blocker_address');
  const callCountFn=maybe(bootstrap,'r360_wasm_backend_call_function_count');
  const callAddressFn=maybe(bootstrap,'r360_wasm_backend_call_function_address');
  const kernelCallsFn=maybe(bootstrap,'r360_kernel_import_calls');
  const kernelLastThunkFn=maybe(bootstrap,'r360_kernel_import_last_thunk');
  const kernelLastModuleFn=maybe(bootstrap,'r360_kernel_import_last_module');
  const kernelLastOrdinalFn=maybe(bootstrap,'r360_kernel_import_last_ordinal');
  const kernelLastStatusFn=maybe(bootstrap,'r360_kernel_import_last_status');
  const executionStatus=execStatusFn?(execStatusFn()>>>0):0;
  const executionInstructions=execInstructionsFn?(execInstructionsFn()>>>0):0;
  const executionR3Hex=execR3Fn?`0x${BigInt.asUintN(64,execR3Fn()).toString(16)}`:'0x0';
  const executionBlockerKind=execBlockerKindFn?(execBlockerKindFn()>>>0):0;
  const executionBlockerOpcode=execBlockerOpcodeFn?(execBlockerOpcodeFn()>>>0):0;
  const executionBlockerAddress=execBlockerAddressFn?(execBlockerAddressFn()>>>0):0;
  // Snapshot sparse-memory failure state immediately after native HIR returns.
  // Any later successful diagnostic/code/GPU read clears SparseGuestMemory's
  // global last-fault latch, so delayed UI inspection is not authoritative.
  const memoryFaultAddressFn=maybe(bootstrap,'r360_sparse_guest_memory_last_fault_address');
  const memoryFaultCodeFn=maybe(bootstrap,'r360_sparse_guest_memory_last_fault_code');
  const memoryFaultAddress=memoryFaultAddressFn?(memoryFaultAddressFn()>>>0):0;
  const memoryFaultCode=memoryFaultCodeFn?(memoryFaultCodeFn()>>>0):0;
  const stackTraceRead=(name,...args)=>{const f=maybe(bootstrap,name);return f?(f(...args)>>>0):undefined;};
  const stackTrace={
    blockerR1:stackTraceRead('r360_ppc_probe_stack_blocker_r1'),
    initialR1:stackTraceRead('r360_ppc_probe_stack_initial_r1'),
    lastWriteAddress:stackTraceRead('r360_ppc_probe_stack_last_write_address'),
    lastOldR1:stackTraceRead('r360_ppc_probe_stack_last_old_r1'),
    lastNewR1:stackTraceRead('r360_ppc_probe_stack_last_new_r1'),
    lastWriteDepth:stackTraceRead('r360_ppc_probe_stack_last_write_depth'),
    lastCallSource:stackTraceRead('r360_ppc_probe_stack_last_call_source'),
    lastCallTarget:stackTraceRead('r360_ppc_probe_stack_last_call_target'),
    lastCallR1:stackTraceRead('r360_ppc_probe_stack_last_call_r1'),
    lastCallDepth:stackTraceRead('r360_ppc_probe_stack_last_call_depth'),
  };
  const stackWriteCount=Math.min(stackTraceRead('r360_ppc_probe_stack_write_count')??0,32);
  const stackCallCount=Math.min(stackTraceRead('r360_ppc_probe_stack_call_count')??0,32);
  stackTrace.writeHistory=Array.from({length:stackWriteCount},(_,index)=>({
    sequence:stackTraceRead('r360_ppc_probe_stack_write_sequence',index),
    address:stackTraceRead('r360_ppc_probe_stack_write_address',index),
    oldR1:stackTraceRead('r360_ppc_probe_stack_write_old_r1',index),
    newR1:stackTraceRead('r360_ppc_probe_stack_write_new_r1',index),
    depth:stackTraceRead('r360_ppc_probe_stack_write_depth',index),
  }));
  stackTrace.callHistory=Array.from({length:stackCallCount},(_,index)=>({
    sequence:stackTraceRead('r360_ppc_probe_stack_call_sequence',index),
    source:stackTraceRead('r360_ppc_probe_stack_call_source',index),
    target:stackTraceRead('r360_ppc_probe_stack_call_target',index),
    r1:stackTraceRead('r360_ppc_probe_stack_call_r1',index),
    depth:stackTraceRead('r360_ppc_probe_stack_call_depth',index),
    flags:stackTraceRead('r360_ppc_probe_stack_call_flags',index),
  }));
  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;
  const firstTranslatedFunction=callAddressFn&&translatedFunctionCount?(callAddressFn(0)>>>0):0;
  const kernelCalls=kernelCallsFn?(kernelCallsFn()>>>0):0;
  const kernelLastThunk=kernelLastThunkFn?(kernelLastThunkFn()>>>0):0;
  const kernelLastModuleId=kernelLastModuleFn?(kernelLastModuleFn()>>>0):0;
  const kernelLastOrdinal=kernelLastOrdinalFn?(kernelLastOrdinalFn()>>>0):0;
  const kernelLastStatus=kernelLastStatusFn?(kernelLastStatusFn()>>>0):0;
  const reachedKernelModule=kernelLastModuleId===1?'xboxkrnl.exe':kernelLastModuleId===2?'xam.xex':null;
  const runtimeBoundary=executionStatus===3?'guest-return':kernelLastStatus===2?'kernel-import-unimplemented':kernelLastStatus===3?'kernel-import-abi-failed':executionStatus===2?'no-return-boundary':executionStatus===1?(executionBlockerKind===2?'unresolved-guest-call':executionBlockerKind===3?'instruction-limit':executionBlockerKind===5?'guest-memory-dependency':'unsupported-hir'):'execution-not-observed';
  const firstKernelBlocker=kernelImports.firstKernelBlocker?{module:kernelImports.firstKernelBlocker.module,ordinal:kernelImports.firstKernelBlocker.ordinal,kind:kernelImports.firstKernelBlocker.kind,valueAddress:kernelImports.firstKernelBlocker.valueAddress,thunkAddress:kernelImports.firstKernelBlocker.thunkAddress}:null;
  const reachedKernelBlocker=kernelLastStatus===2?{module:reachedKernelModule,ordinal:kernelLastOrdinal,thunkAddress:kernelLastThunk}:null;
  const titleGpuTelemetry=nativeTitleGpu?readNativeTitleGpuTelemetry(bootstrap,entry):null;
  const browserHleTelemetry=browserHle?readBrowserTitleHleTelemetry({bootstrap,hle:browserHle}):null;
  const browserHleSummary=browserHle?{kind:'relocated-ppc-abi-shims',windowBase:browserHle.windowBase,windowBytes:browserHle.windowBytes,addresses:browserHle.addresses,telemetryAddresses:browserHle.telemetryAddresses}:null;

  return {headerSize,preparedBytes:prepared.length,peStagingCapacity:peStage.capacity,peStagingGrew:peStage.stagingGrew,entry,xexEntry,peEntry,entrySource:'xex-optional-header',hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0,entryExecutionMode,startupGprCount,mainThreadContext,executionStatus,executionInstructions,executionR3Hex,executionBlockerKind,executionBlockerOpcode,executionBlockerAddress,memoryFaultAddress,memoryFaultCode,stackTrace,translatedFunctionCount,firstTranslatedFunction,runtimeBoundary,importedLibraries,kernelImports,kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelCalls,kernelLastStatus,reachedKernelBlocker,firstKernelBlocker,titleGpuTelemetry,browserHle:browserHleSummary,browserHleTelemetry};
}