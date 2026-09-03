# Rendr360 — Xenia-Web

**Experimental browser-native Xbox 360 emulator built around real Xenia architecture, WebAssembly and WebGPU.**

> Render360 is an emulator research project. It is **not yet claiming commercial-game playability**. The repository deliberately keeps the commercial-frame gate closed until pixels produced by a real extracted title pass through the real GPU path and are presented without the bounded bring-up raster.

This `README.md` is the authoritative public status page. Old percentages in historical notes are not compatibility scores and should not be used to claim that a title is playable.

## Current status — September 3, 2026

```text
DISC / PACKAGE INPUT                         VERIFIED FOUNDATION
RETAIL XEX PREP + PE MAPPING                VERIFIED FOUNDATION
XENIA PPC/HIR + SPARSE GUEST MEMORY         VERIFIED FOUNDATION
KERNEL / XAM IMPORT EXECUTION               VERIFIED FOUNDATION
PERSISTENT PPC CONTEXT + FUNCTION SLICES    CI-PROVEN FOUNDATION
MID-FUNCTION YIELD / XBOX THREAD SCHEDULER  NOT YET VERIFIED
REAL TITLE RING + CP_RB_WPTR CONSUMPTION    CI-PROVEN FOUNDATION
VdSwap -> REAL RING -> XE_SWAP               CI-PROVEN FOUNDATION
TITLE SHADER / TEXTURE / RESOURCE CAPTURE   CI-PROVEN FOUNDATION
UPSTREAM XENIA SHADER INTERPRETER           CI-PROVEN FOUNDATION
XENIA XENOS -> SPIR-V                       CI-PROVEN FOUNDATION
SPIR-V -> NAGA -> WGSL                      CI-PROVEN + PUBLISHED
WGSL -> WEBGPU SHADER MODULE                BROWSER-INTEGRATED / DEVICE-RUNTIME
WEBGPU ASYNC PIPELINE CACHE                  IMPLEMENTED / BROWSER-RUNTIME CRITIC
XENOS 10 MiB EDRAM STORAGE MIRROR            IMPLEMENTED / BROWSER-RUNTIME CRITIC
RAW STORAGE-BUFFER VERTEX FETCH              IMPLEMENTED / BROWSER-RUNTIME CRITIC
LINEAR RGBA8 EDRAM COMPUTE RESOLVE           IMPLEMENTED / FOUNDATION ONLY
OPFS / HTTP RANGE STREAMING SOURCE            IMPLEMENTED / BROWSER-RUNTIME CRITIC
SAB / WEB WORKER HOST POOL                    IMPLEMENTED / GATED; GUEST SMT INCOMPLETE
REAL VdSwap FRONTBUFFER SNAPSHOT             CI-PROVEN FOUNDATION
TITLE-PRODUCED RASTER / EDRAM RESOLVE       GENERAL-TITLE PATH REMAINING
FIRST COMMERCIAL-TITLE FRAME                NOT YET VERIFIED
COMMERCIAL GAMEPLAY                         NOT YET VERIFIED
```

There is intentionally no new overall percentage here. A browser emulator can have many individually complete foundations while still be blocked from commercial gameplay by one missing execution or rendering boundary. Render360 reports those boundaries directly.

The old Naga `InvalidArrayBaseType` blocker is closed. The browser Xenia SPIR-V profile now exposes one logical shared-memory storage binding instead of the Vulkan-oriented array of unsized storage-buffer structs. The currently published converter metadata points to strict Xenia Run `33256702361`, source commit `f9f47a4643824beb9cf674706f5dea44daae5f0d`, and the chained `SPIR-V WGSL Browser Converter` Run `33256916644` completed successfully and published the verified Naga converter.

The end-to-end semantic gate requires:

```text
XENOS_VERTEX_SPIRV_TO_WGSL=PASS
XENOS_PIXEL_SPIRV_TO_WGSL=PASS
XENOS_NAGA_WGSL_VALIDATED=PASS
XENOS_WEBGPU_SHADER_TRANSLATION_PATH=PASS
```

The generated converter publication is provenance-checked so a stale Xenia runtime cannot silently overwrite a newer source state.

## New WebGPU browser architecture foundation

