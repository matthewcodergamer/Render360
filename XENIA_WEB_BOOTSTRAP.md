# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics, HIR/compiler boundary, Processor runtime and the minimum required Memory host boundary into wasm32 without pulling Xenia's x64 JIT or desktop graphics stack into the browser.

The milestone language is strict:

- **PPC TRANSLATION READY** only after real PPC bytes produce real finalized Xenia HIR at runtime.
- **PPC EXECUTING** only after a correctness backend executes the HIR and verified PowerPC architectural state changes.
- **PLAYABLE** only after genuine title execution, kernel services, graphics, input and audio work sufficiently for gameplay.

## Current measured result

The latest completed full translation matrix before the new browser-host additions measured **25 passed, 0 blocked** under Emscripten/wasm32. It includes real Xenia `Memory`, `Processor`, backend interfaces, HIR, compiler boundary, PPC frontend/translator/HIR builder and all five PPC emitter categories, plus the Render360 probe pieces.

A follow-up host-boundary probe measured:

```text
PASS  src/xenia/base/memory_posix.cc
PASS  src/xenia/base/mutex.cc
BLOCK src/xenia/base/logging.cc  -> desktop logging thread dependency
```

`memory_posix.cc` and Xenia's real global recursive mutex are wasm32-compilable. Desktop `logging.cc` deliberately is not used by the browser bootstrap because its native writer thread/ring-buffer design is a host implementation rather than Xbox behavior.

## Browser-only host adaptations

`prepare-xenia-web-overlay.py` generates narrow build-only overlays. Upstream source remains the semantic authority.

### PPCContext

wasm32 host pointers make `PPCContext` 16 bytes short of Xenia's existing 64-byte padding invariant. Render360 appends 16 bytes of **tail-only padding after the final existing field**. Existing GPR/FPR/VMX/LR/CTR/CR/runtime field offsets are unchanged and independently exposed by `ppc_context_abi_probe.cpp`.

### C++20 UTF-8 compatibility

The pinned Xenia revision predates modern `char8_t` behavior in a small number of old utility literals. The generated cvar/UTF8 overlays remove only the `u8` prefix from ASCII byte literals consumed as `std::string<char>` / `std::string_view<char>`. The byte payload and Xenia algorithms are unchanged.

### Processor debugger host PC

Xenia's native debugger exception-resume path knows AMD64 RIP and ARM64 PC. wasm32 has no native machine-code program counter to restore. Only that host-debug branch becomes a wasm32 no-op. `Processor::Setup`, modules, builtins, function lookup, PPCFrontend and translation behavior remain upstream Xenia.

### Bounded translation-probe Memory

Desktop Xenia's `Memory::Initialize()` creates an approximately 4.5 GiB file-backed host address range with fixed aliased virtual/physical views. That host mapping strategy cannot be copied into wasm32.

For the **translation probe only**, the generated memory overlay now exposes a bounded **64 KiB guest code window at `0x80000000`**:

```text
guest 0x80000000 ... 0x8000FFFF
              ↓
64 KiB wasm32 code backing
```

`Memory::TranslateVirtual` preserves 32-bit guest addresses and resolves addresses within that probe window to the WASM backing vector. Addresses outside the window return null. The desktop Memory implementation remains under the non-wasm path.

This is not presented as a fake 4.5 GiB Xbox memory map. Full XEX/kernel/GPU execution later requires sparse/page-backed browser guest memory with aliases, protection metadata, invalidation and physical views.

### Browser logging host adapter

`src/xenia_web_bootstrap/browser_logging.cpp` implements Xenia's existing logging API without creating desktop logging threads or filesystem/ring-buffer infrastructure. It retains the API expected by Xenia code and uses a synchronous thread-local formatting buffer for bootstrap diagnostics.

## Real translation-only backend

`src/xenia_web_bootstrap/probe_backend.cpp` implements Xenia's backend/assembler seam for **translation observation only**:

