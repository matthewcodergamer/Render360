# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.** Xenia is the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns the browser-native integration: WebAssembly, sparse memory, browser I/O/storage, workers, WebGPU, WebGL2 fallback, WebAudio, input and diagnostics.

The root `README.md` is the authoritative public status board.

## Promotion rule

No subsystem reaches 100% from its implementation test alone. Promotion requires all three:

1. the implementation gate is green;
2. an independent adversarial critic proves the exact contract and fail-closed cases;
3. the full locked regression replay remains green.

A red critic or red aggregate replay blocks promotion even when the happy path passes.

## Verified closure ladder

```text
Run 254  eight CPU/browser foundations
Run 261  strict XEX guest mapper
Run 265  full default.xex STFS extraction
Run 276  XEX2 metadata + decoded mapper integration
Run 282  NONE/NONE preparation
Run 288  BASIC preparation
Run 294  NORMAL framing/deblocking
Run 299  upstream Xenia LZX in wasm32
Run 303  XEX session-key / AES-CBC foundation
Run 315  prepared NORMAL image → relocated guest entry → Xenia PPC/HIR
Run 321  strict Xbox PE image decoder
Run 328  prepared PE image → SparseGuestMemory → decoder-derived entry
Run 335  prepared PE entry → mapped guest bytes → Xenia PPC/HIR
Run 338  encrypted retail NONE/BASIC/NORMAL → exact prepared image
Run 348  entry execution + first runtime-boundary telemetry
Run 369  XEX imports → real PE RVA mapping → kernel HLE execution bridge
Run 373  independent harsh critic → PPC/kernel ABI + guest state + continuation
```

**Run 373** is Actions ID `33235084799` on aggregate commit `2a860d2aacc0e21a1d9fcda39d46d8df99c79e8a`. It is fully green and closes the controlled **minimum PPC↔kernel ABI contract**.

The independent critic proves PPC argument registers, guest-visible memory mutation, `r3` return semantics, continuation after HLE return, cross-boundary range rejection, 32-bit wraparound rejection, recursive-target rejection, exact unsupported-import telemetry and no blanket-success behavior. The same run then replays every previously locked Xenia/Wasm foundation successfully.

## Closed V36 contracts

```text
CPU / WASM / MEMORY FOUNDATIONS                  100% ✓
PACKAGE / STFS / XEX FOUNDATION                  100% ✓
XEX2 METADATA + GUEST MAPPER                     100% ✓
NONE / BASIC / NORMAL PREPARATION                100% ✓
UPSTREAM XENIA LZX WASM                          100% ✓
XEX SESSION-KEY / AES-CBC                        100% ✓
FULL RETAIL XEX IMAGE PREPARATION                100% ✓
STRICT XBOX PE IMAGE DECODER                     100% ✓
PREPARED PE IMAGE → GUEST MEMORY                 100% ✓
PREPARED PE ENTRY → XENIA PPC / HIR              100% ✓
ONE-CALL default.xex → XENIA ENTRY               100% ✓
ONE-CALL STFS PACKAGE → XENIA ENTRY              100% ✓
ENTRY EXECUTION / RUNTIME BOUNDARY               100% ✓
XEX IMPORT LIBRARY DISCOVERY                     100% ✓
KERNEL IMPORT DESCRIPTOR / THUNK PAIRING         100% ✓
PPC → KERNEL HLE DISPATCH                        100% ✓
AUTOMATIC XEX IMPORT → KERNEL EXECUTION          100% ✓
KERNEL EXECUTION FOUNDATION                      100% ✓
MINIMUM PPC ↔ KERNEL ABI                         100% ✓
INDEPENDENT KERNEL ABI HARSH CRITIC              100% ✓
```

These are defined CI contracts, not universal title-compatibility claims and not complete xboxkrnl/XAM API coverage.

## Gate D1 — one-call extracted-title handoff — CLOSED

```text
STFS package / default.xex
   ↓
full extraction
   ↓
XEX2 metadata / route selection
   ↓
retail image preparation
   ↓
strict PE decode
   ↓
SparseGuestMemory mappings
   ↓
decoded entry PC
   ↓
Xenia scanner → frontend → finalized HIR
   ↓
controlled execution
   ↓
exact runtime boundary telemetry
```

