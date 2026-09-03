# Render360 WebGPU / Wasm Browser Runtime Foundation

This layer turns the browser roadmap into concrete, capability-gated runtime code without claiming that the remaining Xbox 360 hardware is already emulated.

## Implemented now

### CPU / Wasm integration

Render360 keeps the existing Xenia-derived PPC -> HIR path and generated WebAssembly execution probes. This change does not replace the working Braid startup path. It adds a shared-memory constructor for the future threaded backend with the Xbox 360 512 MiB RAM size represented as an 8192-page **maximum**, while avoiding a mandatory 512 MiB allocation at page load.

`createXboxSharedMemory()` is fail-closed: shared memory is enabled only when `SharedArrayBuffer` exists and, in production mode, the page is cross-origin isolated.

### WebGPU Xenos foundation

`render360-webgpu-runtime.mjs` provides real WebGPU resources:

- a 10 MiB Xenos eDRAM storage-buffer mirror;
- a raw storage-buffer vertex-fetch arena and WGSL helpers for unaligned Xbox vertex layouts;
- a render-target texture cache suitable for render-to-texture workloads;
- asynchronous render and compute pipeline caches using `createRenderPipelineAsync` / `createComputePipelineAsync` when exposed by the browser;
- a compute path that resolves a **canonical linear RGBA8** region from the eDRAM mirror to a WebGPU texture;
- WebGPU presentation of captured real title frontbuffers, with Canvas2D as a fail-safe fallback;
- device-loss and resource telemetry.

The linear resolve is deliberately not described as complete Xenos eDRAM emulation. Xbox tiled layouts, all render-target formats, MSAA sample addressing, resolves, memexport, and the full command processor still need title-driven implementation.

### Shader path

The existing title shader path remains:

`captured Xenos microcode -> Xenia-derived SPIR-V translator -> Naga SPIR-V/WGSL converter -> WebGPU shader module validation`.

The new async pipeline cache is the next stage after shader module creation so a title can avoid synchronously compiling every render/compute pipeline on the UI thread.

### Streaming storage

`render360-streaming-source.mjs` adds range sources for:

- browser `Blob` / `File` objects;
- OPFS files;
- HTTP byte-range sources;
- an LRU block cache for cross-block reads.

This allows ISO/package readers to request bounded byte windows rather than requiring the entire game image in JavaScript RAM. Existing OPFS persistence remains compatible.

### Threading foundation

`render360-web-worker-pool.mjs` adds a SharedArrayBuffer-aware host worker pool and a six-logical-thread Xenon planning contract. The current Xbox guest scheduler is still cooperative and context migration is not yet safe enough to claim one guest hardware thread per Web Worker, so the contract explicitly reports `oneGuestThreadPerWorker: false` and `fullXenonSmtScheduler: false`.

### Development server

`serve.py` now serves the repository root and emits:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`

That makes local SharedArrayBuffer/Wasm-thread experiments possible in compatible browsers. Any deployed host must provide equivalent isolation headers before the shared-thread mode can activate; otherwise Render360 stays on the cooperative scheduler.

## What this does not claim

This is not a complete browser port of Xenia and it does not prove Braid, Portal, GTA V, or Watch Dogs has reached a frame. A genuine title frame is counted only when the existing VdSwap/frontbuffer provenance path captures guest-produced pixels. The next Braid device reports remain authoritative for CPU/kernel/GPU progress.

## Next title-driven GPU work

The next useful GPU changes should be implemented only when real title command traffic reaches them: Xenos packet coverage, tiled render-target addressing, depth/stencil formats, MSAA resolve rules, texture fetch formats, and memexport. Portal-style recursive render-to-texture can then use the render-target cache already introduced here instead of adding a second graphics architecture.
