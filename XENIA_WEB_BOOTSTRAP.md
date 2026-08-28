# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics and HIR/compiler boundary into a wasm32 build without pulling the x64 JIT or desktop graphics stack into the browser.

This milestone must not claim guest execution until real guest instructions execute.

## Current measured result

The compile-only bootstrap runs in GitHub Actions against real upstream Xenia source using Emscripten.

Latest completed expanded matrix:

```text
PASS  src/xenia/cpu/hir/opcodes.cc
PASS  src/xenia/cpu/hir/block.cc
PASS  src/xenia/cpu/hir/instr.cc
PASS  src/xenia/cpu/hir/value.cc
PASS  src/xenia/cpu/compiler/compiler_pass.cc
PASS  src/xenia/cpu/ppc/ppc_context.cc
PASS  src/xenia/cpu/ppc/ppc_emit_alu.cc
PASS  src/xenia/cpu/ppc/ppc_emit_memory.cc
PASS  src/xenia/cpu/ppc/ppc_emit_fpu.cc
PASS  src/xenia/cpu/ppc/ppc_emit_altivec.cc
PASS  render360/ppc_context_abi_probe.cpp

BLOCK src/xenia/cpu/ppc/ppc_emit_control.cc
BLOCK src/xenia/cpu/ppc/ppc_hir_builder.cc
BLOCK src/xenia/cpu/ppc/ppc_translator.cc
BLOCK src/xenia/cpu/ppc/ppc_frontend.cc
```

That is **10 real upstream Xenia CPU/HIR/PPC translation units plus the Render360 ABI probe compiling for wasm32**.

The original `PPCContext` blocker is solved. The upstream context becomes 16 bytes short of Xenia's 64-byte padding invariant on wasm32 because host pointers are 32-bit. `prepare-xenia-web-overlay.py` generates a browser-only copy of the fetched upstream header and adds 16 bytes of **tail-only padding after the final existing data member**. No existing Xenia field is moved.

`src/xenia_web_bootstrap/ppc_context_abi_probe.cpp` now independently compiles against that overlay and exposes the context size plus key GPR/FPR/VR/LR/CTR/reservation offsets for the later linked bootstrap WASM.

The remaining completed-run failures were dependency-boundary issues rather than a return of the context ABI problem:

- `ppc_emit_control.cc`, `PPCHIRBuilder` and `PPCFrontend` reached Xenia's `cvar` dependency and required `cxxopts`.
- `PPCTranslator` reached Xenia's `ContextPromotionPass` and required the distro LLVM include directory for `llvm::BitVector`.

The current branch now fetches `cxxopts` and adds `llvm-config --includedir` to the Emscripten include path. CI is the source of truth for whether those fixes unlock the next layer.

## Verified upstream split

Current upstream Xenia keeps the useful CPU boundary in `src/xenia/cpu/ppc/`:

- `ppc_frontend.cc/.h` — frontend lifecycle and function definition.
- `ppc_translator.cc/.h` — guest function translation.
- `ppc_hir_builder.cc/.h` — PowerPC to Xenia HIR construction.
- `ppc_emit_alu.cc` — integer/ALU semantics.
- `ppc_emit_control.cc` — branch/control semantics.
- `ppc_emit_memory.cc` — load/store semantics.
- `ppc_emit_fpu.cc` — floating-point semantics.
- `ppc_emit_altivec.cc` — VMX/Altivec semantics.
- `ppc_context.*` — architectural PowerPC state.
- `src/xenia/cpu/hir/` — reusable HIR structures.
- `src/xenia/cpu/compiler/` — reusable compiler/pass boundary.

`PPCFrontend::DefineFunction` allocates a `PPCTranslator` and calls its real `Translate` path. Render360 preserves that seam rather than creating a parallel JavaScript PPC decoder.

## Browser-only adaptation layer

Browser host adaptation currently lives in:

