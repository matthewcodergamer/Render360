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

Run 288  streaming BASIC XEX image preparation
         Actions ID 33221272140
         commit e4e8ade63a56bd165a7490a36c679ff7a11303a3
```

All listed aggregate gates completed successfully.

## Image preparation status

Maintained preparation files:

```text
src/xenia_web_bootstrap/xex_image_preparer.h
src/xenia_web_bootstrap/xex_image_preparer.cpp
src/xenia_web_bootstrap/xex_image_preparer_exports.cpp
test-xex-image-prepare-none.mjs
test-xex-image-prepare-basic.mjs
```

### Run 282 — NONE/NONE

The uncompressed path follows Xenia's source rule: payload begins at XEX `header_size`, contains `xex_length - header_size` bytes, remains identity data and is consumed in bounded chunks.

```text
XEX_PREPARE_STREAMING_IDENTITY=PASS
XEX_PREPARE_EXACT_BYTE_ACCOUNTING=PASS
XEX_PREPARE_FILE_BOUNDS_FAIL_CLOSED=PASS
XEX_PREPARE_ENCRYPTION_FAIL_CLOSED=PASS
XEX_PREPARE_COMPRESSION_FAIL_CLOSED=PASS
XEX_PREPARE_CHUNK_OVERFLOW_FAIL_CLOSED=PASS
XEX_IMAGE_PREPARE_NONE=PASS
```

### Run 288 — BASIC/NONE

BASIC follows Xenia's big-endian `(data_size, zero_size)` records. The source XEX payload contains only the concatenated data portions. Render360 consumes those data bytes unchanged and emits each zero region as a separate output event, allowing the final sparse image to be built without a second whole-image allocation.

The implementation validates the complete BASIC table before streaming, uses 64-bit intermediates for source/output sums, rejects tables or payloads that exceed the decoded image span, requires exact source length, and enforces the data-then-zero ordering of every block.

Run 288 proves:

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

The same run recompiled/relinked the real Xenia PPC/HIR WASM bootstrap and re-ran the locked CPU, WasmBackend, SparseGuestMemory and XEX mapper/integration critics successfully.

## Current boundary

```text
STFS default.xex extraction                   ✓
XEX2 metadata decode                          ✓
decoded metadata → mapper                     ✓
NONE encryption / NONE compression prepare   ✓
BASIC compression / NONE encryption           ✓
NORMAL block/hash/chunk framing               ← ACTIVE NEXT
NORMAL LZX decompression                      pending
NORMAL encryption / session key               pending
DELTA patch image                              fail closed / pending
```

NONE/NONE and BASIC are closed sub-contracts. The overall image-preparation layer is **not** 100% yet.

## Next implementation — NORMAL framing and LZX

Current upstream Xenia's `ReadImageCompressed` defines the required behavior. For an unencrypted NORMAL image:

```text
source payload begins at header_size
        ↓
file-format NORMAL window_size
first block_size + SHA-1 digest
        ↓
for each block
  verify block_size is inside remaining payload
  verify SHA-1 over the entire declared block
  read the next block's size/hash header from block start
  skip that 24-byte chained metadata
  parse repeated big-endian 16-bit chunk lengths
  copy each compressed chunk to the deblocked LZX stream
  zero chunk length terminates the block
        ↓
advance exactly by current block_size
        ↓
Xenia-compatible LZX decompression
        ↓
decoded image_size / mapped span
```

The first NORMAL critic may close framing/deblocking as an explicit sub-contract, but NORMAL image preparation is not complete until the resulting stream is decompressed with compatible LZX using the declared `window_size`.

Required fail-closed cases include block overrun, hash mismatch, truncated chained block metadata, chunk overrun, missing chunk terminator, arithmetic overflow and wrong format/encryption routing.

Xenia currently wraps bundled mspack LZX in `src/xenia/cpu/lzx.cc`. Prefer porting that proven implementation or the smallest browser-compatible subset rather than creating an unrelated decompressor.

## Following implementation — NORMAL encryption

Once unencrypted NORMAL/LZX is proven, implement Xenia's real XEX session-key derivation and AES-CBC rules. Cryptographic state should remain in native/WASM code, and encrypted BASIC/NORMAL routes must continue to fail closed until verified.

DELTA remains fail closed until a genuine patch-image path exists.

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

Metadata decode is not image preparation. A preparation sub-format is not the full preparation layer. Mapper integration is not title execution. Do not mark real entry execution, kernel/GPU bring-up, a guest frame, playability or FPS complete until the corresponding event comes from genuine title execution.
