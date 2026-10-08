// Driver for the native core's guest-thread fibers (src/xenia_web_bootstrap/
// guest_fibers.cpp). Xenia runs each XThread on its own host thread; the
// browser core runs them as fibers on the HIR executor. When a guest thread
// blocks in the kernel, the core snapshots it and unwinds the wasm stack back
// here (Binaryen Asyncify); this loop then starts or rewinds the next guest
// thread on its own C stack until the title's primary thread returns.
const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];

export function hasGuestFibers(bootstrap){
  return ['r360_fiber_reset','r360_fiber_prepare','r360_fiber_entry','asyncify_get_state','asyncify_stop_unwind','asyncify_start_rewind','_emscripten_stack_restore']
    .every(name=>typeof bootstrap?.exports?.[name]==='function');
}

// Runs `callPrimary` (the export that enters the title's primary thread) with
// guest-thread scheduling. Resolves to the primary thread's result. When a
// title-created thread stops on a blocker, the run ends with that thread's
// state current (so diagnostics name it) and its root result is returned.
//
// sliceMs > 0 time-slices the run for the browser: after sliceMs of host time
// the core unwinds back here, `onSlice(stats)` runs and the page gets a turn
// (frames, input, UI) before the guest is rewound. `signal` (AbortSignal)
// stops a sliced run at the next slice; the result is then
// {stopped:'aborted'}.
export async function runWithGuestFibers(bootstrap,callPrimary,{maxSwitches=1e9,sliceMs=0,onSlice=null,signal=null,yieldToHost=null}={}){
  if(!hasGuestFibers(bootstrap))return {result:callPrimary(),fibers:null};
  const e=bootstrap.exports;
  const restoreStack=e._emscripten_stack_restore;
  const baseStack=typeof e.emscripten_stack_get_current==='function'?(e.emscripten_stack_get_current()>>>0):0;
  const slicing=sliceMs>0&&typeof e.r360_fiber_set_host_slice==='function';
  const hostTurn=yieldToHost||(()=>new Promise(resolve=>setTimeout(resolve,0)));
  e.r360_fiber_reset(1);
  const stats={switches:0,threads:0,endedOn:0,slices:0,stopped:null};
  let result;
  try{
    if(slicing)e.r360_fiber_set_host_slice(sliceMs);
    result=callPrimary();
    for(;;){
      const state=e.asyncify_get_state();
      if(state===1){
        e.asyncify_stop_unwind();
        if(slicing&&(e.r360_fiber_take_host_yield()>>>0)){
          ++stats.slices;
          stats.threads=Math.max(0,(e.r360_fiber_count()>>>0)-1);
          if(onSlice)await onSlice(stats);
          await hostTurn();
          if(signal?.aborted){stats.stopped='aborted';result=0;break;}
          e.r360_fiber_set_host_slice(sliceMs);
        }
      }else if(state!==0){
        throw new Error(`guest fiber driver: unexpected Asyncify state ${state}`);
      }else{
        // A root returned normally: the primary thread finished, or a
        // title-created thread finished (switch queued) or stopped.
        if((e.r360_fiber_current()>>>0)===0||!(e.r360_fiber_switch_pending()>>>0))break;
      }
      if(++stats.switches>maxSwitches)throw new Error('guest fiber driver: switch limit exceeded');
      const kind=e.r360_fiber_prepare()>>>0;
      if(kind===0)throw new Error('guest fiber driver: unwound without a switch target');
      restoreStack(e.r360_fiber_stack_pointer()>>>0);
      if(kind===2)e.asyncify_start_rewind(e.r360_fiber_asyncify_data()>>>0);
      result=(e.r360_fiber_current()>>>0)===0?callPrimary():(e.r360_fiber_entry()>>>0);
    }
    stats.threads=Math.max(0,(e.r360_fiber_count()>>>0)-1);
    stats.endedOn=e.r360_fiber_current()>>>0;
    stats.endedOnThread=stats.endedOn?(e.r360_fiber_thread(stats.endedOn)>>>0):0;
  }finally{
    // Leave a clean core for the next title even after a trap mid-switch.
    try{if(e.asyncify_get_state()!==0){e.asyncify_stop_unwind();e.asyncify_stop_rewind?.();}}catch{}
    if(baseStack)restoreStack(baseStack);
    if(slicing)e.r360_fiber_set_host_slice(0);
    e.r360_fiber_reset(0);
  }
  return {result,fibers:stats};
}

// Browser options for a continuous title run: ~25 ms host slices, Stop through
// globalThis.render360GuestRun.stop() (aborts at the next slice), and a
// progress line about twice a second.
export function browserGuestRunOptions({bootstrap,onProgress=null,sliceMs=25}={}){
  globalThis.render360GuestRun?.stop?.();
  const controller=new AbortController();
  const now=()=>globalThis.performance?.now?.()??Date.now();
  const started=now();
  let lastReport=0;
  globalThis.render360GuestRun={stop:()=>controller.abort(),signal:controller.signal};
  const read=name=>{const f=bootstrap?.exports?.[name];return typeof f==='function'?(f()>>>0):0;};
  return {guestSliceMs:sliceMs,signal:controller.signal,onGuestSlice:s=>{
    const t=now();
    if(!onProgress||t-lastReport<500)return;
    lastReport=t;
    const frames=read('r360_title_gpu_vd_swap_calls'),draws=read('r360_xenos_draws');
    const seconds=Math.max(0.001,(t-started)/1000);
    onProgress(`Running · ${frames.toLocaleString()} frames presented (${(frames/seconds).toFixed(1)}/s) · ${draws.toLocaleString()} GPU draws · ${s.threads} guest threads`,{frames,draws,slices:s.slices});
  }};
}
