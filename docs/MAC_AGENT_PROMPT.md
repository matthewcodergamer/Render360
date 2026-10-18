# Prompt for an AI agent working on the owner's MacBook

Copy everything below the line into the agent.

---

You are working on **Render360**, a Xbox 360 emulator that runs in the browser.
It is a port of the Xenia emulator to WebAssembly. You have access to the
owner's **2018 Intel MacBook Pro** and to their paired **iPhone 11**.

The project lives on an external drive whose name contains a space. Always
quote paths: `"/Volumes/EXTERNAL HD/..."`. Find the clone with
`ls "/Volumes/EXTERNAL HD"`. If none is there, clone it there:

```
git clone https://github.com/matthewcodergamer/Render360 "/Volumes/EXTERNAL HD/Render360"
git -C "/Volumes/EXTERNAL HD/Render360" checkout claude/xbox-360-emulator-optimization-74g72w
```

Work on branch **`claude/xbox-360-emulator-optimization-74g72w`** (open PR #19).
- Commit small, focused changes with clear messages.
- Push with `git push -u origin claude/xbox-360-emulator-optimization-74g72w`.
- Do not force-push. Do not rewrite history.

## Hard rules (from the owner, non-negotiable)

1. **Game files never go into any Git repository or GitHub release.** That
   covers ISOs, STFS/CON packages, decrypted XEX, extracted assets, GPU
   captures, and game-derived shaders or recompiled code. They live only on
   the Mac or the phone.
   - Add new game-file extensions to `.gitignore` before working with them.
   - Check `git status` before every commit.
2. **The owner's own legally dumped games only.**
3. **Keep the HIR interpreter** as the correctness fallback; never delete it.
4. **Port Xenia, don't imitate it.** When Xenia has code for something,
   reuse or port that code, citing the Xenia file and function in a comment.
5. **Fail closed, and report honest numbers.**
   - Never claim something works without having run it.
   - Report measured FPS, speed and memory, plus what is limiting them.
   - Don't hide a weak device behind a strong one: report each device
     separately.
6. Update `PROGRESS.md` and the PR description after each step.

## First task: lock down the test-games repository (do this before anything else)

`matthewcodergamer/render360-test-games` is **public**, and release `v1`
holds a Banjo-Tooie package (asset `ABB9CAB336175357D09F2D922735D23C62F90DDD58`).
The cloud agent was refused repository-settings writes. Using the owner's own
`gh` login on the Mac:

```
gh repo edit matthewcodergamer/render360-test-games --visibility private --accept-visibility-change-consequences
gh release view v1 -R matthewcodergamer/render360-test-games
gh release delete-asset v1 ABB9CAB336175357D09F2D922735D23C62F90DDD58 -R matthewcodergamer/render360-test-games --yes   # only after the owner has a local copy
```

Keep a local copy of the package on the Mac first. Ask the owner before
deleting the asset.

## How the project works today

### Core (C++ compiled to WebAssembly)

Directory `src/xenia_web_bootstrap/`, plus Xenia sources from
`upstream/xenia` patched by `prepare-*.py` overlay scripts at build time.

| File | What it does |
| --- | --- |
| `probe_backend.cpp` | Guest call resolver, translation cache (HIR builders + a compiled-only tier), tail-call trampoline (`TranslateNestedGuestAddress`) |
| `hir_correctness_executor.cpp` | The HIR **interpreter** (Xenia's PPC frontend → HIR → interpreted) |
| `hir_wasm_jit.cpp` + `hir_jit_glue.inc` | HIR → **WebAssembly JIT** (segment dispatcher, OSR, polls). Wasm-only |
| `guest_fibers.cpp` | Guest threads as cooperative fibers switched with **Emscripten Asyncify** (`#if defined(__wasm__)`). Wasm-only; the native build has no thread switching at all |
| `sparse_guest_memory.cpp` | Guest memory: page table, write watches for GPU invalidation |
| `kernel_xboxkrnl_services.cpp` | xboxkrnl/XAM kernel services ported from Xenia; interrupts, vblank, XMA register window (no audio decode yet) |
| `xenos_gpu_foundation.cpp` | PM4 command processor (ring buffer, draws, swaps) |
| `xenos_soft_renderer.cpp` | CPU software renderer (the frames the web player shows today) |
| `webgpu_backend.cpp/.h`, `webgpu_draws.cpp`, `webgpu_textures.cpp` | **WebGPU recorder**: a port of Xenia's Vulkan backend that records a command stream (ops 1–12 in `webgpu_backend.h`). Shaders come from Xenia's SPIR-V translator; Xenia's texture cache and its own `texture_load_*` / `resolve_*` compute shaders are used |

### JavaScript

| File | What it does |
| --- | --- |
| `render360-webgpu-backend.mjs` | Replays the recorded stream into WebGPU. Naga (`render360_spirv_wgsl*`) converts SPIR-V to WGSL |
| `render360-webgpu-play.mjs` | Browser play path, opt-in with `?gpu=xenos` |
| `render360-perf-overlay.mjs` | The 30 FPS bar overlay. Backtick toggles it; **L** downloads a JSON log with device info |
| `tools/run-title.mjs` | Headless runner (Node 22). The JSON report has a `perf` block |

### Build

`build-xenia-ppc-bootstrap.sh` then `link-xenia-ppc-bootstrap.sh`, with
emsdk sourced. Run `git -C upstream/xenia checkout -- .` before building,
because the overlays patch that tree. The output is
`build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm` (~3.9 MB).

### Tests

The tests are the `test-*.mjs` files at the repo root.

| Test | Covers |
| --- | --- |
| `test-perf-overlay.mjs` | Overlay statistics |
| `test-webgpu-shared-memory*.mjs` | WebGPU shared memory |
| `test-webgpu-replay-capture-browser.mjs` | Replays a **local** GPU capture in headless Chromium; skips without one |
| `test-guest-jit-osr.mjs` | JIT OSR |

Plus the PPC instruction suite and the JIT differential test.

### Status (honest)

- **Banjo-Tooie gameplay:** reaches controllable gameplay headlessly.
- **Wasm CPU:** ~660 guest MIPS on a fast x86 core. At the headless runner's
  deterministic clock (1 ns per instruction) real time is ~1000 MIPS, so the
  wasm CPU runs at roughly 65% of real time before graphics.
- **WebGPU renderer:** renders a correct Banjo main menu frame from a capture,
  through draws, textures, EDRAM resolves and clears.
- **Known renderer bug:** the resolved image is shifted 32 px right. Suspects
  are the window offset / resolve rectangle handling in `webgpu_draws.cpp`
  `Resolve()` and the EDRAM dump in `render360-webgpu-backend.mjs` `dumpEdram()`.
- **Known CPU bug:** at ~105B instructions the game stalls when two functions
  are JIT-compiled: `0x822398D8` (a table fixed-point loop) and `0x8227E6A0`
  (a thunk ending in a direct tail call `call.2`). The prime suspect is
  compiled tail calls interacting with the tail-call trampoline. The
  interpreter is correct.
- **Audio:** none (XMA decoding not implemented).

## Your task: Render360 as a native iOS app on the iPhone 11

**Why:** Safari kills the web tab for memory, so the browser version cannot
run Banjo on the phone.

### Step 0: measure what exists, on the Mac's own browsers (one hour, do it first)

Serve the repo locally, e.g. `python3 -m http.server 8080` from the repo
root; WebGPU needs localhost or https. Then open the player with
`?gpu=xenos` in Chrome and in Safari, load Banjo, and play for 5 minutes.
Press **L** to save the perf log. Report game FPS, 1% low, emulation speed
and interpreted %, for each browser separately.

### Step 1: native core (macOS first, then iOS arm64)

1. Add a CMake build, e.g. `native/CMakeLists.txt`, that compiles the same
   source set as `build-xenia-ppc-bootstrap.sh`, including the overlays
   produced by the `prepare-*.py` scripts, with clang for the host. Mirror
   the shell script's source list exactly. Don't hand-pick files.
2. Provide native replacements for the wasm-only pieces:
   - **Guest fibers:** replace Asyncify with one pthread per guest thread and
     a baton (mutex + condition variable), so exactly one guest thread runs
     at a time. That preserves today's cooperative scheduling and
     determinism. Keep the same API as `guest_fibers.h`.
     `swapcontext` is unavailable on iOS; don't use it.
   - **JIT:** compile `hir_wasm_jit.cpp` out (stub `JitEnabled()` to false).
     Native runs are **interpreter only** at first.
   - **WASI / `export_name` / host imports:** route the `r360_*` exports to a
     small C API header, e.g. `native/render360_core.h`, that the app calls.
3. Native headless runner (`native/run-title`): load a STFS/XEX from a path,
   run N billion instructions, write the same JSON report as
   `tools/run-title.mjs`. Verify on the Mac that Banjo reaches the same
   swap counts as the wasm build at the same instruction counts
   (deterministic mode). Report native MIPS, interpreter only, on the Mac.

### Step 2: the iOS app shell (`ios/`)

**Project and build**
- SwiftUI app with the core linked as a static library.
- Generate the Xcode project with XcodeGen (`ios/project.yml`) so it's
  reviewable in git.
- **No WKWebView for the emulator.**
- If the Mac's Xcode can't build for the iPhone, add a GitHub Actions
  workflow on `macos-latest`. It builds the unsigned app and uploads it as an
  artifact: never game files, never signed builds with credentials.
- Signing happens on the Mac with the owner's **free Apple ID**:
  - Builds expire after 7 days.
  - Add an in-app reminder showing the days left, read from
    `embedded.mobileprovision`.

**Entitlements**
- `com.apple.developer.kernel.increased-memory-limit` and
  `com.apple.developer.kernel.extended-virtual-addressing`.
- **Verify which ones a free (non-paid) account can actually use.**
  Extended Virtual Addressing may need the paid program. Report what works;
  don't assume.

**Graphics**

| Option | How | Tradeoff |
| --- | --- | --- |
| **(a) wgpu-native**, preferred to start | Port `render360-webgpu-backend.mjs` to C++ against wgpu-native's `webgpu.h` | wgpu accepts SPIR-V directly, so Xenia's shaders need no Naga step, and push constants are a native wgpu feature, so Xenia's load and resolve shaders can use them unmodified. The renderer logic stays shared with the web version |
| **(b) Metal directly** | Reuse the owner's GTA V port lessons | Faster at the end, more work |

Whichever you choose, carry over:
- **ASTC** for BC textures, with a self-test at startup that compares against
  a decoded reference. Today's web path decompresses BC to RGBA8, which uses
  4–8× the memory.
- **RG/RGBA16F** for 32-bit float textures that must filter.
- A **memory guard**: watch `os_proc_available_memory()`, shrink caches
  before iOS kills the app, and log it.

**CPU and JIT**
- Ship the interpreter, plus a **persistent translation cache** on disk:
  keep translated HIR or a lighter form so a function is translated once,
  ever.
- Add an optional JIT mode that turns on only when the process can map
  executable memory:
  - Detect it at startup by trying `mmap` with `MAP_JIT` / a dual mapping
    and executing a tiny stub.
  - It works with StikDebug on a sideloaded build.
- **No arm64 JIT backend exists yet** (Xenia only has x64). Treat the JIT
  mode as a later project and report the interpreter speed honestly.

**Telemetry, overlay and controls** (as in the owner's GTA port)
- An HTTP `/status` endpoint on the phone that the Mac can poll over Wi-Fi.
  JSON: FPS, emulation speed, MIPS, interpreted %, memory in use, available
  memory, thermal state.
- Crash breadcrumbs written to a file that survives restarts.
- A **30 FPS cap**.
- MFi / Xbox / PlayStation controllers via `GameController.framework`.
- On-screen touch controls.
- Same overlay fields as `render360-perf-overlay.mjs`.

### Step 3: game import (never in any repo)

- An in-app **Import game** with three sources:
  - the Files app (document picker);
  - AirDrop (open-in);
  - a download from the Mac over Wi-Fi.
- Write `tools/serve-games.py` for the Mac side. It serves a folder over
  HTTP with **Range** support, and the app resumes interrupted downloads.
- Store games in the app's `Documents/Games/`, with
  `isExcludedFromBackup = true` on each file so they are excluded from
  iCloud backup.
- **Multi-disc** titles: group discs under one game entry and let the core's
  VFS swap discs. Watch Dogs has two discs.

### Step 4: tests on the iPhone 11 (report each separately)

1. **Banjo-Tooie:** boot to gameplay. Report:
   - FPS, 1% low, emulation speed %, interpreted %;
   - peak memory and available memory;
   - thermal state after 10 minutes;
   - time to reach gameplay.

   If it isn't real time (expected with interpreter only), say by how much
   and what limits it: CPU, GPU or memory.
2. **Watch Dogs, record mode:** boot as far as it goes, recording every guest
   function entry and indirect-branch target. Export a **ReXGlue manifest**
   for the owner's native recompile.
   - Check ReXGlue's actual expected input format first. Don't invent one.
   - The manifest is game-derived: keep it on the Mac. Do not commit it.

### Step 5: documentation

Write `docs/IOS_APP.md` covering:
- building, on the Mac and in CI;
- signing with a free Apple ID;
- installing on the paired iPhone;
- the 7-day re-sign;
- importing games;
- the telemetry endpoint;
- known limits.

Commit everything except game data and push to the branch above.

## The 30 FPS bar (definition of done for any game)

A game counts as supported only when it holds this bar:

| Requirement | Threshold |
| --- | --- |
| Average FPS | ≥ 30 |
| 1% low | ≥ 25 |
| Emulation speed | ≥ 100% |
| Stutters (frames over 50 ms) | no more than one per minute |
| Audio | in sync |

- Devices, reported separately: desktop Chrome, the 2018 MBP, the iPhone 11.
- Ladder: Banjo-Tooie → another Arcade title → a light retail game → a
  mid-weight game → GTA IV → Watch Dogs.
- Move to the next game only after the current one passes on desktop.

## How to report back

After each step, add to `PROGRESS.md`:
- what you ran (exact commands);
- the measured numbers;
- what broke, and what you'd do next.

Never report a step as done that you haven't run on the real device.
