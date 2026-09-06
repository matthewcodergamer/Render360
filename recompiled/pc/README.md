# Render360 PC Recompiled WebAssembly

This directory is the **PC game port** side of Render360. It is separate from the Xbox 360/Xenia execution path.

## Goal

The player supplies a legally installed PC game. A community project supplies a compatible browser WebAssembly runtime. Render360 supplies the host: file selection, title detection, runtime-package validation, canvas/input integration, diagnostics and launch routing.

```text
Player-owned PC install
        +
Community WebAssembly runtime package
        ↓
Render360 PC content source
        ↓
Per-game host adapter
        ↓
WebAssembly / Emscripten runtime
        ↓
WebGL2 or WebGPU + Web Audio + browser input
```

Render360 does **not** turn an arbitrary Windows `.exe` into WebAssembly at upload time. A compatible port/recompiler must exist for the game. This is the same reason a browser build normally requires source-level or ahead-of-time recompilation plus browser replacements for Win32, graphics, audio, threading and filesystem behavior.

## First target: Portal 1

Portal is registered as:

```text
gameId: portal-1-pc
Steam App ID: 400
host profile: recompiled/pc/portal/manifest.json
```

The browser currently recognizes a Portal installation from player-selected files such as:

- `portal/gameinfo.txt`
- Portal VPK content (`portal/portal_pak_dir.vpk` or numbered Portal VPKs)
- Half-Life 2 base content/VPKs under `hl2/`

No Valve game data is committed to this repository.

## Community runtime package

A runtime can be selected as a folder or ZIP. It must contain `render360-port.json`.

Example adapter package:

```json
{
  "schema": "render360-pc-wasm-package-v1",
  "gameId": "portal-1-pc",
  "name": "Portal Community WebAssembly Runtime",
  "format": "render360-adapter",
  "entry": "portal-runtime.mjs",
  "adapterExport": "createRender360PcPort",
  "files": ["portal-runtime.wasm"],
  "requirements": {
    "webassembly": true,
    "webgl2": true,
    "threads": false
  }
}
```

The entry module returns a session:

```js
export async function createRender360PcPort(host) {
  // host.content exposes bounded reads of the player's Portal files.
  // host.canvas is Render360's game canvas.
  // host.inputHost carries Render360 input state.
  return {
    async start() {},
    pause() {},
    resume() {},
    stop() {}
  };
}
```

`format: "emscripten-esm"` is also supported, but the Emscripten module must expose `render360MountPcContent(host.content)`. Render360 intentionally does not copy an entire multi-gigabyte game installation into MEMFS just to make a generic build appear compatible.

## Filesystem strategy

The host keeps player-owned assets outside the WebAssembly heap and exposes bounded file reads. A production Source-engine build should bridge that source into its own virtual filesystem. For higher throughput, a later worker/OPFS bridge can use synchronous worker-side access while preserving the same host contract.

## Threads / SharedArrayBuffer

Community ports can declare WebGPU, WebGL2, SharedArrayBuffer, thread and cross-origin-isolation requirements in their package manifest. Render360 checks them before executing the package and fails with a concrete requirement list instead of crashing the page.

A threaded Emscripten build may require COOP/COEP/cross-origin isolation. That is intentionally an opt-in runtime requirement rather than a change to the Xbox 360 runtime or a blanket assumption for every browser build.

## Security model

A community runtime package is executable JavaScript/WebAssembly. Render360 therefore:

- accepts package entry points only from the locally selected package;
- rejects remote manifest entry URLs;
- verifies the package `gameId` matches the selected game profile;
- never treats a Windows executable as trusted WebAssembly;
- keeps retail game files separate from community runtime code.

Players should only run community packages they trust.

## Current status

Implemented host foundation:

- Portal PC folder detection;
- player-owned file source with bounded reads;
- local community runtime ZIP/folder loader;
- package manifest validation;
- Emscripten/adapter launch contracts;
- Portal-specific adapter;
- PC-specific runtime router that delegates all Xbox titles to the existing path unchanged;
- Portal import/relink UI;
- regression tests and isolated PC-Wasm CI.

Still required for actual Portal gameplay: a compatible, legally distributable community Portal/Source WebAssembly runtime package implementing the contract above. The host infrastructure cannot manufacture that binary from `portal.exe` by itself.

## Later titles

The same host can register additional PC game IDs, including a future GTA IV target, but each game still needs its own valid recompiler/port runtime and OS/graphics/audio/filesystem compatibility work. Portal is the first integration target so those contracts can be proven on a smaller Source-engine title before attempting GTA IV-class workloads.
