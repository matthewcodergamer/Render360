# Render360 Xenia-Web — V35 WasmBackend Bring-up / Core V32 Runtime / UI V33

Render360 is an experimental browser/iOS-oriented Xbox 360 emulator port built around **real upstream Xenia behavior**, not a second JavaScript imitation of the Xbox 360.

## Version map

```text
Render360 project / development track   V35
Stable deployed browser WASM core       V32
Responsive liquid-glass UI shell        V33
Active architecture track               V35 WasmBackend
```

**Core V32** remains the deployed package/XEX runtime. **UI V33** remains the responsive shell. **V35** contains six completed CPU/browser foundations and the active finalized-Xenia-HIR -> generated-WebAssembly execution path.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128 bytes
  -> Xenia PPCScanner / PPCFrontend / PPCTranslator
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> finalized Xenia HIR
       -> Render360 correctness executor   reference oracle
       -> Render360 WasmBackend            active hot path
            -> generated WebAssembly
            -> browser WASM engine
            -> shared Xenia PPCContext + Xenia Memory backing
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative V35 gate — run 206

GitHub Actions **run 206** (`33157972327`) completed successfully at implementation commit `6728006d854ee3e2958861d38ac8bb57beb73af6`.

```text
V32 package/XEX core rebuild                 PASS
PACKAGE_XEX_FOUNDATION                       PASS
PPC_TRANSLATION_FOUNDATION                   PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION            PASS
GUEST_CONTROL_FOUNDATION                     PASS
FPU_FOUNDATION                               PASS
VMX_FOUNDATION                               PASS (12 / 12)
wasm32 compile matrix                        67 / 67 PASS
strict full-export link                      LINKED
rooted exports                               40
real PPC/FPU/VMX correctness suite           24 / 24 PASS
WASM_BACKEND_SCALAR_DATAFLOW                 PASS
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT      PASS
WASM_BACKEND_CFG_BRANCH                      PASS
WASM_BACKEND_CFG_LOOP                        PASS
WASM_BACKEND_MEMORY_ENDIAN                   PASS
WASM_BACKEND_STAGE                           MEMORY_ENDIAN_PASS
```

Detailed foundation/status documents:

- [`FPU_FOUNDATION.md`](./FPU_FOUNDATION.md)
- [`VMX_FOUNDATION.md`](./VMX_FOUNDATION.md)
- [`WASM_BACKEND_FOUNDATION.md`](./WASM_BACKEND_FOUNDATION.md) — active, not yet complete

## Completed foundations — 100%

```text
STFS / Xbox package / XEX foundation       100% ✓
Xenia PPC translation foundation           100% ✓
Scalar PPC correctness foundation          100% ✓
Guest function / control foundation        100% ✓
FPU foundation                             100% ✓
VMX / VMX128 foundation                    100% ✓
```

These are explicit regression foundations, not claims that every retail title or every hardware edge case is supported.

## Generated WasmBackend — current verified stages

### Scalar dataflow

Run 183 first proved genuine generated execution from real PPC:

```text
addi r3,r4,5      0x38640005
blr               0x4E800020
```

The same compiled child module was reused against live context:

```text
r4=7    -> r3=12
r4=100  -> r3=105
WASM_BACKEND_SCALAR_DATAFLOW=PASS
```

### Scalar type / comparison / shift parity

Real `cmpwi r4,0 ; mfcr r3 ; blr` is lowered through Xenia-finalized HIR and compared against the oracle:

```text
negative -> CR0 LT -> 0x80000000
zero     -> CR0 EQ -> 0x20000000
positive -> CR0 GT -> 0x40000000
WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS
```

This covers truncation, signed comparisons, zero/sign extension, shifts, OR chains, integer booleans and context stores.

### Generated CFG branch / loop parity

The CFG workstream was deliberately not promoted when run 195 found a wrong not-taken branch. The bug came from treating Xenia `BRANCH_TRUE` as if it always terminated the enclosing C++ HIR `Block`. In real finalized HIR, the not-taken instruction stream may follow that branch in the same block.

The canonical source now preserves Xenia's instruction-level semantics. Run 206 re-verifies:

```text
cfg_branch_taken_r3=2
cfg_branch_not_taken_r3=1
cfg_ctr_loop_r3=3
cfg_conditional_reuse_r3=1
cfg_loop_reuse_r3=5
WASM_BACKEND_CFG_BRANCH=PASS
WASM_BACKEND_CFG_LOOP=PASS
```

Generated control flow uses a trap-bounded dispatcher, preserves conditional fallthrough, handles unconditional merge branches and executes backward CTR loops. Unsupported HIR still fails closed.

### Generated guest-memory / endian parity

Run 206 adds a separate generated-WASM memory workstream. The child module does **not** reinterpret Xbox virtual addresses as raw WebAssembly pointers. It translates the bounded probe guest address into the real host pointer backing the same Xenia `Memory` object used by the correctness oracle.

Real PPC tests:

```text
lwz r3,0(r4) ; blr
stw r5,0(r4) ; lwz r3,0(r4) ; blr
```

Measured runtime results:

