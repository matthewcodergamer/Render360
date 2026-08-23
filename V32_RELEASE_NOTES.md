# V32 release notes

## Real Xbox package progress

- Added complete STFS file extraction scheduler to the native C++/WASM core.
- Supports contiguous files and hash-chained non-contiguous files.
- Added extraction ABI: begin/reset/status/current block/bytes/blocks/contiguous state.
- Browser host streams only requested 4 KiB STFS data blocks from `File.slice()`.
- `mountStfs()` now automatically streams the complete root `default.xex` when present.
- Extracted XEX bytes are fed back into the native XEX inspector.
- Added a first-frame gate UI so a black screen is not confused with successful rendering.

## Controller fixes

- Enlarged and respaced liquid-glass touch controls.
- Added visible right analog LOOK control.
- Retained drag-look for the test arena.
- Added Start, Back, LB and RB touch controls.
- Improved pointer capture so one released finger does not cancel other controls.
- Physical Gamepad API input now feeds the native runtime outside the host test arena too.

## Deployment

- Build 32, ABI 3.4, feature mask `0x1FFF`.
- Added text-embedded WASM fallback for GitHub Pages deployment/cache reliability.

## What is still not implemented

V32 does not fabricate a retail frame. First Braid rendering still requires the Xenia execution layers after package extraction: XEX decrypt/decompress + image mapping, PowerPC execution backend suitable for WebAssembly, kernel/XAM startup, and Xenos -> WebGPU.
