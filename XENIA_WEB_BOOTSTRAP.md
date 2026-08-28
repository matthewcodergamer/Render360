# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and minimum browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

Milestone language remains strict:

- **PPC TRANSLATION READY**: real PPC bytes reach real finalized Xenia HIR at runtime.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Current measured result — PPC EXECUTING with runtime integer + control flow

GitHub Actions run **104** (`33139670498`) completed successfully at commit `73986b17776253f8e727d04ca0b41766bae286ff`.

```text
wasm32 compile matrix       62 passed / 0 blocked
strict full-export link     LINKED
rooted exports              23
real PPC correctness cases  5 / 5 PASS
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
  -> real Xenia PPCContext
  -> asserted architectural state
```

Verified programs now include:

```text
li r3,1 ; blr                                -> r3 = 1
seed r4=7; addi r3,r4,5 ; blr               -> r3 = 12
seed r4=0x0F00; ori r3,r4,0xF0 ; blr        -> r3 = 0x0FF0
cmpwi/beq program, seed r4=0                -> taken path, r3 = 2
same cmpwi/beq program, seed r4=5            -> fallthrough path, r3 = 1
```

The runtime-dependent arithmetic cases prove that loaded `PPCContext` state flows through finalized `load_context -> add/or -> store_context` HIR rather than being reduced to a constant-only test.

The branch program produces **3 finalized HIR blocks / 23 HIR instructions**. The taken path executes 18 HIR instructions; the non-taken path executes 21. Xenia's compiler may leave a conditional branch in the middle of a finalized block, so false conditional branches continue at `instr->next`; only a taken branch transfers to the target label block. Run 103 exposed this boundary and run 104 verifies the corrected behavior.

## Current HIR correctness subset

`src/xenia_web_bootstrap/hir_correctness_executor.cpp` consumes finalized Xenia HIR directly. It does **not** decode PowerPC again.

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
- return and Xenia `CALL_POSSIBLE_RETURN` boundaries;
- a 4096-instruction correctness guard so unsupported loops cannot hang CI.

The test ABI can seed real GPR values before execution. Unsupported HIR makes the correctness gate fail instead of being ignored.

## Strict CI behavior

The graph contains **62 wasm32 translation units** and the strict standalone WASM roots **23 exports** in one `EXPORTED_FUNCTIONS` list with `ERROR_ON_UNDEFINED_SYMBOLS=1`.

A green workflow means:

```text
source matrix PASS
-> strict link PASS
-> complete required probe ABI present
-> every real PPC runtime correctness program PASS
```

A BLOCKED compile/link or failed architectural result fails CI.

## Browser-only host adaptations

Generated overlays keep Xenia as the semantic authority:

- **PPCContext**: 16 bytes of wasm32 tail-only padding restore Xenia's 64-byte size invariant without moving existing fields.
- **Memory**: current probe exposes only a 64 KiB guest window at `0x80000000`; this is not fake full Xbox memory.
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
Phase 4B  runtime integer ADD/OR                              COMPLETE
Phase 4C  signed compare + multi-block conditional branch     COMPLETE FIRST SUBSET (run 104)
Phase 4D  guest LOAD/STORE/OFFSET + endian semantics          ACTIVE NEXT
Phase 4E  CR/LR/CTR architectural-state coverage              NEXT
Phase 4F  broader integer/control + FPU + VMX/VMX128          AFTER 4E
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   sparse/page-backed full guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Phase 4D — next execution boundary

The next correctness work is guest memory. Implement the finalized Xenia HIR operations actually emitted for simple PowerPC loads/stores:

```text
LOAD
STORE
LOAD_OFFSET
STORE_OFFSET
```

Requirements:

1. use the browser guest-memory abstraction, not arbitrary wasm host pointers;
2. resolve effective addresses from finalized HIR values;
3. preserve Xenia load/store flags and Xbox byte-order/byte-swap semantics;
4. add test APIs for known guest data only where needed by CI;
5. start from real PPC `lwz/stw`-class programs and assert both GPR and guest-memory results;
6. reject unsupported memory/MMIO behavior rather than silently emulating the wrong thing.

After that, explicitly verify CR fields, LR and CTR, then broaden arithmetic/control before FPU and VMX/VMX128.

## Hot execution tier after correctness

Once the correctness subset is useful:

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

**WebGPU is the main renderer. WebGL2 is a fallback**, not a fake alternate game renderer. Both must consume the same guest command stream, resources and shader semantics. WebGL2 may expose reduced performance/feature coverage where the API cannot match WebGPU efficiently, but it must never substitute host-authored Three.js output for guest rendering.

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
