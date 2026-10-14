# Render360 progress report

Branch: `claude/xbox-360-emulator-optimization-74g72w`. Test title: Banjo-Tooie (XBLA).

## Verified
- Banjo-Tooie boots and renders its loading screen ("Loading…") through the
  HIR executor and guest JIT. File loading finishes (`db360.textures.cmp`,
  ~50 MB, is read in full); 7 title threads run.
- CPU: guest JIT compiles Xenia HIR to WebAssembly. Headless speed is about
  180M guest instructions/s.
- Deterministic headless runs (`run-title --deterministic 1000`): two
  identical runs match through 58.3B instructions (1098 checkpoints, same
  frames, draws and GPU packets). Fixed: a JIT segment resumed after an
  Asyncify rewind re-added its instruction count, which made the guest clock
  depend on host timing.
- Infinite kernel waits with every thread blocked now let guest time pass
  (up to 10 s) so timers and vblank can wake threads, instead of stopping as
  a deadlock.
- Shader path: Xenia SpirvShaderTranslator → Naga → WGSL. All shaders seen
  during loading compile in Chromium WebGPU (SwiftShader).

## Current blocker (investigation, not fixed)
At about 58B instructions the main render thread blocks in D3D `Swap`,
waiting for the GPU to reach the previous frame's timestamp. Confirmed so far:
- The GPU command processor is not deadlocked. It advances one swap at a
  time; each swap waits (WAIT_REG_MEM on 0xFFCF4004) for D3D's vblank handler
  to release it, and that handshake works on every cycle.
- The ring has a growing backlog (~730 words pending behind the read
  pointer). D3D's command-stream worker thread (0x36000201) keeps appending
  small kicks faster than the vblank-paced CP drains them, so the main
  thread's timestamp is never reached.
- Some replayed command buffers contain older fence values, so the fence also
  moves backwards. This is what the guest wrote: the CP does not cache IBs.

Next step: identify what the worker appends (the ring-word trace added in
this commit shows it), and why it outpaces the GPU, before changing anything.

## Tests (latest build)
- Regression runner: 59 of 68 pass. The 9 failures are pre-existing
  foundation tests (fpu/vmx/wasm-backend probes, guest-control, translation
  probe) and are unchanged by recent work.
- Xenia PPC instruction suite with JIT forced: pass (1398 tests, 1406
  functions compiled).
- Guest JIT differential test: pass (2920 cases, 73 instructions).
- `test-translation-window-consistency.mjs` fails before the window fix and
  passes after it.

## Not done yet
- Interactive gameplay: not reached.
- WebGPU real-time renderer: only the shader pipeline is proven; draws,
  render targets, textures and resolves are not implemented. Frames come
  from the CPU software renderer.
- Audio: XMA decoding not implemented (XMA register window only).
