# Render360 V35 WasmBackend Foundation — Active

The WasmBackend is **not yet foundation-complete**. It consumes the exact compiler-finalized HIR produced by upstream Xenia and lowers supported slices into generated WebAssembly. The correctness executor remains the independent architectural oracle while unsupported HIR fails closed.

## Authoritative current gate — run 206

GitHub Actions run **206** (`33157972327`) completed successfully at implementation commit `6728006d854ee3e2958861d38ac8bb57beb73af6`.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
VMX_FOUNDATION                            PASS (12 / 12)
wasm32 compile matrix                     67 / 67 PASS
strict full-export link                   LINKED
rooted exports                            40
real PPC/FPU/VMX correctness suite        24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW              PASS
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT   PASS
WASM_BACKEND_CFG_BRANCH                   PASS
WASM_BACKEND_CFG_LOOP                     PASS
WASM_BACKEND_MEMORY_ENDIAN                PASS
```

## Green workstream 1 — scalar generated WASM

Run 183 first proved genuine finalized-Xenia-HIR -> generated-WebAssembly execution with real PPC `addi r3,r4,5 ; blr`. The generated child module imports the parent `WebAssembly.Memory`, reads/writes the real Xenia `PPCContext`, and was reused with two different runtime inputs:

```text
r4=7    -> generated r3=12
r4=100  -> generated r3=105
WASM_BACKEND_SCALAR_DATAFLOW=PASS
```

The scalar critic now also passes the deliberately strict real-PPC `cmpwi r4,0 ; mfcr r3 ; blr` chain, including truncation, signed comparisons, boolean results, zero/sign extension, shifts, OR chains and context stores:

```text
negative input  -> CR0 LT -> 0x80000000
zero input      -> CR0 EQ -> 0x20000000
positive input  -> CR0 GT -> 0x40000000
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS
```

## Green workstream 2 — generated-WASM CFG branch and loop parity

The CFG workstream deliberately failed before promotion when an earlier run exposed wrong not-taken semantics. The hardened backend follows Xenia's instruction-level branch contract rather than assuming every conditional branch terminates its C++ HIR block.

Run 206 re-verifies both branch directions and a backward CTR loop, including reuse of the same generated modules with changed live input:

```text
cfg_branch_taken_r3=2
cfg_branch_not_taken_r3=1
cfg_ctr_loop_r3=3
cfg_conditional_reuse_r3=1
cfg_loop_reuse_r3=5
WASM_BACKEND_CFG_BRANCH=PASS
WASM_BACKEND_CFG_LOOP=PASS
```

The generated conditional module is 224 bytes and the CTR-loop module is 213 bytes, with 14 finalized-HIR operations lowered in each gate. A bounded dispatcher prevents malformed generated control flow from spinning forever.

## Green workstream 3 — generated-WASM guest memory / endian parity

Run 206 adds an independent memory critic rather than hiding memory behavior inside the scalar backend. It lowers finalized Xenia HIR for scalar guest-memory operations and executes against the same wasm32/Xenia memory environment.

Real `lwz` path:

```text
module_bytes=160
lowered=6
first read   -> r3=0x89ABCDEF
module reuse -> r3=0x10203040
```

Real `stw -> lwz` round-trip:

```text
module_bytes=241
lowered=10
first round-trip   -> r3=0x12345678
module reuse       -> r3=0xA1B2C3D4
```

The HIR path includes `LOAD_OFFSET`, `STORE_OFFSET`, `TRUNCATE`, `ZERO_EXTEND` and `BYTE_SWAP`, so the test locks the Xbox big-endian scalar-memory behavior rather than comparing only host-native bytes.

```text
WASM_BACKEND_MEMORY_ENDIAN=PASS
WASM_BACKEND_STAGE=MEMORY_ENDIAN_PASS
```

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
live-context generated-module reuse                 ✓
dispatch safety budget                              ✓
scalar guest-memory loads/stores                    ✓
Xbox scalar byte-swap/endian path                   ✓
live-memory generated-module reuse                  ✓
```

## What remains before `WASM_BACKEND_FOUNDATION=PASS`

1. direct, nested and CTR-indirect guest calls/returns in generated WASM;
2. completed FPU-baseline lowering;
3. completed VMX/VMX128-baseline lowering;
4. broad generated-WASM vs Xenia correctness-oracle equivalence matrix;
5. compiled guest-function/block cache keyed by guest address and code version;
6. executable-page versioning/invalidation;
7. dedicated final `WASM_BACKEND_FOUNDATION=PASS` gate.

## Current scoped progress

```text
Hot WasmBackend
████████░░░░░░░░░░░░  ~38%  ACTIVE

finalized HIR -> generated WASM                     ✓
scalar integer dataflow                             ✓
scalar types / compare / shifts                     ✓
conditional + unconditional CFG                     ✓
backward loops                                      ✓
guest memory + endian                               ✓
live context/memory module reuse                    ✓
generated guest calls                               ○  NEXT
FPU                                                 ○
VMX / VMX128                                        ○
broad equivalence matrix                            ○
compiled-function cache                             ○
executable-page invalidation                        ○
foundation gate                                     ○
```

The percentage is a scoped engineering estimate, not source-code coverage and not a claim of retail-title compatibility.