The browser runtime now has a dedicated WebGPU/Xenos foundation rather than only a final-frame upload helper. `render360-webgpu-runtime.mjs` owns a 10 MiB eDRAM storage buffer, raw storage-buffer vertex fetch arena, render-target cache, async render/compute pipeline compilation and a canonical linear RGBA8 compute resolve. Real VdSwap-derived frontbuffers prefer WebGPU presentation and fail over to the existing Canvas2D path without changing the real-frame provenance rules.

Large-title I/O also has bounded Blob, OPFS and HTTP byte-range readers with an LRU block cache. The worker layer can create a SharedArrayBuffer-aware host pool when COOP/COEP isolation is available, but Render360 deliberately keeps the current cooperative Xbox scheduler until PPC context migration and guest synchronization are safe to distribute across workers. See `WEBGPU_BROWSER_RUNTIME.md` for the exact implemented/incomplete boundary.

## What is real today

### Browser ISO / executable path

The browser path is no longer a mock loader:

```text
lawfully obtained Xbox 360 .iso
  -> File / Blob-backed virtual disc
  -> XISO / XGD XDVDFS mount
  -> real default.xex discovery
  -> XEX2 security metadata
  -> AES / LZX / retail XEX preparation
  -> strict Xbox PE decode and section mapping
  -> sparse Xbox guest memory
  -> Xenia-scanned PPC entry execution
  -> imported xboxkrnl / XAM service dispatch
  -> title GPU initialization and command production
```

The whole ISO does not need to be copied into Wasm memory. XDVDFS performs bounded reads from the selected browser `File` / `Blob`.

### PPC / runtime path

Render360 uses Xenia's PPC scanner/HIR frontend rather than treating two staged PPC instructions as a game runtime. Executable pages can be paged from sparse guest memory outside the active 64 KiB decoder window, with execute permissions enforced. Non-executable title data is not accepted as PPC code.

High 32-bit Xbox guest pointers are zero-extended in the relocated browser HLE path. This matters on PPC64: constructing addresses such as `0x9100FF00` with a sign-extending `lis` produces an invalid `0xFFFFFFFF9100FF00` host-side value. The browser HLE shims now build those addresses from zero with `oris` / `ori`.

Render360 now also has a browser-side **persistent Xenia PPC function session** built on the existing generated-Wasm call cache rather than a second interpreter. `render360-browser-ppc-session.mjs` keeps the same real Xenia `PPCContext` across separate browser slices, compiles the per-function modules already emitted by the Hot WasmBackend path, refreshes them when executable-page generations change, routes synchronous nested `guest_call` targets through the same context and fails closed on unknown targets.

`Persistent PPC Browser Session` Run `33257247035` proves more than pointer existence. Its adversarial test:

```text
r3 = 5
addi r3,r3,1 ; blr   -> r3 = 6
same live context     -> r3 = 7
replace executable with addi r3,r3,2 ; blr
new page generation   -> r3 = 9
unknown guest target  -> FAIL CLOSED
```

The browser may cooperatively yield between completed generated guest functions without losing architectural state. The modern ISO bridge retains this as `render360ModernTitle.ppcSession` / `persistentCpu` for explicit continuation and inspection. It intentionally does **not** blindly execute `default.xex` again after the one-shot handoff.

This is not yet a complete Xbox title scheduler. The remaining CPU-side playability boundary is **mid-function continuation plus kernel wait/yield semantics and runnable Xbox thread scheduling**. Current safe preemption is at a completed guest-function return; long guest loops and blocking kernel calls still need a continuation-aware scheduler before Render360 can call the title VM continuously scheduled.

### Real Xenos ring path

Render360 models the title's command ring as a producer/consumer stream rather than a guessed one-shot PM4 buffer:

```text
VdInitializeRingBuffer
  -> real ring base + size captured
  -> sparse guest-memory ring backing
  -> translated PPC writes CP_RB_WPTR
  -> native circular ring drain
  -> read-pointer progress / wrap handling
  -> PM4 decode
  -> persistent Xenos register / shader / resource state
```

Only title-produced words inside the producer-visible ring range are consumed. Unsupported commands fail closed and expose the exact opcode / fault word instead of being blanket-success stubs.

### Real Xbox `VdSwap` presentation mechanism

Native `xboxkrnl!VdSwap` (`0x25B`) is implemented using the Xbox/Xenia presentation contract: it writes the frontbuffer texture fetch state into the command ring, appends `XE_SWAP`, and pads the reserved ring region with Type-2 NOPs. A translated PPC test reaches this service through the kernel-import boundary, advances `CP_RB_WPTR`, and causes Xenos to consume the resulting real ring packet.

