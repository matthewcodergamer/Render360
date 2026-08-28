# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. It mounts LIVE/PIRS/CON content in native C++/WASM, walks STFS structures, streams a complete `default.xex`, inspects XEX structure, and exposes real browser input/WebGPU host infrastructure. It does **not** claim retail-title execution or playable Xbox 360 games yet.

The active **V33 CPU bootstrap** ports upstream Xenia's PowerPC frontend, instruction semantics, HIR/compiler pipeline and required runtime support to Emscripten/wasm32 while excluding the native x64 JIT and desktop graphics stack.

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
  -> Render360 browser correctness executor
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

## V33 CPU milestone — PPC EXECUTING (first correctness block)

GitHub Actions **run 94** (`33137958292`) is the current measured gate. It passed with:

```text
wasm32 compile matrix       62 / 62 PASS
strict full-export link     LINKED
rooted probe exports        22
probe status                3 (translated)
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

Those bytes pass through real Xenia `Memory -> Processor -> PPCFrontend -> PPCTranslator -> PPCScanner -> PPCHIRBuilder/ppc_emit_* -> Compiler/pass chain`. The finalized HIR observed at the assembler boundary is:

```text
source_offset
store_context
source_offset
context_barrier
load_context
call_indirect
```

Render360's Phase-4 correctness executor consumes **that finalized Xenia HIR**, creates a real Xenia `PPCContext`, executes the supported HIR operations, reaches the `CALL_POSSIBLE_RETURN` boundary generated for `blr`, and verifies `PPCContext.r[3] == 1`.

That satisfies the project's milestone rule for **PPC EXECUTING**. This means the first known PPC block now translates and changes verified architectural state through Xenia HIR. It does **not** mean arbitrary retail PPC, a full XEX, kernel services, graphics, audio, or a game is executing yet.

The live graph now contains 62 wasm32 units including the real Xenia PPC translation/compiler closure plus `hir_correctness_executor.cpp`. The strict linker roots all 22 probe/correctness exports with `ERROR_ON_UNDEFINED_SYMBOLS=1`, and a BLOCKED compile or link now fails CI instead of producing a false-green workflow.

## Browser compatibility boundaries

The wasm32 build keeps Xbox/PPC behavior upstream and adapts only host/compiler seams:

1. **PPCContext wasm32 ABI** — 16 bytes of tail-only padding restore Xenia's existing 64-byte size invariant without moving architectural/runtime fields.
2. **C++20 legacy UTF-8 literals** — old ASCII `u8` literals used as narrow strings are normalized to identical bytes.
3. **Processor native debugger PC** — wasm32 has no AMD64 RIP / ARM64 PC; only that native debugger-resume branch is a no-op.
4. **Bounded translation Memory** — a 64 KiB probe window maps guest `0x80000000..0x8000FFFF`; it is not represented as full Xbox memory.
5. **MMIO native fault decoding** — real Xenia range semantics remain; native AMD64/ARM64 fault-instruction decoding/register-context access is unavailable on wasm32.
6. **ContextPromotionPass bitset** — the algorithm is unchanged; its private LLVM `BitVector` storage is replaced so native LLVM Support is not linked into standalone wasm32.
7. **Arena alignment** — Xenia's required 16-byte Arena chunk alignment is preserved with arbitrary-size `posix_memalign` on wasm32.
8. **Logging / sleep** — narrow browser host implementations satisfy Xenia's APIs without importing desktop logging threads or the complete native threading subsystem.
9. **Probe register model** — the translation-only backend exposes Xenia's mature allocator shape: 7 integer slots plus 12 shared float/vector slots. This is a compiler allocation contract only; no x64 emitter is linked.

## CPU milestone ladder

```text
upstream Xenia source/contract audit                         ✓
62/62 wasm32 compile matrix                                  ✓
real PPC frontend/scanner/HIR/compiler pipeline             ✓
PPCContext browser ABI                                      ✓
bounded browser translation Memory                          ✓
browser logging/MMIO/compiler/thread/Arena boundaries       ✓
complete runtime ABI rooted in strict linker                ✓
strict full-export WASM link                                ✓
known PPC bytes -> real finalized Xenia HIR                 ✓
PPC TRANSLATION READY                                       ✓
finalized-HIR correctness executor                          ✓ first subset
li r3,1; blr -> PPCContext.r[3] == 1                        ✓
PPC EXECUTING                                               ✓ first correctness block
        ↓
integer/control-flow correctness expansion                  ACTIVE NEXT
        ↓
guest loads/stores + CR/LR/CTR semantics
        ↓
FPU, then VMX/VMX128 correctness
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
  -> native STFS mount                    ✓
  -> directory/hash traversal             ✓
  -> complete default.xex                 ✓
  -> XEX structural inspection            ✓
  -> PPC translation                      ✓ known block proven
  -> PPC correctness execution            ✓ first known block
  -> broader PPC execution coverage       ACTIVE NEXT
  -> sparse guest memory / XEX mapping    AFTER CPU COVERAGE
  -> Kernel/XAM                           FUTURE
  -> Xenos/WebGPU                         FUTURE
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

The stable production core remains separate:

```text
Core build  32
ABI         0x00030004
Features    0x00001FFF
```

## GitHub Pages

Keep Pages on **Settings -> Pages -> Deploy from a branch -> `main` -> `/(root)`**. V33 CPU work stays isolated from the deployed V32 runtime until the CPU path is useful enough for real title bring-up.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
