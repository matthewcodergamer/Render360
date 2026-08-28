# Render360 Xenia-Web — V34 CPU Foundations / Core V32 Runtime / UI V33

Render360 is an experimental browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior** rather than a second JavaScript imitation of the Xbox 360.

## Version map

```text
Render360 project / development track   V34
Stable deployed browser WASM core       V32
Responsive liquid-glass UI shell        V33
Active CPU foundation track             V34
```

The version split is intentional. **Core V32** remains the deployed package/XEX runtime. **UI V33** remains the current responsive shell. **V34** is the active emulator-development milestone containing the completed package/XEX, PPC translation, scalar PPC, guest-control and FPU foundations plus the next VMX/WasmBackend work.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128
  -> Xenia PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> Render360 wasm32 correctness execution
  -> future Render360 WasmBackend
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative V34 CPU gate — run 168

GitHub Actions **run 168** (`33149796414`) completed successfully at implementation commit `2533a1fa855bdc4b1df2a348edc31f1ba169bb8c`.

```text
V32 package/XEX core rebuild              PASS
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

The dedicated FPU foundation status is documented in [`FPU_FOUNDATION.md`](./FPU_FOUNDATION.md).

## Completed foundations — 100%

### 1. STFS / Xbox package / XEX foundation — 100% ✓

The browser package/XEX loader foundation is regression-gated for:

- LIVE / PIRS / CON classification;
- Xenia-aligned STFS header and volume-descriptor contracts;
- native directory enumeration;
- hash-chain traversal;
- root `default.xex` discovery;
- fragmented multi-block extraction;
- byte-for-byte reconstruction of the complete extracted executable;
- structural XEX inspection;
- entry point, image base, title ID and media ID extraction;
- range-driven I/O rather than loading multi-GB packages into WASM memory.

Measured package gate:

```text
core_version        32
mount_reads         5
extract_reads       3
default_xex_bytes   6144
default_xex_blocks  2
xex_entry           0x82001234
```

**100% means the defined browser package/XEX foundation is complete and regression-gated.** It does not mean every retail encryption/compression/title quirk is already compatible.

### 2. Xenia PPC translation foundation — 100% ✓

The portable translation foundation locks:

- PPC frontend / translator / scanner;
- PPC context and opcode tables;
- ALU, control, memory, FPU and Altivec/VMX emitter families;
- HIR opcodes, blocks, instructions, values and builder;
- compiler framework;
- every currently tracked upstream Xenia compiler pass;
- browser host translation units;
- strict undefined-symbol link behavior;
- representative real-PPC runtime categories.

This means **PPC translation foundation = 100%**, not arbitrary retail PPC compatibility = 100%.

### 3. Scalar PPC correctness foundation — 100% ✓

Real PPC bytes are regression-gated through Xenia translation and finalized-HIR execution for:

```text
integer arithmetic / bitwise                  ✓
signed / unsigned comparisons                 ✓
conditional multi-block branches              ✓
CTR-controlled backward loops                 ✓
guest scalar load/store                       ✓
Xbox endian conversion                        ✓
CR / LR / CTR architectural state             ✓
return boundaries                             ✓
```

### 4. Guest function / control foundation — 100% ✓

Verified guest-control behavior includes:

```text
direct bl -> separately scanned callee -> blr          ✓
two-level nested guest calls                            ✓
CTR / bctrl runtime-indirect guest call                 ✓
LR save / update / restore                              ✓
stack pointer decrement / restore through r1            ✓
LR spill / reload through Xenia guest memory            ✓
caller resumes after callee                             ✓
stack-frame-shaped guest function flow                  ✓
```

Xenia `PPCScanner` independently discovers guest callees. They are translated through Xenia and execute against the same live `PPCContext`; there is no hardcoded callee result.

### 5. FPU foundation — 100% ✓

Run 168 closes the defined browser FPU baseline with genuine PPC tests for:

```text
FPR state / lfd / stfd                         ✓
FLOAT64 ADD                                    ✓
FLOAT64 SUB                                    ✓
FLOAT64 MUL                                    ✓
FLOAT64 DIV                                    ✓
fcmpu floating compare -> CR                   ✓
fctiwz float -> signed int, round-to-zero      ✓
fcfid signed int64 -> FLOAT64                  ✓
frsp FLOAT64 -> FLOAT32 -> FLOAT64 rounding    ✓
current Xenia UpdateFPSCR path                 ✓
mffs FPSCR readback                            ✓
```

The real `fdiv f3,f1,f2` case executes `6.0 / 2.0`, stores the exact IEEE-754 double `3.0` value back into guest memory, and verifies the result.

Render360 intentionally follows upstream Xenia for FPSCR behavior. Deeper exception/NaN/overflow details that upstream Xenia itself still marks TODO are not fabricated just to claim compatibility.

## Current execution milestone

The V34 correctness suite contains **24 / 24** passing real PPC/FPU/VMX programs.

The proven execution path now includes:

```text
scalar arithmetic / compare / branch / loop        ✓
guest scalar memory + endian                        ✓
CR / LR / CTR                                       ✓
direct / nested / CTR-indirect calls                ✓
stack-frame-shaped guest control                     ✓
FLOAT64 FPR load/store                              ✓
FLOAT64 ADD / SUB / MUL / DIV                       ✓
floating compare / conversion / rounding            ✓
FPSCR update/readback baseline                       ✓
VEC128 load/store + byte order                       ✓
VMX unsigned-byte VECTOR_ADD                         ✓
```

Unsupported HIR/opcodes still fail closed.

## Active foundation — VMX / VMX128

VMX/VMX128 is now the next CPU completion target.

Already proven:

```text
VEC128 guest load                          ✓
Xenia-compatible vector byte ordering      ✓
unsigned INT8 VECTOR_ADD / vaddubm         ✓
VEC128 guest store                         ✓
```

Next VMX closure sequence:

1. INT16 and INT32 modulo add;
2. vector subtraction;
3. vector AND / OR / XOR;
4. integer vector comparisons;
5. common vector shifts;
6. representative Xbox 360 VMX128-specific forms;
7. dedicated `VMX_FOUNDATION=PASS` CI gate.

## Progress after run 168

These are scoped engineering estimates. A 100% bar means the named **foundation** has met its explicit regression gate, not that the full emulator or all retail compatibility is complete.

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
███░░░░░░░░░░░░░░░░░  ~15%  ← ACTIVE NEXT

Hot WasmBackend
█░░░░░░░░░░░░░░░░░░░  ~3%

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
█████░░░░░░░░░░░░░░░  ~23–24%

Small XBLA / Braid-class playable
███░░░░░░░░░░░░░░░░░  ~16–17%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░  ~9–10%

OVERALL RENDER360
█████░░░░░░░░░░░░░░░  ~25–27%
```

