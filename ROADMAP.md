# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.** Xenia is the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns the browser-native integration: WebAssembly, sparse memory, browser I/O/storage, workers, WebGPU, WebGL2 fallback, WebAudio, input and diagnostics.

The root `README.md` is the authoritative public status board.

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
```

**Run 369** is Actions ID `33232933395` on aggregate commit `2c190baaa129b97f66ddfcbf6a4b4e3c75d8f8ed`. It is fully green and closes the controlled **kernel execution foundation**.

The aggregate critic proves XEX import-library decoding, guest VA→RVA→PE section→raw-offset mapping, import descriptor/function-thunk pairing, automatic kernel-thunk registration, PPC→kernel HLE dispatch, implemented-return continuation, exact unimplemented module/ordinal blocker telemetry and fail-closed behavior.

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

## Gate D2B — minimum kernel ABI + services — ACTIVE

The next work is no longer import discovery. It is real ABI behavior and the minimum service surface required by execution:

```text
PPC argument registers / guest pointers
        ↓
HLE export implementation
        ↓
r3 / NTSTATUS / return-value semantics
        ↓
validated guest memory reads/writes
        ↓
return to translated guest PPC
        ↓
continue until next exact blocker
```

### D2B closure requirements

- integer/status return values flow back through the PPC ABI rather than a side channel;
- arguments are read from the correct PPC GPR/FPR/vector ABI locations for the implemented export;
- guest pointers and lengths are validated against mapped sparse memory before access;
- unsupported exports remain exact module/ordinal blockers;
- implemented exports must not bypass or replace the normal guest return path;
- the critic must prove at least one implemented export mutates/returns guest-visible state and execution continues afterward.

After this ABI gate, implement only what genuine execution reaches:

```text
xboxkrnl import       → minimum required HLE/export
XAM import            → minimum required XAM surface
TLS                    → TLS initialization
thread creation       → KernelState / guest threads
heap / virtual memory → required memory services
filesystem            → browser-backed VFS
GPU initialization    → Xenos command/ringbuffer path
```

## Gate D3 — Xenos to first frame

```text
guest PPC execution
        ↓
minimum kernel/runtime services
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

`FIRST GENUINE FRAME` is promoted only when a frame originates from guest GPU work.

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
minimum kernel ABI / first services             ← ACTIVE
actual extracted title → first real blocker
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
