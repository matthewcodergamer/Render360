# V36 XEX bring-up

V36 is the transition from closed CPU/browser foundations to genuine title-image bring-up.

## Verified gates

```text
Run 254  eight CPU/browser foundations
         commit 3b39da31b6fc3e296e356f7143574951f7fc8861

Run 261  strict XEX guest mapper
         Actions ID 33212297082
         commit f602d889293440a4840c3310a8e5fbf07ddc7756

Run 265  full pull-driven default.xex STFS extraction
         Actions ID 33218179582
         commit 0ba0587bc335ad8391f43cdc8c750da36d149005

Run 276  XEX2 metadata decode + decoded mapper integration
         Actions ID 33219831630
         commit c9fe8dec88e47b2ded17a0ede461bcf3d44acbe7
```

All four aggregate gates completed successfully.

## Run 276 — XEX2 metadata decode closure

New maintained files:

```text
src/xenia_web_bootstrap/xex_image_decoder.h
src/xenia_web_bootstrap/xex_image_decoder.cpp
src/xenia_web_bootstrap/xex_image_decoder_exports.cpp
test-xex-image-decode.mjs
test-xex-real-mapper-integration.mjs
```

The decoder uses a separate `r360_xex_decode_*` ABI. Run 272 first exposed an ABI collision with the older lightweight inspector (`r360_xex_image_base` / `r360_xex_image_size`); that was fixed by separating the new decoder namespace rather than removing the established inspector API.

The green decode critic verifies:

```text
XEX2 magic/header                             PASS
optional-header table bounds                  PASS
security-info bounds                          PASS
image base / load address / image size        VALID
entry point                                    VALID
title/media execution metadata                VALID
file-format metadata                          VALID
NONE/NORMAL encryption classification         PASS
NONE/BASIC/NORMAL compression classification  PASS
DELTA before patch support                    FAIL CLOSED
Xenia page descriptor decoding                PASS
code/data/readonly descriptor types           PASS
64 KiB title image-page rule                  PASS
4 KiB high-image page rule                    PASS
entry outside image                           FAIL CLOSED
32-bit image wrap                             FAIL CLOSED
corrupt/truncated descriptor data             FAIL CLOSED
XEX_IMAGE_DECODE                              PASS
```

The page-size behavior is intentionally aligned with current Xenia `XexModule`: title images based at or below `0x90000000` use 64 KiB image pages; higher images use 4 KiB pages.

## Run 276 — decoded metadata → mapper closure

The integration critic does not feed a parallel set of hard-coded section addresses into the mapper. It reads page-descriptor type/address/size and entry PC from the decoder ABI and uses those values to drive the already-verified `XexGuestMapper`.

```text
code descriptor       → R|X
readonly descriptor   → R
data descriptor       → R|W
entry                  → set_entry / finalize
RX after finalize      → write rejected
RW after finalize      → write allowed
relocated second XEX   → mappings re-derived from new metadata

XEX_DECODED_SECTION_MAPPING=PASS
XEX_DECODED_PERMISSIONS=PASS
XEX_DECODED_ENTRY_VALIDATION=PASS
XEX_METADATA_RELOCATION_REUSE=PASS
XEX_REAL_MAPPER_INTEGRATION=PASS
```

This closes the **metadata interpretation and metadata→mapper contracts**. It does not claim that encrypted/compressed executable payloads have already been transformed into runnable image bytes.

## Current boundary — image preparation

The active V36 path is now:

```text
STFS default.xex extraction                   ✓
        ↓
XEX2 metadata decode                          ✓
        ↓
metadata-derived mapper layout                ✓
        ↓
XEX IMAGE PREPARATION                         ← ACTIVE
        ├── NONE encryption / NONE compression
        ├── BASIC compression
        ├── NORMAL LZX compression
        ├── NORMAL encryption / session key
        └── DELTA patch path remains fail closed
        ↓
prepared executable image bytes
        ↓
SparseGuestMemory / XexGuestMapper            ✓
        ↓
genuine entry PC
        ↓
PPCContext / Xenia frontend / HIR
        ↓
Hot WasmBackend
        ↓
first genuine title instructions
```

## Next CI gate — `XEX_IMAGE_PREPARE`

The image preparation implementation should follow Xenia's current XEX semantics rather than creating a browser-specific executable format. Start with the unencrypted/uncompressed path, then add BASIC, NORMAL/LZX and NORMAL encryption with the real session-key behavior.

Minimum fail-closed requirements:

```text
source offset/length bounds                   PASS
output image bounds                           PASS
prepared byte count == declared image size    PASS
zero-fill semantics                           PASS
BASIC block size accounting                   PASS when supported
NORMAL/LZX stream/block validation            PASS when supported
AES input alignment/session-key rules         PASS when supported
DELTA without patch implementation            FAIL CLOSED
truncated source                              FAIL CLOSED
malformed compression data                    FAIL CLOSED
arithmetic/address overflow                   FAIL CLOSED
```

Do not mark the entire image-preparation layer 100% while BASIC/NORMAL/encryption forms included in the declared contract remain unimplemented.

## After image preparation

Prepared bytes are streamed into decoder-derived guest mappings, permissions are sealed, and the genuine entry PC is used to construct initial PPC state:

```text
prepared XEX image
    ↓
decoder-derived RX/R/RW mappings
    ↓
genuine entry PC
    ↓
PPCContext
    ↓
Xenia PPCScanner / frontend
    ↓
finalized HIR
    ↓
Hot WasmBackend
    ↓
execute until first genuine unresolved dependency
```

That first real failure — xboxkrnl, XAM, TLS, threading, memory, filesystem or GPU initialization — selects the next implementation target.

## Promotion rule

Metadata decode is not image preparation. Mapper integration is not title execution. Do not mark `REAL XEX ENTRY EXECUTION`, kernel bring-up, GPU bring-up, guest frame, playability or FPS complete until the corresponding event comes from genuine title execution.