The authoritative title-runtime test has reported:

```text
TITLE_RUNTIME_REAL_VD_SWAP_ABI=PASS
TITLE_RUNTIME_REAL_VD_SWAP_TO_XE_SWAP=PASS
TITLE_RUNTIME_COMMERCIAL_PRESENT_PATH=PASS
TITLE_RUNTIME_CAPTURED_RING_TO_XENOS=PASS
```

This proves the **commercial presentation mechanism**, not a commercial game's rendered pixels.

### Real `VdSwap` frontbuffer snapshot tier

Render360 also has a fail-closed fast path for games that have already resolved the display surface into Xbox guest memory before `VdSwap`. It decodes fetch constant 0, validates that the fetch and `XE_SWAP` refer to the same mapped title surface, reads the sparse guest backing and converts the supported Xenos layout into RGBA pixels for browser presentation.

`test-xenos-frontbuffer-snapshot.mjs` is part of the strict Xenia shader/bootstrap chain. It requires:

- exact linear `8:8:8:8` pixels from mapped sparse Xbox memory;
- exact Xenos-tiled `2:10:10:10-as-16:16:16:16` de-tiling/normalization;
- correct dimensions, pitch, format, source address, source byte count and frame hash;
- failure after the source page is unmapped, proving stale or synthetic pixels cannot satisfy the gate.

This tier can produce a genuine title frame **only when an actual title supplies a supported resolved frontbuffer**. The fixture itself does not promote `FIRST COMMERCIAL-TITLE FRAME`.

## Real shader and resource work

Render360 no longer treats shader bytes as opaque telemetry only.

The Xenos state layer captures:

- vertex and pixel shader microcode;
- inline and pointer-backed shader uploads;
- fetch constants;
- texture backing addresses and dimensions;
- indirect command buffers;
- register RMW state;
- title memory writes and resource provenance.

The correctness path uses upstream Xenia's shader analysis / interpreter. The browser adaptation also includes a fail-closed 2D RGBA8 point-sampling tier backed by real sparse guest memory, including Xenos tiled addressing. CI deliberately unmaps the texture after a successful shader execution and requires the shader to fail; a fake zero-texture implementation cannot satisfy that gate.

## GPU acceleration path: Xenos -> SPIR-V -> WGSL -> WebGPU

The intended commercial-game path is GPU translation, not CPU interpretation of every pixel.

```text
captured Xenos vertex / pixel microcode
  -> upstream Xenia Shader::AnalyzeUcode
  -> upstream Xenia SpirvShaderTranslator
  -> SPIR-V binary
  -> browser shared-memory resource adaptation
  -> Naga SPIR-V frontend
  -> Naga validation
  -> Naga WGSL backend
  -> GPUDevice.createShaderModule
  -> WebGPU pipeline cache
  -> title draw / render-target / EDRAM work
```

### Xenia SPIR-V bridge

`src/xenia_web_bootstrap/xenos_spirv_translation_probe.cpp` exposes the real upstream Xenia translator from the standalone browser WASM. It validates the emitted SPIR-V magic and exports the translated binary. The strict bootstrap build includes Xenia's SPIR-V builder, shader object and full split translator semantics for ALU, vertex/texture fetch, memory export and render-backend/EDRAM lowering.

`test-xenos-spirv-translation.mjs` requires both captured vertex and pixel Xenos shaders to produce real SPIR-V and verifies invalid input fails closed.

For the WebGPU target, `prepare-xenia-spirv-browser-overlay.py` keeps Xenia's guest shared-memory arithmetic but advertises one **logical 512 MiB storage binding** during translation. Xenia's conservative 128 MiB Vulkan limit otherwise creates four descriptor bindings represented as an array of storage-buffer structs ending in runtime arrays. That descriptor shape is legal for the Vulkan backend but is not representable in WGSL; Naga correctly rejected it as `InvalidArrayBaseType`. The browser host still pages/uploads only title ranges that are actually needed—it does not allocate a literal 512 MiB device buffer just because the shader's logical address space spans Xbox shared memory.

### Naga browser converter

`tools/spirv-wgsl/` contains a dedicated Rust/WASM converter using Naga's real `spv-in` and `wgsl-out` backends. It:

1. validates SPIR-V alignment and magic;
2. parses the complete module with Naga;
3. runs Naga validation;
4. emits non-empty WGSL;
5. returns full nested validation diagnostics instead of weakening validation or inventing output.

