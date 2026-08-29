# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence and do not override the verified status below.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
████████░░░░░░░░░░░░  ~41%
```

This overall percentage is an engineering estimate, not a compatibility score and not a claim that 41% of Xbox 360 titles boot. The already-closed CPU/WASM, package, memory and XEX foundations carry meaningful weight, but genuine title entry execution, xboxkrnl/XAM/runtime services, Xenos semantics, EDRAM, WebGPU presentation and real-title compatibility still contain most of the remaining integration risk.

## Authoritative verified gates

- **Run 254** — eight CPU/browser foundations, commit `3b39da31b6fc3e296e356f7143574951f7fc8861`.
- **Run 261** (Actions ID `33212297082`) — strict V36 XEX guest mapper, commit `f602d889293440a4840c3310a8e5fbf07ddc7756`.
- **Run 265** (Actions ID `33218179582`) — full pull-driven STFS `default.xex` extraction, commit `0ba0587bc335ad8391f43cdc8c750da36d149005`.
- **Run 276** (Actions ID `33219831630`) — XEX2 metadata decode plus decoded-metadata → `XexGuestMapper` integration, commit `c9fe8dec88e47b2ded17a0ede461bcf3d44acbe7`.
- **Run 282** (Actions ID `33220362844`) — streaming unencrypted/uncompressed XEX image preparation, commit `271e169bfe528c3b1b4f2c410e8803481594b6b0`.
- **Run 288** (Actions ID `33221272140`) — streaming BASIC XEX image preparation, commit `e4e8ade63a56bd165a7490a36c679ff7a11303a3`.
- **Run 294** (Actions ID `33221747038`) — NORMAL XEX block/hash/chunk framing, commit `597be9e97ac16e8007d34ea815b2b5b291ee941e`.
- **Run 299** (Actions ID `33222524497`) — upstream Xenia LZX/libmspack executing inside wasm32, commit `198744d214cc8eb6d2f88633f515d99ed8d69808`.

Run 298 first proved all 75 wasm32 translation units—including Xenia `lzx.cc`, vendored libmspack `lzxd.c`, and the Render360 LZX probe—compiled, then the strict linker exposed the real libmspack `xenia_log` dependency. The browser logging ABI shim was added without relaxing strict linking. Run 299 is the first authoritative full-green LZX gate: strict link, real LZX execution and the complete older regression matrix all succeeded.

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
XEX PREPARE BASIC SUB-CONTRACT
████████████████████  100% ✓
XEX NORMAL FRAMING SUB-CONTRACT
████████████████████  100% ✓
XENIA LZX WASM FOUNDATION
████████████████████  100% ✓
```

These percentages close defined CI contracts, not universal Xbox 360 compatibility.

## XEX image preparation — verified chain

### NONE encryption / NONE compression — Run 282

Xenia's uncompressed reader treats the source payload as the bytes beginning at XEX `header_size`, with payload length `xex_length - header_size`. Render360 exposes that as a bounded streaming identity path rather than requiring another whole-XEX copy in WASM memory.

```text
XEX_PREPARE_STREAMING_IDENTITY=PASS
XEX_PREPARE_EXACT_BYTE_ACCOUNTING=PASS
XEX_PREPARE_FILE_BOUNDS_FAIL_CLOSED=PASS
XEX_PREPARE_ENCRYPTION_FAIL_CLOSED=PASS
XEX_PREPARE_COMPRESSION_FAIL_CLOSED=PASS
XEX_PREPARE_CHUNK_OVERFLOW_FAIL_CLOSED=PASS
XEX_IMAGE_PREPARE_NONE=PASS
```

### BASIC compression / NONE encryption — Run 288

BASIC follows Xenia's big-endian `(data_size, zero_size)` records. Source data is streamed unchanged and zero ranges are synthesized without a second complete executable image in WASM memory.

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

### NORMAL framing — Run 294

The NORMAL framing layer incrementally validates Xenia's chained compressed-block layout: declared block sizes, SHA-1 hashes, the next-block header, big-endian 16-bit chunk lengths, zero terminators and exact source/output accounting. Compressed chunk bytes are compacted in-place for the next stage.

```text
XEX_NORMAL_BLOCK_BOUNDS=PASS
XEX_NORMAL_SHA1_CHAIN=PASS
XEX_NORMAL_BE16_CHUNK_FRAMING=PASS
XEX_NORMAL_STREAM_COMPACTION=PASS
XEX_NORMAL_EXACT_ACCOUNTING=PASS
XEX_NORMAL_HASH_FAIL_CLOSED=PASS
XEX_NORMAL_SOURCE_RANGE_FAIL_CLOSED=PASS
XEX_NORMAL_TERMINATOR_FAIL_CLOSED=PASS
XEX_NORMAL_CHUNK_RANGE_FAIL_CLOSED=PASS
XEX_NORMAL_WINDOW_FAIL_CLOSED=PASS
XEX_NORMAL_FRAMING=PASS
```

