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

## V33 CPU milestone — PPC EXECUTING with memory, architectural state and loops

GitHub Actions **run 115** (`33140686990`) is the current measured CPU gate at commit `eea80eaf63131d8c9d39150c8b39c4229b5d5e61`:

```text
wasm32 compile matrix       62 / 62 PASS
strict full-export link     LINKED
rooted probe exports        25
real PPC correctness cases  11 / 11 PASS
```

Every case begins as genuine big-endian Xbox 360 PowerPC bytes, passes through the real Xenia PPC frontend/translator/scanner/HIR builder/compiler passes, and executes the **finalized Xenia HIR** against a real `PPCContext` and, for memory cases, the same bounded Xenia `Memory` object owned by `Processor`.

The verified runtime set now includes:

```text
li r3,1 ; blr                                      -> r3 = 1
seed r4=7; addi r3,r4,5 ; blr                     -> r3 = 12
seed r4=0x0F00; ori r3,r4,0xF0 ; blr              -> r3 = 0x0FF0
cmpwi/beq, r4=0                                   -> taken, r3 = 2
cmpwi/beq, r4=5                                   -> fallthrough, r3 = 1
lwz r3,0(r4), guest[0x80000100]=0x89ABCDEF       -> r3 = 0x89ABCDEF
stw r5,0(r4); lwz r3,0(r4)                        -> r3 = 0x12345678
                                                   guest readback = 0x12345678
mtlr r4; mflr r3                                  -> r3 = 0x80000040
mtctr r4; mfctr r3                                -> r3 = 9
cmpwi r4,0; mfcr r3                               -> r3 = 0x20000000 (CR0 EQ)
mtctr r4; addi loop; bdnz loop, r4=3              -> r3 = 3
```

The guest-memory path is now measured through Xenia HIR including `LOAD_OFFSET`, `STORE_OFFSET` and `BYTE_SWAP`. The `stw -> lwz` round trip verifies both architectural state and the underlying guest bytes. This is still the **64 KiB bounded probe memory**, not the final Xbox 360 address space.

CR/LR/CTR state is also now exercised through real Xenia context semantics. The `mfcr` case produced **138 finalized HIR instructions** and completed successfully. The `bdnz` test produced **2 finalized HIR blocks / 21 HIR instructions**, then executed **45 HIR instructions** across repeated loop iterations before CTR reached its termination condition and `r3` reached `3`.

**PPC TRANSLATION READY and PPC EXECUTING remain complete for this growing correctness subset.** This still does not mean arbitrary retail PPC, a mapped retail XEX, Kernel/XAM, Xenos rendering, audio, or a playable game.

## Current correctness executor coverage

Measured HIR support now includes:

- context load/store and barriers;
- assign/cast/zero-extend/sign-extend/truncate;
- integer negation/not/truth tests;
- integer `ADD`, `SUB`, `MUL`;
- `AND`, `AND_NOT`, `OR`, `XOR`;
- `SHL`, `SHR`, arithmetic shift;
- signed/unsigned comparisons;
- `BRANCH`, `BRANCH_TRUE`, `BRANCH_FALSE`;
- repeated backward control-flow through a real CTR-controlled loop;
- `LOAD`, `STORE`, `LOAD_OFFSET`, `STORE_OFFSET` against Xenia `Memory`;
- `BYTE_SWAP` for Xbox guest endianness;
- LR/CTR/CR state through normal Xenia context load/store HIR;
- return and Xenia `CALL_POSSIBLE_RETURN` boundaries;
- a 4096-instruction guard so unsupported/infinite correctness paths fail instead of hanging CI.

Unsupported HIR fails the correctness gate rather than being guessed or silently ignored.

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

**WebGPU is the main target. WebGL2 is the fallback when WebGPU is unavailable or unsuitable.** Both must consume the same guest command/resource/shader semantics. WebGL2 is not a Three.js scene or fake substitute for Xbox rendering.

## CPU milestone ladder

```text
upstream Xenia source / contract audit                       ✓
62/62 wasm32 compile matrix                                  ✓
strict full-export WASM link                                ✓
known PPC -> finalized Xenia HIR                            ✓
PPC TRANSLATION READY                                       ✓
finalized-HIR execution -> real PPCContext                  ✓
PPC EXECUTING                                               ✓ correctness subset
runtime integer arithmetic                                  ✓
conditional + multi-block control flow                      ✓
guest LOAD/STORE/OFFSET + endian correctness                ✓ run 113
LR / CTR / CR architectural state                           ✓ run 114
real backward CTR-controlled bdnz loop                      ✓ run 115
        ↓
broader calls / returns / integer-control coverage          ACTIVE NEXT
        ↓
FPU correctness
        ↓
VMX / VMX128 correctness
        ↓
hot-block WasmBackend + executable-page invalidation
        ↓
sparse/page-backed full Xbox guest memory
        ↓
map and enter captured default.xex
        ↓
KernelState / xboxkrnl / XAM
        ↓
Xenos -> shared browser GPU layer
        -> WebGPU primary / WGSL / EDRAM
        -> WebGL2 fallback / GLSL ES compatibility
        ↓
WebAudio + first genuine guest framebuffer
        ↓
title compatibility / performance work
```

## Braid / XBLA title path

Use original LIVE/PIRS/CON content you own; do not rename it to `.iso` merely to pass a file picker.

```text
LIVE/STFS package
  -> native STFS + default.xex             ✓
  -> XEX structural inspection             ✓
  -> PPC translation                       ✓
  -> PPC correctness execution             ✓ growing subset
  -> guest memory semantics                ✓ bounded correctness subset
  -> full sparse guest memory              FUTURE
  -> map / enter default.xex               FUTURE
  -> Kernel / XAM                          FUTURE
  -> Xenos WebGPU / WebGL2                 FUTURE
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

A green CPU workflow means the source matrix compiled, the full rooted ABI linked strictly, and every required runtime correctness program passed.

The stable production core remains separate: Core build 32, ABI `0x00030004`, features `0x00001FFF`. Keep GitHub Pages on `main` / root; V33 CPU work remains isolated from the deployed V32 runtime until real title bring-up is ready.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
