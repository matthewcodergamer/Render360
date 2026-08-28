# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and the minimum browser-safe Memory/runtime support into wasm32 without pulling Xenia's x64 JIT or desktop graphics stack into the browser.

Milestone language stays strict:

- **PPC TRANSLATION READY** only after real PPC bytes produce real finalized Xenia HIR at runtime.
- **PPC EXECUTING** only after a correctness backend executes finalized Xenia HIR and verified PowerPC architectural state changes.
- **PLAYABLE** only after genuine title execution, kernel services, graphics, input and audio work sufficiently for gameplay.

## Current measured result — PPC EXECUTING (first correctness block)

GitHub Actions run **94** (`33137958292`) completed successfully at commit `845bd206d2f1984d6f1889b546878e1fdfc59a15`.

```text
wasm32 compile matrix       62 passed / 0 blocked
strict full-export link     LINKED
rooted exports              22
runtime status              3 (translated)
guest base                  0x80000000
loaded bytes                8
assembled functions         1
HIR blocks                  1
HIR instructions            6
translate return            6
last guest address          0x80000000
correctness status          3
correctness instructions    6
correctness r3              1
return boundary             reached
```

The runtime input is genuine big-endian PowerPC:

```text
0x38600001  addi r3, r0, 1   ; li r3, 1
0x4E800020  blr
```

The finalized HIR produced by Xenia for this block is:

```text
source_offset
store_context
source_offset
context_barrier
load_context
call_indirect
```

The live runtime path is now:

```text
WASM input memory
  -> bounded Xenia Memory guest window @ 0x80000000
  -> Xenia Processor::Setup(ProbeBackend)
  -> Xenia PPCFrontend::DefineFunction
  -> Xenia PPCTranslator
  -> Xenia PPCScanner
  -> Xenia opcode lookup / ppc_emit_*
  -> Xenia PPCHIRBuilder
  -> Xenia compiler + complete current pass chain
  -> ProbeAssembler
  -> finalized Xenia HIR
  -> Render360 HIRCorrectnessExecutor
  -> real Xenia PPCContext
  -> verified PPCContext.r[3] == 1
```

The CI harness reported both:

```text
PASS: real PPC bytes reached finalized Xenia HIR.
PASS: finalized Xenia HIR executed against PPCContext and produced r3 == 1.
```

**PPC TRANSLATION READY is complete. PPC EXECUTING is also complete for the first verified correctness block.** This is deliberately narrow: arbitrary retail PPC, complete XEX execution, kernel services and graphics are not yet claimed.

## Phase-4 correctness executor

`src/xenia_web_bootstrap/hir_correctness_executor.cpp` consumes finalized Xenia HIR directly. It does **not** decode PowerPC a second time.

The initial supported subset is exactly the six HIR operations measured for `li r3,1; blr`:

- `SOURCE_OFFSET` — metadata;
- `STORE_CONTEXT` — writes the typed HIR value to the real `PPCContext` byte offset;
- `CONTEXT_BARRIER` — ordering boundary for this single-threaded correctness probe;
- `LOAD_CONTEXT` — reads a typed value from real `PPCContext` state;
- `CALL_INDIRECT` with Xenia's `CALL_POSSIBLE_RETURN` — recognized as the return boundary generated for this `blr` path.

Unsupported HIR still fails the correctness status rather than being silently ignored. The executor result is exported as correctness status, executed-instruction count and `r3`, and the Node gate requires status 3 and `r3 == 1`.

## Strict CI behavior

The full graph now contains **62** wasm32 units, including the correctness executor. The strict linker roots **22** exports in one `EXPORTED_FUNCTIONS` list with `ERROR_ON_UNDEFINED_SYMBOLS=1`.

Run 91 revealed that the executor source had been added but its object was missing from the strict link list. That run's report correctly showed the unresolved `ExecuteHIRCorrectnessProbe` symbol, but the old link script returned success after recording `status=BLOCKED`. This has been corrected:

- compile matrix exits nonzero if any source is BLOCKED;
- strict linker exits nonzero when the link is BLOCKED;
- the correctness executor object is part of the live object list;
- the three correctness exports are rooted in the final ABI;
- the runtime gate requires the verified architectural state change.

A green CPU workflow now means the compile, strict link and runtime correctness gate all completed.

## Browser-only host adaptations

Generated overlays keep upstream Xenia as the semantic authority.

### PPCContext

wasm32 host pointers make `PPCContext` 16 bytes short of Xenia's existing 64-byte padding invariant. Render360 appends 16 bytes of **tail-only padding after the final existing field**. Existing GPR/FPR/VMX/LR/CTR/CR/runtime field offsets are unchanged and independently exported by `ppc_context_abi_probe.cpp`.

### Bounded translation-probe Memory

