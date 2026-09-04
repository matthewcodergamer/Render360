# Render360 — Xenia-Web

**Experimental browser-native Xbox 360 emulator research project built around Xenia's PPC/HIR architecture, WebAssembly, sparse Xbox guest memory and WebGPU.**

> Render360 is not claiming commercial-game playability yet. A title is only promoted when a real user-supplied game continuously executes, produces real GPU work, presents title-produced frames, and accepts working input without synthetic frame substitution.

This README is the current public project status. Historical percentages and old screenshots are not compatibility ratings.

## Current status — September 4, 2026

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

The current work is deliberately focused on **correct CPU execution before GPU bring-up**. Braid still stops before the first kernel HLE call and before Xenos ring initialization, so mapping fake memory, returning fake kernel success, or drawing placeholder pixels would only hide the real blocker.

## Current Braid real-device blocker

The September 4 iPhone run using the verified bootstrap produced:

```text
sourceCommit: abb0043f16dc835b1dc2f108604153ab0e84e121
sourceRun:    33888716919
wasm sha256:  736deb034dd3720daeeffb3afc4f15bc7e6f237f7650c4bed6bf078a091f8e4e

entry:        0x8236EF38
HIR:          340
executed:     83 instructions
translated:   1 function
blocker:      HIR guest-memory dependency (opcode 37)
PPC:          0x8234F5A4 / 0xEB61FFD0
operation:    ld r27,-48(r1)
r1:           0x70081050
fault:        0x70081020 (unmapped)
initial r1:   0x70080F50
stack base:   0x70081000
last r1 write 0x8236EB78: 0x70080F50 -> 0x70081050
last call:    0x8236EB7C -> 0x8234F5A4 (__restgprlr_27 path)
kernel calls: 0
GPU:          ring-not-initialized
```

This is important because the fault is now attributed to the live PPC state rather than to a guessed address calculation. The load itself is valid PPC64 DS-form behavior; the problem is that execution reaches the restore helper with `r1` already moved above the Xbox stack high boundary.

### What has been ruled out

The main-thread stack geometry is not being widened or wrapped to hide the fault. Upstream Xenia creates a no-access upper guard at `stack_base`, so `0x70081020` must remain invalid.

Render360 also now mirrors both pieces of Xenia `Processor::Execute` title-entry state:

```text
ThreadState r1 = stack_base
Processor::Execute reserve = 64 + 112 bytes
Render360 initial r1 = stack_base - 176 = 0x70080F50
initial LR = 0xBCBCBCBC
```

The real-device run still produced the same 83-instruction blocker after the LR sentinel was added, which rules out a missing initial LR value as the complete explanation.

## September 4 CPU fix: seed the guest return token from Xenia's entry LR

The next correction is now in `main`.

Xenia does not use `0xBCBCBCBC` only as an architectural LR value. `Function::Call` also receives that value as the host-side expected guest return address. Render360's HIR compatibility executor previously initialized architectural LR correctly but left its own expected-return stack empty at depth 1.

That distinction matters for PowerPC control flow. A non-linking direct branch is lowered as `CALL_TAIL`, and a branch through LR is marked `CALL_POSSIBLE_RETURN`. If the top-level expected return is absent, a tail-call chain may accept a `bclr` as terminal without proving that its target is the real guest return address. That can end a guest slice too early and leave later shared EABI epilogue code with the wrong live stack state.

`prepare-hir-return-metadata-v3-overlay.py` now seeds depth 1 from the same non-zero initial LR used by Xenia:

```text
initial LR 0xBCBCBCBC
        ↓
expected guest return depth 1
        ↓
CALL_TAIL inherits the same return token
        ↓
CALL_POSSIBLE_RETURN must match it
```

The change is intentionally fail-closed. It does **not** clamp `r1`, map the upper guard, rewrite `0x70081020`, or pretend Braid has progressed. Synthetic fixtures that do not provide an initial LR keep the old test-compatible top-level behavior; production title execution supplies the Xenia sentinel and therefore gets strict return matching.

Current source commit for this surgery:

```text
010f1a064922298c3cf6e0ab7ceedf1ed56e76cf
fix: seed Xenia guest return token from entry LR
```

The next real-device Copy Report determines whether this changes the `0x8236ECA4 -> 0x8236EB74 -> __restgprlr_27` path. If the exact same stack transition remains, the next target is function-boundary / shared-epilogue classification rather than stack geometry.

## Why this matches upstream Xenia more closely

Render360 follows several upstream behaviors that are relevant to this blocker:

- a new PPC `ThreadState` starts with `r1 = stack_base`;
- `Processor::Execute` subtracts `64 + 112` bytes before the guest entry;
- `Processor::Execute` calls the guest function with `0xBCBCBCBC` as its return value/sentinel;
- linked PPC branches emit both `SET_RETURN_ADDRESS(cia + 4)` and an LR update;
- non-linking direct branches are lowered as tail calls;
- LR branches are possible returns, not unconditional returns;
- Xbox thread stacks have inaccessible guard pages below and above the usable stack;
- Xenia recognizes the Microsoft `__savegprlr_*` / `__restgprlr_*` families as special function behavior during normal XEX module setup.

The browser compatibility executor is being brought toward those semantics incrementally while keeping sparse guest memory authoritative.

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

Those systems are not the current Braid blocker because the title has not reached GPU initialization yet.

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
1. rebuild and publish the V52 return-token bootstrap
2. run Braid on the real iPhone and capture a new Copy Report
3. verify whether execution advances beyond 83 instructions
4. if it advances, implement only the next measured CPU/kernel blocker
5. if it does not, inspect Xenia function-boundary/shared-epilogue classification
6. reach the first real xboxkrnl/XAM HLE call
7. bring the guest scheduler online
8. reach Xenos ring initialization and PM4 traffic
9. reach VdSwap and present the first genuine Braid frame
10. only then move from first-frame bring-up to sustained gameplay
```

## Important files

- `render360-title-controller.mjs` — extracted XEX title handoff and main-thread context setup.
- `src/xenia_web_bootstrap/ppc_translation_probe.cpp` — movable Xenia PPC decoder/scanner window and production probe ABI.
- `src/xenia_web_bootstrap/hir_correctness_executor.cpp` — base correctness executor source.
- `prepare-hir-call-return-stack-overlay.py` — nested call/return semantics, sparse-memory fail-closed behavior and stack provenance.
- `prepare-hir-return-metadata-v3-overlay.py` — return-token lifetime rules, Xenia entry LR state and current V52 depth-1 return seeding.
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
