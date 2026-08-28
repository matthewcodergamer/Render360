# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and minimum browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

Milestone language remains strict:

- **PPC TRANSLATION READY**: real PPC bytes reach real finalized Xenia HIR at runtime.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Current measured result — nested guest calls + FLOAT64 arithmetic

GitHub Actions run **133** (`33143476524`) completed successfully at commit `9cceb0529df209f1226f9b81da6918e6e2e24991`.

```text
wasm32 compile matrix       62 passed / 0 blocked
strict full-export link     LINKED
rooted exports              25
real PPC correctness cases  15 / 15 PASS
```

The live path is:

```text
real big-endian Xbox PPC bytes
  -> bounded Xenia Memory @ 0x80000000
  -> Xenia Processor / PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia compiler + current pass chain
  -> finalized Xenia HIR
  -> Render360 HIRCorrectnessExecutor
  -> real Xenia PPCContext + Processor-owned Xenia Memory
  -> asserted architectural and guest-memory state
```

## New measured boundaries

### Direct and nested guest calls

Xenia now drives guest call discovery and translation in the correctness tier. A direct `bl` emits `SET_RETURN_ADDRESS`, LR state and HIR `CALL`; the resolver asks the real Xenia `PPCScanner` to discover the target function extent, then runs that callee through the real Xenia frontend/translator/compiler. Nested HIR executes against the same active `PPCContext` and returns to the caller.

Measured direct call:

```text
caller -> callee(li r3,5) -> caller(addi +2) -> r3 = 7
assembled guest functions = 2
```

Measured two-level chain:

```text
caller -> A -> B -> A -> caller
B result = 4
A result after resume = 6
caller result = 7
assembled guest functions = 3
```

No Render360 PPC decoder or hardcoded callee implementation is involved.

### First non-zero FPU arithmetic path

The earlier `fmr f1,f2` FPR data-path gate remains green. Run 133 additionally executes:

```text
lfd  f1,0(r4)       ; 1.0
lfd  f2,8(r4)       ; 2.0
fadd f3,f1,f2
stfd f3,16(r4)
lwz  r3,16(r4)
blr
```

Xenia emits **33 finalized HIR instructions**, including guest loads, `BYTE_SWAP`, same-width `CAST` between guest INT64 bits and FLOAT64, typed `ADD`, FPR context operations, cast back to integer bits, guest store, and the final return path.

Measured result:

```text
correctness_status       3
correctness_instructions 33
r3                       0x40080000
guest high word          0x40080000
guest low word           0x00000000
full result bits         0x4008000000000000
```

The full result is IEEE-754 double **3.0**, proving a real floating load/arithmetic/store path against Xenia guest memory.

