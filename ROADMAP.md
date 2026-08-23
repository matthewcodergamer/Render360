# Render360 Xenia-Web V28 roadmap

## Project rule
When Xenia already contains Xbox 360 behavior, do not recreate that behavior in front-end JavaScript. Keep browser JavaScript focused on host APIs and UI. Move reusable native semantics into WebAssembly and write browser-specific adapters only where desktop host APIs cannot be used.

## V28 — current milestone
- Root-deployable GitHub Pages application.
- C++ wasm32 core ABI 3.0.
- Xenia-aligned XEX base/header/optional-header inspection.
- Execution-info and file-format metadata extraction.
- Selected XEX2 security metadata extraction.
- WebGPU surface bootstrap.
- Upstream Xenia contract drift workflow.

## V29 target — XEX image preparation
Port the real Xenia-native image preparation path in pieces:
- session-key handling / crypto dependency plan
- uncompressed XEX path
- basic-compressed XEX path
- normal/LZX path
- PE validation and mapping

Do not implement fake "successful load" behavior when one of these paths is unavailable.

## V30 target — imports / VFS
- XEX import libraries
- export resolution
- STFS/VFS path required for XBLA packages
- browser file source adapter

## Later milestones
- xboxkrnl / XAM
- PowerPC interpreter/WASM-compatible backend
- Xenos command processor
- WebGPU texture/render target/EDRAM/resolve backend
- shader translator target suitable for WebGPU
- audio, gamepad/touch, IndexedDB/OPFS
- Braid validation only after real CPU + GPU work reaches presents
