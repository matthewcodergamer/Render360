# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.**

Xenia remains the source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns browser-native integration: WebAssembly execution, sparse guest memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input, PWA behavior and diagnostics.

The root `README.md` is the authoritative public status board.

## Verified closures

```text
Run 254  eight CPU/browser foundations
Run 261  V36 strict XEX guest mapper
Run 265  full pull-driven default.xex STFS extraction
Run 276  XEX2 metadata decode + decoded mapper integration
Run 282  streaming NONE-encryption/NONE-compression image preparation
```

Run 282 is Actions run ID `33220362844` on implementation commit `271e169bfe528c3b1b4f2c410e8803481594b6b0` and completed successfully, including the complete Xenia/WasmBackend/mapper regression matrix.

## Closed V36 bring-up chain

```text
PACKAGE / XEX FOUNDATION                    100% ✓
PPC TRANSLATION FOUNDATION                  100% ✓
SCALAR PPC FOUNDATION                       100% ✓
GUEST CONTROL FOUNDATION                    100% ✓
FPU FOUNDATION                              100% ✓
VMX / VMX128 FOUNDATION                     100% ✓
HOT WASMBACKEND FOUNDATION                  100% ✓
SPARSE XBOX MEMORY FOUNDATION               100% ✓
V36 STRICT XEX GUEST MAPPER                 100% ✓
FULL default.xex STFS EXTRACTION            100% ✓
XEX2 IMAGE METADATA DECODE                  100% ✓
XEX DECODED-METADATA → MAPPER INTEGRATION  100% ✓
XEX PREPARE NONE/NONE SUB-CONTRACT          100% ✓
```

These are defined CI contracts, not claims of universal title compatibility.

## Run 276 boundary

The decoder under `src/xenia_web_bootstrap/xex_image_decoder.{h,cpp}` validates XEX2 header/optional-header/security/file-format metadata, Xenia page descriptors, image ranges, entry ranges and supported format classification. The integration critic obtains section addresses/types/sizes and the entry PC from decoder output and feeds them to the real `XexGuestMapper`.

It deliberately tests a second relocated XEX base so hard-coded synthetic mapper addresses cannot satisfy the gate. `XEX_IMAGE_DECODE=PASS` closes metadata decode only.

## Run 282 — first real image-preparation slice

The new `src/xenia_web_bootstrap/xex_image_preparer.{h,cpp}` path implements Xenia's uncompressed source contract without requiring another complete title image in the WASM staging buffer.

Xenia's `ReadImageUncompressed` uses the payload beginning at `xex_header()->header_size`, with executable byte count `xex_length - header_size`. Render360 now exposes that as a bounded streaming plan:

```text
bounded XEX header staged
       ↓
decode/validate metadata
       ↓
require encryption = NONE
require compression = NONE
       ↓
source_offset = header_size
source_bytes  = full_xex_size - header_size
       ↓
consume source in bounded chunks
       ↓
NONE/NONE bytes remain identity data
       ↓
exact bytes_done accounting
```

Run 282 proves:

```text
XEX_PREPARE_STREAMING_IDENTITY=PASS
XEX_PREPARE_EXACT_BYTE_ACCOUNTING=PASS
XEX_PREPARE_FILE_BOUNDS_FAIL_CLOSED=PASS
XEX_PREPARE_ENCRYPTION_FAIL_CLOSED=PASS
XEX_PREPARE_COMPRESSION_FAIL_CLOSED=PASS
XEX_PREPARE_CHUNK_OVERFLOW_FAIL_CLOSED=PASS
XEX_IMAGE_PREPARE_NONE=PASS
```

This closes only the `NONE encryption + NONE compression` preparation sub-contract. It does **not** promote the full preparation layer to 100%.

## Active Gate D0 — remaining XEX image preparation

