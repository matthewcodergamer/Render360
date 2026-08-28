# Render360 V35 WasmBackend Foundation — Active

The WasmBackend is **not yet foundation-complete**. It consumes the exact compiler-finalized HIR produced by upstream Xenia and lowers supported slices into generated WebAssembly. The correctness executor remains the independent architectural oracle while unsupported HIR fails closed.

## Authoritative current gate — run 196

GitHub Actions run **196** (`33157075912`) completed successfully at implementation commit `d084d034cc4cb88ed9ae9b0f6c8994e4ddf359c5`.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_FOUNDATION                            PASS (12 / 12)
wasm32 compile matrix                     66 / 66 PASS
strict full-export link                   LINKED
rooted exports                            35
real PPC/FPU/VMX correctness suite        24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW              PASS
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT   PASS
WASM_BACKEND_CFG_BRANCH                   PASS
WASM_BACKEND_CFG_LOOP                     PASS
WASM_BACKEND_STAGE                        CFG_BRANCH_LOOP_PASS
```

## Green stage 1 — scalar generated WASM

Run 183 first proved genuine finalized-Xenia-HIR -> generated-WebAssembly execution with real PPC `addi r3,r4,5 ; blr`. The generated child module imports the parent WebAssembly.Memory, reads/writes the real Xenia `PPCContext`, and was reused with two different runtime inputs:

```text
r4=7    -> generated r3=12
r4=100  -> generated r3=105
```

## Green stage 2 — scalar type / compare / shift parity

Run 187 added a deliberately strict real-PPC `cmpwi r4,0 ; mfcr r3 ; blr` equivalence gate. It exercises finalized HIR truncation, signed comparisons, boolean results, zero extension, shifts, OR chains and context stores.

```text
negative input  -> CR0 LT -> 0x80000000
zero input      -> CR0 EQ -> 0x20000000
positive input  -> CR0 GT -> 0x40000000
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS
```

## Green stage 3 — generated-WASM CFG branch and loop parity

The independent CFG workstream deliberately failed before it was promoted. Run 195 exposed a semantic bug where the not-taken side of a finalized-HIR conditional branch incorrectly jumped to the taken label. The cause was assuming every Xenia `BRANCH_TRUE` terminated its C++ HIR `Block`.

Xenia may keep the conditional branch and the not-taken instruction stream in the same finalized HIR block. Commit `d084d034cc4cb88ed9ae9b0f6c8994e4ddf359c5` fixed the generated CFG rule:

```text
condition true   -> dispatch to Xenia label target
condition false  -> continue with the next finalized HIR instruction
unconditional b  -> dispatch to its label target
blr boundary     -> terminate generated function
```

Run 196 then proved both directions and a backward CTR loop:

```text
cfg_branch_taken_r3=2
cfg_branch_not_taken_r3=1
cfg_ctr_loop_r3=3
cfg_conditional_reuse_r3=1
cfg_loop_reuse_r3=5

WASM_BACKEND_CFG_BRANCH=PASS
WASM_BACKEND_CFG_LOOP=PASS
WASM_BACKEND_STAGE=CFG_BRANCH_LOOP_PASS
```

Dedicated generated modules were 224 bytes for the conditional program and 213 bytes for the CTR loop, with 14 finalized-HIR operations lowered in each gate. A 100,000-dispatch trap budget prevents malformed generated control flow from spinning forever.

## Current generated-WASM lowering surface

```text
integer constants / context loads                  ✓
ASSIGN / TRUNCATE / ZERO_EXTEND / SIGN_EXTEND      ✓
ADD / SUB / AND / OR / XOR / NOT / NEG             ✓
integer signed/unsigned compare families            ✓
IS_TRUE / IS_FALSE                                  ✓
SHL / SHR / SHA / ROTATE_LEFT                       ✓
context stores                                      ✓
conditional taken + not-taken semantics             ✓
unconditional branch / merge                        ✓
backward CTR-driven loops                           ✓
CALL_POSSIBLE_RETURN boundary                       ✓
live-context module reuse                           ✓
dispatch safety budget                              ✓
```

## What remains before `WASM_BACKEND_FOUNDATION=PASS`

1. guest scalar memory (`LOAD`, `LOAD_OFFSET`, `STORE`, `STORE_OFFSET`) and Xbox byte-swap/endian parity;
2. direct, nested and CTR-indirect guest calls/returns in generated WASM;
3. completed FPU-baseline lowering;
4. completed VMX/VMX128-baseline lowering;
5. broad generated-WASM vs Xenia correctness-oracle equivalence matrix;
6. compiled guest-function/block cache keyed by guest address and code version;
7. executable-page versioning/invalidation;
8. dedicated final `WASM_BACKEND_FOUNDATION=PASS` gate.

## Current scoped progress

```text
Hot WasmBackend
██████░░░░░░░░░░░░░░  ~28%  ACTIVE

finalized HIR -> generated WASM                     ✓
scalar integer dataflow                             ✓
scalar types / compare / shifts                     ✓
conditional + unconditional CFG                     ✓
backward loops                                      ✓
live module reuse                                   ✓
guest memory + endian                               ○  NEXT
generated guest calls                               ○
FPU                                                 ○
VMX / VMX128                                        ○
compiled-function cache                             ○
executable-page invalidation                        ○
foundation gate                                     ○
```

The percentage is a scoped engineering estimate, not source-code coverage and not a claim of retail-title compatibility.