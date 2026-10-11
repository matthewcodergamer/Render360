# Render360 progress report

Branch: `claude/xbox-360-emulator-optimization-74g72w`. Test title: Banjo-Tooie (XBLA).

## Verified
- Banjo-Tooie boots and renders its loading screen ("Loading…") through the
  HIR executor and guest JIT. File loading finishes (`db360.textures.cmp`,
  ~50 MB, is read in full); 7 title threads run.
- CPU: guest JIT compiles Xenia HIR to WebAssembly. Headless speed is about
  180M guest instructions/s (6B instructions in ~62 s, down from 223 s).
- Deterministic headless runs (`run-title --deterministic 1000`): identical
  flags give identical results up to at least 4B instructions.
- Shader path: Xenia SpirvShaderTranslator → Naga → WGSL. All shaders seen
  during loading compile in Chromium WebGPU (SwiftShader).

## Current blocker
At about 58B instructions the main thread blocks inside D3D `Swap` waiting
for a GPU timestamp. D3D's presentation watchdog thread then keeps
re-presenting the previous frame, and those replays rewrite older timestamps.
No new frame is presented after that (VdSwap stops at ~1540). Root cause not
yet confirmed: the open question is why the main thread's target timestamp
is never observed. Runs still diverge slightly past ~58B (kernel-call counts
differ between identical runs), which blocks exact replay of the stall.

## Tests (latest build)
- Regression runner: 59 pass, 9 fail. The 9 failures are pre-existing
  foundation tests (fpu/vmx/wasm-backend probes, guest-control, translation
  probe) and are unchanged by recent work.
- Xenia PPC instruction suite with JIT forced: pass (1406 functions).
- Guest JIT differential test: pass (73 instructions).
- New: `test-translation-window-consistency.mjs` fails before the window fix
  and passes after it.

## Not done yet
- Interactive gameplay: not reached.
- WebGPU real-time renderer: only the shader pipeline is proven; draws,
  render targets, textures and resolves are not implemented. Frames come
  from the CPU software renderer.
- Audio: XMA decoding not implemented (XMA register window only).

## Next task
Make headless runs fully deterministic past 58B, then reproduce the Swap
stall with a watch on the fence word and dumps of the replayed indirect
buffers, and fix the earliest confirmed cause.
