# Render360 V35 WasmBackend Foundation — Active

The WasmBackend is **not yet foundation-complete**. It consumes the exact compiler-finalized HIR produced by upstream Xenia and lowers supported slices into generated WebAssembly. The correctness executor remains the independent architectural oracle while unsupported HIR fails closed.

## Authoritative current gate — run 216

GitHub Actions run **216** (`33159254632`) completed successfully at implementation commit `d05fae62190b2c559100eec4e93b723f6e49f49f`.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_FOUNDATION                            PASS (12 / 12)
wasm32 compile matrix                     68 / 68 PASS
strict full-export link                   LINKED
rooted exports                            47
real PPC/FPU/VMX correctness suite        24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW              PASS
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT   PASS
WASM_BACKEND_CFG_BRANCH                   PASS
WASM_BACKEND_CFG_LOOP                     PASS
WASM_BACKEND_MEMORY_ENDIAN                PASS
WASM_BACKEND_CALL_DIRECT                  PASS
WASM_BACKEND_CALL_NESTED                  PASS
WASM_BACKEND_CALL_INDIRECT                PASS
WASM_BACKEND_CALL_FAIL_CLOSED             PASS
WASM_BACKEND_STAGE                        GUEST_CALLS_PASS
```

## Green workstream 1 — scalar generated WASM

The scalar workstream lowers real Xenia-finalized HIR into native WebAssembly integer operations and reads/writes a real `PPCContext` through shared WebAssembly memory. It covers integer constants and context state, assign/truncate/extend, arithmetic/bitwise operations, signed/unsigned comparisons, boolean tests and shifts. The same compiled generated modules are reused with changed live context values.

```text
addi r3,r4,5: r4=7 -> r3=12; reuse r4=100 -> r3=105
cmpwi/mfcr: negative/zero/positive -> LT/EQ/GT CR0 encodings
WASM_BACKEND_SCALAR_DATAFLOW=PASS
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS
```

## Green workstream 2 — generated-WASM CFG

The CFG critic previously rejected incorrect not-taken behavior. The hardened implementation follows Xenia's finalized instruction-level branch contract, supports conditional fallthrough, unconditional merge branches and backward CTR loops, and uses a bounded dispatcher so malformed generated CFGs cannot run forever.

```text
cfg_branch_taken_r3=2
cfg_branch_not_taken_r3=1
cfg_ctr_loop_r3=3
cfg_conditional_reuse_r3=1
cfg_loop_reuse_r3=5
WASM_BACKEND_CFG_BRANCH=PASS
WASM_BACKEND_CFG_LOOP=PASS
```

## Green workstream 3 — generated-WASM guest memory / endian

The memory critic lowers `LOAD`, `LOAD_OFFSET`, `STORE`, `STORE_OFFSET`, `TRUNCATE`, `ZERO_EXTEND` and `BYTE_SWAP` from finalized Xenia HIR and operates on the same Xenia Memory backing used by the correctness oracle.

```text
lwz first/reuse         0x89ABCDEF -> 0x10203040
stw->lwz first/reuse    0x12345678 -> 0xA1B2C3D4
WASM_BACKEND_MEMORY_ENDIAN=PASS
```

This is bounded probe-memory execution, not the future sparse/page-backed 32-bit Xbox memory subsystem.

## Green workstream 4 — generated guest calls

The call backend registers one generated child module for every guest function that Xenia itself independently scans/translates/compiles. The generated caller dispatches only to this Xenia-derived function registry and shares the live `PPCContext` with its callees.

Run 215 deliberately failed the first implementation. The critic exposed incorrect encoding of high-bit Xbox guest addresses in WebAssembly `i32.const`: unsigned LEB128 had been used where signed LEB128 is required. The implementation was fixed without weakening the critic, and the same test passed in run 216.

The gate now proves:

```text
direct bl -> generated callee -> blr              PASS
nested caller -> A -> B -> A -> caller             PASS
runtime CTR -> bctrl -> generated callee            PASS
CALL_POSSIBLE_RETURN / blr boundary                 PASS
shared PPCContext across generated functions        PASS
unknown dynamic target fails closed                 PASS

WASM_BACKEND_CALL_DIRECT=PASS
WASM_BACKEND_CALL_NESTED=PASS
WASM_BACKEND_CALL_INDIRECT=PASS
WASM_BACKEND_CALL_FAIL_CLOSED=PASS
```

No second PPC decoder or correctness-interpreter fallback is used for generated calls.

## Current generated-WASM lowering surface

```text
integer dataflow / scalar context                    ✓
scalar compares / types / shifts                      ✓
conditional + unconditional CFG                      ✓
backward CTR-driven loops                             ✓
bounded guest-memory loads/stores                     ✓
Xbox scalar byte-swap/endian                          ✓
generated direct calls                                ✓
generated nested calls                                ✓
generated CTR/bctrl indirect calls                    ✓
unknown generated-call target fail-closed             ✓
live context/memory module reuse                      ✓
```

## What remains before `WASM_BACKEND_FOUNDATION=PASS`

1. completed FPU-baseline lowering;
2. completed VMX/VMX128-baseline lowering;
3. broader generated-WASM vs Xenia correctness-oracle equivalence matrix;
4. compiled guest-function/block cache keyed by guest address and code version;
5. executable-page versioning/invalidation;
6. dedicated final `WASM_BACKEND_FOUNDATION=PASS` gate.

## Current scoped progress

```text
Hot WasmBackend
███████████░░░░░░░░░  ~55%  ACTIVE

finalized HIR -> generated WASM                     ✓
scalar integer dataflow                             ✓
scalar types / compare / shifts                     ✓
conditional + unconditional CFG                     ✓
backward loops                                      ✓
guest memory + endian                               ✓
generated direct/nested/CTR calls                   ✓
fail-closed unknown call target                     ✓
FPU                                                 ○  NEXT
VMX / VMX128                                        ○
broad equivalence matrix                            △ partial
compiled-function cache                             ○
executable-page invalidation                        ○
foundation gate                                     ○
```

The percentage is a scoped engineering estimate, not source-code coverage and not a claim of retail-title compatibility.

## V44.15 retail-title CALL verification

The browser bootstrap is being rebuilt from the current source closure after the Braid startup trace reached HIR `CALL` at `0x8236EF40`. The rebuild includes recursive direct/address guest-call resolution, active title-module preservation for address-decoded calls, and the `R360_CALL_RESOLVERS_READY` provenance marker so a deployed browser trace can prove that the verified WASM contains the current resolver path.
