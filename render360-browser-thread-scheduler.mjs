import {createPersistentPpcSession} from './render360-browser-ppc-session.mjs';

const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];
const need=(bootstrap,name)=>{const fn=pick(bootstrap,name);if(typeof fn!=='function')throw new Error(`Guest thread scheduler missing bootstrap export ${name}`);return fn;};

/**
 * Browser scheduler for Render360's native Xbox guest-thread registry.
 *
 * Every Xbox thread gets an independent byte-for-byte PPCContext snapshot.
 * The live WasmBackend context is restored immediately before a thread runs and
 * saved immediately after it yields or returns. r1 is seeded from the native
 * sparse stack top and r3 from the Xbox thread context argument on first
 * dispatch.
 *
 * Complete callable guest functions preempt at return boundaries. The admitted
 * integer CFG fallback can additionally preempt at a generated CFG block
 * boundary when its fuel quantum expires: its dispatcher PC and live HIR locals
 * are stored in a continuation slot keyed by the native Xbox thread handle.
 */
export async function createGuestThreadScheduler({
  bootstrap,
  session=null,
  defaultStackSize=0x40000,
  maxSlicesPerPump=4,
  terminateOnEntryReturn=true,
}={}){
  if(!(bootstrap?.exports?.memory instanceof WebAssembly.Memory))throw new Error('Guest thread scheduler requires bootstrap WebAssembly memory');
  if(!Number.isInteger(maxSlicesPerPump)||maxSlicesPerPump<1||maxSlicesPerPump>32)throw new RangeError('maxSlicesPerPump must be 1..32');
  const memory=bootstrap.exports.memory;
  const createThread=need(bootstrap,'r360_guest_thread_create');
  const nextRunnable=need(bootstrap,'r360_guest_thread_next_runnable');
  const setCurrent=need(bootstrap,'r360_guest_thread_set_current');
  const stateOf=need(bootstrap,'r360_guest_thread_state');
  const terminateThread=need(bootstrap,'r360_guest_thread_terminate');
  const entryOf=need(bootstrap,'r360_guest_thread_entry');
  const contextOf=need(bootstrap,'r360_guest_thread_context');
  const flagsOf=need(bootstrap,'r360_guest_thread_flags');
  const stackBaseOf=need(bootstrap,'r360_guest_thread_stack_base');
  const stackTopOf=need(bootstrap,'r360_guest_thread_stack_top');
  const stackMappedOf=need(bootstrap,'r360_guest_thread_stack_mapped');
  const ppc=session??await createPersistentPpcSession({bootstrap});
  const contextPtr=ppc.contextPtr>>>0;
  const contextSize=ppc.contextSize>>>0;
  if(!contextPtr||!contextSize)throw new Error('Guest thread scheduler received invalid PPCContext ABI');

  const snapshots=new Map();
  const dispatchCounts=new Map();
  const yieldCounts=new Map();
  let pumpCount=0;
  let sliceCount=0;
  let yieldedSlices=0;
  let completedThreads=0;
  let running=false;
  let paused=false;
  let lastBlocker=null;
  let loopPromise=null;

  const liveContext=()=>new Uint8Array(memory.buffer,contextPtr,contextSize);
  const copyLiveContext=()=>liveContext().slice();

  function inspectThread(handle){
    handle>>>=0;
    return {
      handle,
      state:stateOf(handle)>>>0,
      entry:entryOf(handle)>>>0,
      context:contextOf(handle)>>>0,
      flags:flagsOf(handle)>>>0,
      stackBase:stackBaseOf(handle)>>>0,
      stackTop:stackTopOf(handle)>>>0,
      stackMapped:Boolean(stackMappedOf(handle)>>>0),
      dispatches:dispatchCounts.get(handle)??0,
      yields:yieldCounts.get(handle)??0,
      hasPpcSnapshot:snapshots.has(handle),
    };
  }

  function initializeThreadContext(handle){
    const thread=inspectThread(handle);
    if(!thread.entry)throw new Error(`FAIL_CLOSED_THREAD_${handle.toString(16)}_NO_ENTRY`);
    if(!thread.stackMapped||!thread.stackBase||!thread.stackTop||thread.stackTop<=thread.stackBase){
      throw new Error(`FAIL_CLOSED_THREAD_${handle.toString(16)}_NO_GUEST_STACK`);
    }
    ppc.resetContext();
    ppc.setGpr(1,BigInt(thread.stackTop));
    ppc.setGpr(3,BigInt(thread.context));
    ppc.setLr(0n);
    ppc.setCtr(0n);
    const snapshot=copyLiveContext();
    snapshots.set(handle,snapshot);
    return snapshot;
  }

  function restoreThreadContext(handle){
    let snapshot=snapshots.get(handle);
    if(!snapshot)snapshot=initializeThreadContext(handle);
    if(snapshot.byteLength!==contextSize)throw new Error(`FAIL_CLOSED_THREAD_${handle.toString(16)}_BAD_CONTEXT_SIZE`);
    liveContext().set(snapshot);
  }

  function saveThreadContext(handle){snapshots.set(handle,copyLiveContext());}

  function createThreadRecord({entry,context=0,stackSize=defaultStackSize,flags=0}={}){
    entry>>>=0;context>>>=0;stackSize>>>=0;flags>>>=0;
    if(!entry)throw new Error('Guest thread entry must be nonzero');
    const handle=createThread(entry,context,stackSize,flags)>>>0;
    if(!handle)throw new Error(`FAIL_CLOSED_GUEST_THREAD_CREATE_0x${entry.toString(16)}`);
    return inspectThread(handle);
  }

  async function runThreadSlice(handle,{terminateOnReturn=terminateOnEntryReturn}={}){
    handle>>>=0;
    const state=stateOf(handle)>>>0;
    if(state!==1&&state!==2)throw new Error(`FAIL_CLOSED_THREAD_${handle.toString(16)}_STATE_${state}`);
    if((setCurrent(handle)>>>0)!==1)throw new Error(`FAIL_CLOSED_THREAD_${handle.toString(16)}_SET_CURRENT`);
    const thread=inspectThread(handle);
    restoreThreadContext(handle);
    let result;
    try{result=await ppc.runFunctionSlice(thread.entry,{continuationKey:handle});}
    catch(error){saveThreadContext(handle);lastBlocker={handle,entry:thread.entry,error:String(error?.message??error)};throw error;}
    saveThreadContext(handle);
    sliceCount++;
    dispatchCounts.set(handle,(dispatchCounts.get(handle)??0)+1);
    if(result.yielded){yieldedSlices++;yieldCounts.set(handle,(yieldCounts.get(handle)??0)+1);}
    let terminated=false;
    if(terminateOnReturn&&!result.yielded&&result.guestReturned!==false){
      const exitCode=Number(BigInt.asUintN(32,result.r3));
      if((terminateThread(handle,exitCode)>>>0)!==1)throw new Error(`FAIL_CLOSED_THREAD_${handle.toString(16)}_TERMINATE`);
      terminated=true;completedThreads++;
    }
    return {...result,handle,thread,terminated};
  }

  async function pumpOnce({maxSlices=maxSlicesPerPump,onSlice=null}={}){
    if(!Number.isInteger(maxSlices)||maxSlices<1||maxSlices>32)throw new RangeError('maxSlices must be 1..32');
    const results=[];
    for(let i=0;i<maxSlices;i++){
      const handle=nextRunnable()>>>0;if(!handle)break;
      const state=stateOf(handle)>>>0;if(state!==1&&state!==2)continue;
      const result=await runThreadSlice(handle);results.push(result);if(typeof onSlice==='function')await onSlice(result);
    }
    pumpCount++;await ppc.yieldToBrowser();
    return {pumpCount,slices:results,totalSlices:sliceCount,yieldedSlices,completedThreads,lastBlocker};
  }

  async function runLoop({onPump=null,onSlice=null,onError=null}={}){
    if(running)return loopPromise;
    running=true;
    loopPromise=(async()=>{
      while(running){
        if(paused){await ppc.yieldToBrowser();continue;}
        try{
          const report=await pumpOnce({maxSlices:1,onSlice});
          if(typeof onPump==='function')await onPump(report);
          if(!report.slices.length)running=false;
        }catch(error){
          running=false;
          if(typeof onError==='function')await onError(error,lastBlocker);else throw error;
        }
      }
      return inspect();
    })();
    return loopPromise;
  }

  function pause(){paused=true;return true;}
  function resume(){paused=false;return true;}
  function stop(){running=false;paused=false;}

  function inspect(){
    return {
      kind:'render360-cooperative-xbox-thread-scheduler',running,paused,pumpCount,sliceCount,yieldedSlices,completedThreads,
      trackedContexts:snapshots.size,lastBlocker,
      ppcSession:{kind:ppc.kind,functionCount:ppc.functionCount,sliceCount:ppc.sliceCount,yieldedSliceCount:ppc.yieldedSliceCount,kernelDispatches:ppc.kernelDispatches,nestedDispatches:ppc.nestedDispatches},
      contract:{
        nativeXboxThreadRegistry:true,perThreadPpcContextSnapshots:true,perThreadCfgContinuation:true,sparseGuardedGuestStacks:true,
        cooperativeRoundRobin:true,generatedWasmExecution:true,browserYieldBetweenPumps:true,productionSlicesPerBrowserYield:1,
        preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',
        pauseResume:true,fullXboxThreadScheduler:false,
      },
    };
  }

  return {
    createThread:createThreadRecord,inspectThread,initializeThreadContext,restoreThreadContext,saveThreadContext,
    runThreadSlice,pumpOnce,runLoop,pause,resume,stop,inspect,session:ppc,
    get running(){return running;},get paused(){return paused;},get lastBlocker(){return lastBlocker;},contract:inspect().contract,
  };
}

export function guestThreadSchedulerContract(){
  return {
    nativeXboxThreadRegistry:true,perThreadPpcContextSnapshots:true,perThreadCfgContinuation:true,sparseGuardedGuestStacks:true,
    cooperativeRoundRobin:true,generatedWasmExecution:true,browserYieldBetweenPumps:true,productionSlicesPerBrowserYield:1,
    preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',
    pauseResume:true,fullXboxThreadScheduler:false,
  };
}
