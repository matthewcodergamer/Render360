# Render360 browser-native architecture

Render360 is not a JavaScript reimplementation of Xbox 360 behavior. Upstream Xenia remains the semantic authority; Render360 retargets Xenia CPU/GPU/runtime behavior to browser-native execution primitives.

## Core rule

```text
Xbox 360 program state
  -> Xenia parsers/frontends/semantic builders
  -> portable Xenia semantic IR / finalized HIR
  -> Render360 browser backends
       CPU scalar/FPU      -> generated WebAssembly
       VMX/VMX128          -> WebAssembly SIMD v128 where semantics match
       guest memory        -> shared page-backed WebAssembly memory
       Xenos commands      -> shared API-independent Xenos semantic layer
                               -> WebGPU/WGSL primary
                               -> WebGL2/GLSL ES fallback
       audio               -> WebAudio / AudioWorklet
```

No host-side Three.js scene, precomputed frame, hard-coded guest result, second PPC interpreter, or JavaScript opcode decoder may be presented as Xbox output.

## Performance architecture

### 1. Translate once, execute many times

The hot CPU path must be:

```text
guest address
  -> Xenia function discovery / PPC translation
  -> finalized HIR
  -> generated Wasm function
  -> compiled-function cache
  -> direct cached dispatch
```

The cache key must include guest address plus an executable-code version. Generated guest code or self-modifying code increments the relevant page version and invalidates dependent cached functions.

Repeated execution must never re-run PPC decoding or HIR construction unless the code version changed.

### 2. Keep hot loops out of JavaScript

JavaScript is host glue only: lifecycle, UI, input, file selection, presentation and browser integration.

Avoid hot `WASM -> JS -> WASM` transitions. CPU dispatch, guest memory access, vector arithmetic and most command production stay inside Wasm/shared memory. GPU submission consumes shared command/state buffers in coarse batches.

### 3. VMX / VMX128 maps to Wasm SIMD

Where Xenia HIR semantics match WebAssembly SIMD exactly, lower VEC128 operations to `v128` instructions rather than four scalar operations. Unsupported or semantically mismatched forms fail closed or use a measured fallback path.

Priority vector surface:

```text
v128 load/store + Xbox byte order
byte / halfword / word modulo add/sub
AND / OR / XOR
integer equality / ordered comparisons
lane shifts
permute / swizzle forms used by real titles
representative VMX128 forms
```

Every generated SIMD program is compared against the existing Xenia correctness oracle using exact 128-bit register and memory state.

### 4. Sparse page-backed Xbox guest memory

The bounded probe window is temporary. Production memory must model the Xbox virtual address space without committing a monolithic 4 GiB allocation.

```text
Xbox virtual address
  -> page table / mapping metadata
  -> committed Wasm/shared-memory backing page
  -> permissions + executable version
```

Required behavior includes aliases, virtual/physical mappings, page protection, executable tracking, MMIO routing, and fault/fail-closed behavior.

Game packages and disc images are streamed into the virtual filesystem/page cache on demand rather than copied wholesale into Wasm memory.

### 5. Browser worker topology

Do not mirror Xenon's 3-core/6-thread hardware literally. Schedule browser work by cost and synchronization behavior.

Target topology after single-thread correctness is stable:

```text
main thread      UI, input, presentation, browser lifecycle
CPU worker       primary guest scheduling / generated Wasm execution
worker pool      secondary guest work and async translation jobs
GPU worker       Xenos command processing / shader translation / resource prep
AudioWorklet     low-latency audio mixing/output
```

SharedArrayBuffer/shared Wasm memory is the preferred state transport. Cross-worker messages carry control metadata, not bulk guest state.

Deployment must support the cross-origin isolation headers required for shared-memory browser threading.

### 6. Shared Xenos semantic layer

WebGPU and WebGL2 must not contain separate Xbox emulation rules.

```text
Xenos ringbuffer / packets / shaders / EDRAM state
             -> Xenos semantic objects
                  resources
                  draw state
                  shader IR
                  render-target / EDRAM operations
                  synchronization
             -> backend adapters
                  WebGPU/WGSL
                  WebGL2/GLSL ES (only feasible subset)
```

WebGPU is primary because it maps more naturally to modern explicit GPU APIs. WebGL2 is compatibility mode and may expose fewer features, but both consume identical guest semantics.

### 7. Low-end-first rendering policy

Internal Xbox rendering resolution is decoupled from device display resolution. Initial mobile profiles should support low internal resolutions such as 426x240, 640x360, 854x480 and 960x540, then upscale in WebGPU. 720p is a later/high-end profile rather than the baseline.

Shader translation, pipeline creation and resource uploads are cached. Expensive compilation work should be asynchronous where ordering permits.

## Closure order

```text
1. generated FPU parity
2. generated VMX / VMX128 via v128
3. broad WasmBackend equivalence matrix
4. compiled-function cache + fast dispatch
5. executable-page versioning / invalidation
6. WASM_BACKEND_FOUNDATION=PASS
7. sparse/page-backed Xbox guest memory
8. map real default.xex sections
9. initialize module/CPU state and enter real default.xex
10. minimum xboxkrnl / XAM demanded by the title
11. shared Xenos semantic layer
12. WebGPU primary backend
13. WebGL2 fallback
14. WebAudio / AudioWorklet
15. first genuine guest-produced framebuffer
16. small XBLA title startup/gameplay
17. Portal-class compatibility
18. GTA-class optimization after smaller titles are stable
```

## Verification rule

A subsystem advances only after a separate critic test compares generated-browser execution against Xenia semantics. CPU/FPU/VMX critics compare exact architectural and memory state. GPU critics will compare guest-produced render state and eventually frame output; visual comparison is not meaningful until genuine Xenos output exists.
