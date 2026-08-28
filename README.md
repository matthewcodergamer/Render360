# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. It mounts LIVE/PIRS/CON content in native C++/WASM, walks STFS structures, streams a complete `default.xex`, inspects XEX structure, and exposes real browser input/WebGPU host infrastructure. It does **not** claim retail-title execution or playable Xbox 360 games yet.

The active **V33 CPU bootstrap** ports upstream Xenia's PowerPC frontend, instruction semantics, HIR/compiler pipeline and required runtime support to Emscripten/wasm32 while excluding the native x64 JIT and desktop graphics stack.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / VMX128
  -> Xenia PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> Render360 HIR correctness executor
  -> later Render360 WasmBackend
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or JavaScript PPC emulator is accepted as Xbox output.

## Production V32 already working

- native LIVE / PIRS / CON STFS mount and hash-chain traversal;
- complete root `default.xex` lookup/streaming and XEX structural inspection;
- range-based browser reads instead of loading multi-GB packages into WASM RAM;
- touch/Gamepad API forwarding;
- WebGPU host surface and dynamic-resolution infrastructure;
- honest first-frame readiness gate.

## V33 CPU milestone — PPC EXECUTING with runtime integer + branch coverage

GitHub Actions **run 104** (`33139670498`) is the current measured gate:

```text
wasm32 compile matrix       62 / 62 PASS
strict full-export link     LINKED
rooted probe exports        23
real PPC correctness cases  5 / 5 PASS
```

Every case starts as genuine big-endian Xbox 360 PowerPC bytes, passes through real Xenia translation/compiler passes, and executes the finalized Xenia HIR against a real `PPCContext`.

Measured cases include:

```text
li r3,1 ; blr
  -> r3 = 1

seed r4=7; addi r3,r4,5 ; blr
  -> finalized HIR includes load_context -> add -> store_context
  -> r3 = 12

seed r4=0x0F00; ori r3,r4,0x00F0 ; blr
  -> finalized HIR includes load_context -> or -> store_context
  -> r3 = 0x0FF0

cmpwi/beq multi-block program, seed r4=0
  -> branch taken
  -> r3 = 2

same program, seed r4=5
  -> branch not taken / same-block fallthrough
  -> r3 = 1
```

The branch program produced **3 finalized HIR blocks and 23 HIR instructions**. The taken path executed 18 HIR instructions and the non-taken path executed 21. Run 103 exposed that Xenia's control-flow simplification may leave a conditional branch in the middle of a block; run 104 fixed the executor so a false conditional branch continues at `instr->next`, while a taken branch jumps to the Xenia label target.

**PPC TRANSLATION READY remains complete. PPC EXECUTING is now verified beyond a constant block: runtime-loaded GPR values, integer ADD/OR, comparisons, unconditional/conditional branches and multi-block execution have all changed verified architectural state.** This is still a correctness subset, not arbitrary retail PPC or a complete game runtime.

## Current correctness executor coverage

The finalized-HIR executor currently handles the measured integer/control foundation including context load/store, assign/cast/extend/truncate, negation/not, truth tests, integer ADD/SUB/MUL, AND/AND_NOT/OR/XOR, shifts, signed/unsigned comparisons, branch/branch-true/branch-false, return boundaries and conditional return/call-return forms. Unsupported HIR fails the gate rather than being guessed.

The test ABI can seed GPR state before HIR execution, allowing runtime-dependent PPC tests rather than relying on constant folding.

## Browser compatibility boundaries

The wasm32 build keeps Xbox/PPC behavior upstream and adapts only host/compiler seams: PPCContext tail padding, old C++20 UTF-8 literals, native debugger-PC handling, a bounded 64 KiB guest probe window at `0x80000000`, wasm32 MMIO host-fault boundaries, private ContextPromotionPass bitset storage, 16-byte Arena allocation, and narrow browser logging/sleep adapters. ProbeBackend's 7 integer + 12 shared float/vector register slots are only Xenia compiler-allocation metadata, not x64 execution.

## Browser GPU backend plan

The future Xenos path has one semantic source and two browser host backends:

```text
Xenos ringbuffer / registers / resources / shaders / EDRAM
  -> reuse Xenia command processing and guest GPU semantics
  -> shared Render360 browser GPU layer
       -> WebGPU   PRIMARY backend (WGSL)
       -> WebGL2   FALLBACK backend (GLSL ES / compatibility path)
```

**WebGPU is the main target. WebGL2 is the fallback when WebGPU is unavailable or unsuitable.** WebGL2 must consume the same guest command/resource/shader semantics; it is not a Three.js scene or fake substitute for Xbox rendering. Capability selection happens at the browser-host layer. The WebGL2 path may have reduced performance or feature coverage, but guest output must remain honest.

## CPU milestone ladder

```text
upstream Xenia source/contract audit                         ✓
62/62 wasm32 compile matrix                                  ✓
strict full-export WASM link                                ✓
known PPC -> finalized Xenia HIR                            ✓
PPC TRANSLATION READY                                       ✓
finalized-HIR execution -> real PPCContext                  ✓
PPC EXECUTING                                               ✓ correctness subset
runtime integer ADD / OR                                    ✓
signed comparisons + conditional branch                    ✓
multi-block taken/not-taken execution                       ✓ run 104
        ↓
guest LOAD / STORE / OFFSET + endian correctness            ACTIVE NEXT
        ↓
CR / LR / CTR architectural-state coverage
        ↓
broader integer/control + FPU + VMX/VMX128
        ↓
hot-block WasmBackend + executable-page invalidation
        ↓
sparse/page-backed full guest memory
        ↓
map and enter captured default.xex
        ↓
KernelState / xboxkrnl / XAM
        ↓
Xenos -> shared browser GPU layer
        -> WebGPU primary / WGSL / EDRAM
        -> WebGL2 fallback
        ↓
WebAudio + first genuine guest framebuffer
        ↓
title compatibility/performance work
```

## Braid / XBLA title path

Use original LIVE/PIRS/CON content you own; do not rename it to `.iso` merely to pass a file picker.

```text
LIVE/STFS package
  -> native STFS + default.xex             ✓
  -> XEX structural inspection             ✓
  -> PPC translation                       ✓
  -> PPC correctness execution             ✓ growing subset
  -> guest memory semantics                ACTIVE NEXT
  -> sparse guest memory / XEX mapping     FUTURE
  -> Kernel/XAM                            FUTURE
  -> Xenos WebGPU/WebGL2                   FUTURE
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

A green CPU workflow means the source matrix compiled, the full rooted ABI linked strictly, and all required runtime correctness programs passed.

The stable production core remains separate: Core build 32, ABI `0x00030004`, features `0x00001FFF`. Keep GitHub Pages on `main` / root; V33 CPU work remains isolated from the deployed V32 runtime until real title bring-up is ready.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
