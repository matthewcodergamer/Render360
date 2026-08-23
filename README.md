# Render360 Xenia-Web V32

V32 is the **real-package / first-frame pipeline milestone**. It removes one of the fake-looking boundaries from the older browser experiments: a LIVE/PIRS/CON Xbox 360 package can now be mounted in the native C++/WASM core and its complete `default.xex` can be streamed out block-by-block from the STFS filesystem.

This is real container work, not a rendered mock game. V32 still does **not** claim that Braid is playable yet. The next hard boundary is the actual Xenia execution stack: XEX image preparation, PowerPC execution, kernel/XAM, and Xenos command/shader translation to WebGPU.

## What V32 does now

- LIVE / PIRS / CON STFS mount in native C++/WASM.
- Native file-table and hash-chain traversal derived from Xenia's STFS device logic.
- Root `default.xex` lookup.
- **Complete `default.xex` streaming**, including:
  - contiguous STFS files,
  - non-contiguous files followed through L0/L1/L2 hash chains,
  - exact byte count and block progress,
  - no need to duplicate the whole Xbox package into WASM memory.
- XEX1/XEX2 inspection of the extracted executable.
- First-frame readiness panel showing exactly which emulator layer is ready or blocked.
- Left analog stick with real knob movement.
- Dedicated right analog **LOOK** stick plus drag-look.
- Multi-touch digital controls: A/B/X/Y, LT/RT, LB/RB, Start, Back.
- Standard Gamepad API input is forwarded to the native runtime even when the Three.js arena is not active.
- WebGPU host surface and dynamic-resolution infrastructure remain in place.

## Important architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

Do not re-create retail Xbox behavior in JavaScript with fake success stubs. The browser port should progressively bring Xenia's XEX, CPU, kernel and GPU behavior across while adapting host-facing pieces to WASM/WebGPU.

Upstream Xenia currently creates its real CPU backend only on AMD64/x64. That means a browser build cannot simply compile the existing x64 JIT unchanged; Render360 needs a browser-safe PowerPC backend (interpreter first or PPC/HIR -> generated WASM) while preserving Xenia's decoder/frontend semantics.

## Braid / XBLA input

Use the original LIVE/PIRS/CON content package you own. Do **not** rename or convert it to `.iso` just to make Render360 accept it.

V32 flow:

```text
Braid LIVE/STFS package
  -> native STFS mount
  -> native directory + hash traversal
  -> complete default.xex stream
  -> XEX metadata/header validation
  -> NEXT: XEX decrypt/decompress + guest image mapping
  -> NEXT: Xenia PPC frontend + browser backend
  -> NEXT: KernelState / XAM startup
  -> NEXT: Xenos command processor -> WebGPU
  -> first real Braid frame
```

## Build and tests

```bash
bash ./scripts/build-core.sh
node ./scripts/smoke_test_node.js
```

Browser bridge test:

```bash
python3 -m http.server 8765
node ./scripts/test_mount_node.mjs
```

Expected native core:

```text
Build    32
ABI      0x00030004
Features 0x00001FFF
```

The smoke test now verifies a **non-contiguous two-block `default.xex` extraction** through the native STFS hash chain.

## GitHub Pages

Keep Pages on:

**Settings -> Pages -> Deploy from a branch -> `main` -> `/(root)`**

Open:

`https://matthewcodergamer.github.io/Render360/?v=32`

V32 also includes `render360_xenia_core_embedded.js`, so the current WASM core can be deployed through GitHub's text contents API without the browser accidentally running an older `.wasm` binary from cache.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
