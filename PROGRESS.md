# Render360 progress report

Branch: `claude/xbox-360-emulator-optimization-74g72w`. Test title: Banjo-Tooie (XBLA).

## Verified
- Banjo-Tooie boots and renders its loading screen ("Loading…") through the
  HIR executor and guest JIT. File loading finishes (`db360.textures.cmp`,
  ~50 MB, is read in full); 7 title threads run.
- CPU: guest JIT compiles Xenia HIR to WebAssembly. Headless speed is about
  540M guest instructions/s over Banjo's first 30B instructions (see Step 1).
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

## Verified: player control in gameplay
Continuing the same run: A clears the Bottles dialogue (116-120B), then the
left stick held forward (`--stick 122000:126000:0:1`) walks Banjo along the
path in Spiral Mountain: the camera follows him past Bottles (124B) and by
127B he has reached the boulder pit, which triggers the next dialogue.
Frames keep changing to the 127.5B instruction limit (3607 frames).

## Step 1: CPU speed (in progress)
Benchmark: Banjo-Tooie, first 30B guest instructions headless
(`run-title --max-minstr 30000 --render-from-minstr 999999 --deterministic
1000`), same container, Node 22. MIPS = guest instructions per second.

| Change | MIPS | Cache misses |
| --- | --- | --- |
| Baseline (start of step 1) | 274 | — |
| No per-call `PPCContext` zeroing | 355 | 19.6k |
| Native vector compares in the JIT | 347 | — |
| Flat executable-page generation table; guest function object only on a miss | 355 | 19.6k |
| Ring-buffer call/stack history (was a 32-entry shift per call); cached epilogue signature per tail target | 387 | 20.6k |
| Compiled-only tier: an evicted translation keeps its compiled code (when it holds no HIR pointers) and runs again without retranslating or recompiling | 503–543 | 2.7k |

What the profile showed: 74.5M guest calls in 30B instructions. The
translation cache (192 MiB of HIR) holds ~1000 functions, fewer than one
frame touches, so per-frame functions were evicted and retranslated and
recompiled 100+ times each. The JIT's function table only grows, so every
recompile also leaked a module. The compiled-only tier fixes both. Only
0.11% of instructions are interpreted (interior entries and cold code).
The cache budget is now checked against real arena bytes (Xenia's `Arena`
chunks), not an estimate. Wasm memory at 30B: 668 MiB.

Next: cut the per-call path (JIT → resolver → cache → executor → JIT), which
is now the largest cost.

## Not yet
- Speed: reaching gameplay takes ~1 hour headless with the software
  renderer; the browser needs the WebGPU renderer and faster CPU emulation
  to be playable in real time.
- Audio: XMA decoding (Xenia uses FFmpeg's XMA/WMA Pro decoder).
- Banjo's model looks small and partly fragmented in some frames.

## Tests (latest build)
- Regression runner: 61 of 70 pass. The 9 failures are pre-existing
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
- Interactive gameplay: reached and controllable headlessly; not yet at a
  playable speed in the browser.
- WebGPU real-time renderer: only the shader pipeline is proven; draws,
  render targets, textures and resolves are not implemented. Frames come
  from the CPU software renderer.
- Audio: XMA decoding not implemented (XMA register window only).
