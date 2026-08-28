# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The production browser runtime is still **Core V32**: it can mount LIVE/PIRS/CON content in native C++/WASM, walk STFS structures, find and stream a complete `default.xex`, inspect XEX metadata, and feed real browser input into the runtime. It does **not** claim retail PowerPC execution or playable Xbox 360 games yet.

The active development line is **V33 CPU bootstrap**. V33 is bringing upstream Xenia's PowerPC frontend, instruction semantics, HIR, and compiler boundary into an Emscripten/wasm32 build while keeping Xenia's x64 JIT and desktop graphics backends out of the browser target.

## What the V32 runtime already does

- LIVE / PIRS / CON STFS mount in native C++/WASM.
- Native file-table and hash-chain traversal derived from Xenia's STFS device logic.
- Root `default.xex` lookup.
- Complete `default.xex` streaming, including contiguous and non-contiguous files.
- L0/L1/L2 STFS hash-chain following.
- Exact executable byte/block progress without loading an entire multi-gigabyte package into WASM memory.
- XEX1/XEX2 structural inspection.
- First-frame readiness panel that reports blocked emulator layers honestly.
- Touch controls, drag look, controller buttons, and Gamepad API forwarding.
- WebGPU host surface and dynamic-resolution infrastructure for the future Xenos backend.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

That means Render360 should reuse Xenia for:

```text
PowerPC / VMX128 decode and semantics
        -> PPCFrontend
        -> PPCTranslator
        -> PPCHIRBuilder / ppc_emit_*
        -> Xenia HIR
        -> portable compiler passes
        -> browser correctness backend
        -> Render360 WasmBackend
```

Host-specific x64 machine code generation, executable-memory assumptions, D3D12, Vulkan, desktop windowing, HID and native audio are not copied into the web target. They are replaced by browser host adapters where required.

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, or JavaScript PPC emulator should be presented as Xbox output.

## V33 wasm32 CPU bootstrap

The bootstrap is intentionally separate from `render360_xenia_core.wasm`, so CPU-port experiments cannot break the working V32 STFS/XEX runtime.

The last completed measured baseline before the current expanded source pass was:

```text
PASS  Xenia HIR opcodes
PASS  Xenia HIR blocks
PASS  Xenia HIR instructions
PASS  Xenia HIR values
PASS  Xenia compiler pass

BLOCK PPCContext
BLOCK PPCHIRBuilder
BLOCK PPCTranslator
BLOCK PPCFrontend
```

That was **5 real upstream Xenia translation units compiling under Emscripten/wasm32**.

The blocking `PPCContext` issue was identified precisely: WebAssembly's 32-bit host pointers make Xenia's packed context 16 bytes short of its existing 64-byte padding invariant. V33 now generates a browser-only overlay that adds **tail padding only after Xenia's final context data member**, preserving all existing architectural/runtime field offsets while restoring the 64-byte size invariant.

Current bootstrap infrastructure also includes:

- `src/xenia_web_shims/xenia/base/platform.h` — Emscripten/wasm32 host platform definitions.
- `src/xenia_web_shims/xenia/base/atomic.h` — browser-compatible atomic primitives.
- `prepare-xenia-web-overlay.py` — generates the tail-only `PPCContext` ABI adaptation from the fetched upstream header.
- `src/xenia_web_bootstrap/ppc_context_abi_probe.cpp` — compile-time/runtime telemetry for context size and key field offsets.
- `fetch-xenia.sh` — shallow upstream Xenia fetch plus only the CPU-side submodules currently needed (`fmt`, `utfcpp`, `capstone`, `cpptoml`).
- `build-xenia-ppc-bootstrap.sh` — real Emscripten compile matrix with dependency classification.
- `.github/workflows/xenia-wasm32-bootstrap.yml` — CI audit, Emscripten build, LLVM-header setup, compile report and uploaded failure logs.

The expanded source matrix now tests the real Xenia instruction-semantics categories too:

```text
ppc_emit_alu.cc
ppc_emit_control.cc
ppc_emit_memory.cc
ppc_emit_fpu.cc
ppc_emit_altivec.cc
```

The GitHub Actions compile report is the source of truth for what is currently portable. A source is not marked ready merely because an adapter exists.

## CPU milestone ladder

```text
upstream Xenia source audit
        ↓
real HIR/compiler .cc files compile as wasm32
        ↓
PPCContext browser ABI validated
        ↓
real PPC emit categories compile
        ↓
PPCHIRBuilder + PPCTranslator + PPCFrontend compile
        ↓
link separate xenia_ppc_bootstrap.wasm
        ↓
feed known real PPC bytes
        ↓
Xenia decoder + emit semantics produce observable HIR
        ↓
browser-safe HIR correctness execution backend
        ↓
expected PPC register state matches
        ↓
hot-block WasmBackend
        ↓
map and enter real default.xex
```

`PPC TRANSLATION READY` may only be reported after real PPC bytes have passed through Xenia's decoder/emitter/HIR path. `PPC EXECUTING` may only be reported after guest operations actually execute and architectural state is verified.

## Braid / XBLA input

Use the original LIVE/PIRS/CON content package you own. Do **not** rename it to `.iso` merely to make Render360 accept it.

Current title path:

```text
Braid LIVE/STFS package
  -> native STFS mount                 ✓
  -> directory + hash traversal        ✓
  -> complete default.xex stream       ✓
  -> XEX structural inspection         ✓
  -> XEX image preparation/mapping     NEXT
  -> Xenia PPC execution               IN DEVELOPMENT
  -> KernelState / XAM startup         FUTURE
  -> Xenos command processor/WebGPU    FUTURE
  -> first genuine guest framebuffer
```

## Build and tests

Production V32 core:

```bash
bash ./build-core.sh
node ./smoke_test_node.js
```

Browser bridge test:

```bash
python3 -m http.server 8765
node ./test_mount_node.mjs
```

V33 Xenia CPU bootstrap:

```bash
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
```

Then run the Emscripten matrix from an Emscripten environment:

```bash
bash ./build-xenia-ppc-bootstrap.sh
```

CI performs this automatically on relevant `main` changes and uploads `build/xenia-ppc-bootstrap/report.tsv` plus per-source compiler logs.

Expected production native core remains:

```text
Build    32
ABI      0x00030004
Features 0x00001FFF
```

## GitHub Pages

Keep Pages on:

**Settings -> Pages -> Deploy from a branch -> `main` -> `/(root)`**

The deployed browser UI remains the V32 runtime while V33 CPU work stays isolated from it until the new CPU path is real and testable.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
