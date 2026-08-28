# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence and do not override the verified status below.

## Authoritative verified gates

- **Run 254** — eight CPU/browser foundations, commit `3b39da31b6fc3e296e356f7143574951f7fc8861`.
- **Run 261** (Actions ID `33212297082`) — strict V36 XEX guest mapper, commit `f602d889293440a4840c3310a8e5fbf07ddc7756`.
- **Run 265** (Actions ID `33218179582`) — full pull-driven STFS `default.xex` extraction, commit `0ba0587bc335ad8391f43cdc8c750da36d149005`.
- **Run 276** (Actions ID `33219831630`) — XEX2 metadata decode plus decoded-metadata → `XexGuestMapper` integration, commit `c9fe8dec88e47b2ded17a0ede461bcf3d44acbe7`.
- **Run 282** (Actions ID `33220362844`) — streaming unencrypted/uncompressed XEX image preparation, commit `271e169bfe528c3b1b4f2c410e8803481594b6b0`.

Run 282 completed successfully after rebuilding the package/XEX WASM core, passing STFS extraction, XEX2 metadata decode and the new preparation critic, checking current Xenia contracts, compiling/linking the Xenia PPC/HIR WASM bootstrap, and re-running the complete locked WasmBackend/SparseGuestMemory/XEX-mapper matrix.

## Closed foundations and bring-up layers

```text
PACKAGE / XEX FOUNDATION
████████████████████  100% ✓
PPC TRANSLATION FOUNDATION
████████████████████  100% ✓
SCALAR PPC FOUNDATION
████████████████████  100% ✓
GUEST CONTROL FOUNDATION
████████████████████  100% ✓
FPU FOUNDATION
████████████████████  100% ✓
VMX / VMX128 FOUNDATION
████████████████████  100% ✓
HOT WASMBACKEND FOUNDATION
████████████████████  100% ✓
SPARSE XBOX MEMORY FOUNDATION
████████████████████  100% ✓
V36 STRICT XEX GUEST MAPPER
████████████████████  100% ✓
FULL default.xex STFS EXTRACTION
████████████████████  100% ✓
XEX2 IMAGE METADATA DECODE
████████████████████  100% ✓
XEX REAL MAPPER INTEGRATION
████████████████████  100% ✓
XEX PREPARE NONE/NONE SUB-CONTRACT
████████████████████  100% ✓
```

These percentages close defined CI contracts, not universal Xbox 360 compatibility.

## XEX2 metadata and mapping — Run 276

The maintained decoder under `src/xenia_web_bootstrap/xex_image_decoder.{h,cpp}` has a dedicated `r360_xex_decode_*` ABI. It validates top-level and optional XEX2 headers, security/file-format metadata, image base/load address/size, entry range, title/media metadata, Xenia page descriptors, 64 KiB/4 KiB image-page layout, and 32-bit arithmetic/range safety.

```text
XEX_IMAGE_DECODE=PASS
DELTA compression before patch support        FAIL CLOSED
invalid page descriptor                       FAIL CLOSED
entry outside image                           FAIL CLOSED
image wrap / truncated metadata                FAIL CLOSED
```

The mapper integration critic consumes decoder-derived section type/address/size and entry data, seals RX/R/RW permissions, and repeats at a second relocated image base so hard-coded `0x82...` mapping cannot satisfy the gate.

```text
XEX_DECODED_SECTION_MAPPING=PASS
XEX_DECODED_PERMISSIONS=PASS
XEX_DECODED_ENTRY_VALIDATION=PASS
XEX_METADATA_RELOCATION_REUSE=PASS
XEX_REAL_MAPPER_INTEGRATION=PASS
```

## First XEX image-preparation slice — Run 282

The new `src/xenia_web_bootstrap/xex_image_preparer.{h,cpp}` implements the first executable-payload path using Xenia's uncompressed semantics.

Xenia's uncompressed reader treats the source payload as the bytes beginning at XEX `header_size`, with payload length `xex_length - header_size`. Render360 exposes that as a bounded streaming identity path instead of requiring another whole-XEX copy in WASM memory.

