# Render360 Xenia-Web Roadmap — V35

## Project rule

**Port Xenia; do not imitate Xenia.**

Xenia remains the source of truth for Xbox 360 behavior. Render360 owns the browser host: WebAssembly integration, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, touch/gamepad input, PWA behavior and diagnostics.

## Version map

```text
Project development line   V35
Stable deployed core       V32
Responsive UI shell        V33
Active architecture        WasmBackend
```

The stable V32 browser core and V33 UI are not renamed just because emulator research advances. V35 identifies the VMX-complete CPU milestone and the start of hot generated-WASM execution work.

## Current verified V35 boundary

Authoritative CPU gate: **GitHub Actions run 175 (`33152187091`)** at `fe11632ec806cb6be53da6ff419b77aa201f4b1f`.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_STANDARD_BASELINE                     PASS (11)
VMX128_REPRESENTATIVE                     PASS (1)
VMX_FOUNDATION                            PASS (12)
wasm32 compile matrix                     64 / 64 PASS
strict full-export link                   LINKED
rooted exports                            25
real PPC/FPU/VMX correctness suite        24 / 24 PASS
```

## Foundations closed at 100%

```text
STFS / Xbox package / XEX       100% ✓
Xenia PPC translation           100% ✓
Scalar PPC correctness          100% ✓
Guest function/control          100% ✓
FPU                             100% ✓
VMX / VMX128                    100% ✓
```

These are defined regression foundations, not claims of universal title compatibility.

### VMX closure added in V35

The dedicated VMX gate verifies VEC128 memory/byte order, INT8/INT16/INT32 modulo arithmetic, subtraction, AND/OR/XOR, equality compare, word shifts, and a representative genuine Xbox 360 `vand128` encoding. See `VMX_FOUNDATION.md`.

## Active next foundation — Hot WasmBackend

The correctness executor now acts as the reference oracle. Hot guest code should move to generated WebAssembly:

```text
finalized Xenia HIR
  -> Render360 WasmBackend
  -> generated WebAssembly guest function
  -> browser WASM engine
```

### WasmBackend closure plan

1. integer arithmetic block lowering;
2. multi-block branch/control-flow lowering;
3. scalar guest load/store/endian lowering;
4. direct/indirect call + return lowering;
5. FPU baseline lowering;
6. VMX/VMX128 baseline lowering;
7. result equivalence against the correctness executor;
8. compiled-function/block cache;
9. guest address + executable-code-version cache keys;
10. executable-page invalidation;
11. dedicated `WASM_BACKEND_FOUNDATION=PASS` gate.

## Full Xbox guest memory

After the hot execution baseline, replace the bounded correctness window with a sparse/page-backed 32-bit guest address model.

Required behavior:

- virtual and physical mappings;
- page permissions;
- aliases;
- MMIO routing;
- executable-page tracking;
- dirty/version tracking;
- browser-safe allocation instead of desktop multi-gigabyte host alias mappings.

## Real XEX mapping and entry execution

The package foundation already extracts a complete `default.xex`. Title bring-up then becomes:

1. prepare/decrypt/decompress supported XEX images;
2. map sections at their Xbox addresses;
3. apply permissions;
4. initialize TLS/import/export/module metadata;
5. initialize architectural CPU state;
6. execute the real entry point;
7. fail visibly at the first genuine missing runtime dependency.

This is the next major visible emulator milestone after WasmBackend + full guest memory.

## Kernel / xboxkrnl / XAM

Reuse Xenia kernel HLE rather than recreating Xbox APIs in JavaScript.

Target: `KernelState`, export resolver, xboxkrnl, XAM, kernel objects, memory APIs, threads/events/semaphores/timers, VFS/files and input-facing exports. No broad unknown-export `return success` stubs.

## Browser I/O / VFS

Never load a multi-gigabyte image with one `File.arrayBuffer()`. Keep random-access sources (`size`, `read(offset,length)`, `close`) backed by Blob/File slices, OPFS and cache layers where useful.

## GPU architecture

**WebGPU is primary. WebGL2 is fallback.**

```text
Xenos ringbuffer
  -> Xenia command/register/shader/resource semantics
  -> shared Render360 browser GPU layer
     -> WebGPU + WGSL + EDRAM   primary
     -> WebGL2 + GLSL ES        fallback where feasible
```

Three.js remains host/input diagnostics only and is never presented as guest Xbox rendering.

### GPU targets

- Xenos command processor integration;
- shared memory/resource tracking;
- texture and pipeline caches;
- render-target cache;
- WGSL shader translator;
- EDRAM/resolve behavior;
- presentation from guest-generated framebuffer state.

## Compatibility ladder

```text
six CPU/browser foundations complete
  -> WasmBackend
  -> compiled-function cache + invalidation
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
VMX / VMX128 foundation            100% ✓
Hot WasmBackend                    ~3%   ← ACTIVE
Full guest memory                  ~10%
Real default.xex entry             ~5%
Kernel/xboxkrnl/XAM                ~1–2%
Xenos GPU                          ~1–2%
WebGPU backend                     ~2%
WebGL2 fallback                    ~1%
First genuine title boot           ~24–25%
Small XBLA/Braid-class playable    ~17–18%
Portal-class playable              ~10–11%
Overall Render360                  ~27–29%
```

## Status rule

Never report `PLAYABLE`, `FIRST DRAW`, `FIRST PRESENT`, shader translation, guest FPS or title boot unless those events came from genuine guest execution through the corresponding emulator subsystem.
