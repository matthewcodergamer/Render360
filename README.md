# Render360 — Xenia-Web

**Release 75** · Experimental browser-native Xbox 360 emulator research project built around Xenia's PPC/HIR architecture, WebAssembly, sparse Xbox guest memory and WebGPU, with a separate PC Source/Portal WebAssembly bring-up path.

> Render360 is not claiming Xbox 360 commercial-game playability yet. A title is only promoted when a real user-supplied game continuously executes, produces real GPU work, presents title-produced frames, and accepts working input without synthetic frame substitution.

This README is the current public project status. Historical percentages and old screenshots are not compatibility ratings.

## Current status — September 26, 2026

```text
XBOX 360 / XENIA-WEB TRACK
STFS / CON PACKAGE INPUT                    WORKING FOUNDATION
XISO / XGD / XDVDFS ISO INPUT              WORKING FOUNDATION
RETAIL XEX PREPARATION                     WORKING FOUNDATION
XBOX PE SECTION MAPPING                    WORKING FOUNDATION
XENIA PPC SCANNER / HIR FRONTEND           WORKING FOUNDATION
WASM32 XENIA BOOTSTRAP (-O2)               WORKING FOUNDATION
SPARSE 32-BIT XBOX GUEST MEMORY            WORKING FOUNDATION (page table)
PPC CONTEXT / NESTED GUEST CALLS           ACTIVE BRING-UP
XBOXKRNL / XAM STARTUP SERVICES            PORTED FROM XENIA; CI CRITICS
GUEST FILE SYSTEM (game:, d:, Cdrom0)      IMPLEMENTED; CI CRITICS
SAVE DATA (XamContent, save:)              IMPLEMENTED; KEPT PER SESSION
GUEST THREAD / TLS / KTHREAD / KPCR        IMPLEMENTED; SCHEDULER COOPERATIVE
THREADS THAT BLOCK AND RESUME              NOT YET (next CPU milestone)
XENOS PM4 / RING FOUNDATION                IMPLEMENTED; BRAID HAS NOT REACHED IT
VdSwap / XE_SWAP PATH                      CI-PROVEN FOUNDATION
XENOS SHADER -> SPIR-V -> WGSL / WEBGPU    CI-PROVEN FOUNDATION
REAL XBOX COMMERCIAL-TITLE FIRST FRAME     NOT YET VERIFIED
XBOX COMMERCIAL GAMEPLAY                   NOT YET VERIFIED

PC SOURCE / PORTAL TRACK                   UNCHANGED SINCE SEPTEMBER 7
WORKERFS RETAIL CONTENT MOUNT              VERIFIED ON IPHONE
SOURCE ENGINE CALLMAIN ENTRY               REACHED
SOURCE FILESYSTEM MODULE LOAD              CURRENT BRING-UP BOUNDARY
PORTAL GAMEPLAY / RENDERED FRAME           NOT YET VERIFIED
```

### Braid: where it stands

The last real-device Braid measurement (iPhone, V74) got past the V58 shared-epilog blocker, executed 38 HIR instructions from entry `0x8236EF38`, made five kernel calls and then called `xboxkrnl!HalReturnToFirmware` (ordinal `0x28`). That is the title deliberately giving up, not an emulator crash: Xenia implements the same export as process exit. It almost always means an earlier kernel call returned something the game did not accept.

V75 therefore replaces the placeholder kernel surface with a port of Xenia's own `xboxkrnl`/`xam` behaviour (see below). Braid has **not** been re-measured on a device with V75 yet. The next real-device run is the next authoritative data point; the browser now names the stop reason and lists the kernel calls behind it, so one run tells us exactly what to fix next.

### What changed in V75

