# Render360 Xenia-Web Roadmap — V34

## Project rule

**Port Xenia; do not imitate Xenia.**

Xenia remains the source of truth for Xbox 360 behavior. Render360 owns the browser host: WebAssembly integration, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, touch/gamepad input, PWA behavior and diagnostics.

## Version map

```text
Project development line   V34
Stable deployed core       V32
Responsive UI shell        V33
```

The stable V32 browser core and V33 UI are not being renamed just because CPU research advanced. V34 identifies the active emulator-development milestone.

## Current verified V34 boundary

Authoritative CPU gate: **GitHub Actions run 168 (`33149796414`)**.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
wasm32 compile matrix                     64 / 64 PASS
strict full-export link                   LINKED
rooted exports                            25
real PPC/FPU/VMX correctness suite        24 / 24 PASS
```

## Foundations closed at 100%

### STFS / Xbox package / XEX

Complete for the defined browser-loader baseline: package recognition, STFS traversal/hash-chain behavior, root `default.xex` discovery, fragmented extraction, complete byte reconstruction and structural XEX metadata inspection.

### Xenia PPC translation

Complete for the defined portable translation baseline: frontend, translator, scanner, PPC emitter families, HIR, compiler/pass framework, browser host seams and strict wasm32 linking.

### Scalar PPC correctness

Complete for the defined scalar baseline: arithmetic, comparisons, branches, CTR loops, scalar guest memory, endian conversion, CR/LR/CTR and return boundaries.

### Guest function/control

Complete for the defined control baseline: direct calls, nested calls, CTR/bctrl indirect calls, LR save/restore, stack-frame-shaped flow, guest-memory LR spill/reload and caller resume.

### FPU

Complete for the defined FPU baseline: FPR state/load/store, FLOAT64 add/sub/mul/div, floating compare, common conversions, round-to-zero, f64/f32 rounding and the current upstream-Xenia FPSCR update/readback path.

## Active next foundation — VMX / VMX128

Current proven vector behavior:

```text
VEC128 guest load                          ✓
Xenia-compatible byte ordering             ✓
unsigned INT8 vector add / vaddubm         ✓
VEC128 guest store                         ✓
```

Closure work:

1. INT16 modulo add;
2. INT32 modulo add;
3. vector subtraction;
4. AND / OR / XOR;
5. integer vector comparisons;
6. common vector shifts;
7. representative Xbox 360 VMX128 forms;
8. dedicated `VMX_FOUNDATION=PASS` regression gate.

## Next architecture — hot WasmBackend

After VMX baseline closure, stop expanding the correctness executor indefinitely.

```text
finalized Xenia HIR
  -> Render360 WasmBackend
  -> generated WebAssembly guest function
  -> browser WASM engine
```

Required follow-up:

- translated-function/block cache;
- guest address + code-version cache key;
- executable-page versioning;
- invalidation when guest executable memory changes;
- correctness fallback for unsupported hot-path operations.

## Full Xbox guest memory

Replace the current bounded correctness window with a sparse/page-backed 32-bit guest address model.

Required behavior:

- virtual and physical mappings;
- page permissions;
- aliases;
- MMIO routing;
- executable-page tracking;
- dirty/version tracking;
- browser-safe allocation rather than desktop 4+ GB host alias mappings.

## Real XEX mapping and entry execution

The package foundation already extracts a complete `default.xex`. The next title-bring-up stage is:

1. prepare/decrypt/decompress supported XEX images;
2. map sections at their Xbox addresses;
3. apply permissions;
4. initialize TLS/import/export/module metadata;
5. initialize architectural CPU state;
6. execute the real entry point;
7. fail visibly at the first genuine missing runtime dependency.

This is the next major visible emulator milestone.

## Kernel / xboxkrnl / XAM

Reuse Xenia kernel HLE rather than recreating Xbox APIs in JavaScript.

Target:

- `KernelState`;
- export resolver;
- xboxkrnl;
- XAM;
- kernel objects;
- memory APIs;
- threads/events/semaphores/timers;
- VFS/file APIs;
- input-facing exports.

No broad unknown-export `return success` stubs.

## Browser I/O / VFS

Never load a multi-gigabyte image with one `File.arrayBuffer()`.

Use random-access sources:

```text
size()
read(offset, length)
close()
```

Backends: Blob/File slices, OPFS, IndexedDB cache/chunks where useful, and explicit HTTP Range sources when authorized.

## GPU architecture

**WebGPU is primary. WebGL2 is fallback.**

```text
Xenos ringbuffer
  -> Xenia command/register/shader/resource semantics
  -> shared Render360 browser GPU layer
     -> WebGPU + WGSL + EDRAM   primary
     -> WebGL2 + GLSL ES        fallback where feasible
```

Do not route guest rendering through Three.js. The existing Three.js arena remains a host/input diagnostic only.

### WebGPU targets

- Xenos command processor integration;
- shared memory/resource tracking;
- texture cache;
- pipeline cache;
- render-target cache;
- WGSL shader translator;
- EDRAM/resolve behavior;
- presentation from guest-generated framebuffer state.

## Audio

Port Xbox/Xenia audio behavior incrementally to WebAudio/AudioWorklet with a ring buffer and guest/host timing kept separate.

## Compatibility ladder

```text
CPU/VMX foundation closure
  -> WasmBackend
  -> full guest memory
  -> real default.xex entry
  -> kernel/XAM
  -> first Xenos packets
  -> first guest shader
  -> first guest draw
  -> first guest framebuffer
  -> simple XBLA title
  -> Braid-class playable
  -> Portal-class bring-up
```

## Current progress

```text
Package/XEX foundation             100% ✓
PPC translation foundation         100% ✓
Scalar PPC foundation              100% ✓
Guest control foundation           100% ✓
FPU foundation                     100% ✓
VMX / VMX128                       ~15%
Hot WasmBackend                    ~3%
Full guest memory                  ~10%
Real default.xex entry             ~5%
Kernel/xboxkrnl/XAM                ~1–2%
Xenos GPU                          ~1–2%
WebGPU backend                     ~2%
WebGL2 fallback                    ~1%
First genuine title boot           ~23–24%
Small XBLA/Braid-class playable    ~16–17%
Portal-class playable              ~9–10%
Overall Render360                  ~25–27%
```

## Status rule

Never report `PLAYABLE`, `FIRST DRAW`, `FIRST PRESENT`, shader translation, guest FPS or title boot unless those events came from genuine guest execution through the corresponding emulator subsystem.
