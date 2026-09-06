# Render360 Recompile Track — Portal 1 First

Portal 1 is the first PC/WebAssembly title for Render360. This track is deliberately separate from the Xbox 360/Xenia implementation. Changes under this plan must not modify `src/xenia_web_bootstrap`, the Xenia bootstrap WASM, or Xbox title execution.

## Target user flow

1. Player installs **Portal (Steam App 400)** on a PC they control.
2. In Render360, the player taps the PC button beside `+`.
3. Player selects the installed Portal folder. Render360 detects `portal/gameinfo.txt`, Portal VPK data and the shared HL2 content.
4. Player selects a trusted community Portal WebAssembly runtime ZIP/folder.
5. Render360 validates `render360-port.json` and checks WebAssembly / WebGL / threading requirements before enabling launch.
6. The Portal adapter gives the community runtime the Render360 canvas, input host, logs and a player-owned content source.
7. The Source/Emscripten runtime starts without bundling Portal retail assets in Render360.

The browser is **not** converting `portal.exe` at upload time. The engine is compiled ahead of time for WebAssembly; the retail Portal content is linked at runtime from the player's installation.

## Community source reference

Research target:

- `weliveinhell/source-engine` — describes itself as an Emscripten Source Engine port with Portal tested.
- Its workflow runs `emmake emscripten/build.sh` and packages `build/install`.
- Its current Emscripten linker configuration uses SDL2, FreeType, JPEG/PNG, `MAIN_MODULE`, shared memory/pthreads, `FULL_ES3`, `PROXY_TO_PTHREAD`, OffscreenCanvas, a pthread pool of 8 and roughly 2 GiB initial memory.
- Its existing asset strategy records Source filesystem reads and creates map-specific `.data` chunks.

That proves Portal/Source can reach an Emscripten browser runtime, but the build output is not yet a drop-in Render360 package. Render360 needs an ES-module/module-factory boundary plus a player-owned content bridge.

The upstream repository carries the Source 1 SDK license. Any downstream fork/build must continue to follow that license and must not commit or redistribute Portal retail game assets.

## Render360 runtime package contract

A Portal runtime ZIP/folder contains:

```text
render360-port.json
portal.mjs
portal.wasm
portal.worker.js                 # when required by the build
portal-working-set.json          # path list only; no Valve assets
```

Example manifest: `recompiled/pc/portal/render360-port.example.json`.

The current supported package formats are:

- `render360-adapter`: a JavaScript adapter creates a Render360 session directly.
- `emscripten-esm`: an Emscripten ES-module factory. It must either expose `render360MountPcContent()` or declare a `contentIndex`.

Remote code entries are rejected. The runtime code has to be inside the package selected by the user.

## New player-owned working-set mount

A full Portal install is too large to blindly duplicate into WebAssembly memory, particularly on mobile. The Portal runtime can now declare:

```json
{
  "contentIndex": "portal-working-set.json"
}
```

The content index uses schema `render360-pc-content-index-v1` and contains safe relative paths only. Example:

```json
{
  "schema": "render360-pc-content-index-v1",
  "files": [
    "portal/gameinfo.txt",
    {"path":"portal/maps/testchmb_a_00.bsp","group":"testchmb_a_00"},
    {"path":"platform/platform_misc_dir.vpk","optional":true}
  ]
}
```

At launch Render360:

1. validates every path;
2. verifies required files exist in the player-selected Portal install;
3. reads only the indexed working set;
4. creates the matching Emscripten filesystem directories;
5. writes the files into the Emscripten FS;
6. reports file/byte progress to boot diagnostics;
7. calls the Emscripten `main()` only after the working set is ready.

This gives the first functional bridge between a community Emscripten engine and the player's own Portal files without shipping those files in the community package.

For later optimization, this copy-based working set should be replaced or supplemented by a worker/OPFS-backed synchronous filesystem bridge so Source can stream large assets without keeping the complete working set in the WASM heap.

## Changes required in the Source/Emscripten fork

The linked community port currently emits a normal Emscripten HTML/JS launcher. A Render360-focused fork should add a dedicated build profile that emits an importable module factory.

