# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and the minimum browser-safe Memory/runtime support into wasm32 without pulling Xenia's x64 JIT or desktop graphics stack into the browser.

Milestone language is strict:

- **PPC TRANSLATION READY** only after real PPC bytes produce real finalized Xenia HIR at runtime.
- **PPC EXECUTING** only after a correctness backend executes Xenia HIR and verified PowerPC architectural state changes.
- **PLAYABLE** only after genuine title execution, kernel services, graphics, input and audio work sufficiently for gameplay.

## Current measured result

The latest completed measurement is GitHub Actions run 76: **60 passed, 0 blocked** under Emscripten/wasm32.

The live compile graph now includes real Xenia:

- `Memory`, `Processor`, `EntryTable`, `Module`, `ThreadState`;
- Backend, Assembler, Function and FunctionDebugInfo;
- HIR builder/opcodes/block/instruction/value code;
- Compiler plus the complete compiler-pass chain currently installed by PPCTranslator;
- PPCContext;
- PPCFrontend, PPCTranslator, PPCScanner and PPCHIRBuilder;
- all five PPC emitter categories;
- generated opcode table, opcode lookup and opcode disassembly units;
- POSIX memory/mapped-memory/filesystem/mutex support;
- arena, strings, UTF-8, cvars and CPU flags;
- MMIO range handling;
- Render360 browser logging, host sleep, ProbeBackend, translation driver and PPCContext ABI probe.

The strict link uses the **complete exported probe ABI in one `EXPORTED_FUNCTIONS` list** and `ERROR_ON_UNDEFINED_SYMBOLS=1`. Runtime code is intentionally rooted so dead-code elimination cannot hide dependencies.

### Latest completed link boundary

Run 76 narrowed the remaining strict-link symbols to:

```text
xe::cpu::ppc::PadStringBuffer(...)
xe::cpu::ppc::PrintDisasm_bcx(...)
```

Both are real upstream definitions in `src/xenia/cpu/ppc/ppc_opcode_disasm.cc`. That source has now been added to the real compile/link graph and is being verified by the next CI gate. No replacement decoder or fake helper was written.

## Browser-only host adaptations

Generated overlays keep upstream Xenia as the semantic authority.

### PPCContext

wasm32 host pointers make `PPCContext` 16 bytes short of Xenia's existing 64-byte padding invariant. Render360 appends 16 bytes of **tail-only padding after the final existing field**. Existing GPR/FPR/VMX/LR/CTR/CR/runtime field offsets are unchanged and independently exported by `ppc_context_abi_probe.cpp`.

### C++20 UTF-8 compatibility

The pinned Xenia revision predates modern `char8_t` behavior in a small number of old utility literals. The generated cvar/UTF-8 overlays remove only the `u8` prefix from ASCII byte literals consumed as narrow strings. Byte payloads and algorithms are unchanged.

### Processor debugger host PC

Xenia's native debugger exception-resume path knows AMD64 RIP and ARM64 PC. wasm32 has no corresponding native host program counter to restore. Only that host debugger branch is a wasm32 no-op. `Processor::Setup`, builtins, function resolution and frontend behavior remain upstream Xenia.

### Bounded translation-probe Memory

Desktop Xenia creates an approximately 4.5 GiB file-backed host mapping with aliased fixed virtual/physical views. That host strategy cannot be copied directly into wasm32/Safari.

For the translation probe only, the browser Memory overlay exposes a **64 KiB guest code window at `0x80000000`**:

```text
guest 0x80000000 ... 0x8000FFFF
              ↓
64 KiB wasm32 backing
```

`Memory::TranslateVirtual` resolves only this probe window. Out-of-window addresses return null. This is explicitly **not** presented as a fake full Xbox memory map. Full execution later requires sparse/page-backed guest memory with aliases, protection metadata, physical views and executable-page invalidation.

### Browser logging

`src/xenia_web_bootstrap/browser_logging.cpp` implements Xenia's logging API without Xenia's desktop logging thread/ring-buffer/filesystem host design. It uses synchronous bootstrap-safe formatting.

### MMIO native host fault boundary

Xenia's MMIO range registration, lookup and semantics remain upstream. The wasm overlay only marks native AMD64/ARM64 faulting-instruction decoding and native host-register context access unsupported, because wasm32 does not expose those host machine contexts.

### ContextPromotionPass private bitset

Pinned Xenia's `ContextPromotionPass` uses `llvm::BitVector` only through `resize`, `reset`, `test` and `set`. Linking the machine-native LLVM Support library into standalone wasm32 is invalid. The browser overlay keeps the pass algorithm unchanged and replaces only that private storage container with an equivalent vector-backed bitset.

### Browser host Sleep

The translation dependency closure requires `xe::threading::Sleep(std::chrono::microseconds)`. Rather than importing Xenia's entire native pthread/signal/timer host subsystem, the browser bootstrap provides this host primitive with libc `nanosleep`, retrying on `EINTR`. This is host behavior, not Xbox behavior.

## Real translation-only backend

`src/xenia_web_bootstrap/probe_backend.cpp` implements the Xenia backend/assembler seam for **translation observation only**:

