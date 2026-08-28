# Render360 Browser-Native Architecture

Render360 is not a JavaScript reimplementation of Xbox 360 hardware and it is not a Windows emulator wrapped in a web page. The target is to retarget Xenia's Xbox 360 semantics to browser-native execution primitives with as little host-layer overhead as possible.

## Core rule

**Translate expensive guest semantics once, execute cheaply many times.**

```text
Xbox 360 package / XEX
        |
        v
Xenia package + loader semantics
        |
        +----------------------------+
        |                            |
        v                            v
PowerPC / FPU / VMX              Xenos command stream
        |                            |
Xenia scanner/frontend           shared Xenos semantic IR
        |
Xenia finalized HIR                 |
        |                         +--+------------------+
Render360 WasmBackend            |                     |
        |                         v                     v
cached generated WASM          WGSL                 GLSL ES
        |                         |                     |
WebAssembly engine             WebGPU                WebGL2
        |                         |                   fallback
        +-------------+-----------+
                      |
                browser / iOS host
```

WebGPU is the primary graphics target. WebGL2 is a compatibility backend under the same Xenos semantic layer; it must not develop a second set of Xbox GPU semantics.

## Lessons adopted from browser-native game ports

### 1. Keep hot execution in WebAssembly

JavaScript should coordinate browser lifecycle, UI, input, file selection, presentation and other host-only integration. Guest CPU execution must not bounce through JS for individual instructions, values, memory accesses or common guest calls.

Preferred hot path:

```text
finalized Xenia HIR
  -> generated WASM
  -> live PPCContext / guest memory
  -> cached WASM-to-WASM guest dispatch
```

Avoid:

```text
WASM -> JS -> WASM -> JS
```

inside guest execution loops.

### 2. Compile each guest function once per code version

The long-term hot cache key is conceptually:

```text
(guest virtual address, executable-page/code version, translation mode)
```

A cache hit must jump directly to the already generated function/module representation. Translation is not allowed on every call.

Executable guest writes increment the affected code-page version and invalidate dependent compiled functions. Unsupported or stale code fails closed rather than executing an old translation.

### 3. Fast guest dispatch

Direct `bl`, nested calls and CTR/`bctrl` calls should converge on one fast generated guest-function dispatch mechanism.

Development correctness may use a registry/dispatcher, but the optimized architecture should minimize generic host crossings and move toward a compact address-to-function-index table or equivalent WASM-native dispatch structure.

### 4. Use WASM SIMD for compatible VMX/VMX128 semantics

Where Xenia's finalized HIR vector semantics match WebAssembly SIMD exactly, lower to native `v128` operations rather than scalarizing four or sixteen lanes.

Do not force incompatible Xbox semantics into an approximate SIMD instruction. Cases requiring Xbox-specific saturation, lane ordering, permutes, flags or edge behavior must use explicit exact lowering and remain regression-gated against the Xenia oracle.

### 5. Shared memory instead of copies

CPU, GPU command processing and future workers should exchange state through bounded shared-memory queues/rings rather than repeatedly serializing large structures through JavaScript.

A future threaded deployment may use SharedArrayBuffer / shared WebAssembly memory when cross-origin isolation is available. Threading is an optimization layer and must not fork CPU/GPU semantics.

### 6. Stream game data

Do not load an entire multi-gigabyte Xbox installation into WebAssembly RAM.

```text
package / ISO / content source
       -> Xbox virtual filesystem
       -> requested ranges / blocks
       -> bounded page/cache layer
       -> guest memory or GPU upload
```

The loader should preserve sparse access, reuse hot blocks and evict cold blocks under memory pressure.

### 7. Sparse guest memory

The 64 KiB probe window is only a correctness bootstrap. Retail execution requires a sparse/page-backed Xbox address-space implementation with:

- virtual/physical mappings;
- aliases;
- page permissions;
- executable-page versioning;
- copy-minimizing access to WASM backing memory;
- explicit MMIO ranges;
- bounded allocation rather than eagerly reserving real storage for the full 32-bit guest space.

### 8. WebGPU-first Xenos backend

The Xenos layer should emit API-independent resource, shader, render-target and command semantics. The WebGPU backend then maps those to modern browser GPU objects.

Important performance rules:

- create and cache bind groups/pipelines outside hot draws where possible;
- compile shaders asynchronously and cache translated shader variants;
- batch command submission;
- minimize CPU/GPU synchronization and readbacks;
- reuse buffers/textures rather than recreate every frame;
- keep EDRAM/render-target emulation on the GPU where correctness allows;
- use WebGPU compute for suitable format/resolve/conversion work;
- make internal render resolution independent of the device screen resolution.

### 9. Resolution profiles

Initial mobile profiles should prioritize emulation correctness and frame pacing over native display resolution:

```text
240p   extreme / diagnostic
360p   performance
480p   balanced
540p   quality-mobile
720p   high-end / compatibility target
```

Upscaling is a presentation step. It must not multiply guest rendering cost unnecessarily.

### 10. Separate correctness gates from optimization gates

Every optimized path is compared against Xenia semantics before promotion.

Examples:

```text
PPC bytes -> Xenia finalized HIR -> correctness executor
PPC bytes -> Xenia finalized HIR -> generated WASM
                                  -> compare architectural state/memory
```

Later GPU validation becomes:

```text
same guest command stream
 -> reference Xenia/Xenos semantics
 -> Render360 Xenos semantic IR
 -> WebGPU output
 -> state/resource checks + frame/image comparison where meaningful
```

Host-side Three.js diagnostics are never accepted as Xbox GPU output.

## iPhone-oriented execution architecture

Target long-term layout:

```text
Main thread
  UI / input / lifecycle / presentation

CPU execution worker(s)
  generated-WASM guest functions
  scheduler / PPC hardware-thread state

GPU command worker
  Xenos command decoding / shader translation preparation

WebGPU
  rendering / compute / EDRAM-related work

AudioWorklet
  low-latency audio production

Shared bounded queues
  commands / events / synchronization
```

Do not reproduce Xbox's 3-core/6-thread topology one-to-one just because the hardware had it. Browser scheduling should map emulated hardware threads onto the smallest host-worker configuration that benchmarks best on the target device.

## Immediate implementation order

1. Close generated-WASM FPU parity.
2. Close VMX/VMX128 generated-WASM parity with `v128` where exact.
3. Build a broad generated-WASM vs Xenia equivalence matrix.
4. Add compiled guest-function cache and fast dispatch.
5. Add executable-page code versioning and invalidation.
6. Emit `WASM_BACKEND_FOUNDATION=PASS` only after the above are regression-gated.
7. Replace probe memory with sparse/page-backed Xbox guest memory.
8. Map a real extracted `default.xex` and enter its genuine entry point.
9. Add only the xboxkrnl/XAM services demanded by measured title execution.
10. Build the shared Xenos semantic layer, then WebGPU primary and WebGL2 fallback.
11. Reach a genuine guest-produced frame in a small title before scaling toward Portal/GTA-class workloads.

## Performance measurement rule

Do not optimize by estimated FPS alone. Record at minimum:

- guest instructions/functions executed;
- cache hit/miss/translation counts;
- generated-WASM module/function count and bytes;
- CPU time in translation vs execution;
- worker/JS boundary crossings;
- guest-memory page faults/cache hit rate;
- GPU command count, pipeline/shader cache hit rate and submissions;
- internal resolution;
- frame CPU time, GPU time and frame pacing.

This architecture keeps the project aligned with the central goal: **make the browser behave like another Xenia host target rather than adding another emulation layer around Xenia.**
