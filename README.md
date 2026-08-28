# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. It mounts LIVE/PIRS/CON content in native C++/WASM, walks STFS structures, streams a complete `default.xex`, inspects XEX structure, and exposes browser input/WebGPU host infrastructure. It does **not** claim retail-title execution or playable Xbox 360 games yet.

The active **V33 CPU bootstrap** ports upstream Xenia's PowerPC frontend, instruction semantics, HIR/compiler pipeline and required runtime support to Emscripten/wasm32 while excluding the native x64 JIT and desktop graphics stack.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128
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

## V33 CPU milestone — nested guest calls + real FLOAT64 arithmetic

GitHub Actions **run 133** (`33143476524`) is the current measured CPU gate at commit `9cceb0529df209f1226f9b81da6918e6e2e24991`:

```text
wasm32 compile matrix       62 / 62 PASS
strict full-export link     LINKED
rooted probe exports        25
real PPC correctness cases  15 / 15 PASS
```

Every case begins as genuine big-endian Xbox 360 PowerPC bytes, passes through the real Xenia PPC frontend/translator/scanner/HIR builder/compiler passes, and executes the **finalized Xenia HIR** against a real `PPCContext` and, for memory cases, the same bounded Xenia `Memory` object owned by `Processor`.

The verified runtime set now includes integer arithmetic, conditional/multi-block control flow, guest load/store with Xbox byte order, CR/LR/CTR state, repeated CTR-controlled loops, direct guest calls, two-level nested guest calls, FLOAT64 FPR movement, and the first real floating-point arithmetic/load/store flow.

### Real guest calls execute through independently translated callees

Direct PPC `bl` now crosses a separate guest function boundary. Xenia emits `SET_RETURN_ADDRESS`, stores LR and emits `CALL`; Render360 uses the real Xenia `PPCScanner` to discover the callee extent and sends the callee through Xenia's frontend/translator/compiler. Nested finalized HIR executes against the same live `PPCContext`, returns, and the caller continues.

Measured direct-call result:

```text
caller -> callee(li r3,5) -> caller(addi +2) -> r3 = 7
assembled guest functions = 2
```

A two-level call chain also passes:

```text
caller -> function A -> function B -> function A -> caller
function B r3 = 4
function A resumes -> r3 = 6
caller resumes -> r3 = 7
assembled guest functions = 3
```

No second PPC decoder or hardcoded callee behavior is used.

### Real FPU arithmetic now executes

The first FPR move/data-path gate remains green:

```text
fmr f1,f2
blr
```

Run 133 additionally proves a non-zero floating-point memory/arithmetic path:

```text
lfd  f1,0(r4)       ; guest double 1.0
lfd  f2,8(r4)       ; guest double 2.0
fadd f3,f1,f2
stfd f3,16(r4)
lwz  r3,16(r4)
blr
```

Xenia produced **33 finalized HIR instructions**. The measured path includes guest `LOAD`, Xbox `BYTE_SWAP`, same-width HIR `CAST` between the 64-bit guest bit pattern and `FLOAT64`, typed HIR `ADD`, FPR context stores, conversion back to integer bits, and guest `STORE`.

The executor produced:

```text
r3 = 0x40080000
guest[+16..+23] = 0x4008000000000000
```

`0x4008000000000000` is IEEE-754 double **3.0**, so this is a real architectural + guest-memory floating result rather than a translation-only claim.

### Existing architectural gates remain green

```text
li r3,1 ; blr                                      -> r3 = 1
seed r4=7; addi r3,r4,5 ; blr                     -> r3 = 12
seed r4=0x0F00; ori r3,r4,0xF0 ; blr              -> r3 = 0x0FF0
cmpwi/beq, r4=0                                   -> taken, r3 = 2
cmpwi/beq, r4=5                                   -> fallthrough, r3 = 1
lwz r3,0(r4), guest=0x89ABCDEF                   -> r3 = 0x89ABCDEF
stw r5,0(r4); lwz r3,0(r4)                        -> guest/r3 = 0x12345678
mtlr r4; mflr r3                                  -> r3 = 0x80000040
mtctr r4; mfctr r3                                -> r3 = 9
cmpwi r4,0; mfcr r3                               -> r3 = 0x20000000 (CR0 EQ)
mtctr r4; addi loop; bdnz loop, r4=3              -> r3 = 3
direct bl/callee/blr                              -> r3 = 7
two-level nested bl chain                         -> r3 = 7
fmr f1,f2                                         -> FLOAT64 FPR path PASS
lfd/fadd/stfd 1.0 + 2.0                           -> guest double 3.0
```

