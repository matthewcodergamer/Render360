// Render360 Portal Source runtime pre-js.
//
// Unlike the community demo pre.js, this file never downloads Valve retail
// game data. The Render360 package adapter supplies player-owned files to the
// engine host and the engine runs with -game portal.
Module['arguments'] = Module['arguments'] || [];
Module['noInitialRun'] = true;
Module['render360SourceRuntime'] = Object.freeze({
  gameId: 'portal-1-pc',
  contentMode: 'player-owned-local-files',
  remoteRetailChunks: false,
});

// Emscripten MAIN_MODULE is relocatable. Source side-module constructors can
// run after Emscripten's first stackCheckInit() and overwrite the relocatable
// stack-limit globals. The symptom is very specific: checkStackCookie() sees
// emscripten_stack_get_end() == 0 and reports its cookie at address 0x00000004.
// Re-run Emscripten's own generated stack initializer after dynamic-library
// constructors, and again immediately before manual callMain(). We do not
// guess a stack address, enlarge the stack, disable the cookie, or touch the
// zero page; stackCheckInit() reapplies the exact link-time limits.
Module['render360RepairStackGeometry'] = () => {
  if (typeof stackCheckInit !== 'function') {
    throw new Error('Render360 stack repair unavailable: Emscripten stackCheckInit() was not generated.');
  }
  stackCheckInit();
  const end = typeof _emscripten_stack_get_end === 'function' ? Number(_emscripten_stack_get_end()) >>> 0 : 0;
  if (!end) {
    throw new Error('Render360 stack repair failed: emscripten_stack_get_end() is still zero.');
  }
  const state = Object.freeze({ applied: true, end });
  Module['render360StackGeometry'] = state;
  return state;
};

const render360PreviousRuntimeInitialized = Module['onRuntimeInitialized'];
Module['onRuntimeInitialized'] = () => {
  if (typeof render360PreviousRuntimeInitialized === 'function') {
    render360PreviousRuntimeInitialized();
  }
  Module['render360RepairStackGeometry']();
};

Module['downloadMap'] = (lock, mapName) => {
  try {
    if (typeof HEAP32 !== 'undefined' && Number.isInteger(lock) && lock >= 0) {
      if (typeof SharedArrayBuffer !== 'undefined' && HEAP32.buffer instanceof SharedArrayBuffer) {
        Atomics.store(HEAP32, lock, 0);
        Atomics.notify(HEAP32, lock);
      } else {
        HEAP32[lock] = 0;
      }
    }
  } finally {
    Module['render360OnLocalMapReady']?.(String(mapName || ''));
  }
};