For the current CPU probe, the browser Memory overlay exposes a **64 KiB guest code window at `0x80000000`**. It is not presented as a fake full Xbox address space. Full title execution later requires sparse/page-backed guest memory with aliases, protection metadata, physical views and executable-page invalidation.

### MMIO and host exceptions

Xenia's MMIO range registration/lookup semantics remain upstream. Native AMD64/ARM64 fault-instruction decoding and host-register context access are unsupported in wasm32 because those native machine contexts do not exist in the browser target.

### ContextPromotionPass

The compiler algorithm is unchanged. Only the private `llvm::BitVector` storage used through resize/reset/test/set is replaced by an equivalent browser-safe container to avoid linking the machine-native LLVM Support runtime into standalone wasm32.

### Arena

Xenia's 16-byte Arena payload contract remains enforced. The browser overlay uses `posix_memalign(..., 16, capacity)` for arbitrary-sized chunks because the standalone wasm32 libc configuration did not satisfy the desktop `malloc` alignment assumption in the runtime probe.

### Browser logging and sleep

The browser bootstrap implements the Xenia logging API synchronously and provides only the required host sleep primitive with libc `nanosleep`; it does not import desktop logging threads or the entire native threading subsystem merely for CPU bootstrap work.

## ProbeBackend boundary

`ProbeGuestFunction::CallImpl` still refuses native guest execution because ProbeBackend owns no executable code cache. The verified execution path is the explicit Phase-4 correctness executor consuming the finalized HIR delivered to `ProbeAssembler`.

Its register description remains a compiler allocation contract only: 7 integer allocation slots and 12 shared float/vector slots, matching Xenia's mature allocator shape without importing the x64 emitter.

## Current phase ladder

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation-only ProbeBackend                       COMPLETE
Phase 2C  real Xenia Memory + Processor runtime closure       COMPLETE
Phase 2D  utilities/opcode/compiler dependency closure        COMPLETE
Phase 2E  bounded wasm32 Memory probe window                  COMPLETE FOR PROBE
Phase 2F  browser host/compiler/Arena boundaries              COMPLETE FOR PROBE
Phase 3   strict full-export translation-driver link          COMPLETE
Phase 3A  real PPC bytes -> finalized Xenia HIR CI gate       COMPLETE
Phase 3B  PPC TRANSLATION READY                               COMPLETE
Phase 4   browser-safe HIR correctness executor               STARTED / VERIFIED
Phase 4A  li r3,1; blr -> PPCContext.r[3] == 1                COMPLETE (run 94)
Phase 4B  PPC EXECUTING first correctness block               COMPLETE
Phase 4C  integer/control-flow coverage expansion             ACTIVE NEXT
Phase 4D  guest load/store + CR/LR/CTR correctness            NEXT
Phase 4E  FPU then VMX/VMX128 correctness                     AFTER 4D
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   sparse/page-backed full guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   Xenos -> WebGPU / WGSL / EDRAM                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Immediate correctness expansion

The next CPU work should broaden the executor by adding HIR semantics and paired PPC test blocks in this order:

1. integer value movement and arithmetic needed by simple guest code — `ASSIGN`, integer extend/truncate, `ADD`, `SUB`, bitwise `AND/OR/XOR`, shifts and comparisons as they appear in finalized Xenia HIR;
2. branch/control flow — `BRANCH`, conditional branch forms, return/call boundaries and multiple HIR blocks;
3. guest memory — `LOAD`, `STORE`, offset forms and byte-swap behavior against the browser guest-memory abstraction;
4. architectural control state — CR fields, LR and CTR, with explicit expected-state assertions;
5. FPU;
6. VMX/VMX128.

Each test must begin as real PPC bytes, go through Xenia translation/compiler passes, execute the resulting finalized HIR, and verify GPR/FPR/vector/CR/LR/CTR/memory results. Unsupported HIR should stop the test rather than being guessed.

## After useful correctness coverage

Once a useful correctness subset is verified, add the hot tier:

```text
Xenia finalized HIR
  -> Render360 WasmBackend
  -> generated WebAssembly function/module
  -> WebAssembly.compile / instantiate
  -> cache by guest block + code version
```

Guest writes to executable pages must invalidate affected translated blocks.

Then implement sparse/page-backed full guest memory, map the already captured `default.xex` sections and entry point, bring up KernelState/xboxkrnl/XAM, connect Xenos packet/register/shader/texture/EDRAM semantics to WebGPU/WGSL, then WebAudio and the first genuine guest framebuffer.

## Do not port into the browser CPU bootstrap

- x64 backend / x64 emitter / native executable code cache;
- D3D12 or Vulkan;
- desktop windowing/HID/audio output;
- desktop fixed-address 4.5 GiB host mapping as though wasm32 supported it.

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

GitHub Actions performs the same audit, compile, strict-link and runtime sequence and uploads the reports/artifacts.
