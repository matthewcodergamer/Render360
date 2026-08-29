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
```

**Run 338** is Actions ID `33227956792` on aggregate commit `ffee353216d248618d6bb30781a0dbe724046cfa`. It is fully green and closes ordinary retail XEX image preparation. Encryption type 1 is now chained through Xenia-compatible session-key derivation and streaming AES-CBC before NONE, BASIC or NORMAL preparation. NORMAL continues through upstream Xenia LZX. DELTA remains a separate patch-image feature and stays fail closed.

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
```

These are defined CI contracts, not universal title-compatibility claims.

## Gate D1 — one-call genuine extracted-title handoff — ACTIVE

The next milestone is no longer another format primitive. It is one runtime controller around user-supplied title content:

```text
STFS package / default.xex
   ↓
full extraction
   ↓
XEX2 metadata / route selection
   ↓
retail image preparation (NONE / BASIC / NORMAL, encrypted or plain)
   ↓
strict PE image decode
   ↓
prepared PE section loader
   ↓
SparseGuestMemory RX / R / RW mappings
   ↓
genuine decoded entry PC
   ↓
initial PPCContext
   ↓
Xenia scanner → frontend → finalized HIR
   ↓
Hot WasmBackend cache / dispatch
   ↓
execute genuine title instructions
   ↓
FIRST_RUNTIME_BLOCKER=<exact unresolved dependency>
```

### D1 critic requirements

- runtime input must provide the package/default.xex bytes; no copyrighted title fixture is committed;
- format routing must come from decoded XEX metadata;
- entry PC, section bytes, addresses and permissions must come from decoded title metadata;
- prepared bytes must survive PE mapping unchanged;
- initial PPCContext must be created from the actual title handoff rather than a probe-only constant;
- first unsupported runtime dependency must fail closed and be named exactly.

## Gate D2 — minimum kernel/runtime selected by real failure

Only implement what genuine execution reaches:

```text
xboxkrnl import       → minimum required HLE/export
XAM import            → minimum required XAM surface
TLS                    → TLS initialization
thread creation       → KernelState / guest threads
heap / virtual memory → required memory services
filesystem            → browser-backed VFS
GPU initialization    → Xenos command/ringbuffer path
```

No blanket success stubs.

## Gate D3 — Xenos to first frame

```text
guest PPC execution
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
one-call extracted-title controller             ← ACTIVE
actual extracted title → first instructions
first genuine kernel/runtime blocker
minimum xboxkrnl / XAM / TLS / threads
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
