# Render360 V35 WasmBackend Foundation — Active

The WasmBackend is **not yet foundation-complete**. This document records the measured stages that are green while active development moves finalized Xenia HIR from the reference correctness executor into generated WebAssembly functions.

## First green generated-WASM stage

GitHub Actions run **183** (`33153679117`) completed successfully at implementation commit `edca8d59cbdc7eb38e8b11adc753759d68d6e7af`.

```text
wasm32 compile matrix                     65 / 65 PASS
strict full-export link                   LINKED
rooted exports                            30
real PPC/FPU/VMX correctness suite        24 / 24 PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_FOUNDATION                            PASS (12 cases)
WASM_BACKEND_SCALAR_DATAFLOW              PASS
WASM_BACKEND_STAGE                        SCALAR_DATAFLOW_PASS
```

## What genuinely executed

The gate begins with real big-endian PowerPC bytes:

```text
addi r3,r4,5      0x38640005
blr               0x4E800020
```

They travel through Xenia before Render360's hot backend sees them:

```text
real PPC bytes
  -> Xenia PPCScanner / PPCFrontend / PPCTranslator
  -> PPCHIRBuilder + Xenia compiler passes
  -> finalized Xenia HIR
       load_context r4
       add INT64 +5
       store_context r3
  -> Render360 WasmBackend probe
  -> generated child WebAssembly module
  -> imported parent WebAssembly.Memory
  -> real Xenia PPCContext layout
  -> native WebAssembly i64.load / i64.add / i64.store
```

Measured output from run 183:

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

The generated module was first run with `r4=7`, producing/storing `r3=12`, exactly matching the existing Xenia-HIR correctness oracle. The **same compiled generated module** was then reused with `r4=100` and produced `r3=105`, proving the result was not baked in from the first test input.

## Current lowering surface

The first emitter can recursively lower a narrow INT64 dataflow subset from finalized Xenia HIR:

```text
INT64 constants                 implemented
LOAD_CONTEXT INT64              implemented
ASSIGN INT64                    implemented
ADD INT64                       implemented
SUB INT64                       implemented
AND INT64                       implemented
OR INT64                        implemented
XOR INT64                       implemented
STORE_CONTEXT r3 result         implemented for first gate
```

Unsupported HIR shapes fail closed. They are not reported as generated-WASM success and the existing correctness executor remains the reference/fallback during bring-up.

## What this does not mean

`WASM_BACKEND_FOUNDATION=PASS` is **not** emitted yet. The current stage does not yet provide general multi-block control flow, guest-memory lowering, guest calls, FPU lowering, VMX lowering, a compiled-function cache, or executable-page invalidation.

## Closure sequence

1. broaden scalar integer/value lowering and multi-result context writes;
2. lower comparisons, truncation/extension and shifts;
3. lower branches and multi-block control flow;
4. lower guest scalar memory and Xbox endian operations;
5. lower direct, nested and CTR-indirect guest calls/returns;
6. lower the completed FPU foundation;
7. lower the completed VMX/VMX128 foundation;
8. run a broad generated-WASM vs correctness-oracle equivalence matrix;
9. add compiled guest-function/block caching;
10. add executable-page code versioning/invalidation;
11. only then emit `WASM_BACKEND_FOUNDATION=PASS`.

## Current scoped progress

```text
Hot WasmBackend
██░░░░░░░░░░░░░░░░░░  ~12%  ACTIVE

first finalized-HIR -> generated-WASM function   ✓
shared PPCContext memory                         ✓
INT64 context load/add/store                     ✓
runtime-input reuse                              ✓
correctness-oracle equivalence                   ✓ first case
control flow                                     ○
guest memory                                     ○
calls                                             ○
FPU                                               ○
VMX / VMX128                                      ○
compiled-function cache                           ○
executable-page invalidation                      ○
foundation gate                                   ○
```
