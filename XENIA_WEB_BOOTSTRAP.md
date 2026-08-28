# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Prove the real upstream Xenia PowerPC frontend and HIR/compiler boundary can be brought into a wasm32 build without pulling the x64 JIT or desktop graphics stack into the browser.

This milestone must not claim guest execution until real guest instructions execute.

## Verified upstream split

Current upstream Xenia keeps the useful CPU boundary in `src/xenia/cpu/ppc/`:

- `ppc_frontend.cc/.h` — frontend lifecycle and function definition.
- `ppc_translator.cc/.h` — guest function translation.
- `ppc_hir_builder.cc/.h` — PowerPC to Xenia HIR construction.
- `ppc_emit_*.cc` — instruction-category semantics feeding HIR.
- `ppc_context.*` — architectural PowerPC state.
- `src/xenia/cpu/hir/` — reusable HIR structures.
- `src/xenia/cpu/compiler/` — reusable compiler/pass boundary.

`PPCFrontend::DefineFunction` currently allocates a `PPCTranslator` and calls `Translate`, which is the exact seam Render360 wants to preserve.

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
python3 xenia_web_bootstrap_check.py
```

The audit must pass before we copy or adapt more CPU code. It intentionally checks upstream files rather than pretending Render360 already executes PPC.

## Phase 2 — compile-only wasm32 target

Create a separate experimental target, `xenia_ppc_bootstrap.wasm`, so the stable V32 runtime keeps working while dependencies are removed one at a time.

Target sequence:

1. compile PPC data/context headers;
2. compile HIR core;
3. compile compiler core and portable passes;
4. compile PPC opcode tables and emit categories;
5. compile `PPCHIRBuilder`;
6. compile `PPCTranslator`;
7. compile `PPCFrontend` behind a minimal processor/memory host boundary.

Every failure should be classified as one of:

- `PORTABLE_DEPENDENCY`
- `HOST_OS_DEPENDENCY`
- `HOST_ARCH_DEPENDENCY`
- `THREADING_DEPENDENCY`
- `MEMORY_MAPPING_DEPENDENCY`
- `LOGGING_OR_UTILITY_DEPENDENCY`

Do not solve an x64 dependency by recreating PPC semantics in JavaScript. Move the host-specific dependency behind a web adapter.

## Phase 3 — real translation probe

Expose a tiny test ABI only after the real upstream frontend/HIR compiles:

```text
r360_ppc_probe_reset()
r360_ppc_probe_load(address, bytes, length)
r360_ppc_probe_translate(address)
r360_ppc_probe_status()
r360_ppc_probe_hir_instruction_count()
r360_ppc_probe_last_guest_address()
```

Feed a known synthetic PowerPC basic block into guest memory and ask the real Xenia frontend to translate it.

Success means:

```text
real PPC bytes
  -> Xenia opcode decode
  -> Xenia PPC emit semantics
  -> Xenia HIR
  -> observable HIR instruction count
```

This is translation only. The UI must show `PPC TRANSLATION READY`, not `PPC EXECUTING`.

## Phase 4 — correctness execution backend

Add a browser-safe HIR execution backend before dynamic recompilation. Its purpose is correctness and test coverage, not peak speed.

Use Xenia's PPC tests where practical and compare architectural state after each test.

Required telemetry:

- guest PC
- translated functions
- translated HIR instructions
- executed HIR instructions
- unsupported HIR opcodes
- exceptions
- GPR/FPR/vector state on failure

Only after this backend actually executes guest operations may the first-frame gate change PPC from `NEEDS WASM BACKEND` to an execution status.

## Phase 5 — WasmBackend

Once the correctness backend passes a useful PPC/VMX test subset:

```text
Xenia HIR
  -> WasmBackend
  -> generated WebAssembly module/function
  -> WebAssembly.compile / instantiate
  -> cached hot guest block
```

Use tiering:

```text
cold guest block -> correctness backend
hot guest block  -> WasmBackend
```

Cache key must include guest address and code identity/hash. Guest writes to executable pages must invalidate affected translated blocks.

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
