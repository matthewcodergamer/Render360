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
```

Run 276 is Actions run ID `33219831630` on implementation commit `c9fe8dec88e47b2ded17a0ede461bcf3d44acbe7` and completed successfully.

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
```

These are defined CI contracts, not claims of universal title compatibility.

## Run 276 boundary

The decoder under `src/xenia_web_bootstrap/xex_image_decoder.{h,cpp}` validates XEX2 header/optional-header/security/file-format metadata, Xenia page descriptors, image ranges, entry ranges and supported format classification. The integration critic then obtains section addresses/types/sizes and the entry PC from decoder output and feeds them to the real `XexGuestMapper`.

It deliberately tests a second relocated XEX base so hard-coded synthetic mapper addresses cannot satisfy the gate.

`XEX_IMAGE_DECODE=PASS` means **metadata decode is closed**. It does not mean encryption/decompression or final executable-image preparation is complete.

## Active Gate D0 — XEX image preparation

The next implementation must turn the extracted XEX payload into executable image bytes using Xenia semantics:

```text
exact extracted default.xex                   ✓
        ↓
XEX2 metadata                                 ✓
        ↓
file-format classification                    ✓
        ↓
IMAGE PREPARATION                             ← ACTIVE
        ├── NONE encryption + NONE compression
        ├── BASIC compression
        ├── NORMAL compression / LZX
        ├── NORMAL encryption / XEX session key
        └── DELTA remains fail closed until patch support
        ↓
prepared image bytes
        ↓
decoder-derived page layout                   ✓
        ↓
XexGuestMapper / SparseGuestMemory            ✓
```

### Required image-preparation critic

```text
NONE/NONE image preparation                 PASS
prepared byte count == declared image size  PASS
zero-fill semantics                         PASS
source/header bounds                        PASS
output guest-image bounds                   PASS
BASIC block accounting                      PASS
NORMAL/LZX stream validation                PASS when implemented
NORMAL encryption block alignment           PASS when implemented
unsupported DELTA patch image               FAIL CLOSED
truncated/corrupt payload                    FAIL CLOSED
32-bit arithmetic overflow                  FAIL CLOSED
XEX_IMAGE_PREPARE                            PASS
```

Implement this incrementally. The first promotion may close the unencrypted/uncompressed preparation sub-contract while BASIC/NORMAL remain explicitly pending; do not label the full image-preparation layer 100% until its declared gate covers the formats being claimed.

## Gate D1 — prepared image → real guest mappings

After image preparation, stream prepared bytes into the already-closed mapper using decoded addresses and permissions. Avoid an unnecessary package-sized JavaScript or WASM duplicate.

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

Do not add broad success stubs to move farther. The first real failure selects the next subsystem.

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
XEX image prepare/decrypt/decompress          ← ACTIVE
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

Active title bring-up remains under `src/xenia_web_bootstrap/` until a genuine kernel or GPU subsystem boundary is reached. Working root-level tests are moved only when their scripts and CI references can migrate atomically. See `docs/PROJECT_LAYOUT.md`.

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, guest FPS, shader translation or title boot unless the event came from genuine execution through the corresponding emulator subsystem.
