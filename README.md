# Render360 — Xenia-Web

**Release 58** · Experimental browser-native Xbox 360 emulator research project built around Xenia's PPC/HIR architecture, WebAssembly, sparse Xbox guest memory and WebGPU, with a separate PC Source/Portal WebAssembly bring-up path.

> Render360 is not claiming Xbox 360 commercial-game playability yet. A title is only promoted when a real user-supplied game continuously executes, produces real GPU work, presents title-produced frames, and accepts working input without synthetic frame substitution.

This README is the current public project status. Historical percentages and old screenshots are not compatibility ratings.

## Current status — September 7, 2026

Development over September 5–7 expanded Render360 beyond the earlier Braid-only status page. The repository now contains two active execution tracks:

```text
XBOX 360 / XENIA-WEB TRACK
STFS / CON PACKAGE INPUT                    WORKING FOUNDATION
XISO / XGD / XDVDFS ISO INPUT              WORKING FOUNDATION
RETAIL XEX PREPARATION                     WORKING FOUNDATION
XBOX PE SECTION MAPPING                    WORKING FOUNDATION
XENIA PPC SCANNER / HIR FRONTEND           WORKING FOUNDATION
WASM32 XENIA BOOTSTRAP                     WORKING FOUNDATION
SPARSE 32-BIT XBOX GUEST MEMORY            WORKING FOUNDATION
PPC CONTEXT / NESTED GUEST CALLS           ACTIVE BRING-UP
XBOXKRNL / XAM IMPORT PLAN                 WORKING FOUNDATION
GUEST THREAD / TLS FOUNDATION              IMPLEMENTED; SCHEDULER INCOMPLETE
XENOS PM4 / RING FOUNDATION                IMPLEMENTED; BRAID HAS NOT REACHED IT
VdSwap / XE_SWAP PATH                      CI-PROVEN FOUNDATION
XENOS SHADER -> SPIR-V                     CI-PROVEN FOUNDATION
SPIR-V -> WGSL / WEBGPU                    CI-PROVEN FOUNDATION
10 MiB WEBGPU EDRAM MIRROR                 IMPLEMENTED FOUNDATION
REAL XBOX COMMERCIAL-TITLE FIRST FRAME     NOT YET VERIFIED
XBOX COMMERCIAL GAMEPLAY                   NOT YET VERIFIED

PC SOURCE / PORTAL TRACK
PORTAL RETAIL FILE DISCOVERY               IMPLEMENTED
PORTAL SOURCE WASM PACKAGE ADAPTER         IMPLEMENTED
DEDICATED SOURCE WORKER                    IMPLEMENTED
WORKERFS RETAIL CONTENT MOUNT              VERIFIED ON IPHONE
SOURCE ENGINE CALLMAIN ENTRY               REACHED
SOURCE FILESYSTEM MODULE LOAD              CURRENT BRING-UP BOUNDARY
PORTAL GAMEPLAY / RENDERED FRAME           NOT YET VERIFIED
```

The important September 7 change is that Portal is no longer being diagnosed as if it were an Xbox/PPC title. Real-device diagnostics showed the PC Source runtime entering its own engine path, mounting the supplied retail content and reaching Source subsystem initialization. The current Portal investigation is therefore a Source/Emscripten dynamic-module problem, separate from Braid's Xenia PPC/HIR bring-up.

### September 7 Portal real-device evidence

The latest useful iPhone report reached:

```text
page.appState:       RUNNING
cpu.runtimeBoundary: portal-source-wasm-running
Portal files:        1485 mounted into WORKERFS
Source base.cpp:     SetErrorMode assertion observed
Source filesystem:   SetErrorMode assertion observed
Sys_LoadModule:      libfilesystem_stdio.so
```

The old report also contained empty PPC-style fields such as `pc=0`, `lr=0` and a `native-hir-unsupported-boundary` focus. Those fields were misleading for a PC Source title; there was no measured Xbox guest-memory fault behind them.

The Source worker was consequently hardened so a real worker exception, rejected dynamic-library promise, Emscripten abort or `callMain()` failure carries its origin, stack and last Source log line back into Render360 diagnostics. The worker now emits an explicit `portal-source-callmain` stage immediately before entering the Source engine.

Current baseline commit after the September 7 rollback:

```text
7d463f0163de9d71bf427017cf19ad66337f4707
Improve Portal Source worker fault diagnostics
```

This is intentionally the baseline immediately before the later storage-cleanup / delete-all sequence. Those later storage experiments and subsequent iPhone startup experiments are not part of the current `main` baseline.

## Current Braid CPU bring-up — V58 hardened shared-epilog runtime

The September 5 iPhone measurement that identified the Braid blocker used this generated bootstrap:

```text
sourceCommit: 525a1ac43370ca9b8d357ec3d7c8a3dfd3f7dda0
sourceRun:    33958433624
wasm sha256:  0bd12e1d545514ef6e258e38f0efc72bde21990772d5bebf6afab255cc9745d9

entry:        0x8236EF38
HIR:          340
executed:     17 instructions
blocker:      HIR guest-memory dependency (opcode 37)
PPC:          0x8234F5AC / 0xEBA1FFE0
operation:    ld r29,-32(r1)
caller r1:    0x70080EF0
call:         0x8236C7CC -> 0x8234F5AC
call flags:   0x2 (CALL_TAIL)
kernel calls: 0
GPU:          ring-not-initialized
```

The frame evidence is strong: `0x8236C6E8` allocates `-0x70`, `0x8236C7C8` restores `+0x70`, and the next instruction is the tail branch into the shared restore sequence at `0x8234F5AC`. The zero-address diagnostic is not a real sparse-memory fault; the compatibility executor reached an unsupported HIR memory boundary before performing an authoritative sparse-memory access.