- real Xenia `Backend`, `Assembler` and `GuestFunction` interfaces;
- no native executable-memory allocation;
- no x64 emitter;
- no guest execution claim;
- finalized Xenia HIR block/instruction telemetry;
- translated guest-address telemetry.

`ProbeGuestFunction::CallImpl` refuses execution. Translation must be proven before the execution tier is added.

## Live translation probe ABI

`src/xenia_web_bootstrap/ppc_translation_probe.cpp` exports:

```text
r360_ppc_probe_reset()
r360_ppc_probe_input_buffer()
r360_ppc_probe_input_capacity()
r360_ppc_probe_load(bytes, length)
r360_ppc_probe_translate()
r360_ppc_probe_status()
r360_ppc_probe_guest_base()
r360_ppc_probe_loaded_size()
r360_ppc_probe_assembled_functions()
r360_ppc_probe_hir_block_count()
r360_ppc_probe_hir_instruction_count()
r360_ppc_probe_last_guest_address()
```

The runtime path is intentionally real:

```text
WASM input memory
  -> bounded Xenia Memory guest window @ 0x80000000
  -> Xenia Processor::Setup(ProbeBackend)
  -> Xenia PPCFrontend::DefineFunction
  -> Xenia PPCTranslator
  -> Xenia PPCScanner
  -> Xenia opcode lookup / ppc_emit_*
  -> Xenia PPCHIRBuilder
  -> Xenia compiler passes
  -> ProbeAssembler
  -> finalized HIR telemetry
```

## Runtime CI gate

`test-xenia-ppc-translation-probe.mjs` runs only after a successful strict link. It instantiates the standalone WASM and writes genuine big-endian PowerPC instructions:

```text
0x38600001  addi r3, r0, 1   ; li r3, 1
0x4E800020  blr
```

The test only passes when all are true:

```text
probe status == translated (3)
loaded bytes == 8
assembled functions > 0
HIR blocks > 0
HIR instructions > 0
translate return > 0
last guest address == 0x80000000
```

Until this gate actually passes, the project must continue to say **PPC translation probe in progress**, not `PPC TRANSLATION READY`.

## Strict dependency policy

`link-xenia-ppc-bootstrap.sh` uses strict undefined-symbol checking. We do not use blanket unresolved imports, dummy guest behavior, fake decoder output, fake framebuffers, or JavaScript PPC emulation to manufacture progress.

Closure rule:

1. identify the exact unresolved Xenia symbol;
2. add the real portable Xenia translation unit when appropriate;
3. adapt only a genuinely host-specific OS/architecture implementation;
4. rerun wasm32 compile and strict link with the full ABI rooted;
5. run the real PPC-to-HIR runtime test if WASM is produced;
6. record measured results.

## Current phase ladder

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation-only ProbeBackend                       COMPLETE
Phase 2C  real Xenia Memory + Processor compile               COMPLETE
Phase 2D  UTF8 / fmt and utility runtime closure              COMPLETE
Phase 2E  bounded wasm32 Memory probe window                  COMPLETE FOR PROBE
Phase 2F  browser logging / MMIO / host sleep boundaries      COMPLETE FOR PROBE
Phase 2G  live support units + generated opcode tables        COMPLETE (run 76)
Phase 3   strict full-export translation-driver link          ACTIVE
Phase 3A  real PPC bytes -> finalized Xenia HIR CI gate       WAITING ON PHASE 3
Phase 4   browser-safe HIR correctness executor               NEXT AFTER 3A
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   sparse/page-backed full guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   Xenos -> WebGPU / WGSL / EDRAM                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## What comes after PPC translation is proven

The next CPU stage is a correctness executor that consumes **finalized Xenia HIR**, not a second PPC decoder. Its first execution test should reuse:

```text
li r3, 1
blr
```

Create and initialize a real `PPCContext`, execute the finalized HIR and require `r3 == 1`. Only then mark **PPC EXECUTING**.

Then broaden correctness in this order:

1. integer and control operations;
2. guest load/store and memory semantics;
3. condition/LR/CTR behavior;
4. FPU;
5. VMX/VMX128;
6. verify GPR/FPR/vector/CR/LR/CTR/memory results for every test.

After a useful correctness subset passes, add the hot tier:

```text
Xenia finalized HIR
  -> Render360 WasmBackend
  -> generated WebAssembly function/module
  -> WebAssembly.compile / instantiate
  -> cache by guest block + code version
```

Guest writes to executable pages must invalidate affected translated blocks.

Then implement sparse/page-backed browser guest memory with required aliases/protection/physical views; map the already captured `default.xex` sections and entry point; create KernelState/xboxkrnl/XAM support; then connect Xenos packet/register/shader/texture/EDRAM semantics to WebGPU/WGSL; then WebAudio and the first genuine guest framebuffer.

## Do not port into the browser CPU bootstrap

- x64 backend / x64 emitter / native executable code cache;
- D3D12;
- Vulkan;
- desktop windowing;
- desktop HID;
- native desktop audio output;
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

The Node test is meaningful only after strict link produces the WASM. GitHub Actions performs this sequence automatically and uploads the reports/artifacts.
