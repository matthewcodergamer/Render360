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

Run 282  streaming NONE/NONE XEX image preparation
         Actions ID 33220362844
         commit 271e169bfe528c3b1b4f2c410e8803481594b6b0
```

All listed aggregate gates completed successfully.

## Run 276 — metadata and mapper integration

The maintained decoder is under:

```text
src/xenia_web_bootstrap/xex_image_decoder.h
src/xenia_web_bootstrap/xex_image_decoder.cpp
src/xenia_web_bootstrap/xex_image_decoder_exports.cpp
```

It uses a dedicated `r360_xex_decode_*` ABI. The earlier Run 272 link failure exposed an ABI collision with the lightweight inspector; the collision was fixed without removing the established inspector surface.

Run 276 proves strict XEX2 header/security/file-format bounds, image base and entry validation, Xenia page-descriptor semantics, 64 KiB/4 KiB image-page selection, format classification and fail-closed corrupt/unsupported metadata. The integration critic derives mapper section addresses/types/sizes and entry PC from decoder output and re-runs at a second relocated base to reject baked synthetic addresses.

```text
XEX_IMAGE_DECODE=PASS
XEX_DECODED_SECTION_MAPPING=PASS
XEX_DECODED_PERMISSIONS=PASS
XEX_DECODED_ENTRY_VALIDATION=PASS
XEX_METADATA_RELOCATION_REUSE=PASS
XEX_REAL_MAPPER_INTEGRATION=PASS
```

## Run 282 — streaming NONE/NONE image preparation

New maintained preparation files:

```text
src/xenia_web_bootstrap/xex_image_preparer.h
src/xenia_web_bootstrap/xex_image_preparer.cpp
src/xenia_web_bootstrap/xex_image_preparer_exports.cpp
test-xex-image-prepare-none.mjs
```

The first preparation path follows Xenia's uncompressed source rule: payload begins at the XEX `header_size` and contains `xex_length - header_size` bytes. It is exposed as a streaming identity path rather than requiring another complete XEX-sized WASM buffer.

The caller stages only bounded data. The preparer validates `NONE` encryption and `NONE` compression, exposes the source offset/byte count, accepts bounded payload chunks, leaves identity bytes unchanged, and requires exact byte completion.

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

The full Xenia PPC/HIR, WasmBackend, SparseGuestMemory and XEX mapper regression matrix remained green in the same run.

## Current boundary

```text
STFS default.xex extraction                   ✓
XEX2 metadata decode                          ✓
decoded metadata → mapper                     ✓
NONE encryption / NONE compression prepare   ✓
BASIC compression                             ← ACTIVE NEXT
NORMAL compression / LZX                      pending
NORMAL encryption / session key               pending
DELTA patch image                              fail closed / pending
```

`XEX_IMAGE_PREPARE_NONE=PASS` is a sub-contract. The overall image-preparation layer is **not** 100% yet.

## Next implementation — BASIC compression

Follow Xenia's BASIC block semantics exactly. The file-format record contains a sequence of `(data_size, zero_size)` entries. Preparation must copy each `data_size` payload, append `zero_size` zero bytes, and reject any source/output arithmetic overflow or truncated source.

Required critic:

```text
BASIC block table bounds                     PASS
sum(data_size) source accounting             PASS
sum(data_size + zero_size) output accounting PASS
payload bytes preserved                      PASS
zero regions exactly zero                    PASS
source underrun/overrun                      FAIL CLOSED
output overflow                              FAIL CLOSED
wrong encryption route                       FAIL CLOSED
XEX_IMAGE_PREPARE_BASIC                      PASS
```

After BASIC, implement NORMAL/LZX framing from Xenia and then NORMAL encryption/session-key AES-CBC behavior. DELTA remains fail closed until a genuine patch path exists.

## After full image preparation

Prepared bytes are streamed into decoder-derived RX/R/RW guest mappings, permissions are sealed, and the genuine entry PC becomes initial PPC state:

```text
prepared XEX image
    ↓
decoder-derived SparseGuestMemory mappings
    ↓
genuine entry PC
    ↓
PPCContext
    ↓
Xenia PPCScanner / frontend / finalized HIR
    ↓
Hot WasmBackend
    ↓
execute first genuine title instructions
    ↓
first genuine missing runtime/kernel dependency
```

That first real failure chooses the next implementation target: xboxkrnl, XAM, TLS, threading, memory services, VFS or Xenos initialization.

## Promotion rule

Metadata decode is not image preparation. A single preparation format is not full preparation. Mapper integration is not title execution. Do not mark real entry execution, kernel/GPU bring-up, a guest frame, playability or FPS complete until the corresponding event comes from genuine title execution.