```text
bounded XEX header
    ↓
strict XEX2 decode
    ↓
require encryption = NONE
require compression = NONE
    ↓
source_offset = header_size
source_bytes  = xex_length - header_size
    ↓
consume payload in bounded chunks
    ↓
identity prepared bytes + exact byte accounting
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

This is deliberately a **sub-contract**. The complete XEX image-preparation layer is not 100% yet because BASIC compression, NORMAL/LZX compression and NORMAL encryption/session-key handling remain.

## Active milestone — BASIC XEX preparation

```text
STFS default.xex extraction                  ✓
XEX2 metadata decode                         ✓
metadata-derived mapper integration          ✓
NONE encryption / NONE compression prepare  ✓
BASIC compression                            ← ACTIVE NEXT
NORMAL compression / LZX                     pending
NORMAL encryption / session key              pending
DELTA patch images                           fail closed / pending
        ↓
full prepared executable image
        ↓
XexGuestMapper + SparseGuestMemory           ✓
        ↓
genuine entry PC
        ↓
PPCContext
        ↓
Xenia PPCScanner / frontend / finalized HIR
        ↓
Hot WasmBackend
        ↓
FIRST GENUINE TITLE INSTRUCTIONS
```

BASIC will follow Xenia's `(data_size, zero_size)` block model exactly: preserve each data region, synthesize the specified zero range, validate all source/output arithmetic, and fail closed on truncation or format mismatch. NORMAL then follows Xenia-compatible LZX framing; NORMAL encryption follows the genuine XEX session-key/AES-CBC behavior. DELTA stays fail closed until patch support is real.

## Public board

```text
8 CPU/browser foundations
████████████████████  100% ✓
V36 STRICT XEX GUEST MAPPER
████████████████████  100% ✓
FULL default.xex STFS EXTRACTION
████████████████████  100% ✓
XEX2 IMAGE METADATA DECODE
████████████████████  100% ✓
XEX REAL MAPPER INTEGRATION
████████████████████  100% ✓
XEX PREPARE NONE/NONE
████████████████████  100% ✓

FULL XEX IMAGE PREPARATION
█████░░░░░░░░░░░░░░░  ← ACTIVE; BASIC NEXT
REAL XEX ENTRY EXECUTION
░░░░░░░░░░░░░░░░░░░░
KERNEL / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░
XENOS SEMANTIC LAYER
░░░░░░░░░░░░░░░░░░░░
WEBGPU / WGSL / EDRAM
░░░░░░░░░░░░░░░░░░░░
WEBGL2 FALLBACK
░░░░░░░░░░░░░░░░░░░░
FIRST GENUINE FRAME
░░░░░░░░░░░░░░░░░░░░
```

The partial full-preparation bar is only a work indicator; only the explicitly listed `NONE/NONE` sub-contract is closed.

## Next execution rule

After full image preparation is proven, prepared bytes must stream into decoder-derived guest mappings, final RX/R/RW permissions must be sealed, the genuine entry address validated, and initial `PPCContext` state sent through Xenia's scanner/frontend/HIR and Hot WasmBackend. Execution stops visibly at the first genuine missing dependency. That real failure becomes the next target — `xboxkrnl`, XAM, TLS, threading, memory, VFS or Xenos — rather than being hidden by broad success stubs.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up: CPU/WASM integration, SparseGuestMemory, XEX decoder, preparer and guest mapper.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `xenia_port/` — older imported/ported Xenia-facing surface retained until safe migration.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

Working root tests move only when their CI/script references can migrate atomically. See [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

A subsystem reaches **100%** only when its defined aggregate CI gate proves that exact contract. Metadata decode is not payload preparation; one preparation format is not full preparation; mapper integration is not title execution. Do not claim genuine title boot, guest frame, playability or FPS until those events come from the corresponding emulator subsystem.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — V36 real-title implementation order
- [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md) — verified V36 gates
- [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md) — repository ownership/layout policy
- [`XENIA_WEB_BOOTSTRAP.md`](XENIA_WEB_BOOTSTRAP.md) — Xenia/WebAssembly bootstrap details
- [`WASM_BACKEND_FOUNDATION.md`](WASM_BACKEND_FOUNDATION.md) — WasmBackend implementation history
- [`FPU_FOUNDATION.md`](FPU_FOUNDATION.md) — FPU foundation
- [`VMX_FOUNDATION.md`](VMX_FOUNDATION.md) — VMX / VMX128 foundation
- [`BROWSER_NATIVE_ARCHITECTURE.md`](BROWSER_NATIVE_ARCHITECTURE.md) — browser-native architecture
- [`UPSTREAM_PORT_MAP.md`](UPSTREAM_PORT_MAP.md) — upstream Xenia port map

Older root `V*_RELEASE_NOTES.md` files are historical records only.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
