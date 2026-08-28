# Xenia Web Bootstrap — V35 CPU foundations complete

## Goal

Bring the real upstream Xenia PowerPC/FPU/VMX frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

## Version map

```text
Project development line   V35
Stable browser core        V32
Responsive UI shell        V33
Active architecture track  V35 WasmBackend
```

## Authoritative green result — run 175

GitHub Actions run **175** (`33152187091`) completed successfully at implementation commit `fe11632ec806cb6be53da6ff419b77aa201f4b1f`.

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
wasm32 compile matrix                    64 / 64 PASS
strict full-export link                  LINKED
rooted exports                           25
real PPC/FPU/VMX correctness suite       24 / 24 PASS
```

## Foundation status

```text
Package / XEX foundation            COMPLETE / 100%
PPC translation foundation          COMPLETE / 100%
Scalar PPC correctness foundation   COMPLETE / 100%
Guest function/control foundation   COMPLETE / 100%
FPU foundation                      COMPLETE / 100%
VMX / VMX128 foundation             COMPLETE / 100%
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
  -> Render360 reference correctness executor
  -> real Xenia PPCContext + Processor-owned Xenia Memory
```

The correctness executor remains the reference oracle while V35 adds the hot generated-WASM execution path.

## FPU closure

The defined FPU baseline remains locked for FPR load/store, FLOAT64 ADD/SUB/MUL/DIV, `fcmpu`, `fctiwz`, `fcfid`, `frsp`, current Xenia FPSCR update behavior and `mffs` readback. Detailed scope: `FPU_FOUNDATION.md`.

## VMX / VMX128 closure

Run 175 closes the defined vector baseline. The dedicated gate proves:

```text
VEC128 load/store + byte order                   PASS
INT8 unsigned modulo add                         PASS
INT16 / INT32 modulo add                         PASS
INT8 / INT16 / INT32 modulo subtract             PASS
VEC128 AND / OR / XOR                            PASS
INT32 equality compare                           PASS
INT32 shift-left / logical shift-right           PASS
Xbox 360 VMX128 vand128 representative           PASS
```

Measured runtime output:

```text
VMX_STANDARD_BASELINE=PASS cases=11
VMX128_REPRESENTATIVE=PASS cases=1
VMX_FOUNDATION=PASS cases=12
```

The representative VMX128 case uses genuine Xenia opcode contracts (`vand128`, low-register encoding `0x14611210`). Detailed scope: `VMX_FOUNDATION.md`.

## Phase ladder after run 175

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
Phase 5   hot-block WasmBackend                               ACTIVE NEXT
Phase 5A  compiled-function cache                             NEXT
Phase 5B  executable-page versioning/invalidation             NEXT
Phase 6   sparse/page-backed Xbox guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Active implementation boundary — WasmBackend

Do not reopen the six completed foundations unless their gates regress. V35 active work is:

1. lower finalized Xenia HIR integer arithmetic into a generated WebAssembly function;
2. lower multi-block branches/control flow;
3. lower scalar guest loads/stores and endian operations;
4. lower direct/indirect calls and return boundaries;
5. lower the completed FPU operation set;
6. lower the completed VMX/VMX128 baseline;
7. execute the same guest programs through both generated WASM and the correctness executor and require identical state;
8. cache translated guest functions by guest address/code version;
9. invalidate cached functions when executable guest pages change;
10. add `WASM_BACKEND_FOUNDATION=PASS`.

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
```

Stable production remains **Core V32**. Active project development is **V35**. UI remains **V33** until the next UI-specific release.
