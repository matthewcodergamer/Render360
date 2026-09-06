# Render360 Recompile Track — Portal 1 First

Portal 1 is the first PC/WebAssembly title for Render360. This track stays separate from Xbox 360/Xenia. Do not modify `src/xenia_web_bootstrap`, the Xenia bootstrap WASM, or Xbox title execution while bringing Portal up.

## Active repositories

- Host/UI/runtime: `matthewcodergamer/Render360`
- Source fork: `matthewcodergamer/source-engine`
- Source bring-up branch: `render360-portal-mobile`
- Source build profile: `emscripten/render360/`
- Source CI: **Render360 Portal Runtime**

The browser does not translate `portal.exe` when a user uploads Portal. Source is compiled ahead of time to an Emscripten ES-module/WebAssembly runtime, while Portal retail content stays player supplied.

## Player flow

1. Install **Portal (Steam App 400)** from Steam on a PC you control.
2. In Render360 tap **PC** beside the `+` button.
3. Choose the Portal installation folder containing `portal`, `hl2` and `platform`.
4. Render360 indexes normal files and Source VPK directory trees. VPK contents can be resolved with lazy range reads instead of copying entire archives.
5. Choose the Render360 Portal runtime ZIP/folder produced by the Source fork.
6. Render360 validates `render360-port.json`, WebAssembly, renderer and threading requirements.
7. Render360 mounts the requested working set and starts Source.
8. Source initially renders through its Emscripten WebGL 2 compatibility path to an internal canvas. Render360 presents the visible frame through WebGPU.

## Portal data for testing

The inherited Source repository describes a development workflow where Source filesystem `OpenForRead` requests are logged and map-specific data is prepared. It also mentions an alternate hosted pre-packed `.data` download. Render360 intentionally does not depend on hosted retail game-data chunks.

Use a Portal installation you own:

1. Steam → Portal → **Manage → Browse local files**.
2. For ordinary Render360 selection, keep the VPK files intact. Render360's Source VPK layer can index the VPK directory files and lazily read archive ranges.
3. For dependency profiling only, make a temporary unpacked working tree from your own copy with VPKEdit. The inherited tooling uses a command shaped like:

   ```sh
   vpkeditcli -e / -o . ./vpk_dir.vpk
   ```

4. Build/run the Source tree natively with its `OpenForRead` logging and load the target map. Start with `testchmb_a_00`.
5. Convert the log to a path-only Render360 working set:

   ```sh
   node emscripten/render360/make_content_index.js \
     --game-root /path/to/unpacked/Portal \
     --log map-testchmb_a_00.txt \
     --map testchmb_a_00 \
     --out build/render360/portal-working-set.json
   ```

The JSON contains file paths/metadata only; it must not contain Valve textures, maps, models, audio or other retail asset bytes.

## Build the Render360 Source runtime

From the Source fork:

```sh
source emscripten/get_emscripten.sh
R360_PROFILE=mobile bash emscripten/render360/build.sh
```

The intended package is:

```text
render360-port.json
portal.mjs
portal.wasm
*.worker.js / Source side modules as needed
portal-working-set.json
```

The mobile profile is deliberately separate from the inherited demo build. The inherited port starts around 2 GiB of WebAssembly memory with an eight-worker pthread pool. The Render360 mobile profile starts smaller and is tuned for phone bring-up rather than desktop-style reservation.

Current mobile bring-up defaults in the Source branch are approximately:

- 512 MiB initial Wasm memory;
- memory growth up to 1536 MiB;
- two pthread workers;
- Portal only;
- HDR off;
- color correction off;
- WebGL 2/ES3 Source compatibility renderer;
- host-controlled `callMain()` after player content is ready.

These values are test targets, not final guarantees. Actual iPhone profiling decides whether they need to move lower or higher.

## Filesystem and VPK strategy

Render360 now has two complementary content paths:

### Direct/lazy VPK path

The PC content source recognizes Source VPK directory files and can resolve requested logical paths from Portal/HL2/platform archives using lazy reads. This avoids eagerly copying whole VPK archives into JavaScript or Wasm memory.

