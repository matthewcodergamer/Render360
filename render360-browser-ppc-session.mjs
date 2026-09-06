const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];
const requiredFunction=(bootstrap,name)=>{
  const fn=pick(bootstrap,name);
  if(typeof fn!=='function')throw new Error(`Persistent PPC session missing bootstrap export ${name}`);
  return fn;
};

function normalizeGprs(initialGprs){
  if(initialGprs instanceof Map)return [...initialGprs.entries()];
  if(Array.isArray(initialGprs))return initialGprs.map((value,index)=>[index,value]);
  return Object.entries(initialGprs??{});
}

/**
 * Persistent browser-side execution session for Xenia-generated guest-function
 * WASM modules.
 *
 * The lightweight callable emitter executes complete guest functions. The
 * integer CFG fallback additionally supports browser-safe mid-function resume:
 * when its block-dispatch fuel expires, generated WASM saves the dispatcher PC
 * and all live integer HIR locals into a per-thread continuation slot and
 * returns to JavaScript without claiming a guest return. The next slice restores
 * that exact state and continues against the same Xenia PPCContext.
 *
 * This is deliberately fail-closed outside the admitted CFG tier: arbitrary
 * guest-memory/FPU/VMX/call-heavy functions still remain explicit compatibility
 * boundaries until their generated-WASM lowering gains the same continuation
 * semantics.
 */
