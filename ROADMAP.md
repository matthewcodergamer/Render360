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
```

**Run 328** is Actions ID `33227084124` on aggregate commit `7383622e60d77c16b3fb6435411ce03847cc0aec`. It is fully green. Run 326 exposed that mapper reset erased staged prepared-image bytes; commit `01f081fd5b72c48ab24d94c9525e71b6505da644` corrected reset semantics without weakening the critic. The aggregate run compiled **79/79 wasm32 units**, strict-linked and replayed all locked foundations.

## Closed V36 contracts

```text
PACKAGE / XEX FOUNDATION                         100% ✓
PPC TRANSLATION FOUNDATION                       100% ✓
SCALAR PPC FOUNDATION                            100% ✓
GUEST CONTROL FOUNDATION                         100% ✓
FPU FOUNDATION                                   100% ✓
VMX / VMX128 FOUNDATION                          100% ✓
HOT WASMBACKEND FOUNDATION                       100% ✓
SPARSE XBOX MEMORY FOUNDATION                    100% ✓
V36 STRICT XEX GUEST MAPPER                      100% ✓
FULL default.xex STFS EXTRACTION                 100% ✓
XEX2 IMAGE METADATA DECODE                       100% ✓
DECODED METADATA → MAPPER                        100% ✓
NONE/NONE PREPARATION                            100% ✓
BASIC PREPARATION                                100% ✓
NORMAL FRAMING                                   100% ✓
UPSTREAM XENIA LZX WASM                          100% ✓
XEX SESSION-KEY / AES-CBC FOUNDATION             100% ✓
UNENCRYPTED NORMAL PREPARED-ENTRY PIPELINE       100% ✓
STRICT XBOX PE IMAGE DECODER                     100% ✓
PREPARED PE IMAGE → GUEST MEMORY                 100% ✓
```

These are defined CI contracts, not universal title-compatibility claims.

## Gate D0 — finish image preparation edge cases

Already proven: NONE, BASIC, NORMAL framing, upstream LZX, standalone XEX session-key/AES-CBC, unencrypted NORMAL prepared-entry execution, strict Xbox PE decoding and prepared PE section mapping.

Still open:

```text
combined encrypted retail NORMAL preparation     pending
DELTA / patch images                              fail closed / pending
```

Do not block the rest of title bring-up on DELTA unless a target actually requires it. Unsupported formats must fail closed.

## Gate D1 — genuine extracted-title handoff — ACTIVE

The next meaningful milestone consumes actual user-supplied title content rather than another synthetic CPU program:

```text
STFS package / default.xex
   ↓
full extraction
   ↓
XEX2 metadata / format selection
   ↓
verified image preparation
   ↓
strict PE image decode
   ↓
prepared PE section loader
   ↓
decoder-derived SparseGuestMemory mappings
   ↓
final RX / R / RW permissions
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

The title bytes are runtime input and are not committed to this repository.

### D1 critic requirements

- Entry PC must come from the decoded title, not a hard-coded probe constant.
- Section bytes must come from the prepared image.
- Mapping addresses and permissions must come from decoded PE/XEX metadata.
- PE virtual tails must remain zero-filled.
- Overlap, range wrap, malformed PE/section metadata and entry-outside-executable-region must fail closed.
- Execution must report a concrete first missing runtime dependency rather than return generic success.

The prepared-image mapping portion of D1 is now closed by Run 328. The active work is the **runtime handoff around user-supplied extracted title content and initial PPCContext**.

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

`FIRST GENUINE FRAME` is promoted only when a frame originates from guest GPU work. A JavaScript/WebGPU test triangle alone does not satisfy this contract.

## Gate D4 — performance after correctness

- keep hot execution inside Wasm;
- retain compiled-function cache and executable-page invalidation;
- use native Wasm SIMD for VMX/VMX128;
- reduce JS↔Wasm crossings;
- stream package/XEX content instead of duplicating whole files;
- use workers/shared-memory queues where cross-origin isolation permits;
- start with low internal render resolution;
- build shader/resource caches after first correct frames;
- optimize Xenos/EDRAM traffic from title-specific traces.

## Compatibility ladder

```text
CPU/browser foundations                        ✓ LOCKED
STFS + XEX decode/mapping                      ✓ LOCKED
NONE/BASIC/NORMAL framing/LZX                  ✓ LOCKED
session-key/AES-CBC foundation                 ✓ LOCKED
prepared image → relocated entry PPC/HIR       ✓ LOCKED
strict Xbox PE decoder                         ✓ LOCKED
prepared PE → genuine guest section mappings   ✓ LOCKED
actual extracted title → first instructions    ← ACTIVE
first genuine kernel/runtime failure
minimum xboxkrnl / XAM / TLS / threads
first Xenos packets
first guest shader
first guest draw
FIRST GENUINE GUEST FRAME
performance/latency optimization
small homebrew / XBLA-class title bring-up
Braid-class playable target
Portal-class bring-up
Portal 2-class bring-up
```

The tiny first-frame guest workload should remain permanently in CI once it exists, so performance work cannot regress correctness.

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS, shader translation or title boot unless that event came from genuine execution through the corresponding subsystem.
