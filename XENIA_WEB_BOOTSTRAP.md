# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC/FPU/VMX frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and minimum browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

Milestone language remains strict:

- **PPC TRANSLATION READY**: real PPC bytes reach finalized Xenia HIR at runtime.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state or guest-memory changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Current authoritative green result — run 141

GitHub Actions run **141** (`33144177521`) completed successfully at implementation commit `d3dbfc74e9a7949485039d8e591410c6fe0cc099`.

```text
wasm32 compile matrix       62 passed / 0 blocked
strict full-export link     LINKED
rooted exports              25
real PPC correctness cases  18 / 18 PASS
```

The live path remains:

```text
real big-endian Xbox PPC/FPU/VMX bytes
  -> bounded Xenia Memory @ 0x80000000
  -> Xenia Processor / PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia compiler + portable pass chain
  -> finalized Xenia HIR
  -> Render360 HIRCorrectnessExecutor
  -> real Xenia PPCContext + Processor-owned Xenia Memory
  -> asserted architectural and guest-memory state
```

## What is now verified

### Integer / control / memory

The earlier gates remain green:

```text
li r3,1 ; blr                                      -> r3 = 1
seed r4=7; addi r3,r4,5 ; blr                     -> r3 = 12
seed r4=0x0F00; ori r3,r4,0xF0 ; blr              -> r3 = 0x0FF0
cmpwi/beq, r4=0                                   -> taken, r3 = 2
cmpwi/beq, r4=5                                   -> fallthrough, r3 = 1
lwz r3,0(r4), guest=0x89ABCDEF                   -> r3 = 0x89ABCDEF
stw r5,0(r4); lwz r3,0(r4)                        -> r3/guest = 0x12345678
mtlr r4; mflr r3                                  -> r3 = 0x80000040
mtctr r4; mfctr r3                                -> r3 = 9
cmpwi r4,0; mfcr r3                               -> r3 = 0x20000000
mtctr r4; addi loop; bdnz loop, r4=3              -> r3 = 3
direct bl/callee/blr                              -> r3 = 7
two-level nested bl                               -> r3 = 7
```

Direct and nested calls are not hardcoded. Xenia emits call/LR behavior, the real Xenia `PPCScanner` discovers callee extents, and each callee is independently translated through Xenia before its finalized HIR executes against the same active `PPCContext`.

### FLOAT64 arithmetic — ADD / SUB / MUL

The FPU tier now verifies three non-zero arithmetic operations through guest memory.

```text
1.0 + 2.0 = 3.0
5.0 - 2.0 = 3.0
1.5 * 2.0 = 3.0
```

Each test uses genuine PPC:

```text
lfd  f1,0(r4)
lfd  f2,8(r4)
< fadd | fsub | fmul > f3,f1,f2
stfd f3,16(r4)
lwz  r3,16(r4)
blr
```

Each program produces **33 finalized Xenia HIR instructions** and completes with:

```text
correctness_status       3
correctness_instructions 33
r3                       0x40080000
guest high word          0x40080000
guest low word           0x00000000
full result bits         0x4008000000000000
```

The result is IEEE-754 double **3.0**. The path includes Xenia guest loads, Xbox byte swapping, same-width INT64↔FLOAT64 HIR casts, typed arithmetic, FPR context state, conversion back to guest bits and guest stores.

This closes the first basic FLOAT64 add/subtract/multiply correctness tier. Division, compare/conversion and broader FPSCR semantics remain open.

### First VMX VEC128 execution tier

Diagnostic run 136 previously proved that genuine `lvx/vaddubm/stvx` PPC decoded and translated successfully but stopped at the first VEC128 `BYTE_SWAP` in the correctness executor.

Run 141 closes that boundary. The required program is:

```text
lvx      v1,0,r4
lvx      v2,0,r5
vaddubm  v3,v1,v2
stvx     v3,0,r7
lwz      r3,0(r7)
blr
```

Xenia emits **29 finalized HIR instructions** containing VEC128 loads, VEC128 byte swaps, VR context operations, `VECTOR_ADD`, VEC128 guest store and scalar readback.

The executor now implements exactly the measured semantics:

- VEC128 `BYTE_SWAP` using Xenia's own 128-bit convention: byte reversal within each 32-bit word;
- `VECTOR_ADD` only for the measured `INT8_TYPE + ARITHMETIC_UNSIGNED` form emitted by `vaddubm`;
- modulo-256 addition of all sixteen byte lanes.

With sixteen `0x01` source bytes and sixteen `0x02` source bytes, CI verifies:

```text
correctness_status       3
correctness_instructions 29
r3                       0x03030303
guest[0x80000160]        0x03030303
guest[0x80000164]        0x03030303
guest[0x80000168]        0x03030303
guest[0x8000016c]        0x03030303
```

This is the first genuine **VMX load → vector arithmetic → store** path executing through finalized Xenia HIR on wasm32. Other vector lane widths, saturation modes, vector comparisons, logical operations and VMX128-specific instructions remain fail-closed until measured.

## Current HIR correctness subset

`src/xenia_web_bootstrap/hir_correctness_executor.cpp` consumes finalized Xenia HIR directly. Current support/measurement includes:

