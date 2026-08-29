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
 * A slice is one generated guest function (including synchronous nested guest
 * calls). Every slice uses the same Xenia PPCContext and generation-aware
 * function registry. Generated guest calls that land on registered xboxkrnl /
 * XAM thunks are routed through the native WASM kernel ABI using that exact
 * live PPCContext. Unsupported thunks remain fail-closed.
 *
 * This still is not a preemptive Xbox thread VM: safe browser preemption is at
 * completed generated guest-function returns.
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
  const kernelDispatch=pick(bootstrap,'r360_kernel_import_dispatch_context');
  const kernelLastStatus=pick(bootstrap,'r360_kernel_import_last_status');
  const kernelLastModule=pick(bootstrap,'r360_kernel_import_last_module');
  const kernelLastOrdinal=pick(bootstrap,'r360_kernel_import_last_ordinal');

  const contextPtr=contextPtrFn()>>>0;
  const contextSize=contextSizeFn()>>>0;
  const gprOffset=gprOffsetFn()>>>0;
  const lrOffset=lrOffsetFn()>>>0;
  const ctrOffset=ctrOffsetFn()>>>0;
  if(!contextPtr||!contextSize||gprOffset+32*8>contextSize||lrOffset+8>contextSize||ctrOffset+8>contextSize){
    throw new Error(`Invalid Xenia PPCContext ABI ptr=0x${contextPtr.toString(16)} size=${contextSize}`);
  }

  let registryKey='';
  let records=new Map();
  let sliceCount=0;
  let nestedDispatches=0;
  let kernelDispatches=0;
  let registryRefreshes=0;

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
      descriptors.push({index,address,generation,ptr,size,lowered});
    }
    const nextKey=descriptors.map(x=>`${x.address.toString(16)}:${x.generation}:${x.ptr}:${x.size}`).join('|');
    if(!force&&nextKey===registryKey)return {changed:false,count:records.size,key:registryKey};

    const next=new Map();
    for(const descriptor of descriptors){
      const moduleBytes=new Uint8Array(memory.buffer,descriptor.ptr,descriptor.size).slice();
      const module=await WebAssembly.compile(moduleBytes);
      next.set(descriptor.address,{...descriptor,module,instance:null});
    }
    const guest_call=(target,ctx)=>{
      target>>>=0;ctx>>>=0;
      if(ctx!==contextPtr)throw new Error(`FAIL_CLOSED_PPC_CONTEXT_MISMATCH_0x${ctx.toString(16)}`);
      const callee=next.get(target);
      if(callee?.instance?.exports?.run){
        nestedDispatches++;
        callee.instance.exports.run(ctx);
        return 1;
      }
      if(typeof kernelDispatch==='function'&&(kernelDispatch(target,ctx)>>>0)===1){
        kernelDispatches++;
        return 1;
      }
      throw new Error(`FAIL_CLOSED_UNKNOWN_GUEST_TARGET_0x${target.toString(16)}${kernelFailureDetail(target)}`);
    };
    for(const record of next.values()){
      record.instance=await WebAssembly.instantiate(record.module,{env:{memory,guest_call}});
      if(typeof record.instance?.exports?.run!=='function')throw new Error(`Generated guest function 0x${record.address.toString(16)} has no run export`);
    }
    records=next;
    registryKey=nextKey;
    registryRefreshes++;
    return {changed:true,count:records.size,key:registryKey};
  }

  async function runFunctionSlice(address){
    address>>>=0;
    await refreshFunctions();
    const record=records.get(address);
    if(!record?.instance?.exports?.run)throw new Error(`FAIL_CLOSED_UNKNOWN_GUEST_TARGET_0x${address.toString(16)}`);
    const generationBefore=record.generation;
    const dispatchBefore=nestedDispatches;
    const kernelBefore=kernelDispatches;
    const result=BigInt.asUintN(64,record.instance.exports.run(contextPtr));
    sliceCount++;
    return {
      address,
      generation:generationBefore,
      result,
      r3:getGpr(3),
      lr:getLr(),
      ctr:getCtr(),
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

  async function runFunctionSlices({address,maxSlices=1,continueWhile=()=>true,onSlice=null,yieldBetween=true}={}){
    if(!Number.isInteger(maxSlices)||maxSlices<1)throw new RangeError('maxSlices must be >= 1');
    const results=[];
    for(let i=0;i<maxSlices;i++){
      if(!continueWhile({index:i,session:api}))break;
      const result=await runFunctionSlice(address);
      results.push(result);
      if(typeof onSlice==='function')await onSlice(result);
      if(yieldBetween&&i+1<maxSlices)await yieldToBrowser();
    }
    return results;
  }

  const api={
    kind:'xenia-generated-wasm-function-boundary-session',
    contextPtr,contextSize,gprOffset,lrOffset,ctrOffset,
    resetContext,getGpr,setGpr,getLr,setLr,getCtr,setCtr,
    refreshFunctions,runFunctionSlice,runFunctionSlices,yieldToBrowser,
    get sliceCount(){return sliceCount;},
    get nestedDispatches(){return nestedDispatches;},
    get kernelDispatches(){return kernelDispatches;},
    get registryRefreshes(){return registryRefreshes;},
    get functionCount(){return records.size;},
    contract:{persistentPpcContext:true,generationAwareFunctions:true,cooperativeBrowserYield:true,liveKernelImportContextDispatch:typeof kernelDispatch==='function',unsupportedKernelImportsFailClosed:true,preemptionBoundary:'guest-function-return',midFunctionPreemption:false,fullXboxThreadScheduler:false},
  };
  await refreshFunctions();
  return api;
}

export function persistentPpcSessionContract(){
  return {persistentPpcContext:true,backend:'Xenia-generated per-function WebAssembly',cacheInvalidation:'Xenia executable page generation',browserYield:'between completed guest-function slices',kernelImports:'live PPCContext dispatch when bootstrap export is present',unsupportedKernelImportsFailClosed:true,failClosedUnknownTargets:true,midFunctionPreemption:false,fullXboxThreadScheduler:false};
}
