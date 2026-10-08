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
// guest-thread scheduling. Returns the primary thread's result. When a
// title-created thread stops on a blocker, the run ends with that thread's
// state current (so diagnostics name it) and its root result is returned.
export function runWithGuestFibers(bootstrap,callPrimary,{maxSwitches=1e7}={}){
  if(!hasGuestFibers(bootstrap))return {result:callPrimary(),fibers:null};
  const e=bootstrap.exports;
  const restoreStack=e._emscripten_stack_restore;
  const baseStack=typeof e.emscripten_stack_get_current==='function'?(e.emscripten_stack_get_current()>>>0):0;
  e.r360_fiber_reset(1);
  const stats={switches:0,threads:0,endedOn:0};
  let result;
  try{
    result=callPrimary();
    for(;;){
      const state=e.asyncify_get_state();
      if(state===1){
        e.asyncify_stop_unwind();
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
    e.r360_fiber_reset(0);
  }
  return {result,fibers:stats};
}