```text
src/xenia_web_shims/xenia/base/platform.h
src/xenia_web_shims/xenia/base/atomic.h
prepare-xenia-web-overlay.py
src/xenia_web_bootstrap/ppc_context_abi_probe.cpp
```

These files adapt host platform/ABI behavior only. Xbox instruction behavior remains upstream Xenia.

## Do not port into the first bootstrap

- x64 backend
- x64 emitter / native executable code cache
- D3D12
- Vulkan
- desktop windowing
- native HID
- native audio output

These are host implementations, not Xbox semantics.

## Phase 1 — dependency audit

Run:

```bash
./fetch-xenia.sh
python3 xenia_contract_check.py
python3 xenia_web_bootstrap_check.py
```

The audits run automatically in `.github/workflows/xenia-wasm32-bootstrap.yml` before the compile matrix.

## Phase 2 — compile-only wasm32 target

Run locally with an Emscripten environment:

```bash
./fetch-xenia.sh
bash ./build-xenia-ppc-bootstrap.sh
```

The stable V32 runtime stays separate while dependencies are removed one at a time.

Current sequence:

1. HIR core — **portable subset compiling**;
2. compiler core — **first compiler pass compiling**;
3. `PPCContext` wasm32 ABI — **solved and independently probed**;
4. PPC ALU/memory/FPU/Altivec emit semantics — **compiling**;
5. PPC control emitter — dependency layer being cleared;
6. `PPCHIRBuilder` — dependency layer being cleared;
7. `PPCTranslator` — LLVM include boundary being cleared;
8. `PPCFrontend` — dependency layer being cleared;
9. link separate `xenia_ppc_bootstrap.wasm` experiment.

Every failure should be classified and kept visible in the CI artifact rather than converted into fake success.

## Phase 3 — real translation probe

Expose the guest translation ABI only after the real upstream frontend/HIR source compiles and links:

```text
r360_ppc_probe_reset()
r360_ppc_probe_load(address, bytes, length)
r360_ppc_probe_translate(address)
r360_ppc_probe_status()
r360_ppc_probe_hir_instruction_count()
r360_ppc_probe_last_guest_address()
```

Feed a known PowerPC basic block into guest memory and ask the real Xenia frontend to translate it.

Success means:

```text
real PPC bytes
  -> Xenia opcode decode
  -> Xenia ppc_emit_* semantics
  -> Xenia PPCHIRBuilder
  -> Xenia HIR
  -> observable HIR instruction count
```

This is translation only. The UI must show `PPC TRANSLATION READY`, not `PPC EXECUTING`.

## Phase 4 — correctness execution backend

Add a browser-safe HIR execution backend before dynamic recompilation. Its purpose is correctness and test coverage, not peak speed.

Required telemetry:

- guest PC
- translated functions
- translated HIR instructions
- executed HIR instructions
- unsupported HIR opcodes
- exceptions
- GPR/FPR/vector state on failure

Only after guest operations really execute may the first-frame gate report PPC execution.

## Phase 5 — WasmBackend

After a useful PPC/VMX correctness subset passes:

```text
Xenia HIR
  -> Render360 WasmBackend
  -> generated WebAssembly module/function
  -> WebAssembly.compile / instantiate
  -> cached hot guest block
```

Use tiering:

```text
cold guest block -> correctness backend
hot guest block  -> WasmBackend
```

Guest writes to executable pages must invalidate affected translated blocks.

## First CPU milestone

V33 CPU is achieved only when all are true:

1. upstream Xenia PPC frontend/HIR is in the wasm32 build;
2. a real PPC test block is decoded by Xenia;
3. real Xenia HIR is produced;
4. a correctness backend executes the block;
5. expected PowerPC register state matches;
6. browser telemetry reports the real guest PC/instruction count;
7. no x64 backend is used;
8. no JavaScript PPC emulator is substituted.

After that, connect the already-extracted `default.xex` image to guest memory and move toward the first real title entry point.
