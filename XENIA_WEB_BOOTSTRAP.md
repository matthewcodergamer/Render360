# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and the minimum browser-safe Memory/runtime support into wasm32 without pulling Xenia's x64 JIT or desktop graphics stack into the browser.

Milestone language stays strict:

- **PPC TRANSLATION READY** only after real PPC bytes produce real finalized Xenia HIR at runtime.
- **PPC EXECUTING** only after a correctness backend executes finalized Xenia HIR and verified PowerPC architectural state changes.
- **PLAYABLE** only after genuine title execution, kernel services, graphics, input and audio work sufficiently for gameplay.

## Current measured result — PPC TRANSLATION READY

GitHub Actions run **84** (`33136788561`) completed successfully at commit `4a6d7b9521d7bf697cade285ce0dbf8434d3bc36`.

```text
wasm32 compile matrix   61 passed / 0 blocked
strict full-export link LINKED
runtime status          3 (translated)
guest base              0x80000000
loaded bytes            8
assembled functions     1
HIR blocks              1
HIR instructions        6
translate return        6
last guest address      0x80000000
```

The runtime input is genuine big-endian PowerPC:

```text
0x38600001  addi r3, r0, 1   ; li r3, 1
0x4E800020  blr
```

The CI harness reported:

```text
PASS: real PPC bytes reached Xenia HIR and the ProbeAssembler observed finalized HIR.
```

This proves the live runtime path:

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
  -> finalized Xenia HIR telemetry
```

**PPC TRANSLATION READY is complete. PPC EXECUTING is not yet complete.**

## What had to be closed to reach the runtime gate

The full 61-unit graph includes real Xenia `Memory`, `Processor`, `EntryTable`, `Module`, `ThreadState`, Backend/Assembler/Function, HIR, Compiler and its current pass chain, PPCContext, generated opcode units, all PPC emitter categories, PPCScanner/HIRBuilder/Translator/Frontend, POSIX memory/filesystem/mutex/mapped-memory support, Arena/string/cvar/UTF-8 utilities, plus the browser host seams and Render360 probe code.

The strict linker keeps the entire probe ABI rooted in one `EXPORTED_FUNCTIONS` list with `ERROR_ON_UNDEFINED_SYMBOLS=1`; no dead-stripping workaround is used to manufacture a link.

The final runtime boundaries resolved before run 84 were:

- initialize the standalone WASM as a WASI reactor before any imported WASI function is called;
- preserve Xenia's required 16-byte Arena chunk alignment with arbitrary-size `posix_memalign` on wasm32;
- describe a legitimate target register-allocation model in ProbeBackend so Xenia's `RegisterAllocationPass` can finalize HIR: 7 integer allocation slots and 12 shared float/vector slots, matching the mature Xenia x64 allocator shape without importing or executing the x64 backend;
- ensure every `prepare-xenia-*-overlay.py` change triggers the CPU workflow.

## Browser-only host adaptations

Generated overlays keep upstream Xenia as the semantic authority.

### PPCContext

wasm32 host pointers make `PPCContext` 16 bytes short of Xenia's existing 64-byte padding invariant. Render360 appends 16 bytes of **tail-only padding after the final existing field**. Existing GPR/FPR/VMX/LR/CTR/CR/runtime field offsets are unchanged and independently exported by `ppc_context_abi_probe.cpp`.

### Bounded translation-probe Memory

For the translation probe, the browser Memory overlay exposes a **64 KiB guest code window at `0x80000000`**. It is not presented as a fake full Xbox address space. Full title execution later requires sparse/page-backed guest memory with aliases, protection metadata, physical views and executable-page invalidation.

### MMIO and host exceptions

Xenia's MMIO range registration/lookup semantics remain upstream. Native AMD64/ARM64 fault-instruction decoding and host-register context access are unsupported in wasm32 because those native machine contexts do not exist in the browser target.

### ContextPromotionPass

The compiler algorithm is unchanged. Only the private `llvm::BitVector` storage used through resize/reset/test/set is replaced by an equivalent browser-safe container to avoid linking the machine-native LLVM Support runtime into standalone wasm32.

### Arena

Xenia's 16-byte Arena payload contract remains enforced. The browser overlay uses `posix_memalign(..., 16, capacity)` for arbitrary-sized chunks because the standalone wasm32 libc configuration did not satisfy the desktop `malloc` alignment assumption in the runtime probe.

### Browser logging and sleep

The browser bootstrap implements the Xenia logging API synchronously and provides only the required host sleep primitive with libc `nanosleep`; it does not import desktop logging threads or the entire native threading subsystem merely for translation.

## Translation-only ProbeBackend

`ProbeBackend` remains deliberately non-executing. It uses real Xenia Backend/Assembler/GuestFunction interfaces, owns no native executable code cache, and `ProbeGuestFunction::CallImpl` returns false.

Its machine register description is a **compiler allocation contract only**. It does not claim x64 execution or wasm machine registers. The purpose is to let the same Xenia compiler pipeline produce finalized HIR that the next correctness backend can consume.

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
Phase 3A  real PPC bytes -> finalized Xenia HIR CI gate       COMPLETE (run 84)
Phase 3B  PPC TRANSLATION READY                               COMPLETE
Phase 4   browser-safe HIR correctness executor               ACTIVE NEXT
Phase 4A  li r3,1; blr -> verify PPCContext.r[3] == 1         NEXT GATE
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   sparse/page-backed full guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   Xenos -> WebGPU / WGSL / EDRAM                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Phase 4 rule — execute Xenia HIR, not PPC a second time

The next CPU tier must consume the **already finalized Xenia HIR**. It must not add another PowerPC decoder/interpreter beside Xenia.

The first execution contract is intentionally tiny:

```text
PPC: li r3, 1; blr
  -> Xenia translation and compiler passes
  -> finalized Xenia HIR
  -> Render360 correctness executor
  -> real PPCContext
  -> require PPCContext.r[3] == 1
```

Only after that architectural-state check passes may the project declare **PPC EXECUTING**.

Then broaden correctness in this order:

1. integer arithmetic and control flow;
2. guest loads/stores and memory semantics;
3. condition register, LR and CTR behavior;
4. FPU;
5. VMX/VMX128;
6. verify GPR/FPR/vector/CR/LR/CTR/memory results for every test.

## After correctness execution

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
