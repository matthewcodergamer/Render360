# Xenia Web Bootstrap — V35 WasmBackend bring-up

## Goal

Bring the real upstream Xenia PowerPC/FPU/VMX frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

## Version map

```text
Project development line   V35
Stable browser core        V32
Responsive UI shell        V33
Active architecture track  V35 WasmBackend
```

## Authoritative implementation result — run 183

GitHub Actions run **183** (`33153679117`) completed successfully at implementation commit `edca8d59cbdc7eb38e8b11adc753759d68d6e7af`.

```text
V32 package/XEX rebuild                  PASS
PACKAGE_XEX_FOUNDATION                   PASS
PPC_TRANSLATION_FOUNDATION               PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION        PASS
GUEST_CONTROL_FOUNDATION                 PASS
FPU_FOUNDATION                           PASS
VMX_STANDARD_BASELINE                    PASS (11)
VMX128_REPRESENTATIVE                    PASS (1)
VMX_FOUNDATION                           PASS (12)
wasm32 compile matrix                    65 / 65 PASS
strict full-export link                  LINKED
rooted exports                           30
real PPC/FPU/VMX correctness suite       24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW             PASS
WASM_BACKEND_STAGE                       SCALAR_DATAFLOW_PASS
```

Run 183 is the authoritative code-bearing gate for the first WasmBackend stage. Later documentation-only runs do not supersede it.

## Foundation status

```text
Package / XEX foundation            COMPLETE / 100%
PPC translation foundation          COMPLETE / 100%
Scalar PPC correctness foundation   COMPLETE / 100%
Guest function/control foundation   COMPLETE / 100%
FPU foundation                      COMPLETE / 100%
VMX / VMX128 foundation             COMPLETE / 100%
WasmBackend foundation              ACTIVE / ~12%
```

A 100% foundation is a scoped regression boundary. It is not a claim that every Xbox 360 title, instruction edge case or hardware quirk is fully compatible.

## Live CPU path

```text
real big-endian Xbox PPC / FPU / VMX128 bytes
  -> Xenia Memory
  -> Xenia Processor / PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR
  -> portable compiler passes
  -> finalized Xenia HIR
       -> Render360 correctness executor   (reference oracle)
       -> Render360 WasmBackend            (active hot path)
            -> generated child WebAssembly module
            -> browser/Node WebAssembly engine
            -> shared parent WebAssembly.Memory
            -> real Xenia PPCContext layout
```

## First generated-WASM execution

Run 183 closes the first real WasmBackend stage with genuine PPC:

```text
addi r3,r4,5      0x38640005
blr               0x4E800020
```

Xenia finalizes the corresponding dataflow before Render360 lowers it:

```text
LOAD_CONTEXT r4
ADD INT64 +5
STORE_CONTEXT r3
```

The new backend emits a separate child WebAssembly module that imports the parent bootstrap memory and operates directly on a real Xenia `PPCContext` layout.

Measured runtime output:

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

The generated module first runs with `r4=7` and produces `r3=12`, exactly matching the existing finalized-HIR correctness executor. The same compiled generated module is then reused with `r4=100` and produces `r3=105`, proving the result is driven by live runtime context rather than a baked constant.

Current first-stage lowering surface:

```text
INT64 constants                 PASS
LOAD_CONTEXT INT64              PASS
ASSIGN INT64                    PASS
ADD INT64                       PASS
SUB INT64                       PASS
AND INT64                       PASS
OR INT64                        PASS
XOR INT64                       PASS
first r3 context result store   PASS
shared parent WASM memory       PASS
runtime generated-module reuse  PASS
```

Unsupported HIR shapes fail closed. The correctness executor remains the reference oracle while the hot backend expands.

## Completed CPU foundations

### FPU — COMPLETE / 100%

The defined FPU baseline remains locked for FPR load/store, FLOAT64 ADD/SUB/MUL/DIV, `fcmpu`, `fctiwz`, `fcfid`, `frsp`, current Xenia FPSCR update behavior and `mffs` readback. Detailed scope: `FPU_FOUNDATION.md`.

### VMX / VMX128 — COMPLETE / 100%

The dedicated gate remains green for VEC128 memory/byte order, INT8/INT16/INT32 modulo arithmetic, subtraction, AND/OR/XOR, equality compare, word shifts, and representative genuine Xbox 360 `vand128` behavior. Detailed scope: `VMX_FOUNDATION.md`.

## Phase ladder after run 183

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
Phase 4D  VMX / VMX128 foundation                             COMPLETE / 100%
Phase 5A  finalized HIR -> generated WASM scalar dataflow      COMPLETE
Phase 5B  scalar values / compare / shift expansion            ACTIVE NEXT
Phase 5C  multi-block control-flow lowering                   NEXT
Phase 5D  guest-memory/endian lowering                        NEXT
Phase 5E  guest-call lowering                                 NEXT
Phase 5F  FPU + VMX lowering                                  NEXT
Phase 5G  generated-WASM equivalence matrix                   NEXT
Phase 5H  compiled-function cache                             NEXT
Phase 5I  executable-page versioning/invalidation             NEXT
Phase 5J  WASM_BACKEND_FOUNDATION                             FUTURE GATE
Phase 6   sparse/page-backed Xbox guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Active implementation boundary — WasmBackend

Do not reopen the six completed foundations unless their gates regress. The next WasmBackend closure work is:

1. broaden scalar outputs and context stores;
2. add comparisons, truncation/extension and shifts;
3. lower multi-block branches and loops;
4. lower scalar guest loads/stores plus Xbox endian behavior;
5. lower direct, nested and CTR-indirect guest calls/returns;
6. lower the completed FPU operation set;
7. lower the completed VMX/VMX128 baseline;
8. run the same guest programs through generated WASM and the correctness executor and require identical state;
9. cache translated guest functions by guest address/code version;
10. invalidate cached functions when executable guest pages change;
11. only then add `WASM_BACKEND_FOUNDATION=PASS`.

## After WasmBackend closure

1. Replace the bounded correctness window with sparse/page-backed Xbox virtual/physical memory.
2. Map the already-extracted `default.xex` sections at their real Xbox addresses.
3. Establish initial architectural/module state.
4. Execute the real XEX entry point.
5. Bring up `KernelState`, xboxkrnl and XAM services demanded by real title execution.
6. Build the shared Xenos browser semantic layer.
7. Use WebGPU/WGSL/EDRAM as primary graphics and WebGL2/GLSL ES as compatibility fallback where feasible.
8. Add WebAudio and reach the first genuine guest-produced framebuffer.

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

Stable production remains **Core V32**. Active project development is **V35**. UI remains **V33** until the next UI-specific release.