Recommended bring-up flags/concepts:

```text
MODULARIZE=1
EXPORT_ES6=1
INVOKE_RUN=0 / noInitialRun
FORCE_FILESYSTEM=1
export FS + callMain
WebGL 2 / ES3-compatible rendering
locateFile-compatible WASM/worker loading
```

The exact Emscripten syntax should follow the Emscripten version pinned by the fork.

For a threaded build, the package manifest must declare:

```json
{
  "requirements": {
    "sharedArrayBuffer": true,
    "crossOriginIsolated": true,
    "threads": true
  }
}
```

Render360 will then fail early with a readable browser-capability message instead of hanging on startup.

### iPhone/mobile build profile

Do **not** use the community port's current ~2 GiB initial memory + eight-worker profile as the first iPhone target. The mobile bring-up fork should profile a substantially smaller initial heap and use controlled memory growth where compatible with the Source dynamic-linking layout. The first goal is the menu + first test chamber, not every map and feature at once.

Suggested bring-up sequence:

1. compile single Portal game target only;
2. boot engine and render a frame with no retail assets bundled;
3. mount base Portal/HL2 content from the Render360 index;
4. reach Portal menu/background;
5. load `testchmb_a_00` working set;
6. wire keyboard/mouse/controller abstraction;
7. wire touch controller mapping;
8. fix audio;
9. add save persistence (IDBFS/OPFS strategy);
10. expand generated map working sets and optimize memory.

## Graphics

The linked port uses Emscripten's GLES/WebGL path. Render360 should keep Portal on WebGL 2 first. WebGPU is a later renderer project, not a prerequisite for Portal bring-up.

Source desktop OpenGL calls that do not map cleanly to WebGL need porting/emulation. The linked project already carries an Emscripten WebGL patch and reports an occasional render/lightmap issue, so render correctness should be tracked independently from CPU/WASM execution.

## Filesystem / VPK strategy

Phase 1 (implemented host support): indexed working set copied from user files into Emscripten FS.

Phase 2: generate complete path lists from the community Source fork's filesystem instrumentation instead of committing packed game data.

Phase 3: add a browser worker filesystem backend capable of synchronous Source-style reads backed by File/OPFS handles.

The path-list artifacts may be distributed because they contain filenames/metadata only. Retail VPK/BSP/material/model/audio data remains player supplied.

## Audio and saves

The linked Portal port reports sound and browser-persistent saving as incomplete. Treat these as explicit Portal milestones rather than hiding them behind a generic “compatibility” label.

- Audio target: Web Audio through the Emscripten/SDL audio path.
- Save target: persistent browser storage (IDBFS or a later OPFS-backed layer).

## UI requirements

The PC importer should feel like part of Render360 rather than a raw browser input form:

- PC button grouped directly beside the `+` import button;
- Portal-specific hero treatment;
- three-step visual progress (game files → runtime → ready);
- friendly Portal-folder instructions;
- ZIP/folder runtime import;
- drag/drop on desktop;
- browser preflight badge;
- clear legal/runtime separation;
- iPhone safe-area spacing;
- Xbox runtime controls/HUD shifted below the top safe area.

The operating-system file chooser itself cannot be fully restyled by a webpage; Render360 therefore keeps the native picker behind its own polished selection flow and supports drag/drop on desktop.

## Definition of “Portal functional”

Do not mark Portal playable merely because a `.wasm` file instantiated. The minimum playable milestone is:

- Portal PC folder recognized;
- compatible Source/Emscripten package recognized;
- browser capability check passes;
- Source main module instantiates;
- indexed player-owned content mounts;
- first visible Source frame appears;
- menu accepts input;
- first chamber loads and player movement/camera input works;
- fatal errors show in Render360 diagnostics instead of white-screen/reload loops.

## GTA IV later

GTA IV remains a later PC-recompile target. Its executable/runtime architecture, Direct3D translation, memory requirements and game-specific dependencies are much larger. The Portal track exists to prove the general PC host contract first. Do not mix GTA IV work into the Portal bring-up branch.