## Next implementation order

The five completed foundations remain closed unless their CI gates regress.

1. **VMX / VMX128 foundation** — complete the defined vector baseline and add `VMX_FOUNDATION=PASS`.
2. **Render360 WasmBackend** — lower finalized Xenia HIR into generated WebAssembly functions instead of interpreting hot HIR.
3. **Compiled-function cache + invalidation** — cache translated guest functions and invalidate them when executable guest pages change.
4. **Full sparse Xbox guest memory** — page-backed 32-bit virtual/physical memory, mappings, aliases, permissions and executable-page tracking.
5. **Real XEX mapper** — map the already-extracted `default.xex` sections to their Xbox guest addresses and establish initial CPU state.
6. **Execute the real `default.xex` entry point** — switch bring-up from synthetic CPU programs to genuine title execution.
7. **Kernel bring-up** — `KernelState`, xboxkrnl, XAM, threads, synchronization, files and services demanded by the title.
8. **Graphics/audio** — Xenos packets/registers -> shader translation -> WebGPU/WGSL -> EDRAM -> WebGL2 fallback -> WebAudio -> first genuine guest framebuffer.

## Graphics architecture

**WebGPU is the primary Xenos host backend. WebGL2 is the compatibility fallback.** Both consume one shared Xenia/Xenos semantic layer; neither is a fake Three.js replacement for guest rendering.

```text
Xenos ringbuffer
  -> Xenia generic command/register semantics
  -> shared Render360 browser GPU layer
     -> WebGPU + WGSL + EDRAM   (primary)
     -> WebGL2 + GLSL ES        (fallback where feasible)
```

The existing Three.js arena remains host/input diagnostics only.

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
```

## Status language

- **FOUNDATION COMPLETE** means the named scoped regression gate is green.
- **PPC EXECUTING** means finalized Xenia HIR is changing verified architectural/guest-memory state.
- **PLAYABLE** remains reserved for genuine title execution with sufficient CPU, kernel, GPU, input and audio behavior for gameplay.

Stable production remains **Core V32**. The active project-development line is now **V34**. UI remains **V33** until the next UI-specific release.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