- `SOURCE_OFFSET`, context/memory barriers;
- `LOAD_CONTEXT`, `STORE_CONTEXT` for GPR/FPR/VR state as reached by measured programs;
- same-width `CAST`, including INT64 ↔ FLOAT64 bit reinterpretation;
- integer zero/sign extend, truncate, negate, not and truth tests;
- integer `ADD`, `SUB`, `MUL`;
- integer bitwise logic and shifts;
- signed/unsigned comparisons;
- typed FLOAT32/FLOAT64 `ADD`, `SUB`, `MUL` support, with FLOAT64 forms independently verified;
- `BRANCH`, conditional branches and backward loops;
- `LOAD`, `STORE`, `LOAD_OFFSET`, `STORE_OFFSET` against Xenia Memory;
- scalar `BYTE_SWAP` plus measured VEC128 `BYTE_SWAP`;
- LR, CTR and CR state;
- direct/conditional HIR calls with nested Xenia-scanned translation;
- return / `CALL_POSSIBLE_RETURN` boundaries;
- measured `VECTOR_ADD` for unsigned INT8 lanes;
- a 4096-instruction correctness guard.

Unsupported HIR fails the gate rather than being ignored, guessed or treated as no-op behavior.

## Strict CI behavior

The live graph contains **62 wasm32 translation units** and the strict standalone WASM roots **25 exports** with `ERROR_ON_UNDEFINED_SYMBOLS=1`.

A green workflow means:

```text
source matrix PASS
-> strict link PASS
-> complete required probe ABI present
-> every required real PPC/FPU/VMX runtime program PASS
```

## Browser-only host adaptations

Generated overlays keep Xenia as the semantic authority:

- PPCContext wasm32 tail padding preserves upstream field offsets;
- current Memory overlay provides only a bounded 64 KiB guest correctness window;
- Processor/MMIO native host exception seams are adapted where wasm has no AMD64/ARM64 machine context;
- ContextPromotionPass private storage is browser-safe while its algorithm remains Xenia's;
- Arena retains Xenia's 16-byte allocation contract;
- browser logging/sleep replace only host facilities;
- ProbeBackend register counts are compiler-allocation metadata, not x64 execution.

## Current phase ladder

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation ProbeBackend                            COMPLETE
Phase 2C  Xenia Memory / Processor / runtime closure          COMPLETE FOR PROBE
Phase 3   strict full-export link                             COMPLETE
Phase 3A  real PPC -> finalized Xenia HIR                     COMPLETE
Phase 3B  PPC TRANSLATION READY                               COMPLETE
Phase 4   finalized-HIR correctness execution                 ACTIVE / VERIFIED
Phase 4A  first PPCContext state change                       COMPLETE
Phase 4B  runtime integer arithmetic                          COMPLETE FIRST SUBSET
Phase 4C  compare + multi-block branch                        COMPLETE FIRST SUBSET
Phase 4D  guest load/store + endian semantics                 COMPLETE FIRST SUBSET
Phase 4E  CR/LR/CTR architectural state                       COMPLETE FIRST SUBSET
Phase 4F  CTR-controlled backward loops                       COMPLETE FIRST SUBSET
Phase 4G  direct + nested guest calls/returns                 COMPLETE FIRST SUBSET
Phase 4H  FPR movement + FLOAT64 load/store                   COMPLETE FIRST SUBSET
Phase 4I  FLOAT64 ADD/SUB/MUL                                 COMPLETE FIRST SUBSET (run 141)
Phase 4J  VMX VEC128 load/byte-add/store                      COMPLETE FIRST SUBSET (run 141)
Phase 4K  FP DIV + compare/convert/FPSCR                      ACTIVE NEXT
Phase 4L  broader VMX / VMX128 correctness                    NEXT
Phase 5   hot-block WasmBackend + function cache              FUTURE
Phase 5A  executable-page invalidation                        FUTURE
Phase 6   sparse/page-backed full Xbox guest memory           FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Next CPU boundary

Continue from real Xenia HIR traces rather than guessing:

1. add genuine PPC `fdiv` and typed FLOAT32/FLOAT64 HIR `DIV` execution;
2. add real floating compare/conversion cases and verify CR/FPSCR state;
3. broaden VMX to halfword/word adds, vector subtraction and logical operations as emitted by Xenia;
4. add VMX128-specific correctness cases representative of Xbox 360 compiled code;
5. keep unsupported HIR fail-closed;
6. once this correctness subset is sufficient, move hot execution into `WasmBackend` rather than turning the correctness executor into a full permanent interpreter.

## Hot execution tier after correctness

```text
Xenia finalized HIR
  -> Render360 WasmBackend
  -> generated WebAssembly functions/modules
  -> cache by guest block + code version
```

Writes to executable guest pages must invalidate affected translated blocks.

## Major emulator transition after CPU correctness

The large next architecture transition is:

```text
sparse/page-backed Xbox guest memory
  -> map captured default.xex sections at guest addresses
  -> establish initial CPU state
  -> execute the real default.xex entry point
  -> observe requested KernelState/xboxkrnl/XAM services
```

That is where the CPU stops being driven only by handcrafted correctness programs and starts executing real title code.

## Browser graphics architecture

```text
Xenia Xenos command/register/resource/shader/EDRAM semantics
  -> shared Render360 browser GPU layer
       -> WebGPU PRIMARY backend
            -> WGSL
       -> WebGL2 FALLBACK backend
            -> GLSL ES compatibility emission
```

Both graphics backends must consume the same guest Xenos semantics. WebGL2 is a compatibility backend, not a fake alternate renderer.

## Build / verification

```bash
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

## Do not port into the browser CPU bootstrap

- x64 emitter/native executable-code cache;
- D3D12 or Vulkan;
- desktop windowing/HID/audio output;
- desktop fixed-address 4.5 GiB mapping as though wasm32 supported it.

Those are host implementations, not Xbox semantics.