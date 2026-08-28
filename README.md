# Render360 Xenia-Web — V35 WasmBackend Bring-up / Core V32 Runtime / UI V33

Render360 is an experimental browser/iOS-oriented Xbox 360 emulator port built around **real upstream Xenia behavior**, not a second JavaScript imitation of the Xbox 360.

## Version map

```text
Render360 project / development track   V35
Stable deployed browser WASM core       V32
Responsive liquid-glass UI shell        V33
Active architecture track               V35 WasmBackend
```

The split is intentional. **Core V32** remains the deployed package/XEX runtime. **UI V33** remains the current responsive shell. **V35** contains six completed CPU/browser foundations and the first measured finalized-Xenia-HIR -> generated-WebAssembly execution stage.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128 bytes
  -> Xenia PPCScanner / PPCFrontend / PPCTranslator
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> finalized Xenia HIR
       -> Render360 correctness executor   (reference oracle)
       -> Render360 WasmBackend            (active hot path)
            -> generated WebAssembly
            -> browser WASM engine
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative V35 gate — run 183

GitHub Actions **run 183** (`33153679117`) completed successfully at implementation commit `edca8d59cbdc7eb38e8b11adc753759d68d6e7af`.

```text
V32 package/XEX core rebuild              PASS
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_STANDARD_BASELINE                     PASS (11 cases)
VMX128_REPRESENTATIVE                     PASS (1 case)
VMX_FOUNDATION                            PASS (12 cases)
wasm32 compile matrix                     65 / 65 PASS
strict full-export link                   LINKED
rooted exports                            30
real PPC/FPU/VMX correctness suite        24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW              PASS
WASM_BACKEND_STAGE                        SCALAR_DATAFLOW_PASS
```

Detailed status documents:

- [`FPU_FOUNDATION.md`](./FPU_FOUNDATION.md)
- [`VMX_FOUNDATION.md`](./VMX_FOUNDATION.md)
- [`WASM_BACKEND_FOUNDATION.md`](./WASM_BACKEND_FOUNDATION.md) — active, not yet complete

## Completed foundations — 100%

### 1. STFS / Xbox package / XEX foundation — 100% ✓

Regression-gated browser loader behavior includes LIVE/PIRS/CON recognition, Xenia-aligned STFS structures, native directory/hash-chain traversal, root `default.xex` discovery, fragmented extraction, byte-for-byte executable reconstruction, structural XEX inspection, metadata extraction and range-driven browser I/O.

Measured package baseline:

```text
core_version        32
mount_reads         5
extract_reads       3
default_xex_bytes   6144
default_xex_blocks  2
xex_entry           0x82001234
```

### 2. Xenia PPC translation foundation — 100% ✓

Locked for PPC frontend/translator/scanner, PPC context/opcodes, ALU/control/memory/FPU/Altivec emitter families, HIR, compiler framework, every tracked upstream portable compiler pass, browser host seams and strict undefined-symbol linking.

### 3. Scalar PPC correctness foundation — 100% ✓

Real PPC bytes execute through Xenia finalized HIR for integer arithmetic/bitwise operations, signed/unsigned comparisons, multi-block conditional branches, CTR loops, scalar guest memory, Xbox endian conversion, CR/LR/CTR state and return boundaries.

### 4. Guest function / control foundation — 100% ✓

Verified behavior includes direct calls, nested calls, CTR/`bctrl` runtime-indirect calls, independent Xenia scanning/translation of guest callees, LR save/update/restore, stack pointer movement, LR spill/reload through guest memory and caller resume.

### 5. FPU foundation — 100% ✓

The defined FPU baseline is locked for FPR state/load/store, FLOAT64 ADD/SUB/MUL/DIV, `fcmpu`, `fctiwz`, `fcfid`, `frsp`, current Xenia FPSCR update behavior and `mffs` readback. Render360 follows upstream Xenia rather than inventing exception flags Xenia itself still marks TODO.

### 6. VMX / VMX128 foundation — 100% ✓

The dedicated gate verifies VEC128 load/store and byte order, INT8/INT16/INT32 modulo arithmetic, subtraction, AND/OR/XOR, INT32 equality compare, word shifts, and representative genuine Xbox 360 VMX128 `vand128` behavior.

```text
VMX_STANDARD_BASELINE=PASS cases=11
VMX128_REPRESENTATIVE=PASS cases=1
VMX_FOUNDATION=PASS cases=12
```

## First real WasmBackend execution — run 183

The first hot-backend slice is now genuinely executing generated WebAssembly. The gate begins with real guest instructions:

```text
addi r3,r4,5      0x38640005
blr               0x4E800020
```

Xenia translates those bytes first. The compiler-finalized dataflow seen by `ProbeAssembler` is the expected shape:

```text
LOAD_CONTEXT r4
ADD INT64 +5
STORE_CONTEXT r3
```

Render360 then lowers that finalized Xenia HIR into a **separate child WebAssembly module**. The child imports the parent bootstrap's `WebAssembly.Memory`, reads/writes the real Xenia `PPCContext` layout and executes native WASM integer operations.

Measured run-183 output:

```text
wasm_backend_status=2
wasm_backend_module_bytes=73
wasm_backend_lowered_instructions=2
xenia_correctness_r3=12
generated_wasm_r3=12
generated_wasm_reuse_r3=105
WASM_BACKEND_SCALAR_DATAFLOW=PASS
WASM_BACKEND_STAGE=SCALAR_DATAFLOW_PASS
```

