# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.**

Xenia remains the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns browser-native integration: WebAssembly execution, sparse guest memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input, PWA behavior and diagnostics.

The root `README.md` is the authoritative public status board.

## Verified closures

```text
Run 254  eight CPU/browser foundations
Run 261  V36 strict XEX guest mapper
Run 265  full pull-driven default.xex STFS extraction
Run 276  XEX2 metadata decode + decoded mapper integration
Run 282  NONE encryption / NONE compression image preparation
Run 288  BASIC compression / NONE encryption image preparation
```

Run 288 is Actions run ID `33221272140` on implementation commit `e4e8ade63a56bd165a7490a36c679ff7a11303a3`. It completed successfully, including the full Xenia PPC/HIR, WasmBackend, SparseGuestMemory and XEX-mapper regression matrix.

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
XEX PREPARE BASIC SUB-CONTRACT              100% ✓
```

These are defined CI contracts, not claims of universal title compatibility.

## Run 288 — BASIC preparation closure

The BASIC path follows Xenia's file-format table of big-endian `(data_size, zero_size)` records. The unencrypted source contains only the concatenated data portions. Render360 streams those data bytes unchanged and emits each zero range explicitly, allowing the final sparse image to be built without keeping another complete executable copy in WASM memory.

The critic locks table bounds, exact source/output arithmetic, payload preservation, zero fill, ordering, truncation, mapped-span overflow, wrong encryption/compression routing and chunk overshoot.

```text
XEX_PREPARE_BASIC_TABLE_BOUNDS=PASS
XEX_PREPARE_BASIC_SOURCE_ACCOUNTING=PASS
XEX_PREPARE_BASIC_OUTPUT_ACCOUNTING=PASS
XEX_PREPARE_BASIC_PAYLOAD_PRESERVED=PASS
XEX_PREPARE_BASIC_ZERO_FILL=PASS
XEX_PREPARE_BASIC_STREAMING=PASS
XEX_PREPARE_BASIC_ENCRYPTION_FAIL_CLOSED=PASS
XEX_PREPARE_BASIC_ROUTING_FAIL_CLOSED=PASS
XEX_PREPARE_BASIC_FORMAT_FAIL_CLOSED=PASS
XEX_PREPARE_BASIC_TRUNCATION_FAIL_CLOSED=PASS
XEX_PREPARE_BASIC_OUTPUT_RANGE_FAIL_CLOSED=PASS
XEX_PREPARE_BASIC_ORDER_FAIL_CLOSED=PASS
XEX_PREPARE_BASIC_CHUNK_OVERFLOW_FAIL_CLOSED=PASS
XEX_IMAGE_PREPARE_BASIC=PASS
```

## Active Gate D0 — NORMAL XEX image preparation

```text
exact extracted default.xex                   ✓
XEX2 metadata                                 ✓
decoded metadata → mapper                     ✓
NONE encryption + NONE compression            ✓
BASIC compression + NONE encryption           ✓
NORMAL block/hash/chunk framing               ← ACTIVE NEXT
NORMAL LZX decompression                      pending
NORMAL encryption / XEX session key           pending
DELTA patch path                              fail closed / pending
```

### NORMAL framing contract

Follow Xenia's `ReadImageCompressed` structure rather than inventing a web-specific archive format:

```text
payload begins at XEX header_size
       ↓
file-format NORMAL window_size + first block metadata
       ↓
for each declared compressed block:
  block_size bounds                           PASS
  SHA-1 of entire block                       PASS
  chained next-block size/hash header         PASS
  repeated BE16 chunk lengths                 PASS
  zero chunk terminator                       PASS
  exact compressed-stream output accounting   PASS
       ↓
Xenia-compatible LZX stream
```

Required adversarial behavior:

```text
block extends past source                     FAIL CLOSED
hash mismatch                                 FAIL CLOSED
missing 24-byte next-block header             FAIL CLOSED
chunk extends past block                      FAIL CLOSED
missing chunk terminator                      FAIL CLOSED
next-block arithmetic overflow                FAIL CLOSED
compressed-stream accounting overflow         FAIL CLOSED
wrong encryption/compression route            FAIL CLOSED
```

The first NORMAL gate should close **deblocking/framing only** if LZX is not yet integrated. Do not call NORMAL preparation complete until the deblocked stream is actually decompressed with Xenia-compatible LZX using the declared window size.

### LZX implementation direction

Current Xenia delegates LZX to its `src/xenia/cpu/lzx.cc` wrapper over bundled mspack LZX. Render360 should prefer porting that proven implementation or the smallest compatible subset into the browser-native WASM build rather than writing a new decompressor from scratch. Hash verification must remain before decompression.

### Encryption direction

NORMAL encryption remains a separate gate. Session-key derivation and AES-CBC must follow Xenia's XEX security-key semantics and stay inside native/WASM code rather than exposing title keys to JavaScript. BASIC+encrypted and NORMAL+encrypted routes remain fail closed until that path is verified.

## Gate D1 — full prepared image → real guest mappings

After all required preparation formats are proven, stream prepared bytes into decoder-derived mappings:

```text
prepared image bytes
  → decoded XEX pages/sections
  → RX / R / RW SparseGuestMemory mappings
  → final permission seal
  → genuine entry PC validation
```

The existing decoded-metadata mapper integration remains a locked prerequisite; D1 adds real prepared payload bytes, not synthetic section contents.

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

## After first real failure

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

## Compatibility ladder

```text
8 CPU/browser foundations                    ✓ LOCKED
V36 strict XEX mapper                        ✓ LOCKED
full default.xex STFS extraction             ✓ LOCKED
XEX2 metadata decode                         ✓ LOCKED
decoded metadata → mapper                    ✓ LOCKED
NONE/NONE streaming image preparation        ✓ LOCKED
BASIC XEX preparation                        ✓ LOCKED
NORMAL block/hash/chunk framing              ← ACTIVE
NORMAL LZX decompression
NORMAL encryption / session key
full prepared real image mapped
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

Active title bring-up remains under `src/xenia_web_bootstrap/` until a genuine kernel or GPU subsystem boundary is reached. Working root-level tests move only when scripts and CI references can migrate atomically. See `docs/PROJECT_LAYOUT.md`.

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, guest FPS, shader translation or title boot unless the event came from genuine execution through the corresponding emulator subsystem.
