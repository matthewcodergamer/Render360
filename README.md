# Render360 Xenia-Web — V35 WasmBackend Bring-up / Core V32 Runtime / UI V33

Render360 is an experimental browser/iOS-oriented Xbox 360 emulator port built around **real upstream Xenia behavior**, not a second JavaScript imitation of the Xbox 360.

## Version map

```text
Render360 project / development track   V35
Stable deployed browser WASM core       V32
Responsive liquid-glass UI shell        V33
Active architecture track               V35 WasmBackend
```

**Core V32** remains the deployed package/XEX runtime. **UI V33** remains the responsive shell. **V35** contains six completed CPU/browser foundations and the active finalized-Xenia-HIR -> generated-WebAssembly execution path.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128 bytes
  -> Xenia PPCScanner / PPCFrontend / PPCTranslator
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> finalized Xenia HIR
       -> Render360 correctness executor   reference oracle
       -> Render360 WasmBackend            active hot path
            -> generated WebAssembly
            -> browser WASM engine
            -> shared Xenia PPCContext + Xenia Memory backing
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative V35 gate — run 216

GitHub Actions **run 216** (`33159254632`) completed successfully at implementation commit `d05fae62190b2c559100eec4e93b723f6e49f49f`.

```text
V32 package/XEX core rebuild                 PASS
PACKAGE_XEX_FOUNDATION                       PASS
PPC_TRANSLATION_FOUNDATION                   PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION            PASS
GUEST_CONTROL_FOUNDATION                     PASS
FPU_FOUNDATION                               PASS
VMX_FOUNDATION                               PASS (12 / 12)
wasm32 compile matrix                        68 / 68 PASS
strict full-export link                      LINKED
rooted exports                               47
real PPC/FPU/VMX correctness suite           24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW                 PASS
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT      PASS
WASM_BACKEND_CFG_BRANCH                      PASS
WASM_BACKEND_CFG_LOOP                        PASS
WASM_BACKEND_MEMORY_ENDIAN                   PASS
WASM_BACKEND_CALL_DIRECT                     PASS
WASM_BACKEND_CALL_NESTED                     PASS
WASM_BACKEND_CALL_INDIRECT                   PASS
WASM_BACKEND_CALL_FAIL_CLOSED                PASS
WASM_BACKEND_STAGE                           GUEST_CALLS_PASS
```

Run 215 intentionally failed the first call implementation. The critic exposed incorrect WebAssembly `i32.const` encoding for high-bit Xbox guest addresses: direct targets such as `0x80000014` were emitted as unsigned LEB128 even though `i32.const` requires signed LEB128. Commit `d05fae6` corrected the encoding; the same unchanged adversarial call gate then passed in run 216.

Detailed foundation/status documents:

- [`FPU_FOUNDATION.md`](./FPU_FOUNDATION.md)
- [`VMX_FOUNDATION.md`](./VMX_FOUNDATION.md)
- [`WASM_BACKEND_FOUNDATION.md`](./WASM_BACKEND_FOUNDATION.md) — active, not yet complete

## Completed foundations — 100%

```text
STFS / Xbox package / XEX foundation       100% ✓
Xenia PPC translation foundation           100% ✓
Scalar PPC correctness foundation          100% ✓
Guest function / control foundation        100% ✓
FPU foundation                             100% ✓
VMX / VMX128 foundation                    100% ✓
```

These are explicit regression foundations, not claims that every retail title or every hardware edge case is supported.

## Generated WasmBackend — verified workstreams

### 1. Scalar dataflow

Real PPC `addi r3,r4,5 ; blr` is translated by Xenia and lowered from finalized HIR into a child WebAssembly module. The same compiled module is reused against live context:

```text
r4=7    -> r3=12
r4=100  -> r3=105
WASM_BACKEND_SCALAR_DATAFLOW=PASS
```

### 2. Scalar type / comparison / shift parity

Real `cmpwi r4,0 ; mfcr r3 ; blr` verifies truncation, signed comparisons, integer booleans, zero/sign extension, shifts, OR chains and context stores:

```text
negative -> CR0 LT -> 0x80000000
zero     -> CR0 EQ -> 0x20000000
positive -> CR0 GT -> 0x40000000
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS
```

### 3. Generated CFG branch / loop parity

The CFG critic previously caught a wrong not-taken interpretation and was hardened to follow Xenia's instruction-level branch contract. Current measured behavior includes both branch directions and a reusable backward CTR loop:

```text
cfg_branch_taken_r3=2
cfg_branch_not_taken_r3=1
cfg_ctr_loop_r3=3
cfg_conditional_reuse_r3=1
cfg_loop_reuse_r3=5
WASM_BACKEND_CFG_BRANCH=PASS
WASM_BACKEND_CFG_LOOP=PASS
```

### 4. Generated guest-memory / endian parity

The memory workstream lowers scalar guest loads/stores and byte swaps while operating on the same Xenia Memory backing as the oracle:

```text
lwz first/reuse         0x89ABCDEF -> 0x10203040
stw->lwz first/reuse    0x12345678 -> 0xA1B2C3D4
WASM_BACKEND_MEMORY_ENDIAN=PASS
```

