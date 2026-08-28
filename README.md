# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. It mounts LIVE/PIRS/CON content in native C++/WASM, walks STFS structures, streams a complete `default.xex`, inspects XEX structure, and exposes real browser input/WebGPU host infrastructure. It does **not** claim retail PowerPC execution or playable Xbox 360 games yet.

The active **V33 CPU bootstrap** is porting upstream Xenia's PowerPC frontend, instruction semantics, HIR/compiler pipeline and required runtime support to Emscripten/wasm32 while excluding the native x64 JIT and desktop graphics stack.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / VMX128
  -> Xenia PPCFrontend
  -> Xenia PPCTranslator
  -> Xenia PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR
  -> Xenia portable compiler passes
  -> Render360 browser correctness backend
  -> later Render360 WasmBackend
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or JavaScript PPC emulator is accepted as Xbox output.

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

## V33 CPU milestone — 60 / 60 wasm32 compile PASS

The latest **completed** measured bootstrap is GitHub Actions run 76. It reached **60 passed, 0 blocked** in the wasm32 compile matrix.

That matrix now includes the real Xenia PPC translation/compiler path and the support units made live by the complete exported WASM ABI:

- PPCFrontend, PPCTranslator, PPCScanner and PPCHIRBuilder;
- all five `ppc_emit_*` categories;
- generated PPC opcode table, lookup and disassembly units;
- HIR builder/opcodes/block/instruction/value code;
- Xenia Compiler and its current optimization/finalization pass chain;
- Backend, Assembler, Function and FunctionDebugInfo;
- Memory, Processor, EntryTable, Module and ThreadState;
- MMIO range handling;
- POSIX memory and mapped-memory support;
- arena, string, string-buffer, UTF-8, cvar, filesystem and mutex support;
- browser logging and browser host sleep adapters;
- Render360 ProbeBackend, translation driver and PPCContext ABI probe.

The full linker still uses one complete `EXPORTED_FUNCTIONS` list with `ERROR_ON_UNDEFINED_SYMBOLS=1`. We do not allow dead-code elimination to hide dependencies just to obtain a green link.

### Latest strict-link boundary

Run 76 reduced the remaining strict-link closure to Xenia's real PPC disassembly helper implementation:

```text
xe::cpu::ppc::PadStringBuffer(...)
xe::cpu::ppc::PrintDisasm_bcx(...)
```

Both definitions were located in upstream `src/xenia/cpu/ppc/ppc_opcode_disasm.cc`. That real source has now been added to the compile and strict-link graphs. The next CI run is responsible for verifying it; no fake definitions were introduced.

`PPC TRANSLATION READY` is **not** declared from compile/link progress alone. It requires the runtime test below to pass.

## Browser compatibility boundaries

The browser build uses narrow host adaptations while keeping Xbox/PPC semantics in Xenia:

1. **PPCContext wasm32 ABI** — 16 bytes of tail-only padding restore Xenia's 64-byte size invariant without moving existing architectural/runtime fields.
2. **C++20 legacy UTF-8 literals** — old ASCII `u8` literals used as narrow strings are normalized to identical byte strings.
3. **Processor native debugger PC** — wasm32 has no AMD64 RIP / ARM64 PC; only that native debugger-resume branch is a no-op.
4. **Bounded translation Memory** — a 64 KiB browser probe window maps guest `0x80000000..0x8000FFFF`; it is explicitly not represented as full Xbox memory.
5. **MMIO native fault decoding** — Xenia's MMIO range semantics remain real, while AMD64/ARM64 native fault-instruction decoding/register-context access is unsupported on wasm32.
6. **ContextPromotionPass bit set** — the pass algorithm is unchanged; its private four-operation LLVM `BitVector` storage is replaced in the browser overlay so a native host LLVM Support library is not pulled into standalone wasm32.
7. **Logging** — browser logging implements Xenia's logging API without the desktop writer thread/ring-buffer host architecture.
8. **Sleep** — the one bootstrap `xe::threading::Sleep` host primitive uses libc `nanosleep`; the full desktop pthread/signal/timer subsystem is not required merely to translate PPC.

These are browser host boundaries, not replacement Xbox behavior.

## Real translation-only ProbeBackend

`src/xenia_web_bootstrap/probe_backend.cpp` implements Xenia's backend/assembler seam for translation observation only:

- real Xenia `Backend`, `Assembler` and `GuestFunction` interfaces;
- no native executable-memory allocation;
- no x64 emitter;
- `ProbeGuestFunction::CallImpl` refuses execution;
- `ProbeAssembler::Assemble` observes real finalized Xenia HIR blocks/instructions;
- exported telemetry records assembled functions, HIR block/instruction counts and guest address.

This is a translation gate, not a fake JIT.

## Runtime PPC -> HIR gate

`test-xenia-ppc-translation-probe.mjs` instantiates the fully linked standalone WASM and writes genuine big-endian PowerPC instructions:

```text
0x38600001  addi r3, r0, 1   ; li r3, 1
0x4E800020  blr
```

The runtime path is:

```text
PPC bytes
  -> bounded Xenia Memory @ 0x80000000
  -> Xenia Processor::Setup(ProbeBackend)
  -> Xenia PPCFrontend::DefineFunction
  -> PPCTranslator
  -> PPCScanner
  -> opcode lookup / ppc_emit_*
  -> PPCHIRBuilder
  -> Xenia compiler passes
  -> ProbeAssembler
  -> finalized HIR telemetry
```

The test must report all of the following before the milestone changes:

```text
status == translated (3)
loaded bytes == 8
assembled functions > 0
HIR blocks > 0
HIR instructions > 0
translate return > 0
last guest address == 0x80000000
```

Until that runtime gate passes, the correct status remains **PPC translation probe in progress**.

## CPU milestone ladder

```text
upstream Xenia source/contract audit                         ✓
60/60 latest completed wasm32 compile matrix                ✓
real PPC frontend/scanner/HIR/compiler pipeline             ✓
PPCContext browser ABI                                      ✓
translation-only ProbeBackend                               ✓
bounded browser translation Memory                          ✓
browser logging/MMIO/compiler/thread host boundaries        ✓
complete probe ABI rooted in strict linker                  ✓
real upstream PPC disassembly helper added                  VERIFYING
        ↓
strict full-export WASM link
        ↓
known PPC bytes -> real finalized Xenia HIR
        ↓
PPC TRANSLATION READY
        ↓
browser-safe Xenia-HIR correctness executor
        ↓
verify PPCContext.r[3] == 1 for li r3,1; blr
        ↓
PPC EXECUTING
        ↓
integer/control/memory coverage, then FPU/VMX/VMX128
        ↓
hot-block WasmBackend + executable-page invalidation
        ↓
sparse/page-backed full guest memory
        ↓
map and enter captured default.xex
        ↓
KernelState / xboxkrnl / XAM
        ↓
Xenos -> WebGPU / WGSL / EDRAM
        ↓
WebAudio + first genuine guest framebuffer
        ↓
title compatibility/performance work
```

## Braid / XBLA title path

Use original LIVE/PIRS/CON content you own; do not rename it to `.iso` merely to pass a file picker.

```text
LIVE/STFS package
  -> native STFS mount              ✓
  -> directory/hash traversal       ✓
  -> complete default.xex           ✓
  -> XEX structural inspection      ✓
  -> PPC translation                IN DEVELOPMENT
  -> PPC execution                  NOT YET
  -> XEX image mapping/entry         AFTER CPU EXECUTION FOUNDATION
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
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

GitHub Actions runs the same audit, compile, strict-link and runtime sequence. The runtime test only runs when the strict linker actually produces the WASM.

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