`build-spirv-wgsl.sh` produces a browser `wasm-bindgen` module. `SPIR-V WGSL Browser Converter` CI builds it only against a verified Xenia bootstrap, runs Xenos -> SPIR-V -> WGSL end to end, uploads the verified converter artifact before publication, and only publishes when source provenance is still safe. Run `33256916644` is green and the root `render360_spirv_wgsl.meta.json` records its verified source Xenia Run `33256702361`.

### Browser WebGPU shader validation

`render360-webgpu-title-shaders.mjs` takes a captured title shader through Xenia SPIR-V and Naga WGSL, passes the source to `GPUDevice.createShaderModule`, inspects WebGPU compilation messages and caches successful modules by Xenos shader identity.

`render360-browser-modern-iso-bridge.mjs` invokes that validator automatically when the real ISO path has captured and translated both title shader stages. The result is surfaced as `render360ModernTitle.shaderWebGPU` and in the live blocker/status text. A missing browser WebGPU implementation or converter remains an explicit blocker rather than causing a fake success.

A successfully translated or compiled shader **does not count as a frame**. The first-commercial-frame gate still requires title-produced pixels.

## Why the commercial-frame gate is still closed

The current low-level Xenos bring-up draw path contains a deliberately bounded software triangle rasterizer. It is useful for proving command flow, EDRAM storage, frame hashes and browser presentation plumbing, but it is not a commercial game's raster output.

Render360 tracks frame provenance. `r360_xenos_real_title_frame_ready()` explicitly rejects the bounded-raster provenance bit. Therefore:

```text
real PM4 + real shader bytes + real XE_SWAP
                        !=
              real commercial frame
```

There are now two real rendering routes:

1. **Resolved-frontbuffer fast path:** already implemented and CI-proven for supported mapped `VdSwap` surfaces. A real game must actually reach it with title-produced pixels before the commercial-frame gate may pass.
2. **General WebGPU raster/EDRAM path:** still needs the title's actual vertex/index buffers, translated VS/PS, constants, textures, render targets, depth/blend state and EDRAM/resolve behavior bound into WebGPU draws. This is required for games that do not hand the browser an already-resolved supported frontbuffer.

Neither route may fall back to the bounded triangle when claiming a commercial frame.

## Authoritative CI rules

Render360 does not promote a subsystem because code exists. A bounded contract is considered closed only when its implementation and regression/critic gates are green.

The full `Xenia WASM32 Bootstrap` gate covers package/XEX preparation, LZX/AES, PE mapping, PPC/HIR, kernel imports/services, guest runtime, sparse memory, Xenos PM4, title shader/resources, shader interpreter, Xenia SPIR-V, the real-frontbuffer snapshot critic, EDRAM/frame foundations, title ring/MMIO and captured ring submission. The currently published Naga converter is tied to strict Xenia Run `33256702361` and source commit `f9f47a4643824beb9cf674706f5dea44daae5f0d`.

The dedicated `Extracted XEX GPU Traffic Bridge` gate isolates the title-to-GPU path. `SPIR-V WGSL Browser Converter` Run `33256916644` verifies and publishes the accelerated shader format bridge. `Persistent PPC Browser Session` Run `33257247035` separately proves live PPC architectural state across browser function slices, executable-generation refresh, and fail-closed unknown targets.

Strict Wasm linking uses `ERROR_ON_UNDEFINED_SYMBOLS=1`. Missing Xenia shader semantics are added from the real pinned upstream source; they are not hidden with success stubs.

## Important implementation files