### Upstream Xenia LZX in WebAssembly — Run 299

The strict Xenia bootstrap now compiles and links Xenia's own `src/xenia/cpu/lzx.cc` and vendored libmspack LZX decoder into wasm32. The critic decompresses changed valid LZX streams and rejects invalid windows, corrupt streams and staging overflow. This is the upstream decoder, not a browser-specific reimplementation.

```text
XENIA_LZX_WASM_DECOMPRESS=PASS
XENIA_LZX_REUSE_CHANGED_PAYLOAD=PASS
XENIA_LZX_WINDOW_FAIL_CLOSED=PASS
XENIA_LZX_CORRUPT_STREAM_FAIL_CLOSED=PASS
XENIA_LZX_PROBE_BOUNDS_FAIL_CLOSED=PASS
XEX_NORMAL_LZX_FOUNDATION=PASS
```

The complete retail XEX image-preparation layer is **not** 100% yet. XEX session-key derivation/AES-CBC and the encrypted `decrypt → framing → LZX` integration critic are the active work. DELTA patch images stay fail closed until patch support is genuine.

## Active milestone — retail NORMAL XEX preparation

```text
STFS default.xex extraction                  ✓
XEX2 metadata decode                         ✓
metadata-derived mapper integration          ✓
NONE encryption / NONE compression prepare  ✓
BASIC compression / NONE encryption          ✓
NORMAL block/hash/chunk framing              ✓
Xenia LZX decompressor in wasm32             ✓
NORMAL encryption / XEX session key          ← ACTIVE
retail decrypt → frame → LZX integration     pending
DELTA patch images                           fail closed / pending
        ↓
prepared executable image
        ↓
XexGuestMapper + SparseGuestMemory           ✓ foundation
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
        ↓
first genuine kernel/runtime dependency
        ↓
Xenos → EDRAM → WebGPU/WGSL
        ↓
FIRST GENUINE GUEST FRAME
```

The encryption implementation must preserve Xenia's actual rules: decrypt the 16-byte XEX security-info AES key with the retail/devkit master key to derive the session key, then AES-128-CBC-decrypt executable data with a zero initial IV while preserving CBC chaining across streamed chunks. The combined gate must keep encrypted metadata intact and feed only genuinely decrypted bytes into the NORMAL framing layer before LZX.

## Public board

```text
OVERALL RENDER360
████████░░░░░░░░░░░░  ~41%  weighted engineering estimate

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
XEX PREPARE BASIC
████████████████████  100% ✓
XEX NORMAL FRAMING
████████████████████  100% ✓
XENIA LZX WASM FOUNDATION
████████████████████  100% ✓

FULL RETAIL XEX IMAGE PREPARATION
██████████████░░░░░░  ~70%  ← AES/session-key + end-to-end next
REAL XEX ENTRY EXECUTION
███░░░░░░░░░░░░░░░░░  early integration only
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

The partial bars are planning indicators only. A subsystem reaches **100%** only when its defined aggregate critic is green.

## Performance path after genuine execution starts

The architecture remains optimized for browser/mobile constraints:

```text
guest PPC / FPU / VMX128
        ↓
Xenia scanner + frontend + finalized HIR
        ↓
Hot WasmBackend
        ↓
cached generated Wasm + native Wasm SIMD
        ↓
SparseGuestMemory + executable-page invalidation
```

After genuine title execution is established, performance work focuses on keeping hot loops inside Wasm, minimizing JS↔Wasm crossings, retaining compiled-function caching, using native Wasm SIMD for VMX, streaming package/image data instead of duplicating whole titles in memory, and later moving GPU command processing toward worker/shared-memory queues where browser isolation permits it. For the first real frames, WebGPU/WGSL is primary and WebGL2 is the compatibility fallback.

## Next execution rule

After retail image preparation is proven, prepared bytes must stream into decoder-derived guest mappings, final RX/R/RW permissions must be sealed, the genuine entry address validated, and initial `PPCContext` state sent through Xenia's scanner/frontend/HIR and Hot WasmBackend. Execution stops visibly at the first genuine missing dependency. That real failure becomes the next target—`xboxkrnl`, XAM, TLS, threading, memory, VFS or Xenos—rather than being hidden by broad success stubs.

Portal 1/2 are later compatibility targets, not current boot claims. The first useful milestone is a genuine title reaching real guest instructions, then a genuine Xenos-produced frame; title-specific optimization comes after those foundations are real.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up: CPU/WASM integration, SparseGuestMemory, XEX decoder, preparer, crypto/LZX probes and guest mapper.
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