```text
memory_lwz_module_bytes=160
memory_lwz_lowered=6
memory_lwz_r3=0x89abcdef
memory_lwz_reuse_r3=0x10203040

memory_stw_lwz_module_bytes=241
memory_stw_lwz_lowered=10
memory_stw_lwz_r3=0x12345678
memory_stw_lwz_reuse_r3=0xa1b2c3d4

WASM_BACKEND_MEMORY_ENDIAN=PASS
WASM_BACKEND_STAGE=MEMORY_ENDIAN_PASS
```

The same generated modules are reused with changed live memory values, so hardcoded or stale results cannot pass. Register state and guest-memory bytes are compared against Xenia semantics. This is the **bounded V35 probe-memory execution stage**, not the later full sparse/page-backed Xbox guest-memory subsystem.

## Current WasmBackend surface

```text
integer constants / context reads                 ✓
ASSIGN / TRUNCATE / ZERO_EXTEND / SIGN_EXTEND     ✓
ADD / SUB / AND / OR / XOR / NOT / NEG            ✓
signed + unsigned integer compares                 ✓
IS_TRUE / IS_FALSE                                 ✓
SHL / SHR / SHA / ROTATE_LEFT                      ✓
context writes                                     ✓
conditional taken + not-taken CFG                  ✓
unconditional branches / merge                     ✓
backward CTR loops                                 ✓
likely-return boundary                              ✓
live generated-module reuse                        ✓
dispatch safety budget                             ✓
bounded guest LOAD / LOAD_OFFSET                    ✓
bounded guest STORE / STORE_OFFSET                  ✓
Xbox scalar BYTE_SWAP / endian path                 ✓
same Xenia Memory backing                           ✓

generated direct/nested/CTR calls                   ○ NEXT
FPU lowering                                        ○
VMX / VMX128 lowering                               ○
broad generated-WASM equivalence matrix             △ partial
compiled-function cache                             ○
executable-page invalidation                        ○
WASM_BACKEND_FOUNDATION=PASS                        ○
```

## Current progress after run 206

```text
Package / XEX foundation
████████████████████  100% ✓

PPC translation foundation
████████████████████  100% ✓

Scalar PPC foundation
████████████████████  100% ✓

Guest control foundation
████████████████████  100% ✓

FPU foundation
████████████████████  100% ✓

VMX / VMX128 foundation
████████████████████  100% ✓

Hot WasmBackend
████████░░░░░░░░░░░░  ~40%  ← ACTIVE

Full Xbox guest-memory system
██░░░░░░░░░░░░░░░░░░  ~10%

Real default.xex entry execution
█░░░░░░░░░░░░░░░░░░░  ~5%

Kernel / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░  ~1–2%

Xenos guest GPU
░░░░░░░░░░░░░░░░░░░░  ~1–2%

WebGPU Xenos backend
█░░░░░░░░░░░░░░░░░░░  ~2%

WebGL2 compatibility fallback
░░░░░░░░░░░░░░░░░░░░  ~1%

First genuine Xbox title boot
█████░░░░░░░░░░░░░░░  ~26–27%

Small XBLA / Braid-class playable
████░░░░░░░░░░░░░░░░  ~19%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░  ~11%

OVERALL RENDER360
██████░░░░░░░░░░░░░░  ~31–32%
```

Percentages are scoped engineering estimates, not literal source-code coverage.

## Next implementation order

1. **WasmBackend guest-call critic** — generated direct, nested and CTR-indirect calls/returns through Xenia-discovered guest functions with shared live `PPCContext`.
2. **WasmBackend FPU critic** — lower the already-closed FPU foundation and demand architectural/memory equivalence.
3. **WasmBackend VMX/VMX128 critic** — lower the closed vector baseline and compare 128-bit state/memory.
4. **Broad equivalence matrix** — generated WASM vs correctness oracle across representative guest functions.
5. **Compiled-function cache + executable invalidation** — guest address + code-version cache keys and executable-page invalidation.
6. Only then emit `WASM_BACKEND_FOUNDATION=PASS` and mark the WasmBackend foundation 100%.
7. Replace the bounded probe memory with the full sparse/page-backed Xbox guest-memory system.
8. Map the extracted `default.xex`, initialize CPU/module state and execute its genuine entry point.
9. Bring up `KernelState`, xboxkrnl/XAM, then Xenos -> WebGPU/WGSL/EDRAM with WebGL2 fallback and WebAudio.

## Graphics architecture

**WebGPU is primary. WebGL2 is fallback.** Both must consume one shared Xenia/Xenos semantic layer. Three.js remains host/input diagnostics only and is never presented as guest Xbox output.

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
node ./test-guest-control-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-fpu-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-vmx-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-wasm-backend.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-wasm-backend-cfg.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-wasm-backend-memory.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

## Status language

- **FOUNDATION COMPLETE** means the named scoped regression contract is green.
- **GENERATED WASM EXECUTING** means finalized Xenia HIR was lowered into WebAssembly and executed with measured state equivalence.
- **PLAYABLE** remains reserved for genuine title execution with sufficient CPU, kernel, GPU, input and audio behavior for gameplay.

Stable production remains **Core V32**. Active project development remains **V35**. UI remains **V33** until a UI-specific release.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.