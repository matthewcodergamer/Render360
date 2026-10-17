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

## Fixed: Swap stall at ~58B instructions
Root cause: the command processor ignored PM4 type-3 predication. D3D
predicated tiling replays each frame's command buffer once per screen bin,
and packets meant for one bin (including D3D's GPU-to-CPU deferred callback
requests) ran in every pass. Each extra callback made D3D's worker thread
queue another frame, the ring backlog outgrew the vblank-paced swaps, and
the main thread waited forever for its frame. Ported Xenia's check
(`ExecutePacketType3`: skip predicated packets when `bin_select & bin_mask`
is 0, never run a predicated swap).

After the fix (deterministic headless runs):
- 90B instructions: 2551 frames (VdSwap), was stuck at ~1542.
- 120B instructions: 3067 frames; the title polls the controller every
  frame (XamInputGetState 4056 calls by 90B, was 20).
- Frame at 61B: the Rare logo intro renders (software renderer).

## Verified: title screen, input and main menu
Headless deterministic run (`run-title --deterministic 1000`), software
renderer, controller input injected with `--press`:
- 61B instructions: Rare logo intro.
- 80B: title screen ("PRESS START TO PLAY") over a moving 3D flythrough.
- Start at 80B: the title asks "Gamer profile not online" (offline profile);
  the player's answer is passed back (`--dialog-button 1` = "Continue
  playing offline"; in the browser the page shows the dialog).
- 82B: main menu, Banjo's room, rendered in 3D.
- 85B: "Trial game" notice (the default license is trial, as in Xenia).
- 90B: "PRESS A TO PLAY THE GAME"; frames change every second and the run
  reaches its instruction limit with no blocker.

Fixed on the way (each with a kernel services test):
- XamShowMessageBoxUI (headless focused button, or the player's answer).
- XamUserCreateAchievementEnumerator (title XDBF via Xenia xdbf_utils).
- XexGetProcedureAddress (kernel export trampolines),
  XamContentAggregateCreateEnumerator, XamGetPrivateEnumStructureFromHandle
  (guest X_KENUMERATOR objects), XamTaskSchedule.
- A thread's exit left the kernel service status at "terminal" and the next
  thread resuming mid-sleep returned it, ending the run.

## Verified: in-game in Spiral Mountain
Same headless run, continued: A at "PRESS A TO PLAY THE GAME" starts the
opening cutscene (rainy night, "B SKIP"); B skips it, and by 108B the game
is in Spiral Mountain (first level) with the HUD (health honeycombs), the
"SPIRAL MOUNTAIN" title and in-game dialogue; frames keep changing to the
115B instruction limit (3268 frames presented).

Two scheduler bugs blocked it (single host thread running all guest
threads as fibers):
- Least-run-first scheduling starved the busy main thread: a timer thread
  looping Sleep(0) around a critical section kept winning, and the main
  thread waited ~50B instructions for the lock. Lag is now bounded (8
  quanta), as CFS bounds it.
- The HIR interpreter polled for interrupts and preemption only at guest
  calls. A function called once that loops waiting for another thread ran
  10B instructions without letting that thread run. It now polls every 4096
  instructions, as the guest JIT polls on backward branches.
Headless message-box answers are now given inside the call
(`--dialog-button`), so runs no longer depend on host timing.

Known visual issue: Banjo's own model renders incompletely (small,
fragmented); the level, HUD and other characters render.

## Current work
Proving in-game control (`--stick` for the left analog stick), then the
renderer issue above and speed.

## Tests (latest build)
- Regression runner: 60 of 69 pass. The 9 failures are pre-existing
  foundation tests (fpu/vmx/wasm-backend probes, guest-control, translation
  probe) and are unchanged by recent work.
- Xenia PPC instruction suite with JIT forced: pass (1398 tests, 1406
  functions compiled).
- Guest JIT differential test: pass (2920 cases, 73 instructions).
- `test-translation-window-consistency.mjs` fails before the window fix and
  passes after it.
- `test-xenos-predication.mjs` fails before the predication fix and passes
  after it.

## Not done yet
- Interactive gameplay: in-game reached; movement under player control is
  being verified.
- WebGPU real-time renderer: only the shader pipeline is proven; draws,
  render targets, textures and resolves are not implemented. Frames come
  from the CPU software renderer.
- Audio: XMA decoding not implemented (XMA register window only).