- real Xenia `Backend` and `Assembler` interfaces;
- no native executable-memory allocation;
- no x64 emitter;
- no guest execution claim;
- finalized Xenia HIR block and instruction telemetry;
- translated guest-address telemetry.

The ProbeGuestFunction refuses execution. This is deliberate: translation must be proven before the correctness execution tier is added.

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

`test-xenia-ppc-translation-probe.mjs` is now wired into GitHub Actions after a successful strict link. It instantiates the standalone WASM and writes genuine big-endian PowerPC instructions into the exported input buffer:

```text
0x38600001  addi r3, r0, 1   ; li r3, 1
0x4E800020  blr
```

The test only passes when all of these are true:

```text
probe status == translated
loaded bytes == supplied PPC bytes
assembled functions > 0
HIR blocks > 0
HIR instructions > 0
translate return > 0
last guest address == probe guest base
```

Until this runtime gate actually passes in CI, the project must continue to say **PPC translation probe in progress**, not `PPC TRANSLATION READY`.

## Strict dependency policy

`link-xenia-ppc-bootstrap.sh` uses strict undefined-symbol checking. We do not use blanket unresolved imports, dummy guest functions, fake decoder output, fake framebuffers or JavaScript PPC emulation to manufacture progress.

Dependency closure follows this rule:

1. identify the exact unresolved Xenia symbol;
2. add the real portable Xenia translation unit when appropriate;
3. adapt only the host implementation when it is genuinely OS/architecture-specific;
4. rerun wasm32 compile and strict link;
5. record measured results.

## Current phase ladder

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation-only ProbeBackend strict link           COMPLETE
Phase 2C  real Xenia Memory + Processor compile               COMPLETE
Phase 2D  UTF8 / fmt runtime closure                          COMPLETE
Phase 2E  bounded wasm32 Memory probe window                  IMPLEMENTED
Phase 2F  browser logging + global mutex host seam            IMPLEMENTED / VERIFYING
Phase 3   live strict translation-driver link                 ACTIVE
Phase 3A  real PPC bytes -> finalized Xenia HIR CI gate       ACTIVE
Phase 4   browser-safe HIR correctness executor               NEXT AFTER PHASE 3A
Phase 5   hot-block WasmBackend                               FUTURE
Phase 6   map/enter captured default.xex                      FUTURE
Phase 7   KernelState / xboxkrnl / XAM                        FUTURE
Phase 8   Xenos -> WebGPU / WGSL / EDRAM                      FUTURE
Phase 9   first genuine guest framebuffer                     FUTURE
```

## What comes after PPC translation is proven

The next CPU stage is a correctness executor that consumes Xenia HIR and mutates a real `PPCContext`. Start with integer/control/memory operations required by tiny test functions, then FPU and VMX/VMX128. Each test must verify the expected GPR/FPR/vector/CR/LR/CTR/memory result rather than only counting instructions.

Once a useful correctness subset passes, add a hot tier:

```text
Xenia finalized HIR
  -> Render360 WasmBackend
  -> generated WebAssembly function/module
  -> WebAssembly.compile / instantiate
  -> cache by guest block + code generation/version
```

Guest writes to executable pages must invalidate affected translated blocks.

After CPU execution is real, connect the already-extracted `default.xex`: prepare/map XEX sections into sparse guest memory, resolve the entry point, create the required kernel runtime, and enter guest code. KernelState/xboxkrnl/XAM comes before meaningful retail title boot. Xenos packet processing, shader translation to WGSL, textures, EDRAM and WebGPU come after that, followed by WebAudio and the first genuine guest framebuffer.

## Do not port into the browser CPU bootstrap

- x64 backend / x64 emitter / native executable code cache;
- D3D12;
- Vulkan;
- desktop windowing;
- desktop HID;
- native audio output;
- desktop fixed-address 4.5 GiB host memory mapping as if wasm32 supported it.

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

The Node test is meaningful only after strict link has produced the WASM. GitHub Actions performs the same sequence automatically and uploads compile/link logs and the WASM artifact when available.
