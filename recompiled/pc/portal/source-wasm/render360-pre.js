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
