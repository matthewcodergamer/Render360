# Render360 Xenia-Web V29 roadmap

## Project rule
When Xenia already contains Xbox 360 behavior, do not recreate that behavior in front-end JavaScript. Keep browser JavaScript focused on host APIs and UI. Move reusable native semantics into WebAssembly and write browser-specific adapters only where desktop host APIs cannot be used.

## V29 — current milestone: live browser runtime
- Root-deployable GitHub Pages application.
- C++ wasm32 core ABI 3.1.
- Dedicated Web Worker continuously executing native `r360_runtime_tick`.
- Controller input bitmask wired to the native worker.
- Live worker Hz/tick/work telemetry.
- Real animated WebGPU WGSL pipeline.
- Animated WebGL2 fallback.
- Three.js/WebGL diagnostic scene.
- Xenia-aligned XEX base/header/optional-header inspection retained from V28.
- Upstream Xenia contract drift workflow.

## V30 target — XEX image preparation
Port the real Xenia-native image preparation path in pieces:
- session-key handling / crypto dependency plan
- uncompressed XEX path
- basic-compressed XEX path
- normal/LZX path
- PE validation and mapping

Do not implement fake "successful load" behavior when one of these paths is unavailable.

## V31 target — imports / VFS
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
