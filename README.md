# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. It mounts LIVE/PIRS/CON content in native C++/WASM, walks STFS structures, streams a complete `default.xex`, inspects XEX structure, and exposes browser input/WebGPU host infrastructure. It does **not** claim retail-title execution or playable Xbox 360 games yet.

The active **V33 CPU bootstrap** ports upstream Xenia's PowerPC, FPU and VMX frontend/semantics/HIR/compiler pipeline to Emscripten/wasm32 while excluding Xenia's native x64 JIT and desktop graphics backends.

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

## Production V32 already working

- native LIVE / PIRS / CON STFS mount and hash-chain traversal;
- complete root `default.xex` lookup/streaming and XEX structural inspection;
- range-based browser reads instead of loading multi-GB packages into WASM RAM;
- touch/Gamepad API forwarding;
- WebGPU host surface and dynamic-resolution infrastructure;
- honest first-frame readiness gate.

## V33 authoritative CPU milestone — run 141

GitHub Actions **run 141** (`33144177521`) is the current authoritative green CPU gate at implementation commit `d3dbfc74e9a7949485039d8e591410c6fe0cc099`.

```text
wasm32 compile matrix       62 / 62 PASS
strict full-export link     LINKED
rooted probe exports        25
real PPC correctness cases  18 / 18 PASS
```

Every required case begins as genuine big-endian Xbox 360 PowerPC bytes, passes through the real Xenia PPC frontend/translator/scanner/HIR builder/compiler passes, and executes the **finalized Xenia HIR** against a real `PPCContext` and the same bounded Xenia `Memory` object owned by `Processor`.

The verified runtime subset now includes:

- integer arithmetic and bitwise operations;
- comparisons and multi-block conditional control flow;
- backward CTR-controlled loops;
- guest load/store with Xbox byte order;
- CR/LR/CTR architectural state;
- direct and two-level nested guest function calls;
- FLOAT64 FPR movement and guest-memory load/store;
- real FLOAT64 add, subtract and multiply;
- first real VMX VEC128 load/add/store execution.

### Guest calls are real Xenia function translations

A direct PPC `bl` crosses a separate guest function boundary. Xenia emits `SET_RETURN_ADDRESS`, LR state and HIR `CALL`; Render360 asks the real Xenia `PPCScanner` to discover the callee extent and sends that callee back through Xenia's frontend/translator/compiler. Nested finalized HIR executes against the same live `PPCContext` and returns to the caller.

```text
caller -> callee(li r3,5) -> caller(addi +2) -> r3 = 7
assembled guest functions = 2

caller -> function A -> function B -> function A -> caller
final r3 = 7
assembled guest functions = 3
```

### FLOAT64 arithmetic tier

The original arithmetic gate remains:

```text
lfd  f1,0(r4)       ; 1.0
lfd  f2,8(r4)       ; 2.0
fadd f3,f1,f2
stfd f3,16(r4)
lwz  r3,16(r4)
blr
```

Run 141 additionally verifies genuine PPC `fsub` and `fmul` through the same memory/FPR path.

```text
5.0 - 2.0 = 3.0
1.5 * 2.0 = 3.0
```

For each operation Xenia emits **33 finalized HIR instructions**. CI verifies both architectural state and the exact guest-memory IEEE-754 result:

```text
r3                 = 0x40080000
guest result        = 0x4008000000000000
                     IEEE-754 double 3.0
```

The measured HIR path includes guest `LOAD`, scalar `BYTE_SWAP`, INT64↔FLOAT64 same-width `CAST`, typed `ADD` / `SUB` / `MUL`, FPR context state, conversion back to guest bits and guest `STORE`.

### First VMX execution subset

Run 141 also passes genuine VMX:

```text
lvx      v1,0,r4
lvx      v2,0,r5
vaddubm  v3,v1,v2
stvx     v3,0,r7
lwz      r3,0(r7)
blr
```

The input vectors contain sixteen `0x01` bytes and sixteen `0x02` bytes. Xenia produces **29 finalized HIR instructions**, including VEC128 `LOAD`, VEC128 `BYTE_SWAP`, VR context operations, `VECTOR_ADD`, VEC128 `STORE` and the scalar readback.

The correctness executor implements only the measured semantics:

- Xenia-compatible VEC128 byte swap, reversing bytes inside each 32-bit word;
- `VECTOR_ADD` with `INT8_TYPE + ARITHMETIC_UNSIGNED`, exactly the HIR form emitted by `vaddubm`;
- modulo-256 addition across all 16 byte lanes.

CI verifies the full 128-bit guest-memory result:

```text
guest[0x80000160] = 0x03030303
guest[0x80000164] = 0x03030303
guest[0x80000168] = 0x03030303
guest[0x8000016c] = 0x03030303
r3                = 0x03030303
```

This means VMX is no longer translation-only in Render360: **the first genuine vector load → arithmetic → store path now executes through finalized Xenia HIR on wasm32.** Unmeasured vector operations still fail closed.

## Current CPU milestone ladder

```text
upstream Xenia source / contract audit                       ✓
62/62 wasm32 translation graph                               ✓
strict full-export WASM link                                 ✓
known PPC -> finalized Xenia HIR                             ✓
PPC TRANSLATION READY                                        ✓
finalized HIR -> real PPCContext execution                   ✓
runtime integer arithmetic / compare / branch                ✓ first subset
guest load/store + Xbox endian correctness                   ✓ first subset
CR / LR / CTR + backward loops                               ✓ first subset
direct + nested guest calls                                  ✓ first subset
FLOAT64 load/store + add/sub/mul                             ✓ first subset
VMX VEC128 load + byte add + store                           ✓ first subset
        ↓
FLOAT64 divide + FP compare/convert/FPSCR                     ACTIVE NEXT
        ↓
broader VMX / VMX128 integer + vector-float semantics
        ↓
hot-block WasmBackend + translated-function cache
        ↓
executable-page versioning / invalidation
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
title compatibility / iPhone optimization
```

## Next implementation boundary

The closest CPU work to finish next is:

1. add real PPC `fdiv` and typed FLOAT32/FLOAT64 HIR `DIV` correctness;
2. add floating compare and conversion cases and verify FPSCR/CR effects from real Xenia HIR;
3. broaden VMX from byte `vaddubm` to measured word/halfword add/sub and logical operations;
4. begin VMX128-specific cases used by Xbox 360 software;
5. stop extending the correctness executor once the useful semantic subset is broad enough and start the hot `WasmBackend`.

The next major emulator transition remains **sparse full guest memory + mapping and entering the real captured `default.xex` entry point**. That is where Render360 moves from handcrafted correctness programs into real title code execution.

## Browser GPU plan

```text
Xenia Xenos command/register/resource/shader/EDRAM semantics
  -> shared Render360 browser GPU layer
       -> WebGPU PRIMARY backend (WGSL)
       -> WebGL2 FALLBACK backend (GLSL ES)
```

WebGL2 is a compatibility backend consuming the same Xbox guest semantics; it is not a host-authored Three.js replacement for Xbox output.

## Build / verification

```bash
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

A green CPU workflow means the source graph compiled, the required ABI linked strictly, and every required real PPC runtime correctness program passed.

Stable production remains Core V32, ABI `0x00030004`, features `0x00001FFF`. V33 CPU work remains isolated from the deployed production runtime until real title bring-up is ready.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.