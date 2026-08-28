# Xenia Web Bootstrap — V34 CPU foundations

## Goal

Bring the real upstream Xenia PowerPC/FPU/VMX frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

## Version map

```text
Project development line   V34
Stable browser core        V32
Responsive UI shell        V33
CPU foundation track       V34
```

## Authoritative green result — run 168

GitHub Actions run **168** (`33149796414`) completed successfully at implementation commit `2533a1fa855bdc4b1df2a348edc31f1ba169bb8c`.

```text
V32 package/XEX rebuild                  PASS
PACKAGE_XEX_FOUNDATION                   PASS
PPC_TRANSLATION_FOUNDATION               PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION        PASS
GUEST_CONTROL_FOUNDATION                 PASS
FPU_FOUNDATION                           PASS
wasm32 compile matrix                    64 / 64 PASS
strict full-export link                  LINKED
rooted exports                           25
real PPC/FPU/VMX correctness suite       24 / 24 PASS
```

## Milestone language

- **PACKAGE/XEX FOUNDATION COMPLETE**: the defined browser STFS/package/XEX extraction and structural-inspection baseline is regression-gated.
- **PPC TRANSLATION FOUNDATION COMPLETE**: the defined portable Xenia translation graph, scanner/emitter surface, compiler-pass set and strict wasm32 link are regression-gated.
- **SCALAR PPC CORRECTNESS FOUNDATION COMPLETE**: the defined non-FPU/non-VMX scalar arithmetic/control/memory baseline is regression-gated through finalized Xenia HIR.
- **GUEST CONTROL FOUNDATION COMPLETE**: direct, nested, CTR-indirect and stack-frame-shaped guest calls/returns are regression-gated.
- **FPU FOUNDATION COMPLETE**: the defined floating-point correctness baseline is regression-gated through genuine PPC and guest-memory/FPSCR verification.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state or guest-memory changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Live CPU path

```text
real big-endian Xbox PPC / FPU / VMX bytes
  -> Xenia Memory
  -> Xenia Processor / PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR
  -> portable compiler passes
  -> finalized Xenia HIR
  -> Render360 HIR correctness executor
  -> real Xenia PPCContext + Processor-owned Xenia Memory
  -> asserted architectural and guest-memory state
```

## Completed foundations

### Package / XEX — COMPLETE / 100%

Regression-gated behavior:

```text
LIVE / PIRS / CON classification
STFS header + volume descriptor parsing
native directory traversal
hash-chain traversal
root default.xex discovery
fragmented multi-block complete extraction
byte-for-byte executable reconstruction
XEX structural metadata inspection
```

### PPC translation — COMPLETE / 100%

Locked surface includes PPCFrontend, PPCTranslator, PPCScanner, PPC context/opcodes, all five current PPC emitter families, HIR, compiler framework, every tracked upstream compiler pass, browser host seams and strict undefined-symbol linking.

### Scalar PPC correctness — COMPLETE / 100%

```text
integer arithmetic / bitwise
signed and unsigned comparisons
conditional multi-block branches
CTR-controlled backward loops
guest scalar load/store
Xbox endian conversion
CR / LR / CTR state
return boundaries
```

### Guest function / control — COMPLETE / 100%

```text
direct bl / callee / blr                     PASS
two-level nested bl chain                     PASS
CTR / bctrl runtime-indirect call             PASS
LR save/update/restore                        PASS
stack-frame-shaped flow                       PASS
LR spill/reload through guest memory          PASS
caller resume after callee                    PASS
```

### FPU — COMPLETE / 100%

Run 168 closes the defined floating baseline:

```text
FPR state / load / store                    PASS
FLOAT64 ADD                                 PASS
FLOAT64 SUB                                 PASS
FLOAT64 MUL                                 PASS
FLOAT64 DIV                                 PASS
fcmpu -> CR                                 PASS
fctiwz round-to-zero                        PASS
fcfid int64 -> FLOAT64                      PASS
frsp f64 -> f32 -> f64 rounding             PASS
current Xenia UpdateFPSCR path               PASS
mffs FPSCR readback                          PASS
```

The detailed compatibility boundary is documented in `FPU_FOUNDATION.md`. Render360 follows upstream Xenia's current FPSCR implementation and does not invent deeper exception flags that upstream still marks TODO.

## Active next foundation — VMX / VMX128

Current proven vector baseline:

```text
VEC128 guest load                          ✓
Xenia-compatible vector byte ordering      ✓
unsigned INT8 VECTOR_ADD / vaddubm         ✓
VEC128 guest store                         ✓
```

Closure sequence:

1. INT16 and INT32 modulo add;
2. vector subtraction;
3. vector AND / OR / XOR;
4. integer vector comparisons;
5. common vector shifts;
6. representative Xbox 360 VMX128 forms;
7. dedicated `VMX_FOUNDATION=PASS` gate.

## Phase ladder after run 168

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation ProbeBackend                            COMPLETE
Phase 2C  Xenia Memory / Processor probe closure              COMPLETE FOR PROBE
Phase 2D  complete current compiler-pass source manifest      COMPLETE
Phase 3   strict full-export link                             COMPLETE
Phase 3A  real PPC -> finalized Xenia HIR                     COMPLETE
Phase 3B  PPC TRANSLATION FOUNDATION                         COMPLETE / 100%
Phase 3C  STFS / package / XEX loader foundation              COMPLETE / 100%
Phase 4A  scalar PPC correctness foundation                   COMPLETE / 100%
Phase 4B  guest call/control foundation                       COMPLETE / 100%
Phase 4C  FPU foundation                                      COMPLETE / 100%
Phase 4D  VMX / VMX128 foundation                             ACTIVE NEXT
Phase 5   hot-block WasmBackend + function cache              FUTURE
Phase 5A  executable-page versioning/invalidation             FUTURE
Phase 6   sparse/page-backed Xbox guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## After VMX closure

1. Build `WasmBackend`: finalized Xenia HIR -> generated WebAssembly function.
2. Add translated-function/block caching.
3. Add executable-page versioning and invalidation.
4. Replace the bounded correctness window with sparse/page-backed Xbox virtual/physical memory.
5. Map the already-captured `default.xex` sections at their Xbox addresses.
6. Establish initial CPU state and execute the real XEX entry point.
7. Bring up `KernelState`, xboxkrnl and XAM services demanded by real title execution.
8. Build the shared Xenos browser GPU layer.
9. Use WebGPU/WGSL/EDRAM as the primary graphics path and WebGL2/GLSL ES as fallback where feasible.
10. Add WebAudio and reach the first genuine guest-produced framebuffer.

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

Stable production remains **Core V32**. Active project development is **V34**. UI remains **V33** until the next UI-specific release.
