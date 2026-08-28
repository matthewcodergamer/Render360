# Render360 Xenia-Web — V35 CPU Foundations / Core V32 Runtime / UI V33

Render360 is an experimental browser/iOS-oriented Xbox 360 emulator port built around **real upstream Xenia behavior**, not a second JavaScript imitation of the Xbox 360.

## Version map

```text
Render360 project / development track   V35
Stable deployed browser WASM core       V32
Responsive liquid-glass UI shell        V33
Active architecture track               V35 WasmBackend
```

The split is intentional. **Core V32** remains the deployed package/XEX runtime. **UI V33** remains the current responsive shell. **V35** is the active emulator-development milestone: six CPU/browser foundations are now regression-complete and active work moves to generated WebAssembly execution.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128
  -> Xenia PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> Render360 correctness execution
  -> Render360 WasmBackend            <- active next
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative V35 CPU gate — run 175

GitHub Actions **run 175** (`33152187091`) completed successfully at implementation commit `fe11632ec806cb6be53da6ff419b77aa201f4b1f`.

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
wasm32 compile matrix                     64 / 64 PASS
strict full-export link                   LINKED
rooted exports                            25
real PPC/FPU/VMX correctness suite        24 / 24 PASS
```

Detailed closure documents:

- [`FPU_FOUNDATION.md`](./FPU_FOUNDATION.md)
- [`VMX_FOUNDATION.md`](./VMX_FOUNDATION.md)

## Completed foundations — 100%

### 1. STFS / Xbox package / XEX foundation — 100% ✓

Regression-gated browser loader behavior includes LIVE/PIRS/CON recognition, Xenia-aligned STFS structures, native directory traversal, hash-chain traversal, root `default.xex` discovery, fragmented multi-block extraction, byte-for-byte executable reconstruction, structural XEX inspection, metadata extraction, and range-driven browser I/O.

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

The portable translation graph is locked for PPC frontend/translator/scanner, PPC context/opcodes, ALU/control/memory/FPU/Altivec emitter families, HIR, compiler framework, every tracked upstream portable compiler pass, browser host seams and strict undefined-symbol linking.

### 3. Scalar PPC correctness foundation — 100% ✓

Real PPC bytes execute through Xenia finalized HIR for integer arithmetic/bitwise operations, signed/unsigned comparisons, multi-block conditional branches, CTR loops, scalar guest memory, Xbox endian conversion, CR/LR/CTR state and return boundaries.

### 4. Guest function / control foundation — 100% ✓

Verified behavior includes direct calls, nested calls, CTR/`bctrl` runtime-indirect calls, independent Xenia scanning/translation of guest callees, LR save/update/restore, stack pointer movement, LR spill/reload through guest memory and caller resume.

### 5. FPU foundation — 100% ✓

Run 168 closed the defined FPU baseline:

```text
FPR state / lfd / stfd                         ✓
FLOAT64 ADD / SUB / MUL / DIV                  ✓
fcmpu -> CR                                    ✓
fctiwz round-to-zero                           ✓
fcfid signed int64 -> FLOAT64                  ✓
frsp f64 -> f32 -> f64 rounding                ✓
current Xenia UpdateFPSCR path                 ✓
mffs FPSCR readback                            ✓
```

Render360 follows upstream Xenia's FPSCR behavior rather than inventing exception flags Xenia itself still marks TODO.

### 6. VMX / VMX128 foundation — 100% ✓

Run 175 closes the defined vector correctness baseline with **12/12 dedicated VMX cases**:

```text
VEC128 guest load/store                        ✓
Xenia-compatible vector byte ordering          ✓
INT8 unsigned modulo add                       ✓
INT16 modulo add                               ✓
INT32 modulo add                               ✓
INT8 / INT16 / INT32 modulo subtract           ✓
VEC128 AND / OR / XOR                          ✓
INT32 vector equality compare                  ✓
INT32 vector shift left                        ✓
INT32 vector logical shift right               ✓
representative Xbox 360 VMX128 vand128         ✓
```

Measured gate:

```text
vadduhm   0x10611040  -> 00030003 x4
vadduwm   0x10611080  -> 01020305 x4
vsububm   0x10611400  -> 03030303 x4
vsubuhm   0x10611440  -> 00030003 x4
vsubuwm   0x10611480  -> 00000003 x4
vand      0x10611404  -> 00000000 x4
vor       0x10611484  -> ffffffff x4
vxor      0x106114c4  -> ffffffff x4
vcmpequw  0x10611086  -> ffffffff x4
vslw      0x10611184  -> 2,4,8,16
vsrw      0x10611284  -> 4,8,16,32
vand128   0x14611210  -> 0f000f00 x4
```

The VMX128 case uses a genuine Xbox 360 VX128 encoding derived from Xenia's opcode contract. Unsupported vector behavior remains fail-closed.

## Current execution milestone

The general V35 correctness suite remains **24 / 24** real PPC/FPU/VMX programs passing, while dedicated FPU, guest-control and VMX closure suites add deeper subsystem-specific assertions.

The proven execution path now includes scalar arithmetic/control/memory, architectural state, direct/nested/indirect guest functions, FLOAT64 arithmetic/conversion/rounding/FPSCR baseline, and representative VMX/VMX128 arithmetic, logic, compare and shift behavior.

## Active foundation — Render360 WasmBackend

The correctness executor has now served its purpose as the reference implementation for the defined CPU foundations. The next architecture step is a hot generated-WASM path:

```text
finalized Xenia HIR
  -> Render360 WasmBackend
  -> generated WebAssembly guest function
  -> browser WebAssembly engine
  -> ARM64 host through Safari/JavaScriptCore on iPhone
