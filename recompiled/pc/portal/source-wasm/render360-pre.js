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
  stackRepairVersion: 4,
});

// Emscripten MAIN_MODULE is relocatable. Source side-module constructors can
// run after Emscripten's first stackCheckInit() and overwrite the relocatable
// stack-limit globals. The characteristic false-overflow symptom is a stack
// cookie check at 0x00000004 because emscripten_stack_get_end() became zero.
//
// Re-run Emscripten's generated stack initializer after dynamic-library
// constructors and again immediately before manual callMain(). We never guess
// a stack address, disable the cookie, write the zero page, or enlarge the
// stack. stackCheckInit() restores the exact link-time geometry and cookie.
Module['render360RepairStackGeometry'] = (phase = 'unspecified') => {
  if (typeof stackCheckInit !== 'function') {
    throw new Error('Render360 stack repair unavailable: Emscripten stackCheckInit() was not generated.');
  }

  stackCheckInit();

  const base = typeof _emscripten_stack_get_base === 'function'
    ? Number(_emscripten_stack_get_base()) >>> 0
    : 0;
  const end = typeof _emscripten_stack_get_end === 'function'
    ? Number(_emscripten_stack_get_end()) >>> 0
    : 0;
  const heapBytes = typeof HEAPU8 !== 'undefined' ? Number(HEAPU8.byteLength) >>> 0 : 0;

  if (!base || !end) {
    throw new Error(`Render360 stack repair failed during ${phase}: base=${base} end=${end}.`);
  }
  if (base <= end) {
    throw new Error(`Render360 stack repair failed during ${phase}: invalid downward stack geometry base=0x${base.toString(16)} end=0x${end.toString(16)}.`);
  }
  if (heapBytes && base >= heapBytes) {
    throw new Error(`Render360 stack repair failed during ${phase}: stack base 0x${base.toString(16)} lies outside the ${heapBytes}-byte Wasm heap.`);
  }

  const state = Object.freeze({
    applied: true,
    version: 4,
    phase: String(phase),
    base,
    end,
    bytes: (base - end) >>> 0,
    heapBytes,
  });
  Module['render360StackGeometry'] = state;
  return state;
};

const render360PreviousRuntimeInitialized = Module['onRuntimeInitialized'];
Module['onRuntimeInitialized'] = () => {
  if (typeof render360PreviousRuntimeInitialized === 'function') {
    render360PreviousRuntimeInitialized();
  }
  Module['render360RepairStackGeometry']('onRuntimeInitialized');
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