The first run uses `r4=7` and produces/stores `r3=12`, exactly matching the correctness executor. The **same generated and compiled child module** is then reused with `r4=100` and produces `r3=105`, proving the module is using live runtime context rather than a baked test result.

This is the first verified transition from:

```text
real PPC -> Xenia finalized HIR -> interpreted correctness
```

to:

```text
real PPC -> Xenia finalized HIR -> generated WebAssembly -> executed result
```

### Current WasmBackend lowering surface

```text
INT64 constants                 ✓
LOAD_CONTEXT INT64              ✓
ASSIGN INT64                    ✓
ADD INT64                       ✓
SUB INT64                       ✓
AND INT64                       ✓
OR INT64                        ✓
XOR INT64                       ✓
first PPCContext r3 store       ✓
shared parent WASM memory       ✓
runtime module reuse            ✓
```

Unsupported HIR shapes still fail closed. `WASM_BACKEND_FOUNDATION=PASS` is **not** emitted yet.

## WasmBackend closure sequence

1. broaden scalar integer/value lowering and support general context outputs;
2. comparisons, truncation/extension and shifts;
3. branches and multi-block control flow;
4. guest scalar memory and Xbox endian behavior;
5. direct/nested/CTR-indirect guest calls and returns;
6. completed FPU-baseline lowering;
7. completed VMX/VMX128-baseline lowering;
8. broad generated-WASM vs correctness-oracle equivalence matrix;
9. compiled guest-function/block cache keyed by guest address/code version;
10. executable-page versioning and invalidation;
11. only then add `WASM_BACKEND_FOUNDATION=PASS`.

## Progress after run 183

A 100% bar means the named **foundation** met its scoped regression contract, not that every retail title is compatible.

```text
STFS / Xbox package / XEX foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Xenia PPC translation foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Scalar PPC correctness foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Guest function / control foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

FPU foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

VMX / VMX128 foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Hot WasmBackend
██░░░░░░░░░░░░░░░░░░  ~12%  ← ACTIVE / FIRST GENERATED-WASM STAGE GREEN

Full Xbox guest-memory system
██░░░░░░░░░░░░░░░░░░  ~10%

Real default.xex entry execution
█░░░░░░░░░░░░░░░░░░░  ~5%

Kernel / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░  ~1–2%

Xenos guest GPU
░░░░░░░░░░░░░░░░░░░░  ~1–2%

WebGPU Xenos backend
█░░░░░░░░░░░░░░░░░░░  ~2%

WebGL2 compatibility fallback
░░░░░░░░░░░░░░░░░░░░  ~1%

First genuine Xbox title boot
█████░░░░░░░░░░░░░░░  ~25%

Small XBLA / Braid-class playable
████░░░░░░░░░░░░░░░░  ~18%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░  ~10–11%

OVERALL RENDER360
██████░░░░░░░░░░░░░░  ~29%
```

## Next implementation order

1. **WasmBackend scalar/control expansion** — broaden lowering, then multi-block branches and loops.
2. **WasmBackend guest memory** — scalar loads/stores, byte swapping and verified guest-memory equivalence.
3. **WasmBackend guest calls** — direct, nested and CTR-indirect calls/returns.
4. **WasmBackend FPU + VMX** — lower the already-closed correctness foundations.
5. **Compiled-function cache + invalidation** — cache translated functions and invalidate them when executable guest pages change.
6. **Full sparse Xbox guest memory** — browser-safe page-backed 32-bit virtual/physical mappings, aliases, permissions, MMIO and executable-page tracking.
7. **Real XEX mapper** — map the already-extracted `default.xex` sections and initialize CPU/module state.
8. **Execute the real `default.xex` entry point** — switch bring-up from synthetic CPU programs to genuine title execution.
9. **Kernel bring-up** — `KernelState`, xboxkrnl, XAM, threads, synchronization, VFS/files and demanded services.
10. **Graphics/audio** — shared Xenos semantics -> WebGPU/WGSL/EDRAM primary -> WebGL2 fallback -> WebAudio -> first genuine guest framebuffer.

## Graphics architecture

**WebGPU is the primary Xenos host backend. WebGL2 is the compatibility fallback.** Both consume one shared Xenia/Xenos semantic layer; Three.js remains host/input diagnostics only.

```text
Xenos ringbuffer
  -> Xenia generic command/register semantics
  -> shared Render360 browser GPU layer
     -> WebGPU + WGSL + EDRAM   primary
     -> WebGL2 + GLSL ES        fallback where feasible
```

## Build / verification

```bash
bash ./build-core.sh
node ./test-package-xex-foundation.mjs
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
python3 ./xenia_translation_foundation_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-guest-control-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-fpu-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-vmx-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-wasm-backend.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

## Status language

- **FOUNDATION COMPLETE** means the named scoped regression gate is green.
- **PPC EXECUTING** means finalized Xenia HIR changes verified architectural/guest-memory state.
- **GENERATED WASM EXECUTING** means finalized Xenia HIR has been lowered into a WebAssembly function that actually ran and matched measured architectural state.
- **PLAYABLE** remains reserved for genuine title execution with sufficient CPU, kernel, GPU, input and audio behavior for gameplay.

Stable production remains **Core V32**. Active project development remains **V35**. UI remains **V33** until the next UI-specific release.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
