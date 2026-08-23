# Render360 Xenia-Web roadmap

## Project rule
**Xenia owns Xbox 360 behavior. Render360 owns host behavior.** Keep Xbox structures, CPU/GPU semantics, kernel behavior and VFS logic in portable/native code based on Xenia. Keep HTML/JS focused on browser file access, UI, input, audio/graphics host adapters and telemetry.

## V30 — current: native STFS mount
- C++ wasm32 ABI 3.2.
- Pull-driven native mount state machine: WASM requests byte ranges, browser `File.slice()` fulfills them.
- XContent/STFS header and volume-descriptor validation.
- Xenia-aligned block-to-offset and L0/L1/L2 hash-table selection.
- Native 0x40-byte directory parsing and flat parent-index model.
- Native file-table hash-chain traversal.
- Root `default.xex` lookup.
- First real `default.xex` data-block XEX1/XEX2 probe.
- Continuous worker/input/session telemetry.
- Direct WebGPU host + dynamic-resolution infrastructure; Three.js stays diagnostic-only.

## V31 — complete default.xex extraction + VFS
- Follow the executable's own STFS data-block chain rather than only probing block 0.
- Support contiguous fast path and hashed non-contiguous files.
- Expose mounted file reads through a small Xenia-style VFS/browser adapter.
- Read the complete executable without copying the entire LIVE/PIRS/CON package into WASM memory.
- Feed the exact executable bytes to the XEX loader boundary.

## V32 — Xenia XEX image preparation
- key/session-key dependency plan
- unencrypted/uncompressed path first
- Basic compression
- Normal/LZX compression
- encrypted image path
- PE validation / guest image mapping
- import table parsing
- strict stop whenever a required path is missing

## V33 — browser guest memory + portable PowerPC execution
- wasm32-suitable Xbox virtual/physical memory model
- reuse Xenia PPC decoder/frontend/HIR
- correctness-first interpreter/emulated-opcode backend
- later hot-block optimization / wasm-friendly compiled path
- keep PPC arithmetic out of JavaScript hot loops

## V34 — kernel/XAM startup
- Xenia `KernelState`
- xboxkrnl/XAM exports
- threads/events/synchronization
- no broad unknown-ordinal success stubs

## V35+ — Xenos → WebGPU
- shared Xenia command processor
- direct WebGPU backend (no Three.js in the emulation path)
- WGSL shader translation target
- texture tiling/endian conversion + cache
- EDRAM/render targets/resolves
- shader/pipeline caches
- frame pacing and dynamic internal resolution

## Validation order
`default.xex` full extraction → XEX image mapped → first PPC instructions → kernel startup → Xenos ring → first real Braid draw/frame → small XBLA → lighter 3D → heavier titles → GTA IV.

Performance work follows profiling. If a game is CPU-bound, lowering resolution will not solve the main bottleneck; if it is GPU-bound, dynamic resolution and render-path optimizations can matter greatly.
