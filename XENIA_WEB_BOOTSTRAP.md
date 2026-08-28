# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and minimum browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

Milestone language remains strict:

- **PPC TRANSLATION READY**: real PPC bytes reach real finalized Xenia HIR at runtime.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Current measured result — PPC EXECUTING through memory, CR/LR/CTR and loops

GitHub Actions run **115** (`33140686990`) completed successfully at commit `eea80eaf63131d8c9d39150c8b39c4229b5d5e61`.

```text
wasm32 compile matrix       62 passed / 0 blocked
strict full-export link     LINKED
rooted exports              25
real PPC correctness cases  11 / 11 PASS
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

## Measured correctness programs

The current CI set verifies:

```text
li r3,1 ; blr                                      -> r3 = 1
seed r4=7; addi r3,r4,5 ; blr                     -> r3 = 12
seed r4=0x0F00; ori r3,r4,0xF0 ; blr              -> r3 = 0x0FF0
cmpwi/beq program, r4=0                           -> taken, r3 = 2
same program, r4=5                                -> fallthrough, r3 = 1
lwz r3,0(r4), memory=0x89ABCDEF                  -> r3 = 0x89ABCDEF
stw r5,0(r4); lwz r3,0(r4)                        -> r3 = 0x12345678
                                                   guest readback = 0x12345678
mtlr r4; mflr r3                                  -> r3 = 0x80000040
mtctr r4; mfctr r3                                -> r3 = 9
cmpwi r4,0; mfcr r3                               -> r3 = 0x20000000
mtctr r4; addi loop; bdnz loop, r4=3              -> r3 = 3
```

The memory cases prove finalized Xenia HIR `LOAD_OFFSET`, `STORE_OFFSET` and `BYTE_SWAP` execute against the **same Xenia `Memory` instance owned by `Processor`**. The store/load round trip additionally reads the underlying guest bytes back and requires exactly `0x12345678`.

The architectural-state cases prove the initial LR/CTR/CR subset without a second PPC decoder. `cmpwi/mfcr` generated **138 finalized HIR instructions** and produced CR0 equality as `0x20000000`.

The real CTR-controlled `bdnz` loop generated **2 finalized HIR blocks / 21 HIR instructions**. Runtime execution traversed the backward edge repeatedly, executed **45 HIR instructions**, decremented CTR to its termination condition, and finished with `r3 = 3`.

## Current HIR correctness subset

`src/xenia_web_bootstrap/hir_correctness_executor.cpp` consumes finalized Xenia HIR directly.

Current measured/support foundation includes:

- `SOURCE_OFFSET`, `CONTEXT_BARRIER`;
- `LOAD_CONTEXT`, `STORE_CONTEXT`;
- `ASSIGN`, integer cast/zero-extend/sign-extend/truncate;
- `NEG`, `NOT`, `IS_TRUE`, `IS_FALSE`;
- integer `ADD`, `SUB`, `MUL`;
- `AND`, `AND_NOT`, `OR`, `XOR`;
- `SHL`, `SHR`, `SHA`;
- signed/unsigned equality and relational comparisons;
- `BRANCH`, `BRANCH_TRUE`, `BRANCH_FALSE`;
- backward loop execution and CTR-driven branch state;
- `LOAD`, `STORE`, `LOAD_OFFSET`, `STORE_OFFSET` against Xenia guest Memory;
- `BYTE_SWAP` for Xbox guest byte order;
- LR, CTR and CR state through normal Xenia context operations;
- return and Xenia `CALL_POSSIBLE_RETURN` boundaries;
- a 4096-instruction correctness guard so unsupported/infinite paths cannot hang CI.

Unsupported HIR makes the gate fail instead of being ignored or guessed.

## Strict CI behavior

The graph contains **62 wasm32 translation units** and the strict standalone WASM roots **25 exports** in one `EXPORTED_FUNCTIONS` list with `ERROR_ON_UNDEFINED_SYMBOLS=1`.

A green workflow means:

```text
source matrix PASS
-> strict link PASS
-> complete required probe ABI present
-> every real PPC runtime correctness program PASS
```

A BLOCKED compile/link or failed architectural/memory result fails CI.

## Browser-only host adaptations

Generated overlays keep Xenia as the semantic authority:

- **PPCContext**: 16 bytes of wasm32 tail-only padding restore Xenia's 64-byte size invariant without moving existing fields.
- **Memory**: the current correctness probe exposes only a 64 KiB guest window at `0x80000000`; it is not the final Xbox address-space implementation.
- **Processor/MMIO**: native AMD64/ARM64 host exception-PC/fault decoding is excluded where wasm has no such machine context; Xbox-facing behavior is not replaced.
- **ContextPromotionPass**: private LLVM BitVector storage is replaced while the pass algorithm remains the same.
- **Arena**: Xenia's 16-byte alignment contract is retained with `posix_memalign`.
- **Logging/sleep**: narrow browser host implementations avoid dragging desktop host threads into the probe.
- **ProbeBackend register model**: 7 integer + 12 shared float/vector slots are compiler allocation metadata only, not x64 execution.

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
Phase 4D  guest LOAD/STORE/OFFSET + endian semantics          COMPLETE FIRST SUBSET (run 113)
Phase 4E  CR/LR/CTR architectural state                       COMPLETE FIRST SUBSET (run 114)
Phase 4F  real CTR-controlled backward loop                   COMPLETE FIRST SUBSET (run 115)
Phase 4G  broader guest calls/returns/integer-control          ACTIVE NEXT
Phase 4H  FPU correctness                                    NEXT
Phase 4I  VMX / VMX128 correctness                            AFTER FPU
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   sparse/page-backed full guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Next CPU boundary — calls and broader control

The next correctness tier should exercise guest call/return structure beyond treating `blr` only as the final probe boundary. Use real PPC that produces Xenia HIR call/return behavior, validate LR updates and return targets, and then expand arithmetic/address/control combinations that a real compiled XEX prologue and function body will need.

The rule remains unchanged: consume Xenia's finalized HIR and architectural context. Do not add a second PowerPC interpreter.

After that:

1. FPU HIR correctness and real PPC floating-point tests;
2. VMX/VMX128 vector correctness;
3. hot-block `WasmBackend` lowering finalized Xenia HIR to generated WebAssembly;
4. executable-page versioning/invalidation;
5. sparse/page-backed full Xbox guest memory;
6. map the already captured `default.xex` sections and entry point;
7. KernelState/xboxkrnl/XAM bring-up.

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
            -> GLSL ES compatibility emission
```

**WebGPU is the main renderer. WebGL2 is a fallback**, not a fake alternate game renderer. Both must consume the same guest command stream, resources and shader semantics. WebGL2 may have reduced performance/feature coverage where its API cannot match WebGPU efficiently, but it must never substitute host-authored Three.js output for guest rendering.

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