### Indexed working-set path

The runtime package can declare `portal-working-set.json` using schema `render360-pc-content-index-v1`. Entries can identify direct paths or logical Source paths/path IDs. Render360 resolves them against the player-owned content source and mounts only the files required by the current bring-up set.

The next filesystem optimization is to expose Source-compatible synchronous reads through a worker-backed or OPFS-backed bridge, reducing duplicate copies into Wasm MEMFS for large individual files.

## WebGPU architecture

Render360 is WebGPU-first for the visible PC game surface. Source 1 itself is still based on an OpenGL/GLES-oriented renderer, so WebGPU is being migrated in stages instead of falsely relabeling WebGL as WebGPU.

### Stage 1 — implemented host path

- Source/Emscripten renders to an internal Source canvas using WebGL 2.
- `runtime/pc-webgpu-presenter.js` owns the visible Render360 canvas with WebGPU.
- Each Source frame becomes a WebGPU texture and is presented with a WGSL full-screen pass.
- Source render resolution and WebGPU presentation resolution are capped separately for phone performance.

### Stage 2

Move scaling, presentation and suitable post-processing work to WebGPU while profiling frame-copy cost.

### Stage 3

Port Source renderer/material abstractions and shader generation toward Dawn/Emdawnwebgpu/WGSL, then remove the compatibility WebGL renderer only after map/render correctness is proven.

## iPhone 11-first graphics target

For a phone-class profile, the host starts with roughly a 960×540-class Source pixel budget and a 1280×720-class WebGPU presentation budget, targeting 30 FPS before attempting 60 FPS. It does not blindly render at the device's full native DPR.

This reduces:

- Source render-target memory;
- shader/fragment load;
- texture bandwidth;
- WebGPU presentation load;
- the chance of iOS terminating the page for memory pressure.

Dynamic resolution should later react to measured frame time rather than device resolution alone.

## Browser requirements

A threaded Portal runtime currently needs:

- WebAssembly;
- WebGPU for the Render360 visible presentation path;
- WebGL 2 while Source uses its compatibility renderer;
- `SharedArrayBuffer`;
- cross-origin isolation for pthreads.

Render360 preflights these requirements and should show a readable blocker instead of entering a white-screen/reload loop.

## UI / installed PWA

Current PC UI requirements are implemented in the isolated Portal PC surface:

- PC button is grouped directly beside `+`;
- the Portal hero uses fixed-size portal artwork rather than stretching the art to the modal height;
- the sheet uses a fixed scrolling body and mobile-height guard;
- standalone/PWA mode and `visualViewport` top offset are tracked;
- installed iPhone web apps receive extra top breathing room beyond the normal safe-area value;
- runtime controls/HUD are shifted below the status/notch area.

The OS folder/file chooser itself is native and cannot be completely restyled from the webpage. Render360 controls the polished flow around that picker.

## Definition of Portal playable

Do not call Portal playable just because `portal.wasm` instantiates. Minimum success is:

- Portal folder recognized;
- Source VPKs/index available;
- runtime package passes preflight;
- Source module instantiates;
- required player-owned content resolves/mounts;
- first Source frame reaches the WebGPU presenter;
- menu accepts input;
- `testchmb_a_00` loads;
- movement/camera works;
- fatal errors remain visible in Render360 diagnostics instead of causing a white-screen reload loop.

## Remaining milestones

1. Make the Source fork produce a passing `Render360-Portal-Runtime` artifact in CI.
2. Generate a complete base + `testchmb_a_00` dependency index from real player-owned content logs.
3. Instantiate that runtime in Render360.
4. Verify first frame through WebGPU.
5. Verify menu and first chamber.
6. Wire controller/touch input fully.
7. Stabilize audio.
8. Persist saves.
9. Profile iPhone memory, VPK reads, frame-copy cost, lightmaps and shader state.
10. Continue the real Source-to-WebGPU renderer migration.

GTA IV stays a later PC target after this Portal path proves the general host/runtime/content contract.
