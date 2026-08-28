# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime is still **Core V32**: native C++/WASM mounts LIVE/PIRS/CON content, walks STFS, streams a complete `default.xex`, inspects XEX structure, and bridges real browser input/WebGPU host infrastructure. It does **not** claim retail PowerPC execution or playable Xbox 360 games yet.

The active **V33 CPU bootstrap** is porting upstream Xenia's PowerPC frontend, instruction semantics, HIR and compiler boundary to Emscripten/wasm32 while keeping the x64 JIT and desktop graphics backends out of the browser target.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / VMX128
  -> Xenia PPCFrontend
  -> Xenia PPCTranslator
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR
  -> Xenia portable compiler passes
  -> Render360 browser correctness backend
  -> later Render360 WasmBackend
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, or JavaScript PPC emulator is accepted as Xbox output.

## Production V32 already working

- native LIVE / PIRS / CON STFS mount;
- native file-table and hash-chain traversal;
- root `default.xex` lookup;
- complete contiguous/non-contiguous `default.xex` streaming;
- L0/L1/L2 STFS hash following;
- XEX1/XEX2 structural inspection;
- range-based browser reads instead of loading multi-GB packages into WASM RAM;
- touch/Gamepad API forwarding;
- WebGPU host surface and dynamic-resolution infrastructure;
- honest first-frame readiness gate.

## V33 CPU milestone — 25 / 25 wasm32 compile PASS

The CPU bootstrap has moved beyond the original frontend-only experiment. GitHub Actions now measures **25 / 25 PASS, 0 blocked** for the current live translation matrix.

The set includes real upstream Xenia:

```text
PASS  third_party/fmt/src/format.cc
PASS  src/xenia/base/cvar.cc
PASS  src/xenia/base/utf8.cc
PASS  src/xenia/memory.cc
PASS  src/xenia/cpu/processor.cc
PASS  src/xenia/cpu/backend/backend.cc
PASS  src/xenia/cpu/backend/assembler.cc
PASS  src/xenia/cpu/function.cc
PASS  src/xenia/cpu/hir/opcodes.cc
PASS  src/xenia/cpu/hir/block.cc
PASS  src/xenia/cpu/hir/instr.cc
PASS  src/xenia/cpu/hir/value.cc
PASS  src/xenia/cpu/compiler/compiler_pass.cc
PASS  src/xenia/cpu/ppc/ppc_context.cc
PASS  src/xenia/cpu/ppc/ppc_emit_alu.cc
PASS  src/xenia/cpu/ppc/ppc_emit_control.cc
PASS  src/xenia/cpu/ppc/ppc_emit_memory.cc
PASS  src/xenia/cpu/ppc/ppc_emit_fpu.cc
PASS  src/xenia/cpu/ppc/ppc_emit_altivec.cc
PASS  src/xenia/cpu/ppc/ppc_hir_builder.cc
PASS  src/xenia/cpu/ppc/ppc_translator.cc
PASS  src/xenia/cpu/ppc/ppc_frontend.cc
PASS  render360/probe_backend.cpp
PASS  render360/ppc_translation_probe.cpp
PASS  render360/ppc_context_abi_probe.cpp
```

A previous translation-only subset strictly linked into `build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm`. The live translation driver now deliberately pulls Xenia `Memory` and `Processor` into the strict link so runtime dependencies cannot be hidden by dead-code elimination.

The latest verified strict-link boundary after UTF-8/fmt closure is Xenia's **host memory / logging / global-lock layer**:

```text
xe::memory::AllocFixed / DeallocFixed / Protect
xe::memory::CreateFileMappingHandle / MapFileView / UnmapFileView
xe::memory::page_size
xe::logging::*
xe::global_critical_region::mutex
```

That is the correct next boundary. These are host services; they are not PowerPC or Xbox semantics.

### Translation-only ProbeBackend

`src/xenia_web_bootstrap/probe_backend.cpp` implements the browser translation seam required by `PPCTranslator` without pretending to be an execution JIT:

- uses Xenia's real `Backend` and `Assembler` interfaces;
- advertises conservative machine capabilities;
- never allocates native executable code;
- `ProbeGuestFunction::CallImpl` refuses execution;
- `ProbeAssembler` walks the real finalized Xenia HIR blocks/instructions;
- exports actual HIR block/instruction counts and the translated guest address.

This is intentionally the precursor to a correctness backend, not a fake x64 replacement.

### Browser compatibility overlays

