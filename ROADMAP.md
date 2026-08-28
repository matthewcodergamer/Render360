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

The stable V32 browser core and V33 UI are not renamed just because emulator research advances. V35 now identifies six completed CPU/browser foundations plus the first green finalized-HIR -> generated-WebAssembly execution stage.

## Current verified V35 boundary

Authoritative code-bearing gate: **GitHub Actions run 183 (`33153679117`)** at implementation commit `edca8d59cbdc7eb38e8b11adc753759d68d6e7af`.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_STANDARD_BASELINE                     PASS (11)
VMX128_REPRESENTATIVE                     PASS (1)
VMX_FOUNDATION                            PASS (12)
wasm32 compile matrix                     65 / 65 PASS
strict full-export link                   LINKED
rooted exports                            30
real PPC/FPU/VMX correctness suite        24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW              PASS
WASM_BACKEND_STAGE                        SCALAR_DATAFLOW_PASS
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

## Hot WasmBackend — active

The correctness executor remains the reference oracle. Run 183 proves the first hot generated-WASM path is real:

```text
real PPC addi r3,r4,5 / blr
  -> Xenia scanner/frontend/translator
  -> Xenia finalized HIR
       LOAD_CONTEXT r4
       ADD INT64 +5
       STORE_CONTEXT r3
  -> Render360 WasmBackend
  -> generated child WebAssembly module
  -> imported parent WebAssembly.Memory
  -> real Xenia PPCContext
  -> executed result
```

Measured stage:

```text
wasm_backend_module_bytes=73
wasm_backend_lowered_instructions=2
xenia_correctness_r3=12
generated_wasm_r3=12
generated_wasm_reuse_r3=105
WASM_BACKEND_SCALAR_DATAFLOW=PASS
```

The same compiled child module produces `12` from runtime `r4=7`, then `105` from runtime `r4=100`, so the generated code is not simply baking in a test result.

Current first-stage lowering surface includes INT64 constants, context loads, assignment, ADD/SUB/AND/OR/XOR and the first PPCContext output store. Unsupported HIR fails closed.

### WasmBackend closure plan

1. broaden scalar value lowering and general context outputs;
2. comparisons, truncation/extension and shifts;
3. multi-block branch/control-flow lowering;
4. scalar guest load/store/endian lowering;
5. direct/nested/CTR-indirect call + return lowering;
6. FPU baseline lowering;
7. VMX/VMX128 baseline lowering;
8. broad generated-WASM equivalence matrix against the correctness executor;
9. compiled-function/block cache;
10. guest address + executable-code-version cache keys;
11. executable-page invalidation;
12. dedicated `WASM_BACKEND_FOUNDATION=PASS` gate.

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

## Compatibility ladder

```text
six CPU/browser foundations complete
  -> WasmBackend scalar/dataflow stage              ✓ first stage
  -> WasmBackend control/memory/calls/FPU/VMX
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
Hot WasmBackend                    ~12%  ← ACTIVE
Full guest memory                  ~10%
Real default.xex entry             ~5%
Kernel/xboxkrnl/XAM                ~1–2%
Xenos GPU                          ~1–2%
WebGPU backend                     ~2%
WebGL2 fallback                    ~1%
First genuine title boot           ~25%
Small XBLA/Braid-class playable    ~18%
Portal-class playable              ~10–11%
Overall Render360                  ~29%
```

## Status rule

Never report `WASM_BACKEND_FOUNDATION=PASS`, `PLAYABLE`, `FIRST DRAW`, `FIRST PRESENT`, shader translation, guest FPS or title boot unless those events came from genuine execution through the corresponding emulator subsystem.
