# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC frontend, instruction semantics and HIR/compiler boundary into a wasm32 build without pulling the x64 JIT or desktop graphics stack into the browser.

This milestone must not claim guest execution until real guest instructions execute.

## Current measured result

The compile-only CPU surface is now **complete for the selected V33 bootstrap set**.

GitHub Actions measured:

```text
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
PASS  render360/ppc_context_abi_probe.cpp
```

Result: **15 passed, 0 blocked** — 14 real upstream Xenia CPU/HIR/PPC translation units plus Render360's ABI probe compile under Emscripten/wasm32.

This proves the selected Xenia frontend/translator/HIR/emit source surface is wasm32-compilable. It does **not** prove that a guest PPC block has been translated or executed yet.

## PPCContext browser ABI

The original `PPCContext` blocker is solved. On wasm32, Xenia's packed context was 16 bytes short of the existing 64-byte padding invariant because host pointers are 32-bit.

`prepare-xenia-web-overlay.py` generates a browser-only version of the fetched upstream header and adds 16 bytes of **tail-only padding after the final existing data member**. Existing Xenia architectural/runtime field offsets are not moved.

`src/xenia_web_bootstrap/ppc_context_abi_probe.cpp` independently validates the context size invariant and exposes size plus key GPR/FPR/VR/LR/CTR/reservation offsets for the linked bootstrap module.

## Browser-only adaptation layer

```text
src/xenia_web_shims/xenia/base/platform.h
src/xenia_web_shims/xenia/base/atomic.h
prepare-xenia-web-overlay.py
src/xenia_web_bootstrap/ppc_context_abi_probe.cpp
```

These adapt host platform/ABI behavior only. Xbox instruction behavior remains upstream Xenia.

The bootstrap fetch currently initializes only the CPU-side dependencies needed by this path: `fmt`, `utfcpp`, `capstone`, `cpptoml`, `cxxopts`, and `date`. CI also supplies LLVM headers for Xenia's compiler passes.

## Verified CPU seam

```text
Xbox PPC / VMX128
        -> Xenia PPCFrontend
        -> Xenia PPCTranslator
        -> Xenia PPCHIRBuilder
        -> Xenia ppc_emit_alu/control/memory/fpu/altivec
        -> Xenia HIR
        -> portable compiler passes
        -> browser correctness backend
        -> Render360 WasmBackend
```

Render360 preserves Xenia's real translation path rather than creating a parallel JavaScript PPC decoder.

## Phase 1 — source audit

**Complete for this bootstrap set.**

```bash
./fetch-xenia.sh
python3 xenia_contract_check.py
python3 xenia_web_bootstrap_check.py
```

## Phase 2 — compile-only wasm32

**Complete for the selected 15-entry matrix.**

```bash
bash ./build-xenia-ppc-bootstrap.sh
```

All selected frontend, translator, HIR, context and PPC emitter translation units compile for wasm32.

## Phase 2B — strict bootstrap link

This is the active stage.

`link-xenia-ppc-bootstrap.sh` takes the real compiled Xenia objects and attempts to link a separate:

```text
build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

The link uses strict undefined-symbol checking. Missing Xenia dependencies are reported in `link.log` / `link-report.txt`; they are **not** hidden with blanket imports or fake stubs merely to manufacture a `.wasm` file.

CI now runs:

```bash
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
```

and uploads the compile matrix, strict link report, linker log, and the WASM only if a real link succeeds.

## Do not port into this CPU bootstrap

- x64 backend / x64 emitter / native executable code cache
- D3D12
- Vulkan
- desktop windowing
- native HID
- native audio output

These are host implementations, not Xbox semantics.

## Phase 3 — real translation probe

After the real CPU surface links, expose:

```text
r360_ppc_probe_reset()
r360_ppc_probe_load(address, bytes, length)
r360_ppc_probe_translate(address)
r360_ppc_probe_status()
r360_ppc_probe_hir_instruction_count()
r360_ppc_probe_last_guest_address()
```

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

Add a browser-safe HIR execution backend before dynamic recompilation. Required telemetry includes guest PC, translated/executed HIR counts, unsupported opcodes, exceptions and register state on failure.

Only after guest operations really execute may Render360 report PPC execution.

## Phase 5 — WasmBackend

After a useful PPC/VMX correctness subset passes:

```text
Xenia HIR
  -> Render360 WasmBackend
  -> generated WebAssembly module/function
  -> WebAssembly.compile / instantiate
  -> cached hot guest block
```

Use a cold correctness tier and a hot WasmBackend tier. Guest writes to executable pages must invalidate affected translated blocks.

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
