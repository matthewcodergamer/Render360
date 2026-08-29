# Render360 — Xenia-Web

**Experimental browser-native Xbox 360 emulator built around real Xenia architecture, WebAssembly and WebGPU.**

> Render360 is an emulator research project. It is **not yet claiming commercial-game playability**. The repository deliberately keeps the commercial-frame gate closed until pixels produced by a real extracted title pass through the real GPU path and are presented without the bounded bring-up raster.

This `README.md` is the authoritative public status page. Old percentages in historical notes are not compatibility scores and should not be used to claim that a title is playable.

## Current status — August 29, 2026

```text
DISC / PACKAGE INPUT                         VERIFIED FOUNDATION
RETAIL XEX PREP + PE MAPPING                VERIFIED FOUNDATION
XENIA PPC/HIR + SPARSE GUEST MEMORY         VERIFIED FOUNDATION
KERNEL / XAM IMPORT EXECUTION               VERIFIED FOUNDATION
REAL TITLE RING + CP_RB_WPTR CONSUMPTION    CI-PROVEN FOUNDATION
VdSwap -> REAL RING -> XE_SWAP               CI-PROVEN FOUNDATION
TITLE SHADER / TEXTURE / RESOURCE CAPTURE   CI-PROVEN FOUNDATION
UPSTREAM XENIA SHADER INTERPRETER           CI-PROVEN FOUNDATION
XENIA XENOS -> SPIR-V                       IN STRICT CI INTEGRATION
SPIR-V -> NAGA -> WGSL                      IMPLEMENTED; CI INTEGRATION
WGSL -> WEBGPU SHADER MODULE                IMPLEMENTED; CONVERTER-DEPENDENT
TITLE-PRODUCED RASTER / EDRAM RESOLVE       NOT YET VERIFIED
FIRST COMMERCIAL-TITLE FRAME                NOT YET VERIFIED
COMMERCIAL GAMEPLAY                         NOT YET VERIFIED
```

There is intentionally no new overall percentage here. A browser emulator can have many individually complete foundations while still being blocked from commercial gameplay by one missing execution or rendering boundary. Render360 now reports those boundaries directly.

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

### Real Xenos ring path

Render360 now models the title's command ring as a producer/consumer stream rather than a guessed one-shot PM4 buffer:

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

The authoritative title-runtime test has already reported:

```text
TITLE_RUNTIME_REAL_VD_SWAP_ABI=PASS
TITLE_RUNTIME_REAL_VD_SWAP_TO_XE_SWAP=PASS
TITLE_RUNTIME_COMMERCIAL_PRESENT_PATH=PASS
TITLE_RUNTIME_CAPTURED_RING_TO_XENOS=PASS
```

This proves the **commercial presentation mechanism**, not a commercial game's rendered pixels.

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

### Naga browser converter

`tools/spirv-wgsl/` contains a dedicated Rust/WASM converter using Naga's real `spv-in` and `wgsl-out` backends. It:

1. validates SPIR-V alignment and magic;
2. parses the complete module with Naga;
3. runs Naga validation;
4. emits non-empty WGSL;
5. returns an error instead of inventing shader output when conversion fails.

`build-spirv-wgsl.sh` produces a browser `wasm-bindgen` module. `SPIR-V WGSL Browser Converter` CI builds it only against a verified Xenia bootstrap, runs Xenos -> SPIR-V -> WGSL end to end, and publishes the generated converter beside the browser runtime only after the test is green.

### Browser WebGPU shader validation

`render360-webgpu-title-shaders.mjs` takes a captured title shader through Xenia SPIR-V and Naga WGSL, passes the source to `GPUDevice.createShaderModule`, inspects WebGPU compilation messages and caches successful modules by Xenos shader identity.

A successfully translated or compiled shader **does not count as a frame**. The first-commercial-frame gate still requires title-produced pixels.

## Why the commercial-frame gate is still closed

The current low-level Xenos bring-up draw path contains a deliberately bounded software triangle rasterizer. It is useful for proving command flow, EDRAM storage, frame hashes and browser presentation plumbing, but it is not a commercial game's raster output.

Render360 tracks frame provenance. `r360_xenos_real_title_frame_ready()` explicitly rejects the bounded-raster provenance bit. Therefore:

```text
real PM4 + real shader bytes + real XE_SWAP
                        !=
              real commercial frame
```

The remaining rendering boundary is to bind the title's actual vertex/index buffers, translated VS/PS, constants, textures, render targets, depth/blend state and EDRAM/resolve behavior into the WebGPU draw path, then present the resulting title pixels at `VdSwap` / `XE_SWAP`.

A second useful fast path is possible when a game has already resolved a supported frontbuffer into guest memory: decode the real frontbuffer fetch at `VdSwap`, read/de-tile the backed title pixels, and present those directly. That path must also remain fail-closed for unsupported formats/layouts.

## Authoritative CI rules

Render360 does not promote a subsystem because code exists. A bounded contract is considered closed only when its implementation and regression/critic gates are green.

The full `Xenia WASM32 Bootstrap` gate currently covers package/XEX preparation, LZX/AES, PE mapping, PPC/HIR, kernel imports/services, guest runtime, sparse memory, Xenos PM4, title shader/resources, shader interpreter, EDRAM/frame foundations, title ring/MMIO and captured ring submission.

The dedicated `Extracted XEX GPU Traffic Bridge` gate isolates the title-to-GPU path. The `SPIR-V WGSL Browser Converter` gate is responsible for the new accelerated shader bridge.

Strict Wasm linking uses `ERROR_ON_UNDEFINED_SYMBOLS=1`. Missing Xenia shader semantics are added from the real pinned upstream source; they are not hidden with success stubs.

## Important implementation files

- `render360-xdvdfs.mjs` — browser-native XDVDFS virtual disc reader.
- `render360-iso-title-controller.mjs` — ISO -> retail XEX title handoff.
- `render360-browser-title-runtime.mjs` — modern bootstrap loader and browser title runtime.
- `render360-browser-modern-iso-bridge.mjs` — public ISO UI integration and exact blocker reporting.
- `render360-browser-title-hle.mjs` — relocated browser HLE fallback shims.
- `src/xenia_web_bootstrap/ppc_translation_probe.cpp` — Xenia PPC/scanned code-window bridge.
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

```text
1. strict-link and validate full Xenia Xenos -> SPIR-V accelerator
2. validate Naga SPIR-V -> WGSL browser converter
3. validate translated title WGSL with Safari/WebGPU
4. bind real title vertex/index/constants/textures into WebGPU draws
5. implement/expand EDRAM render-target + resolve behavior from real blockers
6. present title-produced frontbuffer at VdSwap / XE_SWAP
7. run a lawfully obtained commercial ISO and implement its first exact blockers
8. repeat until menu/gameplay/input are sustained
```

The game itself is the final compatibility test. Synthetic fixtures stay useful for regression coverage, but they cannot promote `FIRST COMMERCIAL-TITLE FRAME` or `COMMERCIAL GAMEPLAY`.

## Legal / project scope

Render360 does not include commercial Xbox 360 games, copyrighted title assets, keys or firmware. Use only content you are legally permitted to use. Xenia-derived portions remain subject to upstream Xenia licensing terms; see `LICENSE_XENIA.txt`.