The current memory remains a **64 KiB bounded correctness window**, not the final Xbox 360 address-space implementation.

**PPC TRANSLATION READY and PPC EXECUTING remain complete for this growing correctness subset.** This does not yet mean arbitrary retail PPC, a mapped retail XEX, Kernel/XAM, Xenos rendering, audio, or a playable game.

## Current correctness executor coverage

Measured/support coverage includes:

- context load/store and barriers for GPR/FPR architectural state;
- same-width HIR bit-casts including measured INT64 ↔ FLOAT64 paths;
- integer zero/sign extension and truncation;
- integer negation/not/truth tests;
- integer `ADD`, `SUB`, `MUL`, bitwise logic and shifts;
- signed/unsigned comparisons;
- typed FLOAT32/FLOAT64 arithmetic support for `ADD`, `SUB`, `MUL` (FLOAT64 `ADD` measured in run 133);
- `BRANCH`, `BRANCH_TRUE`, `BRANCH_FALSE` and backward loops;
- `LOAD`, `STORE`, `LOAD_OFFSET`, `STORE_OFFSET` against Xenia `Memory`;
- `BYTE_SWAP` for Xbox guest endianness;
- LR/CTR/CR state;
- direct `CALL` / conditional-call plumbing with nested Xenia function translation;
- return and `CALL_POSSIBLE_RETURN` boundaries;
- a 4096-instruction correctness guard.

Unsupported HIR fails the correctness gate rather than being guessed or silently ignored.

## Browser GPU backend plan

The future Xenos path has one semantic source and two browser host backends:

```text
Xenos ringbuffer / registers / resources / shaders / EDRAM
  -> reuse Xenia command processing and guest GPU semantics
  -> shared Render360 browser GPU layer
       -> WebGPU   PRIMARY backend (WGSL)
       -> WebGL2   FALLBACK backend (GLSL ES compatibility)
```

**WebGPU is the main renderer. WebGL2 is the fallback.** Both consume the same guest command/resource/shader semantics. WebGL2 is not a Three.js scene or fake substitute for Xbox rendering.

## CPU milestone ladder

```text
upstream Xenia source / contract audit                       ✓
62/62 wasm32 compile matrix                                  ✓
strict full-export WASM link                                ✓
PPC -> finalized Xenia HIR                                  ✓
PPC TRANSLATION READY                                       ✓
finalized HIR -> real PPCContext                            ✓
PPC EXECUTING                                               ✓ correctness subset
runtime integer arithmetic                                  ✓
conditional + multi-block control flow                      ✓
guest LOAD/STORE/OFFSET + endian correctness                ✓
LR / CTR / CR architectural state                           ✓
real backward CTR-controlled loop                           ✓
direct guest call/return                                    ✓
two-level nested guest calls                                ✓
FLOAT64 FPR move/data path                                  ✓
real lfd -> fadd -> stfd                                    ✓ run 133
        ↓
broader FPU SUB/MUL/DIV + compare/convert/FPSCR             ACTIVE NEXT
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
title compatibility / iPhone performance work
```

## Braid / XBLA title path

Use original LIVE/PIRS/CON content you own.

```text
LIVE/STFS package
  -> native STFS + default.xex             ✓
  -> XEX structural inspection             ✓
  -> PPC translation                       ✓
  -> integer/control/memory execution       ✓ growing subset
  -> nested guest functions                ✓ first subset
  -> FPU load/add/store                     ✓ first arithmetic subset
  -> VMX/VMX128                             ACTIVE AFTER FPU EXPANSION
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

A green CPU workflow means the 62-unit source matrix compiled, the complete probe ABI linked strictly, and every required runtime correctness program passed.

The stable production core remains separate: Core build 32, ABI `0x00030004`, features `0x00001FFF`. V33 CPU work remains isolated from the deployed V32 runtime until real title bring-up is ready.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.