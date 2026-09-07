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
  zeroStackCookieSelfHeal: true,
});

// The generated Emscripten MAIN_MODULE is relocatable. Its exact link-time
// stack geometry for this build is installed by stackCheckInit(). Source's
// dynamically loaded modules can later leave emscripten_stack_get_end() at
// zero. Emscripten's own checkStackCookie() special-cases zero by checking
// address 0x00000004, which is the exact false "Stack overflow" signature we
// see on iOS. Repairing only before callMain() is therefore not enough: Source
// can invalidate the limit after entering main / the SDL main loop.
//
// Wrap Emscripten's generated checker itself. If its stack-end metadata has
// become zero, re-run the generated stackCheckInit() immediately before the
// check, then run the original checker normally. This does NOT disable stack
// checking. A real overwrite at the real stack end is still detected by the
// original Emscripten cookie checker.
const render360OriginalCheckStackCookie = checkStackCookie;
checkStackCookie = () => {
  if (!ABORT && typeof _emscripten_stack_get_end === 'function') {
    let end = Number(_emscripten_stack_get_end()) >>> 0;
    if (!end) {
      if (typeof stackCheckInit !== 'function') {
        throw new Error('Render360 cannot recover zero Emscripten stack end: stackCheckInit() is unavailable.');
      }
      stackCheckInit();
      end = Number(_emscripten_stack_get_end()) >>> 0;
      if (!end) {
        throw new Error('Render360 recovered the Emscripten stack cookie, but stack end is still zero.');
      }
      Module['render360ZeroStackRepairs'] = (Number(Module['render360ZeroStackRepairs']) || 0) + 1;
      Module['render360OnZeroStackRepair']?.({
        count: Module['render360ZeroStackRepairs'],
        end,
      });
    }
  }
  return render360OriginalCheckStackCookie();
};

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
    zeroStackRepairs: Number(Module['render360ZeroStackRepairs']) || 0,
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