- `render360-xdvdfs.mjs` — browser-native XDVDFS virtual disc reader.
- `render360-iso-title-controller.mjs` — ISO -> retail XEX title handoff.
- `render360-browser-title-runtime.mjs` — modern bootstrap loader, runtime export validation and persistent PPC session factory.
- `render360-browser-ppc-session.mjs` — persistent Xenia `PPCContext`, generation-aware generated-Wasm registry and function-boundary browser slices.
- `test-persistent-ppc-session.mjs` — adversarial persistence / generation / fail-closed CPU gate.
- `render360-browser-modern-iso-bridge.mjs` — public ISO UI integration, persistent CPU session exposure, WebGPU shader validation and exact blocker reporting.
- `render360-browser-title-hle.mjs` — relocated browser HLE fallback shims.
- `src/xenia_web_bootstrap/ppc_translation_probe.cpp` — Xenia PPC/scanned code-window bridge.
- `src/xenia_web_bootstrap/wasm_backend_call_probe.cpp` — generated per-function Wasm modules, shared Xenia context and executable generations.
- `src/xenia_web_bootstrap/sparse_guest_memory.cpp` — sparse Xbox guest memory.
- `src/xenia_web_bootstrap/kernel_import_probe.cpp` — real imported-thunk/kernel boundary.
- `src/xenia_web_bootstrap/title_gpu_runtime.cpp` — native title ring/MMIO and `VdSwap` services.
- `src/xenia_web_bootstrap/xenos_gpu_foundation.cpp` — PM4/register/resource/EDRAM semantics and strict real-frame provenance gate.
- `src/xenia_web_bootstrap/xenos_shader_interpreter_probe.cpp` — upstream Xenia shader interpreter bridge.
- `src/xenia_web_bootstrap/xenos_spirv_translation_probe.cpp` — upstream Xenia Xenos -> SPIR-V bridge.
- `render360-title-gpu-traffic.mjs` — captured title ring -> Xenos submission/telemetry.
- `render360-xenos-shader-runtime.mjs` — browser shader analysis, SPIR-V retrieval and WGSL handoff.
- `tools/spirv-wgsl/` — Naga SPIR-V -> WGSL converter.
- `render360-spirv-wgsl-runtime.mjs` — browser converter loader.
- `render360-webgpu-title-shaders.mjs` — WebGPU validation/cache for translated title shaders.
- `render360-title-frontbuffer.mjs` — real `VdSwap` frontbuffer capture and browser presentation.
- `test-xenos-frontbuffer-snapshot.mjs` — adversarial real-frontbuffer critic.
- `render360-webgpu-runtime.mjs` — WebGPU device foundation, 10 MiB eDRAM mirror, async pipeline cache, raw vertex fetch, render-target cache and linear compute resolve.
- `render360-streaming-source.mjs` — bounded Blob/OPFS/HTTP byte-range sources with LRU block caching.
- `render360-web-worker-pool.mjs` — cross-origin-isolated SharedArrayBuffer host worker pool foundation.
- `WEBGPU_BROWSER_RUNTIME.md` — exact browser architecture contract and remaining Xenos/threading work.
- `render360-webgpu-xenos.mjs` — browser framebuffer presentation bridge.
- `render360-webgl2-xenos.mjs` — framebuffer fallback.

## What “playable” will mean

Render360 will not label a commercial title playable merely because it mounts, decrypts, reaches the kernel, initializes the GPU or emits a swap.

A title should only be called playable after a real user-supplied, lawfully obtained game demonstrates at minimum:

- sustained PPC/runtime execution;
- required kernel/XAM services;
- continuous real PM4 consumption;
- title shader/resource translation;
- title-produced rendered frames;
- repeated presentation without synthetic frame substitution;
- working input and timing sufficient to interact with the game.

Audio, save/storage, networking and title-specific compatibility may still affect a fuller compatibility rating after the first playable graphics/input milestone.

## Near-term engineering order

The shader-format bridge, resolved-frontbuffer critic and persistent function-boundary PPC context are no longer the lead blockers. The order to reach a first playable title is now:

```text
1. run a small lawfully obtained commercial title/ISO through the modern browser path
2. capture the first exact CPU/kernel/PM4/resource blocker from that real title
3. add mid-function continuation points for long guest loops and blocking kernel calls
4. schedule runnable Xbox guest threads across cooperative browser time slices
5. keep CP_RB_WPTR / PM4 consumption advancing as those threads resume
6. use the CI-proven VdSwap frontbuffer fast path whenever the title supplies it
7. otherwise bind real title vertex/index/constants/textures into WebGPU draws
8. expand EDRAM render-target/resolve/depth/blend behavior from exact title blockers
9. sustain repeated frames, input and timing through menu/gameplay
10. add audio/save/title-specific services as the game reaches them
```

The game itself is the final compatibility test. Synthetic fixtures stay useful for regression coverage, but they cannot promote `FIRST COMMERCIAL-TITLE FRAME` or `COMMERCIAL GAMEPLAY`.

## Legal / project scope

Render360 does not include commercial Xbox 360 games, copyrighted title assets, keys or firmware. Use only content you are legally permitted to use. Xenia-derived portions remain subject to upstream Xenia licensing terms; see `LICENSE_XENIA.txt`.
