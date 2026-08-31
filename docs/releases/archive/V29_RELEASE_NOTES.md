# Render360 Xenia-Web V29 — Live Runtime

V29 fixes the confusing "static website" behavior of V28 without pretending that an Xbox 360 game is already executing.

## What changed

- Added a dedicated module Web Worker (`worker/runtime-worker.js`).
- The worker loads the native C++ WebAssembly core and calls `r360_runtime_tick` continuously.
- Added native runtime counters, deterministic native work, checksum state, and controller input bitmask exports.
- Controller LT/RT/A/B/X/Y events are now delivered to the worker runtime.
- Replaced the nearly-black WebGPU clear loop with a real animated WGSL fullscreen shader pipeline.
- Replaced the WebGL2 fallback clear with an actual GLSL shader pipeline.
- Added an optional Three.js WebGL diagnostic layer (pinned to Three.js r185 via jsDelivr) so the page visibly demonstrates a separate 3D render loop.
- Added live worker Hz, native tick/work counters, WebGPU/WebGL FPS, and Three.js FPS telemetry.
- Added visibility diagnostics. Mobile browsers may throttle timers when Safari is backgrounded or the phone is locked.

## Important boundary

V29 makes the browser runtime continuously active. It does not claim that the Xenia CPU, STFS VFS, XEX image loader, Xenos command processor, shaders, EDRAM, audio, or commercial-game execution are complete. Those remain native port milestones.

GitHub Pages is a static file host, but JavaScript, Web Workers, WebAssembly, WebGPU and WebGL execute on the user's device after those files are downloaded.