### V58 fix: execute shared epilog helpers on the live PPC context

V58 keeps ordinary linked calls on their exact ABI targets and keeps `.pdata` owner/interior routing for genuine compiler-generated tail fragments. For `CALL_TAIL` targets, Render360 accepts either Xenia `Function::Behavior::kEpilogReturn` metadata or a strict canonical `__restgprlr_N` PPC signature. This matters for Braid's interior label `0x8234F5AC`, which may not be registered as a standalone function even though its instruction stream is the canonical shared restore helper.

The helper bridge:

```text
CALL_TAIL -> kEpilogReturn metadata OR strict __restgprlr_N signature
        ↓
validate every ld rN..r31 slot and exact helper tail
        ↓
restore rN..r31 from authoritative sparse guest memory using live r1
        ↓
restore LR using canonical lwz r12,-8(r1) 32-bit spill semantics
        ↓
complete the existing tail-call return boundary
```

The implementation remains fail-closed. It validates the complete helper signature when metadata is unavailable, reads only through `SparseGuestMemory`, and returns a real failure if code or stack data is unmapped. It does not map the upper guard, clamp `r1`, fabricate register values, or bypass unrelated memory faults.

The hardened source landed at:

```text
c0b6d9791b20fd9a404d8c6ce43d9ed4e8222d98
fix: execute Braid shared epilog on live PPC context
```

The V58 fastlane rebuilt, verified and published a browser bootstrap with this provenance:

```text
sourceCommit: 864ececa4a55277288f0812b6f7040fab37597cb
sourceRun:    33961264666
wasm sha256:  a981bdecc560431ba2ef54a1f07c55c53ab9d20760e38a4750846190b3474e36
bytes:        2545518
publish commit: 3d2b7277b666fbdea834559ad26285acbaf5d7e9
```

The fastlane verified the hardened V58 source contract, compiled and linked the Xenia WASM32 bootstrap, and passed the existing PE staging, CFG, generated-call/LOAD_OFFSET/XAM, scheduler, sparse direct-call, signed LOAD_OFFSET, title-entry LR ABI and deployed-runtime contract gates before publishing.

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

## Near-term engineering order — September 7

```text
PORTAL
1. test the current 7d463f0 baseline on the real iPhone
2. capture the new Source-aware diagnostic report
3. determine whether libfilesystem_stdio.so returns, rejects, traps or hangs
4. if needed, instrument the C++ Sys_LoadModule/dlopen boundary with before/after + dlerror evidence
5. keep Source failures out of Xenia/PPC blocker reporting
6. reach Source filesystem/engine initialization
7. reach the first genuine Portal-rendered frame

XBOX / BRAID
1. preserve the V58 PPC/HIR correctness work
2. obtain the next authoritative Braid real-device measurement
3. inspect only the next measured PPC/HIR blocker
4. reach the first real xboxkrnl/XAM HLE call
5. bring the guest scheduler online
6. reach Xenos ring initialization and PM4 traffic
7. reach VdSwap and the first genuine title frame
```

## Important files

- `recompiled/pc/portal/source-wasm/portal-source-worker.mjs` — dedicated Portal Source worker, retail mount, Source initialization and fault reporting.
- `recompiled/pc/portal/source-wasm/portal-package-adapter.mjs` — Portal runtime-package bridge.
- `recompiled/pc/portal/source-wasm/build-render360.sh` — Source/Emscripten build and Render360 integration patching.
- `runtime/pc-library-integration.js` — PC-title library/controller integration at the current pre-cleanup baseline.
- `storage/pc-persistent-storage.js` — PC persistent-source support at the current pre-delete-all baseline.
- `render360-title-controller.mjs` — extracted XEX title handoff and main-thread context setup.
- `src/xenia_web_bootstrap/ppc_translation_probe.cpp` — movable Xenia PPC decoder/scanner window and production probe ABI.
- `src/xenia_web_bootstrap/hir_correctness_executor.cpp` — base correctness executor source.
- `prepare-hir-call-return-stack-overlay.py` — nested call/return semantics, sparse-memory fail-closed behavior and stack provenance.
- `prepare-hir-return-metadata-v3-overlay.py` — return-token lifetime rules, Xenia entry LR state and V52 depth-1 return seeding plus V55-V58 tail/epilog routing.
- `src/xenia_web_bootstrap/probe_backend.cpp` — nested-call resolver and V58 live-context shared-epilog helper bridge.
- `tools/apply-xenia-epilog-inline-v58.py` — idempotent V58 shared-epilog source hardening patch.
- `src/xenia_web_bootstrap/sparse_guest_memory.cpp` — authoritative sparse Xbox virtual memory.
- `src/xenia_web_bootstrap/kernel_import_probe.cpp` — imported thunk / HLE boundary.
- `src/xenia_web_bootstrap/kernel_runtime_foundation.cpp` — browser kernel service foundation.
- `src/xenia_web_bootstrap/title_gpu_runtime.cpp` — title ring/MMIO/VdSwap runtime.
- `src/xenia_web_bootstrap/xenos_gpu_foundation.cpp` — Xenos PM4/resource/EDRAM state.
- `render360-webgpu-runtime.mjs` — browser WebGPU/eDRAM foundation.
- `WEBGPU_BROWSER_RUNTIME.md` — browser GPU/runtime architecture notes.
- `ROADMAP.md` — broader project milestones.

## Legal / project scope

Render360 does not include commercial Xbox 360 games, copyrighted title assets, keys or firmware. Use only content you are legally permitted to use. Xenia-derived portions remain subject to upstream Xenia licensing terms; see `LICENSE_XENIA.txt`.
