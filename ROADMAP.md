# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.** Xenia is the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns the browser-native integration: WebAssembly, sparse memory, browser I/O/storage, workers, WebGPU, WebGL2 fallback, WebAudio, input and diagnostics.

The root `README.md` is the authoritative public status board.

## Promotion rule

Development order is implementation first, critic last:

1. define a bounded subsystem contract;
2. finish the implementation for that contract;
3. pass its implementation tests;
4. let a separate adversarial critic attack it;
5. replay every previously locked foundation;
6. only then promote to 100%.

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
Run 379  starter xboxkrnl/XAM services + guest threads/TLS/runtime in main wasm
```

**Run 379** is Actions ID `33236768472` on aggregate commit `a350df341289352326bfe188ce58460a17ce8414`. It is fully green.

Run 379 compiles the new kernel/runtime implementation into the same strict `xenia_ppc_bootstrap.wasm` used by the rest of Render360. Both independent critics run against that main wasm, and the complete older stack replays afterward.

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
REAL xboxkrnl / XAM STARTER SERVICES             100% ✓
INDEPENDENT KERNEL SERVICES HARSH CRITIC         100% ✓
GUEST THREADS / TLS / RUNTIME FOUNDATION         100% ✓
INDEPENDENT GUEST RUNTIME HARSH CRITIC           100% ✓
```

These are bounded first-frame contracts, not universal title-compatibility claims and not complete xboxkrnl/XAM API coverage.

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

## Gate D2B — minimum PPC ↔ kernel ABI — CLOSED

The ABI critic proves argument registers, guest-visible memory mutation, `r3` return semantics, caller continuation, boundary/wraparound rejection, recursive-target rejection and exact unsupported-import telemetry.

## Gate D2C — first-frame xboxkrnl / XAM starter services — CLOSED

The bounded service surface currently proves:

```text
xboxkrnl starter semantics
  KeQueryPerformanceFrequency
  RtlLowerChar
  RtlUpperChar
  KeTlsAlloc
  KeTlsFree
  KeTlsGetValue
  KeTlsSetValue

XAM starter semantics
  XGetLanguage

unknown module / ordinal
  → exact unsupported status
  → no blanket-success fallback
```

Additional APIs remain title-specific blockers when reached.

## Gate D2D — guest threads / TLS / runtime foundation — CLOSED

The bounded runtime foundation proves:

```text
generation-tagged guest thread handles
thread creation + aligned stack metadata
current-thread switching
suspend / resume
termination + exit telemetry
stale-handle rejection
per-thread TLS isolation
TLS allocation / free / exhaustion
bounded cooperative runnable selection
```

This is the first-frame runtime foundation, not a claim that the entire Xbox scheduler/kernel object model is finished.

## Gate D3 — Xenos to first frame — ACTIVE

The primary development target is now the GPU boundary:

```text
guest PPC execution
        ↓
closed first-frame kernel/runtime foundation
        ↓
first Xenos packet / register traffic
        ↓
ringbuffer / command processor
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

The first-frame workload should be deliberately tiny: guest code that causes the emulated Xenos path to clear a target or draw a minimal primitive. Browser-side rendering that bypasses guest/Xenos semantics does not count.

The eventual first-frame critic must prove that the frame originates from guest GPU work and should remain permanently in CI.

## ISO / GOD input track

This does not block the first-frame synthetic guest workload, but it is the preferred future real-title input path:

```text
.iso
  → random-access XDVDFS mount
  → default.xex + game files

GOD / STFS
  → STFS/GOD mount
  → default.xex + game files

both
  → existing Render360 XEX / PE / PPC pipeline
```

Do not require ISO2GOD. Large disc images should remain browser `File`/`Blob` objects and be read by bounded ranges rather than copied whole into Wasm memory.

## Gate D4 — performance after correctness

Once a guest-produced frame exists, optimize from real traces: keep hot execution in Wasm, retain compiled-function caching/invalidation, use Wasm SIMD for VMX, minimize JS↔Wasm crossings, stream title data, use workers/shared queues where available, begin at low internal resolution, cache shaders/resources, and reduce EDRAM traffic.

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
minimum PPC ↔ kernel ABI                        ✓ LOCKED
first-frame xboxkrnl/XAM starter services       ✓ LOCKED BY HARSH CRITIC
guest threads/TLS/runtime foundation            ✓ LOCKED BY HARSH CRITIC
first Xenos packets                             ← ACTIVE
ringbuffer / command processor
first guest shader / draw
EDRAM / render target
FIRST GENUINE GUEST FRAME
performance / latency optimization
ISO/XDVDFS virtual mount
small homebrew / XBLA-class bring-up
Braid-class playable target
Portal-class bring-up
Portal 2-class bring-up
```

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS, shader translation or title boot unless that event came from genuine execution through the corresponding subsystem.