The controlled path is CI-closed. Genuine title testing still requires legally obtained user-supplied runtime content and must not be inferred from synthetic critics.

## Gate D2A — kernel import/execution bridge — CLOSED

```text
XEX import table
   ↓
module + ordinal records
   ↓
guest VA → RVA → PE-backed bytes
   ↓
descriptor + function thunk pairing
   ↓
automatic HLE registration
   ↓
translated PPC reaches thunk
   ↓
implemented export → return and continue
unimplemented export → exact fail-closed blocker
```

No blanket success stubs.

## Gate D2B — minimum PPC ↔ kernel ABI — CLOSED

```text
PPC r3/r4 arguments
        ↓
registered HLE thunk
        ↓
nested service on the same live PPCContext
        ↓
validated guest memory access
        ↓
guest-visible state mutation
        ↓
r3 return value
        ↓
return to translated guest PPC
        ↓
caller continues
```

The independent harsh critic separately verifies boundary crossing, 32-bit address wraparound, recursive ABI targets and unsupported imports all fail closed. D2B is promoted only because Run 373 passed both that critic and the complete regression replay.

## Gate D2C — first real xboxkrnl / XAM services — ACTIVE

Do not pre-build a giant guessed API catalog. Genuine execution chooses the order. For each reached import:

```text
exact module + ordinal blocker
        ↓
identify corresponding Xenia kernel/XAM semantic source
        ↓
implement minimum browser-portable behavior
        ↓
validate all guest pointers/ranges
        ↓
return exact r3 / NTSTATUS / guest-visible state
        ↓
continue real guest execution
        ↓
record next blocker
        ↓
independent critic + full replay before 100%
```

Expected runtime classes, only when demanded by execution:

```text
thread/TLS             → KernelState / guest thread startup
heap / virtual memory  → required memory APIs
synchronization/time   → events, waits, timers as reached
filesystem             → browser-backed VFS
XAM startup            → minimum XAM exports actually imported
GPU initialization     → handoff into Xenos command/ringbuffer path
```

A service family does not become 100% merely because one export works. Its critic must define and prove the exact promoted scope.

## Gate D3 — Xenos to first frame

```text
guest PPC execution
        ↓
minimum real kernel/runtime services
        ↓
Xenos packets / ringbuffer
        ↓
command processor
        ↓
shared Xenos semantic layer
        ↓
register / shader / resource semantics
        ↓
EDRAM / render targets
        ↓
WebGPU / WGSL primary
        ↓
WebGL2 fallback where practical
        ↓
FIRST GENUINE GUEST-PRODUCED FRAMEBUFFER
```

`FIRST GENUINE FRAME` is promoted only when a frame originates from guest GPU work. The first-frame critic should compare deterministic guest-produced output/state and remain permanently in CI.

## Gate D4 — performance after correctness

Keep hot execution inside Wasm, retain compiled-function caching/invalidation, use Wasm SIMD for VMX, minimize JS↔Wasm crossings, stream title data, use workers/shared queues where available, start at low internal resolution, then build shader/resource caches and optimize Xenos/EDRAM traffic from real traces.

## Compatibility ladder

```text
CPU/browser foundations                         ✓ LOCKED
STFS + XEX metadata                             ✓ LOCKED
retail NONE/BASIC/NORMAL preparation            ✓ LOCKED
strict PE decode + guest mapping                ✓ LOCKED
prepared PE entry → Xenia PPC/HIR               ✓ LOCKED
one-call extracted-title controller             ✓ LOCKED
entry execution/runtime boundary                ✓ LOCKED
XEX import discovery + thunk pairing            ✓ LOCKED
PPC → kernel HLE execution bridge               ✓ LOCKED
minimum PPC ↔ kernel ABI                        ✓ LOCKED BY HARSH CRITIC
first real xboxkrnl/XAM services                ← ACTIVE
actual extracted title → next real blocker
TLS / threads / heap / VFS as required
first Xenos packets
first guest shader / draw
FIRST GENUINE GUEST FRAME
performance / latency optimization
small homebrew / XBLA-class bring-up
Braid-class playable target
Portal-class bring-up
Portal 2-class bring-up
```

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS, shader translation or title boot unless that event came from genuine execution through the corresponding subsystem.
