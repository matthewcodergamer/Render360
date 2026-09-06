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

The browser recognizes a Portal installation from player-selected files such as:

- `portal/gameinfo.txt`
- Portal VPK content (`portal/portal_pak_dir.vpk` or numbered Portal VPKs)
- Half-Life 2 base content/VPKs under `hl2/`

No Valve retail game data is committed to this repository.

The first community source reference is `weliveinhell/source-engine`, an Emscripten Source Engine port whose README identifies Portal as its tested title. Render360 does not vendor that engine tree; the Portal host accepts a separately built runtime package.

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

## Emscripten ES-module packages

`format: "emscripten-esm"` is supported for a Source build that exports a module factory. The package declares its `.wasm` file and can mount player-owned data in one of two ways:

1. export `render360MountPcContent(host.content)` from the module; or
2. declare a `contentIndex` using `render360-pc-content-index-v1`.

Example files are included beside the Portal adapter:

- `render360-port.example.json`
- `portal-working-set.example.json`

A content index contains **paths only**, never Valve assets. Render360 validates the list, reads those paths from the player's selected Portal installation, creates the matching directories in Emscripten `FS`, writes the working set, reports progress, and only then calls the module's main function.

This is intended as the first functional bridge for Source's synchronous filesystem model. It avoids copying the complete multi-gigabyte Portal install into the WASM heap, though a large map working set can still consume significant memory.

## Filesystem strategy

Phase 1: player-owned indexed working sets copied into Emscripten `FS` before launch.

Phase 2: generate complete path lists from Source filesystem instrumentation, replacing the linked community port's asset-containing map chunks with path metadata.

Phase 3: worker/OPFS-backed synchronous file access so Source can stream large files without retaining the full working set in linear memory.

## Threads / SharedArrayBuffer

Community ports can declare WebGPU, WebGL2, SharedArrayBuffer, thread and cross-origin-isolation requirements in their package manifest. Render360 checks them before executing the package and fails with a concrete requirement list instead of crashing the page.

A threaded Emscripten build requires browser support for SharedArrayBuffer and typically COOP/COEP cross-origin isolation. The linked Source port currently uses pthreads, a pool of workers and shared memory; that should be treated as a declared runtime requirement, not silently assumed.

## iPhone target

The linked Source port's current build uses a very large initial WebAssembly memory allocation and eight pthread workers. That is a useful desktop proof but not the Render360 iPhone bring-up profile. Portal-on-iPhone should start with the smallest working set and memory/thread configuration that can reach the menu and first chamber, then grow from measured telemetry.

See `docs/recompile/PORTAL1_PLAN.md` for the concrete Source-fork/build changes and milestone definition.

## Security model

A community runtime package is executable JavaScript/WebAssembly. Render360 therefore:

- accepts package entry points only from the locally selected package;
- rejects remote manifest entry URLs;
- verifies the package `gameId` matches the selected game profile;
- validates content-index paths and blocks traversal/remote paths;
- never treats a Windows executable as trusted WebAssembly;
- keeps retail game files separate from community runtime code.

Players should only run community packages they trust.

## Current status

Implemented host foundation:

- Portal PC folder detection;
- player-owned file source with bounded reads;
- local community runtime ZIP/folder loader;
- package manifest validation;
- browser capability preflight;
- adapter and Emscripten ES-module launch contracts;
- player-owned indexed Emscripten working-set mount;
- Portal-specific adapter;
- PC-specific runtime router that delegates all Xbox titles to the existing path unchanged;
- redesigned Portal import/relink UI with Steam install guidance and desktop drag/drop;
- iPhone runtime safe-area spacing;
- regression tests and isolated PC-WASM CI.

Still required for actual Portal gameplay: build a compatible Source/Emscripten runtime package from an authorized community Source tree, generate a complete startup/first-map content index, and fix the remaining Source-browser graphics/audio/save issues. The host infrastructure cannot manufacture that engine binary from `portal.exe` by itself.

## Later titles

The same host can register additional PC game IDs, including a future GTA IV target, but each game still needs its own valid recompiler/port runtime and OS/graphics/audio/filesystem compatibility work. Portal is the first integration target so those contracts can be proven on a smaller Source-engine title before attempting GTA IV-class workloads.