## Existing measured correctness set

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
fmr f1,f2                                         -> FPR FLOAT64 path PASS
lfd/fadd/stfd 1.0 + 2.0                           -> guest double 3.0
```

The memory operations use the same bounded Xenia `Memory` instance owned by `Processor`. The current 64 KiB window is a correctness environment, not a fake full Xbox memory model.

## Current HIR correctness subset

`src/xenia_web_bootstrap/hir_correctness_executor.cpp` consumes finalized Xenia HIR directly. Current support/measurement includes:

- `SOURCE_OFFSET`, context/memory barriers;
- `LOAD_CONTEXT`, `STORE_CONTEXT` for integer and FPR state;
- same-width `CAST`, including measured INT64 ↔ FLOAT64 bit reinterpretation;
- integer zero/sign extend and truncate;
- integer negation/not/truth tests;
- integer `ADD`, `SUB`, `MUL`;
- bitwise logic and integer shifts;
- signed/unsigned comparisons;
- typed FLOAT32/FLOAT64 `ADD`, `SUB`, `MUL` execution support, with FLOAT64 `ADD` measured in run 133;
- `BRANCH`, conditional branches, backward loops;
- `LOAD`, `STORE`, `LOAD_OFFSET`, `STORE_OFFSET` against Xenia Memory;
- `BYTE_SWAP` for Xbox guest byte order;
- LR, CTR and CR state;
- direct/conditional HIR calls with nested Xenia-scanned guest translation;
- return / `CALL_POSSIBLE_RETURN` boundaries;
- a 4096-instruction correctness guard.

Unsupported HIR fails the gate instead of being ignored or guessed.

## Strict CI behavior

The live graph contains **62 wasm32 translation units** and the strict standalone WASM roots **25 exports** with `ERROR_ON_UNDEFINED_SYMBOLS=1`.

A green workflow means:

```text
source matrix PASS
-> strict link PASS
-> complete required probe ABI present
-> every required real PPC runtime program PASS
```

## Browser-only host adaptations

Generated overlays keep Xenia as the semantic authority:

- PPCContext wasm32 tail padding preserves upstream field offsets;
- current Memory overlay provides only a bounded 64 KiB guest probe window;
- Processor/MMIO native host exception seams are adapted where wasm has no AMD64/ARM64 host context;
- ContextPromotionPass private storage is browser-safe while the algorithm remains Xenia's;
- Arena retains Xenia's 16-byte allocation contract;
- browser logging/sleep replace only host facilities;
- ProbeBackend's register counts are compiler allocation metadata, not x64 execution.

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
Phase 4C  signed compare + multi-block branch                 COMPLETE FIRST SUBSET
Phase 4D  guest load/store + endian semantics                 COMPLETE FIRST SUBSET
Phase 4E  CR/LR/CTR architectural state                       COMPLETE FIRST SUBSET
Phase 4F  CTR-controlled backward loops                       COMPLETE FIRST SUBSET
Phase 4G  direct + nested guest calls/returns                 COMPLETE FIRST SUBSET
Phase 4H  FPR movement + FLOAT64 load/add/store                COMPLETE FIRST SUBSET (run 133)
Phase 4I  broader FPU compare/convert/FPSCR/divide            ACTIVE NEXT
Phase 4J  VMX / VMX128 correctness                            NEXT
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   executable-page invalidation + sparse guest memory  FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Next CPU boundary

Continue expanding only from real Xenia HIR traces:

1. add genuine PPC floating subtraction/multiplication/division tests with exact guest-memory result bits;
2. add floating compare and conversion/FPSCR cases as Xenia emits them;
3. add first VMX/VMX128 context/vector correctness programs;
4. keep unsupported HIR fail-closed;
5. after the correctness subset is broad enough, lower finalized Xenia HIR to the hot `WasmBackend` rather than extending the interpreter indefinitely.

## Hot execution tier after correctness

```text
Xenia finalized HIR
  -> Render360 WasmBackend
  -> generated WebAssembly functions/modules
  -> cache by guest block + code version
```

Writes to executable guest pages must invalidate affected translated blocks.

## Browser graphics architecture

Xenos semantics remain shared; only the browser host API changes:

```text
Xenia Xenos command/register/resource/shader/EDRAM semantics
  -> shared Render360 browser GPU layer
       -> WebGPU PRIMARY backend
            -> WGSL
       -> WebGL2 FALLBACK backend
            -> GLSL ES compatibility
```

**WebGPU is the main renderer. WebGL2 is a fallback**, not a fake alternate game renderer. Both consume the same guest command stream, resources and shader semantics.

After full/sparse memory and XEX entry execution, bring up KernelState/xboxkrnl/XAM, then Xenos packet processing, shader translation, textures, render targets/EDRAM, WebAudio, and finally the first genuine guest framebuffer.

## Do not port into the browser CPU bootstrap

- x64 emitter/native executable-code cache;
- D3D12 or Vulkan;
- desktop windowing/HID/audio output;
- desktop fixed-address 4.5 GiB mapping as though wasm32 supported it.

Those are host implementations, not Xbox semantics.

## Build / verification

```bash
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```