export async function createPersistentPpcSession({bootstrap,initialGprs={},clearContext=true}={}){
  if(!(bootstrap?.exports?.memory instanceof WebAssembly.Memory))throw new Error('Persistent PPC session requires bootstrap WebAssembly memory');
  const memory=bootstrap.exports.memory;
  const contextPtrFn=requiredFunction(bootstrap,'r360_wasm_backend_call_context_ptr');
  const contextSizeFn=requiredFunction(bootstrap,'r360_ppc_context_size');
  const gprOffsetFn=requiredFunction(bootstrap,'r360_ppc_context_offset_gpr');
  const lrOffsetFn=requiredFunction(bootstrap,'r360_ppc_context_offset_lr');
  const ctrOffsetFn=requiredFunction(bootstrap,'r360_ppc_context_offset_ctr');
  const countFn=requiredFunction(bootstrap,'r360_wasm_backend_call_function_count');
  const addressFn=requiredFunction(bootstrap,'r360_wasm_backend_call_function_address');
  const generationFn=requiredFunction(bootstrap,'r360_wasm_backend_call_function_generation');
  const modulePtrFn=requiredFunction(bootstrap,'r360_wasm_backend_call_module_ptr');
  const moduleSizeFn=requiredFunction(bootstrap,'r360_wasm_backend_call_module_size');
  const loweredFn=requiredFunction(bootstrap,'r360_wasm_backend_call_lowered_instructions');
  const contentGenerationFn=pick(bootstrap,'r360_wasm_backend_executable_content_generation');
  const cfgStatusFn=pick(bootstrap,'r360_wasm_backend_cfg_status');
  const cfgPtrFn=pick(bootstrap,'r360_wasm_backend_cfg_module_ptr');
  const cfgSizeFn=pick(bootstrap,'r360_wasm_backend_cfg_module_size');
  const cfgLoweredFn=pick(bootstrap,'r360_wasm_backend_cfg_lowered_instructions');
  const cfgSlotCountFn=pick(bootstrap,'r360_wasm_backend_cfg_continuation_slot_count');
  const cfgStateSizeFn=pick(bootstrap,'r360_wasm_backend_cfg_continuation_state_size');
  const cfgStatePtrFn=pick(bootstrap,'r360_wasm_backend_cfg_continuation_ptr');
  const cfgStateStatusFn=pick(bootstrap,'r360_wasm_backend_cfg_continuation_status');
  const cfgStateResetFn=pick(bootstrap,'r360_wasm_backend_cfg_continuation_reset');
  const lastGuestAddressFn=pick(bootstrap,'r360_ppc_probe_last_guest_address');
  const kernelDispatch=pick(bootstrap,'r360_kernel_import_dispatch_context');
  const kernelLastStatus=pick(bootstrap,'r360_kernel_import_last_status');
  const kernelLastModule=pick(bootstrap,'r360_kernel_import_last_module');
  const kernelLastOrdinal=pick(bootstrap,'r360_kernel_import_last_ordinal');
  const generatedGuestLoad=requiredFunction(bootstrap,'r360_generated_guest_load_scalar');
  const generatedGuestLoadStatus=requiredFunction(bootstrap,'r360_generated_guest_load_status');
  const sparseFaultAddress=pick(bootstrap,'r360_sparse_guest_memory_last_fault_address');
  const sparseFaultCode=pick(bootstrap,'r360_sparse_guest_memory_last_fault_code');

  const contextPtr=contextPtrFn()>>>0;
  const contextSize=contextSizeFn()>>>0;
  const gprOffset=gprOffsetFn()>>>0;
  const lrOffset=lrOffsetFn()>>>0;
  const ctrOffset=ctrOffsetFn()>>>0;
  if(!contextPtr||!contextSize||gprOffset+32*8>contextSize||lrOffset+8>contextSize||ctrOffset+8>contextSize){
    throw new Error(`Invalid Xenia PPCContext ABI ptr=0x${contextPtr.toString(16)} size=${contextSize}`);
  }

  const hasCfgContinuation=[cfgSlotCountFn,cfgStateSizeFn,cfgStatePtrFn,cfgStateStatusFn,cfgStateResetFn].every(fn=>typeof fn==='function');
  let registryKey='';
  let records=new Map();
  let sliceCount=0;
  let yieldedSliceCount=0;
  let nestedDispatches=0;
  let kernelDispatches=0;
  let registryRefreshes=0;
  let cfgFallbackLoads=0;
  let nextCfgSlot=0;
  const cfgContinuations=new Map();
  const compiledModuleCache=new Map();
  const functionExecutions=new Map();
  const hotFunctionThreshold=256;
  let moduleCompileHits=0;
  let moduleCompileMisses=0;

  const bytes=()=>new Uint8Array(memory.buffer,contextPtr,contextSize);
  const view=()=>new DataView(memory.buffer);
  const checkGpr=index=>{if(!Number.isInteger(index)||index<0||index>=32)throw new RangeError(`Invalid PPC GPR index ${index}`);};
  const getGpr=index=>{checkGpr(index);return view().getBigUint64(contextPtr+gprOffset+index*8,true);};
  const setGpr=(index,value)=>{checkGpr(index);view().setBigUint64(contextPtr+gprOffset+index*8,BigInt.asUintN(64,BigInt(value)),true);};
  const getLr=()=>view().getBigUint64(contextPtr+lrOffset,true);
  const setLr=value=>view().setBigUint64(contextPtr+lrOffset,BigInt.asUintN(64,BigInt(value)),true);
  const getCtr=()=>view().getBigUint64(contextPtr+ctrOffset,true);
  const setCtr=value=>view().setBigUint64(contextPtr+ctrOffset,BigInt.asUintN(64,BigInt(value)),true);

  function resetContext(){bytes().fill(0);}
  if(clearContext)resetContext();
  for(const [rawIndex,rawValue] of normalizeGprs(initialGprs)){
    if(rawValue===undefined||rawValue===null)continue;
    setGpr(Number(rawIndex),rawValue);
  }

  function kernelFailureDetail(target){
    if(typeof kernelLastStatus!=='function')return '';
    const status=kernelLastStatus()>>>0;
    const module=typeof kernelLastModule==='function'?kernelLastModule()>>>0:0;
    const ordinal=typeof kernelLastOrdinal==='function'?kernelLastOrdinal()>>>0:0;
    if(!status&&!module&&!ordinal)return '';
    return `_KERNEL_STATUS_${status}_MODULE_${module}_ORDINAL_0x${ordinal.toString(16).toUpperCase()}_TARGET_0x${target.toString(16).toUpperCase()}`;
  }

  function continuationOwner(address,key){
    const normalized=key===undefined||key===null?'default':String(key);
    return `${address>>>0}:${normalized}`;
  }

  function clearContinuationRegistry(){
    if(hasCfgContinuation){
      const count=cfgSlotCountFn()>>>0;
      for(let slot=0;slot<count;slot++)cfgStateResetFn(slot);
    }
    cfgContinuations.clear();
    nextCfgSlot=0;
  }

  function acquireCfgContinuation(address,key){
    if(!hasCfgContinuation)throw new Error('FAIL_CLOSED_CFG_CONTINUATION_ABI_MISSING');
    const owner=continuationOwner(address,key);
    const existing=cfgContinuations.get(owner);
    if(existing)return existing;
    const count=cfgSlotCountFn()>>>0;
    const stateSize=cfgStateSizeFn()>>>0;
    if(!count||!stateSize)throw new Error(`FAIL_CLOSED_CFG_CONTINUATION_LAYOUT_${count}_${stateSize}`);
    if(nextCfgSlot>=count)throw new Error(`FAIL_CLOSED_CFG_CONTINUATION_SLOTS_EXHAUSTED_${count}`);
    const slot=nextCfgSlot++;
    cfgStateResetFn(slot);
    const ptr=cfgStatePtrFn(slot)>>>0;
    if(!ptr||ptr+stateSize>memory.buffer.byteLength)throw new Error(`FAIL_CLOSED_CFG_CONTINUATION_PTR_${slot}_0x${ptr.toString(16)}_${stateSize}`);
    const record={owner,slot,ptr,stateSize};
    cfgContinuations.set(owner,record);
    return record;
  }

  function releaseCfgContinuation(address,key,{reset=true}={}){
    if(!hasCfgContinuation)return;
    const owner=continuationOwner(address,key);
    const record=cfgContinuations.get(owner);
    if(!record)return;
    if(reset)cfgStateResetFn(record.slot);
    cfgContinuations.delete(owner);
  }

  function maybeAppendCfgFallback(descriptors){
    if(typeof cfgStatusFn!=='function'||typeof cfgPtrFn!=='function'||typeof cfgSizeFn!=='function'||typeof cfgLoweredFn!=='function'||typeof lastGuestAddressFn!=='function')return;
    if((cfgStatusFn()>>>0)!==2)return;
    const address=lastGuestAddressFn()>>>0;
    const ptr=cfgPtrFn()>>>0;
    const size=cfgSizeFn()>>>0;
    const lowered=cfgLoweredFn()>>>0;
    if(!address||!ptr||size<=8||!lowered||descriptors.some(x=>x.address===address))return;
    if(!hasCfgContinuation)throw new Error('CFG fallback was generated without resumable continuation exports');
    const generation=typeof contentGenerationFn==='function'?(contentGenerationFn(address)>>>0)||1:1;
    descriptors.push({index:-1,address,generation,ptr,size,lowered,tier:'cfg-fallback'});
  }

  async function refreshFunctions({force=false}={}){
    const count=countFn()>>>0;
    const descriptors=[];
    for(let index=0;index<count;index++){
      const address=addressFn(index)>>>0;
      const generation=generationFn(index)>>>0;
      const ptr=modulePtrFn(index)>>>0;
      const size=moduleSizeFn(index)>>>0;
      const lowered=loweredFn(index)>>>0;
      if(!address||!generation||!ptr||size<=8||!lowered)throw new Error(`Invalid Xenia generated-function record ${index}`);
      descriptors.push({index,address,generation,ptr,size,lowered,tier:'callable'});
    }
    maybeAppendCfgFallback(descriptors);
    const nextKey=descriptors.map(x=>`${x.address.toString(16)}:${x.generation}:${x.ptr}:${x.size}:${x.tier}`).join('|');
    if(!force&&nextKey===registryKey)return {changed:false,count:records.size,key:registryKey};

    const next=new Map();
    for(const descriptor of descriptors){
      const cacheKey=`${descriptor.address}:${descriptor.generation}:${descriptor.size}:${descriptor.lowered}:${descriptor.tier}`;
      let module=compiledModuleCache.get(cacheKey);
      if(module){
        moduleCompileHits++;
        // Refresh LRU order without recompiling the generated guest function.
        compiledModuleCache.delete(cacheKey);compiledModuleCache.set(cacheKey,module);
      }else{
        const moduleBytes=new Uint8Array(memory.buffer,descriptor.ptr,descriptor.size).slice();
        module=await WebAssembly.compile(moduleBytes);
        compiledModuleCache.set(cacheKey,module);
        moduleCompileMisses++;
        while(compiledModuleCache.size>512)compiledModuleCache.delete(compiledModuleCache.keys().next().value);
      }
      next.set(descriptor.address,{...descriptor,module,instance:null,cacheKey});
      if(descriptor.tier==='cfg-fallback')cfgFallbackLoads++;
    }
    const guest_call=(target,ctx)=>{
      target>>>=0;ctx>>>=0;
      if(ctx!==contextPtr)throw new Error(`FAIL_CLOSED_PPC_CONTEXT_MISMATCH_0x${ctx.toString(16)}`);
      const callee=next.get(target);
      if(callee?.instance?.exports?.run){
        nestedDispatches++;
        if(callee.tier==='cfg-fallback'){
          const continuation=acquireCfgContinuation(target,`nested:${target}`);
          callee.instance.exports.run(ctx,continuation.ptr);
          const status=cfgStateStatusFn(continuation.slot)>>>0;
          if(status===2){releaseCfgContinuation(target,`nested:${target}`);return 1;}
          throw new Error(`FAIL_CLOSED_NESTED_CFG_YIELD_0x${target.toString(16).toUpperCase()}_REQUIRES_ASYNC_SCHEDULER`);
        }
        callee.instance.exports.run(ctx);
        return 1;
      }
      if(typeof kernelDispatch==='function'&&(kernelDispatch(target,ctx)>>>0)===1){
        kernelDispatches++;
        return 1;
      }
      throw new Error(`FAIL_CLOSED_UNKNOWN_GUEST_TARGET_0x${target.toString(16)}${kernelFailureDetail(target)}`);
    };
    const guest_load=(address,size,flags)=>{
      address>>>=0;size>>>=0;flags>>>=0;
      const value=generatedGuestLoad(address,size,flags);
      const status=generatedGuestLoadStatus()>>>0;
      if(status!==1){
        const faultAddress=typeof sparseFaultAddress==='function'?sparseFaultAddress()>>>0:address;
        const faultCode=typeof sparseFaultCode==='function'?sparseFaultCode()>>>0:0;
        throw new Error(`FAIL_CLOSED_GUEST_LOAD_0x${address.toString(16).toUpperCase()}_SIZE_${size}_FLAGS_${flags}_FAULT_${faultCode}_AT_0x${faultAddress.toString(16).toUpperCase()}`);
      }
      return BigInt.asUintN(64,value);
    };
    for(const record of next.values()){
      record.instance=await WebAssembly.instantiate(record.module,{env:{memory,guest_call,guest_load}});
      if(typeof record.instance?.exports?.run!=='function')throw new Error(`Generated guest function 0x${record.address.toString(16)} has no run export`);
    }
    clearContinuationRegistry();
    records=next;
    registryKey=nextKey;
    registryRefreshes++;
    return {changed:true,count:records.size,key:registryKey};
  }

  async function runFunctionSlice(address,{continuationKey='default'}={}){
    address>>>=0;
    await refreshFunctions();
    const record=records.get(address);
    if(!record?.instance?.exports?.run)throw new Error(`FAIL_CLOSED_UNKNOWN_GUEST_TARGET_0x${address.toString(16)}`);
    const generationBefore=record.generation;
    const dispatchBefore=nestedDispatches;
    const kernelBefore=kernelDispatches;
    let rawResult;
    let continuation=null;
    let continuationStatus=0;
    let yielded=false;
    let guestReturned=true;
    try{
      if(record.tier==='cfg-fallback'){
        continuation=acquireCfgContinuation(address,continuationKey);
        rawResult=record.instance.exports.run(contextPtr,continuation.ptr);
        continuationStatus=cfgStateStatusFn(continuation.slot)>>>0;
        if(continuationStatus===1){yielded=true;guestReturned=false;yieldedSliceCount++;}
        else if(continuationStatus===2){releaseCfgContinuation(address,continuationKey);}
        else throw new Error(`FAIL_CLOSED_CFG_CONTINUATION_STATUS_${continuationStatus}`);
      }else{
        rawResult=record.instance.exports.run(contextPtr);
      }
    }catch(error){
      if(record.tier==='cfg-fallback')throw new Error(`FAIL_CLOSED_CFG_FUNCTION_0x${address.toString(16).toUpperCase()}_RESUME: ${error?.message||error}`);
      throw error;
    }
    const result=BigInt.asUintN(64,rawResult);
    sliceCount++;
    functionExecutions.set(address,(functionExecutions.get(address)??0)+1);
    return {
      address,
      generation:generationBefore,
      tier:record.tier,
      lowered:record.lowered,
      result,
      r3:getGpr(3),
      lr:getLr(),
      ctr:getCtr(),
      yielded,
      guestReturned,
      continuationStatus,
      continuationSlot:continuation?.slot??null,
      nestedDispatches:nestedDispatches-dispatchBefore,
      kernelDispatches:kernelDispatches-kernelBefore,
      sliceCount,
      contextPtr,
    };
  }

  async function yieldToBrowser(){
    await new Promise(resolve=>{
      if(typeof globalThis.scheduler?.yield==='function')globalThis.scheduler.yield().then(resolve,resolve);
      else if(typeof globalThis.requestAnimationFrame==='function')globalThis.requestAnimationFrame(()=>resolve());
      else setTimeout(resolve,0);
    });
  }

  async function runFunctionSlices({address,maxSlices=1,continueWhile=()=>true,onSlice=null,yieldBetween=true,continuationKey='default'}={}){
    if(!Number.isInteger(maxSlices)||maxSlices<1)throw new RangeError('maxSlices must be >= 1');
    const results=[];
    for(let i=0;i<maxSlices;i++){
      if(!continueWhile({index:i,session:api}))break;
      const result=await runFunctionSlice(address,{continuationKey});
      results.push(result);
      if(typeof onSlice==='function')await onSlice(result);
      if(result.guestReturned)break;
      if(yieldBetween&&i+1<maxSlices)await yieldToBrowser();
    }
    return results;
  }

  const api={
    kind:'xenia-generated-wasm-function-boundary-session',
    contextPtr,contextSize,gprOffset,lrOffset,ctrOffset,
    resetContext,getGpr,setGpr,getLr,setLr,getCtr,setCtr,
    refreshFunctions,runFunctionSlice,runFunctionSlices,yieldToBrowser,
    releaseCfgContinuation,
    get sliceCount(){return sliceCount;},
    get yieldedSliceCount(){return yieldedSliceCount;},
    get nestedDispatches(){return nestedDispatches;},
    get kernelDispatches(){return kernelDispatches;},
    get registryRefreshes(){return registryRefreshes;},
    get cfgFallbackLoads(){return cfgFallbackLoads;},
    get cfgContinuationCount(){return cfgContinuations.size;},
    get functionCount(){return records.size;},
    get moduleCompileHits(){return moduleCompileHits;},
    get moduleCompileMisses(){return moduleCompileMisses;},
    get compiledModuleCacheEntries(){return compiledModuleCache.size;},
    get hotFunctionCount(){return [...functionExecutions.values()].filter(count=>count>=hotFunctionThreshold).length;},
    get functionTiers(){return [...records.values()].map(r=>{const executionCount=functionExecutions.get(r.address)??0;return {address:r.address,generation:r.generation,tier:r.tier,lowered:r.lowered,executionCount,hot:executionCount>=hotFunctionThreshold};});},
    contract:{persistentPpcContext:true,generationAwareFunctions:true,compiledModuleReuse:true,compiledModuleCacheLimit:512,hotFunctionTelemetry:true,hotFunctionThreshold,cooperativeBrowserYield:true,liveKernelImportContextDispatch:typeof kernelDispatch==='function',cfgFallback:true,cfgFuelBounded:true,cfgFuelExhaustionYields:true,cfgPerThreadContinuationSlots:hasCfgContinuation,unsupportedKernelImportsFailClosed:true,preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',fullXboxThreadScheduler:false},
  };
  await refreshFunctions();
  return api;
}

export function persistentPpcSessionContract(){
  return {persistentPpcContext:true,backend:'Xenia-generated per-function WebAssembly + resumable fuel-bounded integer CFG fallback',cacheInvalidation:'Xenia executable page/content generation',compiledModuleReuse:true,compiledModuleCacheLimit:512,hotFunctionTelemetry:true,browserYield:'between completed guest functions or yielded CFG quanta',kernelImports:'live PPCContext dispatch in callable tier when bootstrap export is present',cfgFallback:'most recently translated multi-block integer function',cfgFuelLimit:4096,cfgFuelExhaustionYields:true,cfgContinuationState:'per-thread status + dispatcher PC + live integer HIR locals',unsupportedKernelImportsFailClosed:true,failClosedUnknownTargets:true,preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',fullXboxThreadScheduler:false};
}
