# Render360 — Xenia-Web

**Release 58** · Experimental browser-native Xbox 360 emulator research project built around Xenia's PPC/HIR architecture, WebAssembly, sparse Xbox guest memory and WebGPU.

> Render360 is not claiming commercial-game playability yet. A title is only promoted when a real user-supplied game continuously executes, produces real GPU work, presents title-produced frames, and accepts working input without synthetic frame substitution.

This README is the current public project status. Historical percentages and old screenshots are not compatibility ratings.

## Current status — September 5, 2026

Render360 now has the major browser foundations required to keep working toward a real Xbox 360 title frame:

```text
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
REAL COMMERCIAL-TITLE FIRST FRAME          NOT YET VERIFIED
COMMERCIAL GAMEPLAY                        NOT YET VERIFIED
```

The current work is deliberately focused on **correct CPU execution before GPU bring-up**. The last real-device Braid measurement stopped before the first kernel HLE call and before Xenos ring initialization, so mapping fake memory, returning fake kernel success, or drawing placeholder pixels would only hide the real blocker.

## Current Braid CPU bring-up — V58 hardened shared-epilog runtime

The September 5 iPhone measurement that identified the blocker used this older generated bootstrap:

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

V58 keeps ordinary linked calls on their exact ABI targets and keeps `.pdata` owner/interior routing for genuine compiler-generated tail fragments. For `CALL_TAIL` targets, Render360 now accepts either Xenia `Function::Behavior::kEpilogReturn` metadata or a strict canonical `__restgprlr_N` PPC signature. This matters for Braid's interior label `0x8234F5AC`, which may not be registered as a standalone function even though its instruction stream is the canonical shared restore helper.

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

The V58 fastlane then rebuilt, verified and published a new browser bootstrap. Current published provenance:

```text
sourceCommit: 864ececa4a55277288f0812b6f7040fab37597cb
sourceRun:    33961264666
wasm sha256:  a981bdecc560431ba2ef54a1f07c55c53ab9d20760e38a4750846190b3474e36
bytes:        2545518
publish commit: 3d2b7277b666fbdea834559ad26285acbaf5d7e9
```

The fastlane verified the hardened V58 source contract, compiled and linked the Xenia WASM32 bootstrap, and passed the existing PE staging, CFG, generated-call/LOAD_OFFSET/XAM, scheduler, sparse direct-call, signed LOAD_OFFSET, title-entry LR ABI and deployed-runtime contract gates before publishing.

### What remains ruled out

- The initial Xbox stack reservation is correct (`r1 = 0x70080F50`).
- The upper stack guard remains protected.
- The measured blocker has a matching `-0x70` allocation and `+0x70` teardown, so it is not the earlier missing-prologue case.
- No XAM/xboxkrnl HLE call had executed in the last real-device measurement.
- The Xenos ring remained downstream of the CPU blocker in that measurement.

The **next real-device Copy Report** is the actual V58 behavioral test. It should show `runtimeAsset.sourceCommit = 864ececa4a55277288f0812b6f7040fab37597cb` and `sourceRun = 33961264666`. The immediate success criterion is that `0x8234F5AC` is no longer reported as the 17-instruction guest-memory blocker; any later blocker should be treated as the next measured target rather than guessed around.

## Browser execution architecture

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

Render360 also has a title-specific **Recompiled WebAssembly** execution route in the architecture. That route is intended for ahead-of-time recompiled titles where a compatible build exists; it does not make an arbitrary imported Xbox 360 game automatically recompiled.

## GPU foundation

The GPU work already includes:

- title ring and `CP_RB_WPTR` tracking;
- PM4 decoding and persistent Xenos state;
- `VdSwap` / `XE_SWAP` presentation semantics;
- real mapped-frontbuffer snapshot validation;
- Xenos shader capture;
- upstream Xenia Xenos -> SPIR-V translation;
- Naga SPIR-V -> WGSL conversion;
- WebGPU shader module validation;
- a 10 MiB browser WebGPU eDRAM mirror;
- async pipeline caching;
- browser streaming foundations for large title data.

Those systems are not the current Braid blocker because the last real-device run had not reached GPU initialization yet.

## Storage and browser constraints

Large ISO files must not be copied wholesale into Wasm RAM. The project uses bounded file/Blob reads and browser streaming infrastructure so multi-gigabyte game media can remain outside the emulated 512 MiB Xbox address space.

Browser storage quota is not the same thing as physical iPhone free storage, and Safari does not expose a trustworthy API that returns the device's exact remaining flash capacity to a webpage. Render360 therefore treats browser quota estimates as browser-origin storage information, not as an iPhone-storage meter.

## What “playable” will mean

A commercial title will only be marked playable after a real user-supplied copy demonstrates, at minimum:

- sustained PPC execution;
- required kernel / XAM services;
- runnable guest-thread scheduling;
- continuous PM4/ring consumption;
- real title shader/resource handling;
- repeated title-produced frames;
- presentation without synthetic substitution;
- working controls and timing sufficient to interact with the game.

Audio, save data, networking and title-specific compatibility may remain separate follow-up ratings.

## Near-term engineering order

```text
1. run the newly published V58 bootstrap on the real iPhone
2. capture a new Copy Report with sourceRun 33961264666
3. verify execution advances beyond 0x8234F5AC / 17 instructions
4. inspect only the next measured PPC/HIR blocker
5. confirm later ordinary tail fragments still use .pdata owner/interior routing
6. reach the first real xboxkrnl/XAM HLE call
7. bring the guest scheduler online
8. reach Xenos ring initialization and PM4 traffic
9. reach VdSwap and the first genuine title frame
10. only then move from first-frame bring-up to sustained gameplay
```

## Important files

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