`prepare-xenia-web-overlay.py` performs narrow host/compiler adaptations while leaving Xbox/PPC behavior upstream:

1. **PPCContext wasm32 ABI** — 16 bytes of tail-only padding compensate for wasm32 host pointers without moving existing PPC state fields.
2. **legacy cvar UTF-8 literals** — old `u8` literals consumed as `std::string<char>` are normalized to identical narrow bytes for C++20.
3. **legacy utf8.cc literal** — the single ASCII `u8"\\/"` delimiter is normalized to the same narrow bytes; Xenia's UTF-8 algorithms remain unchanged.
4. **Processor native debugger resume PC** — wasm32 has no AMD64 RIP / ARM64 PC to restore. Only that host debugger branch is an intentional no-op; Processor setup/function/frontend logic remains upstream Xenia.

Other host shims remain in `src/xenia_web_shims/xenia/base/platform.h` and `atomic.h`.

## Current gate — browser host memory for a real PPC -> HIR translation

`src/xenia_web_bootstrap/ppc_translation_probe.cpp` exports:

```text
r360_ppc_probe_reset()
r360_ppc_probe_load(bytes, length)
r360_ppc_probe_translate()
r360_ppc_probe_status()
r360_ppc_probe_guest_base()
r360_ppc_probe_loaded_size()
r360_ppc_probe_hir_block_count()
r360_ppc_probe_hir_instruction_count()
r360_ppc_probe_last_guest_address()
```

The driver deliberately calls:

```text
Xenia Memory
  -> Xenia Processor::Setup(ProbeBackend)
  -> Xenia PPCFrontend::DefineFunction
  -> PPCTranslator
  -> PPCScanner
  -> PPCHIRBuilder / ppc_emit_*
  -> Xenia compiler passes
  -> ProbeAssembler
  -> observable finalized HIR telemetry
```

Desktop Xenia creates an approximately 4.5 GB file-backed host mapping with aliased virtual/physical views. wasm32 cannot use that exact host strategy. V33 is therefore separating **guest address semantics** from the **browser backing implementation**: first a small translation-probe guest code window, later sparse/page-backed memory for XEX, kernel and GPU-visible memory.

`PPC TRANSLATION READY` must not be shown until a known real PPC byte block passes through Xenia and produces nonzero finalized HIR. `PPC EXECUTING` must wait for the correctness executor to execute HIR and verify architectural register state.

## CPU milestone ladder

```text
upstream Xenia source audit                         ✓
portable PPC/HIR/compiler source on wasm32          ✓
PPCContext browser ABI                              ✓
all five PPC emit categories                        ✓
PPCFrontend / Translator / HIRBuilder               ✓
translation-only ProbeBackend                       ✓
Memory + Processor compile on wasm32                ✓
UTF-8 / fmt portable runtime closure                ✓
        ↓
wasm32 host memory + logging + global lock          CURRENT
        ↓
strict live translation-driver link
        ↓
browser guest-code translation window
        ↓
known PPC bytes -> real Xenia finalized HIR
        ↓
PPC TRANSLATION READY
        ↓
browser-safe HIR correctness executor
        ↓
verified GPR/FPR/VMX result state
        ↓
hot-block WasmBackend
        ↓
map and enter captured default.xex
        ↓
KernelState / xboxkrnl / XAM
        ↓
Xenos -> WebGPU / WGSL / EDRAM
        ↓
first genuine guest framebuffer
```

## Braid / XBLA title path

Use original LIVE/PIRS/CON content you own; do not rename it to `.iso` merely to pass a file picker.

```text
LIVE/STFS package
  -> native STFS mount              ✓
  -> directory/hash traversal       ✓
  -> complete default.xex           ✓
  -> XEX structural inspection      ✓
  -> XEX image preparation/mapping  NEXT AFTER CPU PROBE
  -> PPC execution                  IN DEVELOPMENT
  -> Kernel/XAM                     FUTURE
  -> Xenos/WebGPU                   FUTURE
```

## Build / CI

```bash
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
```

GitHub Actions runs the same audit/compile/strict-link pipeline and uploads the matrix, linker report, per-source logs and the bootstrap WASM whenever a strict link succeeds.

The stable production core remains separate:

```text
Core build  32
ABI         0x00030004
Features    0x00001FFF
```

## GitHub Pages

Keep Pages on **Settings -> Pages -> Deploy from a branch -> `main` -> `/(root)`**. V33 CPU work stays isolated from the deployed V32 runtime until the CPU path is genuinely testable.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