- **Kernel services ported from Xenia** (`src/xenia_web_bootstrap/kernel_xboxkrnl_services.cpp`): XConfig settings, module handles and sections, system time, IRQL/spinlocks, events, semaphores, mutants, timers, single/multiple waits, thread creation with Xenia-shaped KTHREAD/KPCR/TLS, pool and physical memory, virtual-memory queries, Rtl strings/critical sections/SLists, NT status mapping, video-mode and display helpers, XAM user/sign-in/locale/input, XAudio render-driver clients and XMA contexts. Export tables are generated from Xenia's `xboxkrnl_table.inc`/`xam_table.inc` (`tools/generate-kernel-export-tables.py`).
- **More of Xenia's startup surface**: SHA-1/SHA-256/HMAC/RC4 crypto (checked against Node's crypto), `NtProtectVirtualMemory`, kernel stacks, `KeSetCurrentStackPointers`, profile settings with Xenia's default profile, locale, launch data, offline XNet/WSA startup, the XMA context register API, and real notification listeners that receive Xenia's startup notifications (sign-in changed, UI, input devices). Braid polls `XNotifyGetNext` during startup.
- **Save data**: `XamContentCreate`/`Open`/`Close`/`Delete`, enumeration, device queries and the headless device selector, backed by writable in-memory devices mounted at the title's root (for example `save:`). Saves last for the session; storing them in browser storage is still to do.
- **XBLA license**: a per-game setting (Trial by default, as in Xenia, or Full for a title you own) feeds `XamContentGetLicenseMask`.
- **Kernel variables** (`KeTimeStampBundle`, `XboxHardwareInfo`, `ExLoadedImageName`, `VdGpuClockInMHz`, ...) use Xenia's layout; anything unmapped gets Xenia's `D###BEEF` placeholder instead of zero.
- **Guest file system**: `game:`/`d:` resolve to `\Device\Cdrom0` over the user's ISO, package or folder, with `NtCreateFile`/`NtReadFile`/`NtQueryDirectoryFile` and friends. Large files are read on demand; a read the browser cannot satisfy synchronously stops at a named host-I/O boundary and is retried.
- **Named stop reasons**: title exit (`HalReturnToFirmware`, `XamLoaderTerminateTitle`, bug checks), blocking waits and unimplemented exports are reported by name in the "Game Stopped" sheet; **Diagnostics** shows the last stop with the recent kernel calls as `#n Name(args) -> result`.
- **CPU runtime speed**: the bootstrap is built at `-O2`, guest memory uses a flat two-level page table with host pointers, SSA values are indexed by Xenia's value ordinals, and per-call text tracing is off unless requested. Guest loop benchmarks improved roughly 1.5–1.75×.
- **UI**: fixed the iPhone profile sheet opening half off-screen, the laptop header margin, the truncated status line and clipped settings values.
- **Release lanes** (runtime, title runtime, content bridge, package core, service worker) all agree on V75; the fastlane republishes the browser bootstrap as V75 on `main`.

### Running a title on a laptop

`tools/run-title.mjs` runs the same browser runtime headlessly in Node, straight from your own files, and prints why it stopped:

```text
node tools/run-title.mjs <game.iso | package (LIVE/PIRS/CON) | default.xex | extracted folder>
     [--bootstrap build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm]
     [--trace 64] [--json report.json] [--budget N] [--verbose] [--trace-calls]
```

The report names the stop (for example `title-requested-exit` via `HalReturnToFirmware`), the next kernel export that needs implementing, the recent kernel calls with arguments and results, and the title's `DbgPrint` output. Nothing is uploaded or copied. On an iPhone the same information is under **Game → Diagnostics** after a stop.

### The next CPU milestone: threads that wait

Every title that gets past its first seconds creates worker threads and blocks on events those threads signal. Today a blocking wait ends execution on both CPU tiers: the native HIR interpreter runs the main thread to its first blocker, and the generated-WASM tier can only yield between blocks of its top-level function, not from inside nested calls where waits actually happen. The browser has no native stack switching on Safari, so the plan is to make yields travel through guest calls in Render360's own WASM emitter (each call site becomes a resumable block and each guest thread keeps a stack of continuations), with Asyncify-style fibers for the interpreter as the fallback. Until that lands, the named "waiting in ..." stop is expected once a title blocks on another thread.

### iPhone 11 and GTA IV / GTA V, honestly

Braid (XBLA, 2D) is the right first target, followed by other XBLA and lighter retail titles. GTA IV and GTA V are not realistic in Safari on an iPhone 11: they need most of the Xbox 360's 512 MiB of RAM plus Render360's own overhead inside a Safari tab limited to roughly 1–1.5 GB, three 3.2 GHz PowerPC hardware threads with heavy VMX128 vector code (WebAssembly has no native JIT, only generated Wasm), and a GPU pipeline that even desktop Xenia struggles to run at speed. Growable WebAssembly memory keeps Render360 from reserving that memory up front, but it cannot make it appear.

## Browser execution architecture

### Xbox 360 / Xenia-Web

```text
lawfully obtained Xbox 360 package / ISO
        ↓
STFS or XDVDFS reader
        ↓
default.xex
        ↓
XEX2 preparation / AES / LZX
        ↓
Xbox PE mapping
        ↓
sparse 32-bit guest memory
        ↓
Xenia PPC scanner + HIR frontend
        ↓
Render360 Wasm / HIR execution path
        ↓
xboxkrnl + XAM HLE imports
        ↓
Xenos ring / PM4
        ↓
shader translation + EDRAM
        ↓
WebGPU
        ↓
real VdSwap-derived browser frame
```

### PC Source / Portal

```text
user-supplied Portal retail files
        ↓
Portal package adapter
        ↓
dedicated Source WebAssembly worker
        ↓
WORKERFS game-content mount
        ↓
Emscripten Source engine
        ↓
Source dynamic modules (.so / Wasm side modules)
        ↓
filesystem + engine subsystem initialization
        ↓
Source renderer / audio / input
        ↓
real Portal frame and gameplay
```