This is the bounded V35 probe-memory execution stage, not the later full sparse/page-backed Xbox guest-memory system.

### 5. Generated direct / nested / CTR-indirect guest calls

The call backend registers a generated child WebAssembly module for every guest function that **Xenia itself** separately scans, translates, compiles and hands to the assembler. Generated callers dispatch only to that Xenia-derived registry; there is no PPC-side decoder or correctness-interpreter fallback.

The adversarial gate covers:

```text
direct bl -> callee -> blr                         PASS
caller -> A -> B -> A -> caller                    PASS
CTR target -> bctrl -> callee -> caller            PASS
unknown dynamic guest target                       FAILS CLOSED ✓
shared live PPCContext across generated callees    PASS
```

`CALL_POSSIBLE_RETURN` remains the Xenia-defined `blr` return boundary. Direct guest addresses are encoded with signed WebAssembly LEB128, including Xbox addresses with bit 31 set.

```text
WASM_BACKEND_CALL_DIRECT=PASS
WASM_BACKEND_CALL_NESTED=PASS
WASM_BACKEND_CALL_INDIRECT=PASS
WASM_BACKEND_CALL_FAIL_CLOSED=PASS
WASM_BACKEND_STAGE=GUEST_CALLS_PASS
```

## Current WasmBackend surface

```text
integer constants / context reads                 ✓
ASSIGN / TRUNCATE / ZERO_EXTEND / SIGN_EXTEND     ✓
ADD / SUB / AND / OR / XOR / NOT / NEG            ✓
signed + unsigned integer compares                 ✓
IS_TRUE / IS_FALSE                                 ✓
SHL / SHR / SHA / ROTATE_LEFT                      ✓
context writes                                     ✓
conditional taken + not-taken CFG                  ✓
unconditional branches / merge                     ✓
backward CTR loops                                 ✓
live generated-module reuse                        ✓
dispatch safety budget                             ✓
bounded guest LOAD / STORE / OFFSET                ✓
Xbox scalar BYTE_SWAP / endian path                ✓
same Xenia Memory backing                          ✓
generated direct guest calls                       ✓
generated nested guest calls                       ✓
generated CTR / bctrl indirect calls               ✓
unknown guest-call target fail-closed               ✓

FPU lowering                                        ○ NEXT
VMX / VMX128 lowering                               ○
broad generated-WASM equivalence matrix             △ partial
compiled-function cache                             ○
executable-page invalidation                        ○
WASM_BACKEND_FOUNDATION=PASS                        ○
```

## Current progress after run 216

```text
Package / XEX foundation
████████████████████  100% ✓

PPC translation foundation
████████████████████  100% ✓

Scalar PPC foundation
████████████████████  100% ✓

Guest control foundation
████████████████████  100% ✓

FPU foundation
████████████████████  100% ✓

VMX / VMX128 foundation
████████████████████  100% ✓

Hot WasmBackend
███████████░░░░░░░░░  ~55%  ← ACTIVE

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
██████░░░░░░░░░░░░░░  ~28%

Small XBLA / Braid-class playable
████░░░░░░░░░░░░░░░░  ~20%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░  ~12%

OVERALL RENDER360
███████░░░░░░░░░░░░░  ~33–34%
```

Percentages are scoped engineering estimates, not literal source-code coverage.

## Next implementation order

1. **WasmBackend FPU critic** — lower the already-closed FPU foundation into generated WebAssembly and demand FPR/CR/FPSCR/guest-memory equivalence where upstream Xenia defines the behavior.
2. **WasmBackend VMX/VMX128 critic** — lower the closed vector baseline and compare 128-bit state/memory.
3. **Broad equivalence matrix** — generated WASM vs correctness oracle across representative guest functions.
4. **Compiled-function cache + executable invalidation** — guest address + code-version cache keys and executable-page invalidation.
5. Only then emit `WASM_BACKEND_FOUNDATION=PASS` and mark the WasmBackend foundation 100%.
6. Replace the bounded probe memory with the full sparse/page-backed Xbox guest-memory system.
7. Map the extracted `default.xex`, initialize CPU/module state and execute its genuine entry point.
8. Bring up `KernelState`, xboxkrnl/XAM, then Xenos -> WebGPU/WGSL/EDRAM with WebGL2 fallback and WebAudio.

## Graphics architecture

**WebGPU is primary. WebGL2 is fallback.** Both must consume one shared Xenia/Xenos semantic layer. Three.js remains host/input diagnostics only and is never presented as guest Xbox output. Visual side-by-side comparison against Xenia becomes meaningful only after genuine guest Xenos output exists; CPU/WASM work is judged by architectural-state and memory parity instead.

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
node ./test-wasm-backend-cfg.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-wasm-backend-memory.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-wasm-backend-calls.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

## Status language

- **FOUNDATION COMPLETE** means the named scoped regression contract is green.
- **GENERATED WASM EXECUTING** means finalized Xenia HIR was lowered into WebAssembly and executed with measured state equivalence.
- **PLAYABLE** remains reserved for genuine title execution with sufficient CPU, kernel, GPU, input and audio behavior for gameplay.

Stable production remains **Core V32**. Active project development remains **V35**. UI remains **V33** until a UI-specific release.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.