```text
exact extracted default.xex                   ✓
XEX2 metadata                                 ✓
decoded metadata → mapper                     ✓
NONE encryption + NONE compression            ✓
BASIC compression                             ← ACTIVE NEXT
NORMAL compression / LZX                      pending
NORMAL encryption / XEX session key           pending
DELTA patch path                              fail closed / pending
```

### Full image-preparation closure requirements

```text
NONE/NONE streaming preparation               PASS ✓
source/header bounds                          PASS ✓
exact streaming byte accounting               PASS ✓
wrong-format routing                          FAIL CLOSED ✓
BASIC block accounting / zero-fill            NEXT
NORMAL/LZX stream validation                  pending
NORMAL encryption block/session-key rules     pending
DELTA without patch implementation            FAIL CLOSED
truncated/corrupt payload                     FAIL CLOSED
32-bit arithmetic overflow                    FAIL CLOSED
XEX_IMAGE_PREPARE                             pending
```

BASIC should follow Xenia's block model exactly: each record contributes `data_size` bytes followed by `zero_size` bytes, with strict source/output bounds. NORMAL must use Xenia-compatible LZX framing; encryption must use the real XEX session-key/AES-CBC behavior.

## Gate D1 — prepared image → real guest mappings

After full image preparation, stream prepared bytes into the already-closed mapper using decoded addresses and permissions. Avoid an unnecessary package-sized JavaScript or WASM duplicate.

```text
prepared image bytes
  → decoded XEX pages/sections
  → RX / R / RW sparse mappings
  → final permission seal
  → genuine entry PC validation
```

## Gate D2 — first genuine entry execution

Construct initial `PPCContext`, set the genuine title entry PC and execute through:

```text
Xenia PPCScanner
   ↓
Xenia frontend
   ↓
finalized HIR
   ↓
Hot WasmBackend cache / dispatch
   ↓
first genuine title instructions
   ↓
FAIL CLOSED on first missing runtime dependency
```

Do not add broad success stubs. The first real failure selects the next subsystem.

## After the first real failure

```text
xboxkrnl import       → minimum required xboxkrnl HLE/export
XAM import            → minimum required XAM surface
TLS                    → TLS initialization
thread creation       → KernelState / guest thread runtime
heap / virtual memory → required kernel memory service
filesystem            → browser-backed VFS
GPU initialization    → Xenos command/ringbuffer path
```

Only create `src/xenia_web_kernel/` or `src/xenia_web_gpu/` after genuine title execution reaches those boundaries.

## GPU path

```text
Xenos ringbuffer / command processor
        ↓
shared Xenos semantic layer
        ↓
shader / register / resource semantics
        ↓
EDRAM / render targets
        ↓
WebGPU + WGSL primary
        ↓
WebGL2 + GLSL ES fallback where feasible
        ↓
first genuine guest-produced framebuffer
```

Three.js may remain a host diagnostic tool but is never presented as guest Xbox rendering.

## Compatibility ladder

```text
8 CPU/browser foundations                    ✓ LOCKED
V36 strict XEX mapper                        ✓ LOCKED
full default.xex STFS extraction             ✓ LOCKED
XEX2 metadata decode                         ✓ LOCKED
decoded metadata → mapper                    ✓ LOCKED
NONE/NONE streaming image preparation        ✓ LOCKED
BASIC XEX preparation                        ← ACTIVE NEXT
NORMAL/LZX + encryption
prepared real image mapped
real XEX entry PC executed
first genuine kernel/runtime failure
minimum xboxkrnl / XAM
threads / TLS / runtime
first Xenos packets
first guest shader
first guest draw
first guest framebuffer
small XBLA title bring-up
Braid-class playable
Portal-class bring-up
```

## Repository organization

Active title bring-up remains under `src/xenia_web_bootstrap/` until a genuine kernel or GPU subsystem boundary is reached. Working root-level tests are moved only when scripts and CI references can migrate atomically. See `docs/PROJECT_LAYOUT.md`.

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, guest FPS, shader translation or title boot unless the event came from genuine execution through the corresponding emulator subsystem.
