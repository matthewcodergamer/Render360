# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. The active **V33 CPU bootstrap** ports upstream Xenia PowerPC/FPU/VMX translation and execution infrastructure to Emscripten/wasm32 while excluding the native x64 JIT and desktop graphics stack.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128
  -> Xenia PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> Render360 finalized-HIR correctness executor
  -> later Render360 WasmBackend
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative foundation gate — run 153

GitHub Actions **run 153** (`33145524618`) completed successfully at commit `1d59e3618f4cf624a97c2d1b8fb84c01ccd44ad1`.

```text
V32 package/XEX core rebuild       PASS
PACKAGE_XEX_FOUNDATION             PASS
PPC_TRANSLATION_FOUNDATION         PASS
wasm32 compile matrix              64 / 64 PASS
strict full-export link            LINKED
rooted probe exports               25
real PPC/FPU/VMX correctness       18 / 18 PASS
```

### STFS / Xbox package / XEX foundation — 100%

For the current browser-loader foundation scope, this gate is complete.

CI rebuilds `render360_xenia_core.wasm` directly from `render360_xenia_core_v32.cpp`, then verifies:

- LIVE / PIRS / CON package classification;
- Xenia-aligned STFS header and volume-descriptor contracts;
- native directory enumeration;
- STFS hash-chain traversal;
- root `default.xex` discovery;
- fragmented multi-block `default.xex` extraction;
- byte-for-byte reconstruction of the complete extracted executable;
- structural XEX inspection after reconstruction;
- entry point, image base, title ID and media ID extraction;
- range-driven I/O rather than loading a multi-GB package into WASM memory.

Measured synthetic runtime gate:

```text
core_version        32
mount_reads         5
extract_reads       3
default_xex_bytes   6144
default_xex_blocks  2
xex_entry           0x82001234
```

**100% here means the defined package/XEX foundation is complete and regression-gated.** It does not mean every retail package variant, XEX encryption/compression mode, title quirk or executable loader behavior is already compatible.

### Xenia PPC translation foundation — 100%

The portable translation foundation is also complete for its defined scope.

`xenia_translation_foundation_check.py` now locks:

- PPC frontend;
- PPC translator;
- PPC scanner;
- PPC context and opcode tables;
- all five current PPC emitter families: ALU, control, memory, FPU and Altivec/VMX;
- HIR opcodes, blocks, instructions, values and builder;
- compiler and compiler-pass framework;
- **every current upstream Xenia compiler-pass `.cc` implementation**;
- browser host translation units;
- strict undefined-symbol link behavior;
- representative real-PPC runtime categories.

Run 153 measured:

```text
upstream translation units manifested  36
browser translation units manifested    6
compiler passes manifested              14
end-to-end runtime categories           10
wasm32 compile matrix                   64 / 64 PASS
```

This lets us mark **PPC translation foundation = 100%** without pretending **PPC execution compatibility = 100%**. Translation infrastructure is complete; instruction/runtime coverage is the separate active layer.

## Current execution milestone

All 18 required programs still begin as genuine big-endian Xbox 360 PPC bytes, pass through Xenia, execute finalized HIR against real `PPCContext` / Xenia `Memory`, and fail closed on unsupported semantics.

Verified execution currently includes:

```text
integer arithmetic / bitwise                 ✓
integer comparisons                           ✓
conditional multi-block branches              ✓
CTR-controlled backward loops                 ✓
guest scalar load/store + Xbox endian         ✓
CR / LR / CTR                                 ✓
direct guest calls                            ✓
two-level nested guest calls                  ✓
FLOAT64 FPR load/store                         ✓
FLOAT64 ADD                                    ✓
FLOAT64 SUB                                    ✓
FLOAT64 MUL                                    ✓
VEC128 load                                    ✓
VEC128 Xenia-compatible byte swap             ✓
VMX unsigned-byte VECTOR_ADD                  ✓
VEC128 store                                   ✓
```

The current FLOAT64 tests verify exact IEEE-754 guest-memory results, including `0x4008000000000000` for double `3.0`. The VMX test executes genuine `lvx -> vaddubm -> stvx` and verifies sixteen result bytes of `0x03`.

## Progress after run 153

These percentages are scoped engineering estimates. A 100% bar means that named **foundation** has met its defined gate, not that all retail-title compatibility is complete.

```text
STFS / Xbox package / XEX foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Xenia PPC translation foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

PPC correctness execution
███████████░░░░░░░░░   ~55%

Guest function / control runtime
█████████████░░░░░░░   ~63%

FPU execution
█████████░░░░░░░░░░░   ~45%
✓ load/store / FPR state
✓ ADD / SUB / MUL
○ DIV
○ floating compare / conversion
○ FPSCR behavior

VMX / VMX128 execution
███░░░░░░░░░░░░░░░░░   ~12–15%
✓ VEC128 load/store
✓ VEC128 byte order
✓ unsigned-byte add
○ halfword/word arithmetic
○ vector logic / compare / shift
○ VMX128-specific coverage

Hot WasmBackend
█░░░░░░░░░░░░░░░░░░░   ~3%

Full Xbox guest-memory system
██░░░░░░░░░░░░░░░░░░   ~10%

default.xex real entry execution
█░░░░░░░░░░░░░░░░░░░   ~5%

Kernel / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░   ~1–2%

Xenos guest GPU emulation
░░░░░░░░░░░░░░░░░░░░   ~1–2%

WebGPU Xenos backend
█░░░░░░░░░░░░░░░░░░░   ~2%

WebGL2 fallback
░░░░░░░░░░░░░░░░░░░░   ~1%

First genuine Xbox title boot
████░░░░░░░░░░░░░░░░   ~20%

Small XBLA / Braid-class playable
███░░░░░░░░░░░░░░░░░   ~14–15%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░   ~8–9%

OVERALL RENDER360
█████░░░░░░░░░░░░░░░   ~21–23%
```

## Next implementation order

With the two nearest foundations closed, work moves to the next layers rather than reopening them unless CI finds a regression.

1. **Finish the basic FPU arithmetic tier**: real PPC `fdiv`, then floating compare/conversion and the first measured FPSCR behavior.
2. **Expand VMX execution**: halfword/word add/sub, AND/OR/XOR, shifts and comparisons, followed by measured VMX128-specific instructions.
3. **Start Render360 `WasmBackend`**: finalized Xenia HIR -> generated WebAssembly functions.
4. Add translated block/function caching.
5. Add executable-page versioning and invalidation for generated/self-modifying guest code.
6. Replace the 64 KiB correctness window with sparse/page-backed Xbox virtual + physical memory, mappings, aliases and protection.
7. Map the already-captured complete `default.xex` sections at their Xbox addresses.
8. Establish initial CPU state and execute the real XEX entry point.
9. Bring up `KernelState`, xboxkrnl and XAM services demanded by real execution.
10. Build the shared Xenos browser GPU layer, then WebGPU/WGSL/EDRAM and WebGL2 fallback.
11. Add WebAudio and reach the first genuine guest-produced framebuffer.
12. Bring a small XBLA/Braid-class title through startup/menu/gameplay before Portal-class compatibility work.

The next major visible milestone remains **real `default.xex` entry-point execution**. The package side can now supply a complete executable and the translation foundation is locked; the major missing bridge is full guest memory plus executable mapping/runtime services.

## Build / verification

```bash
bash ./build-core.sh
node ./test-package-xex-foundation.mjs
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
python3 ./xenia_translation_foundation_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

Stable production remains Core V32. V33 CPU work remains isolated from the deployed runtime until real title bring-up is ready.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.