The PC Source route is independent of Xbox XEX/PPC emulation. A Portal Source failure must therefore remain in Portal/Source diagnostics instead of falling through to an unrelated Xenia CPU blocker.

## GPU foundation

The Xbox GPU work already includes title ring and `CP_RB_WPTR` tracking, PM4 decoding and persistent Xenos state, `VdSwap` / `XE_SWAP` presentation semantics, mapped-frontbuffer validation, Xenos shader capture, upstream Xenia Xenos -> SPIR-V translation, Naga SPIR-V -> WGSL conversion, WebGPU shader validation, a 10 MiB browser WebGPU eDRAM mirror, async pipeline caching and browser streaming foundations.

Those systems are not the measured Braid blocker because the last Braid real-device run had not reached GPU initialization. They are also separate from Portal's Source rendering path.

## Storage and browser constraints

Large Xbox ISO files must not be copied wholesale into Wasm RAM. Render360 uses bounded file/Blob reads and browser streaming infrastructure so multi-gigabyte media can remain outside the emulated 512 MiB Xbox address space.

Portal similarly uses browser-backed retail content rather than treating the whole installation as one giant Wasm-memory allocation. Browser storage quota is not the same thing as physical iPhone free storage, and Safari does not expose a trustworthy webpage API for exact remaining device flash capacity.

The current September 7 `main` baseline deliberately predates the later experimental **Delete All Games & Copies** / aggressive storage-cleanup sequence. Storage changes should be reintroduced only when they can be isolated from emulator and Source startup behavior.

## What “playable” will mean

An Xbox commercial title will only be marked playable after a real user-supplied copy demonstrates sustained PPC execution, required kernel/XAM services, runnable guest scheduling, continuous PM4/ring consumption, real title shader/resource handling, repeated title-produced frames and usable controls without synthetic substitution.

For Portal/PC Source, playable means the real Source engine initializes from the user's retail content, loads the required modules and maps, continuously renders genuine game frames, accepts controls and advances through gameplay without a synthetic replacement renderer.

## Near-term engineering order — September 26

```text
XBOX / BRAID
1. run Braid on the real device with V75 (XBLA License: Full) and read the named stop + kernel calls
2. implement or correct the kernel service that report points at (Xenia semantics)
3. make guest threads able to block and resume (yield through calls in the WASM emitter)
4. deliver the graphics interrupt (vblank / swap) to the title's callback
5. reach Xenos ring initialization, PM4 traffic, VdSwap and the first genuine title frame
6. persist save packages in browser storage; move emulation into a Web Worker

PORTAL
1. determine whether libfilesystem_stdio.so returns, rejects, traps or hangs
2. reach Source filesystem/engine initialization
3. reach the first genuine Portal-rendered frame
```

## Important files

- `src/xenia_web_bootstrap/kernel_xboxkrnl_services.cpp` — Xenia-ported xboxkrnl/XAM services, guest file system, terminal and wait boundaries.
- `src/xenia_web_bootstrap/kernel_runtime_foundation.cpp` — guest threads, TLS, handles and virtual memory.
- `src/xenia_web_bootstrap/kernel_import_probe.cpp` — imported thunk / HLE boundary and named kernel call trace.
- `src/xenia_web_bootstrap/kernel_export_ordinals.h`, `render360-kernel-export-names.mjs` — generated from Xenia's export tables.
- `render360-guest-vfs.mjs` — registers the user's ISO/package/folder as the guest disc.
- `tools/run-title.mjs` — headless title runner for laptop iteration.
- `render360-title-controller.mjs` — extracted XEX title handoff, main-thread context, kernel variables and boundary telemetry.
- `render360-browser-ppc-session.mjs`, `render360-browser-thread-scheduler.mjs` — generated-Wasm CPU session and cooperative guest scheduler.
- `src/xenia_web_bootstrap/sparse_guest_memory.cpp` — authoritative sparse Xbox virtual memory (two-level page table).
- `src/xenia_web_bootstrap/hir_correctness_executor.cpp` — base HIR compatibility executor.
- `src/xenia_web_bootstrap/probe_backend.cpp` — nested-call resolver and shared-epilog helper bridge.
- `src/xenia_web_bootstrap/title_gpu_runtime.cpp` — title ring/MMIO/VdSwap runtime.
- `src/xenia_web_bootstrap/xenos_gpu_foundation.cpp` — Xenos PM4/resource/EDRAM state.
- `render360-webgpu-runtime.mjs` — browser WebGPU/eDRAM foundation.
- `recompiled/pc/portal/source-wasm/` — Portal Source worker, package adapter and build.
- `docs/PROJECT_LAYOUT.md` — repository rules; `ROADMAP.md` — broader milestones.

## Legal / project scope

Render360 does not include commercial Xbox 360 games, copyrighted title assets, keys or firmware. Use only content you are legally permitted to use. Xenia-derived portions remain subject to upstream Xenia licensing terms; see `LICENSE_XENIA.txt`.
