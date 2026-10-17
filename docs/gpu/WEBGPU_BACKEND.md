# WebGPU Xenos backend (step 2)

Goal: render titles on the GPU through WebGPU, as a port of Xenia's Vulkan
backend (`src/xenia/gpu/vulkan`), with no CPU drawing in the play path. The
software renderer (`xenos_soft_renderer.cpp`) stays as the reference that
GPU frames are compared against.

## What Xenia's Vulkan backend does, and the WebGPU equivalent

| Xenia (Vulkan) | Role | Render360 (WebGPU) |
| --- | --- | --- |
| `SharedMemory` + `VulkanSharedMemory` | 512 MiB GPU copy of guest physical memory; ranges a draw needs are uploaded on demand; CPU writes invalidate pages through physical-memory access watches | Same base class compiled to wasm. Watches: a per-page watch bit next to the executable-alias count in the sparse page table, so JIT inline stores (which already check that field) take the slow path and invalidate. Uploads go through a staging ring and `copyBufferToBuffer` in command order. |
| `PrimitiveProcessor` + `VulkanPrimitiveProcessor` | Index buffers, primitive type conversion (fans, quads, rectangles), 32-bit index endian handling | Same base class; converted index data is uploaded to a GPU buffer. |
| `SpirvShaderTranslator` + `VulkanPipelineCache` | Xenos microcode → SPIR-V; pipelines keyed by shaders and render state | The translator already builds into the core (`xenos_spirv_translation_probe.cpp`); SPIR-V → WGSL through Naga (`render360-spirv-wgsl-runtime.mjs`); one WebGPU render pipeline per Xenia pipeline description. Descriptor sets map 1:1 to bind groups (shared memory/EDRAM, constants, vertex textures, pixel textures — 4, the WebGPU limit). |
| `VulkanRenderTargetCache` (host render targets path) | EDRAM modelled with host render targets; ownership transfers between formats; resolves (EDRAM → shared memory) with compute shaders | Host render targets as WebGPU textures; transfers and resolves with Xenia's own compute shaders (`shaders/*.xesl`, built to SPIR-V by Xenia), converted to WGSL by Naga at build time. No fragment shader interlock path (WebGPU has none). |
| `TextureCache` + `VulkanTextureCache` | Texture keys from fetch constants; untiling and format conversion with compute shaders (`texture_load_*`); invalidation through shared-memory watches | Same base class; Xenia's `texture_load_*` shaders via Naga; WebGPU textures. |
| `VulkanCommandProcessor` | PM4 → draws, copies, swaps; system constants; submission | The core's PM4 processor (`xenos_gpu_foundation.cpp`) calls the backend per draw/copy/swap; the backend records a command stream (like Xenia's `DeferredCommandBuffer`) that `render360-webgpu-xenos.mjs` replays into a `GPUCommandEncoder` and submits at swap. |

## Data flow per frame

1. Guest CPU writes vertex/index/texture data → watch bits invalidate pages.
2. PM4 draw → backend: `PrimitiveProcessor`, `SharedMemory::RequestRange`
   for vertex fetch and index ranges (uploads only invalid pages), texture
   cache requests, render target cache update, pipeline lookup, system and
   guest constants → command stream.
3. Resolve (copy draw) → render target cache resolve: compute dispatch that
   writes the shared memory buffer and marks the range as GPU-written
   (`RangeWrittenByGpu`, as Xenia does).
4. Swap → front buffer texture presented to the canvas; the encoder is
   submitted.

## Order of work (each with a test in headless Chromium + SwiftShader)

1. Physical write watches in sparse guest memory (unit test: watched page,
   JIT store, interpreter store, kernel write all invalidate exactly once).
2. Shared memory: base class + WebGPU subclass + JS buffer mirror (test:
   upload, CPU write, re-request uploads only the dirty page; GPU readback
   matches guest memory).
3. Pipeline + draw path: translated shaders, vertex fetch from shared
   memory, system constants, one host render target, present (test: a
   captured Banjo frame's draws match the software renderer within a
   tolerance).
4. Render target cache with EDRAM transfers and resolves.
5. Texture cache with tiled/endian-swapped formats.
6. Play path switched to WebGPU; software renderer only for verification.

Rules kept: no game data, decrypted XEX or game-derived shaders in the
repository; translated shaders live only in the browser at run time.
Xenia's own compute shaders (resolve, texture load) are Xenia's code and are
converted from Xenia's SPIR-V at build time.