```

### WasmBackend closure sequence

1. generate a WebAssembly function for a finalized-HIR integer arithmetic block;
2. lower branches and multi-block control flow;
3. lower guest scalar loads/stores and endian behavior;
4. lower direct/indirect calls and returns;
5. lower the completed FPU baseline;
6. lower the completed VMX/VMX128 baseline;
7. run generated-WASM output against the correctness executor as an equivalence oracle;
8. add compiled-function/block caching;
9. add executable-page versioning and invalidation;
10. create a dedicated `WASM_BACKEND_FOUNDATION=PASS` gate.

## Progress after run 175

These are scoped engineering estimates. A 100% bar means the named **foundation** met its explicit regression contract, not that every retail title is compatible.

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
█░░░░░░░░░░░░░░░░░░░  ~3%  ← ACTIVE NEXT

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
█████░░░░░░░░░░░░░░░  ~24–25%

Small XBLA / Braid-class playable
████░░░░░░░░░░░░░░░░  ~17–18%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░  ~10–11%

OVERALL RENDER360
██████░░░░░░░░░░░░░░  ~27–29%
```

## Next implementation order

The six completed foundations remain closed unless their CI gates regress.

1. **Render360 WasmBackend foundation** — finalized Xenia HIR -> generated WebAssembly execution with equivalence tests.
2. **Compiled-function cache + invalidation** — cache by guest address/code version and invalidate executable pages when code changes.
3. **Full sparse Xbox guest memory** — browser-safe page-backed 32-bit virtual/physical mappings, aliases, permissions, MMIO and executable-page tracking.
4. **Real XEX mapper** — prepare/map the already-extracted `default.xex` sections and initialize CPU/module state.
5. **Execute the real `default.xex` entry point** — move bring-up from synthetic correctness programs to genuine title execution.
6. **Kernel bring-up** — `KernelState`, xboxkrnl, XAM, threads, synchronization, VFS/files and services demanded by the title.
7. **Graphics/audio** — Xenos packet/register processing -> shader translation -> WebGPU/WGSL -> EDRAM -> WebGL2 fallback -> WebAudio -> first genuine guest framebuffer.

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
```

## Status language

- **FOUNDATION COMPLETE** means the named scoped regression gate is green.
- **PPC EXECUTING** means finalized Xenia HIR changes verified architectural/guest-memory state.
- **PLAYABLE** remains reserved for genuine title execution with sufficient CPU, kernel, GPU, input and audio behavior for gameplay.

Stable production remains **Core V32**. The active project-development line is **V35**. UI remains **V33** until the next UI-specific release.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
