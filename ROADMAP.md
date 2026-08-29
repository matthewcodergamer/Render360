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
Run 282  NONE/NONE image preparation
Run 288  BASIC/NONE image preparation
Run 294  NORMAL block/hash/chunk framing
Run 299  upstream Xenia LZX/libmspack in wasm32
```

Run 299 is Actions run ID `33222524497` on implementation commit `198744d214cc8eb6d2f88633f515d99ed8d69808`. Run 298 first exposed the genuine `xenia_log` dependency at strict link; Run 299 fixed that browser-portability edge and completed the full regression matrix.

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
XEX NORMAL FRAMING SUB-CONTRACT             100% ✓
XENIA LZX WASM FOUNDATION                   100% ✓
```

These are defined CI contracts, not claims of universal title compatibility.

## Run 294 — NORMAL framing

Render360 follows Xenia's `ReadImageCompressed` block model: SHA-1 validates every declared block, each block starts with the chained next-block size/hash, BE16 chunk lengths identify the compressed pieces, zero terminates each block, and only compressed bytes are compacted into the deblocked output stream.

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

## Run 299 — upstream Xenia LZX in wasm32

The Xenia PPC/HIR bootstrap now directly compiles Xenia `src/xenia/cpu/lzx.cc` plus its vendored libmspack LZX implementation to wasm32. A thin Render360 probe feeds the upstream function and does not reproduce the decompressor.

The critic uses valid LZX UNCOMPRESSED-block streams with changed payloads, then corrupt/window/bounds adversaries:

```text
XENIA_LZX_WASM_DECOMPRESS=PASS
XENIA_LZX_REUSE_CHANGED_PAYLOAD=PASS
XENIA_LZX_WINDOW_FAIL_CLOSED=PASS
XENIA_LZX_CORRUPT_STREAM_FAIL_CLOSED=PASS
XENIA_LZX_PROBE_BOUNDS_FAIL_CLOSED=PASS
XEX_NORMAL_LZX_FOUNDATION=PASS
```

## Active Gate D0 — retail XEX encryption and full preparation

```text
exact extracted default.xex                   ✓
XEX2 metadata                                 ✓
decoded metadata → mapper                     ✓
NONE/NONE preparation                         ✓
BASIC/NONE preparation                        ✓
NORMAL framing/deblocking                     ✓
NORMAL LZX decoder                            ✓
XEX retail/devkit session-key derivation      ← ACTIVE
streaming AES-128-CBC                         ← ACTIVE
retail decrypt → framing → LZX integration    NEXT
DELTA patch path                              fail closed / pending
```

Xenia's real non-patch encryption contract is:

```text
security_info.aes_key
      ↓ AES-128-CBC decrypt, zero IV
retail master key or devkit master key
      ↓
XEX session key
      ↓ AES-128-CBC decrypt, zero initial IV
executable ciphertext stream
      ↓ preserve CBC IV across chunks
plaintext compressed XEX payload
```

The implementation must use Xenia's Rijndael source and preserve block alignment/chaining. Keys remain in wasm/native state rather than being exposed as a browser-JS title-key API.

### Full retail NORMAL closure critic

After the standalone AES/session-key gate is green, the combined critic must keep `encryption=NORMAL` in the XEX metadata and prove:

```text
encrypted security AES key
  → genuine session key derivation
  → encrypted NORMAL payload
  → streaming AES-CBC plaintext
  → NORMAL block/hash/chunk validation
  → deblocked compressed stream
  → upstream Xenia LZX
  → exact expected executable bytes
```

Omitting crypto, using the wrong master key, hash corruption, AES misalignment, malformed framing or LZX corruption must fail closed.

## Gate D1 — prepared image → real guest mappings

Once retail image preparation is proven, stream the prepared image into decoder-derived mappings without a package-sized duplicate:

```text
prepared executable bytes
  → decoded XEX pages/sections
  → RX / R / RW SparseGuestMemory mappings
  → final permission seal
  → genuine entry PC validation
```

The decoded-metadata mapper is already a locked foundation. D1 adds genuine prepared payload bytes rather than synthetic mapper data.

## Gate D2 — first genuine entry execution

Construct the initial `PPCContext`, set the genuine title entry PC and execute:

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

## Gate D3 — minimum runtime selected by genuine failures

```text
xboxkrnl import       → minimum required xboxkrnl HLE/export
XAM import            → minimum required XAM surface
TLS                    → TLS initialization
thread creation       → KernelState / guest thread runtime
heap / virtual memory → required kernel memory service
filesystem            → browser-backed VFS
GPU initialization    → Xenos command/ringbuffer path
```

## Gate D4 — genuine GPU path

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

Only after this chain produces a guest framebuffer can `FIRST GENUINE FRAME` be promoted.

## Performance work after genuine execution exists

Keep hot execution inside Wasm, retain compiled-function caching/executable-page invalidation, use native Wasm SIMD for VMX, reduce JS↔Wasm crossings, stream large package/image data instead of duplicating it, and later use worker/shared-memory command paths where browser isolation allows. Initial rendering should prioritize low internal resolution and correctness before heavier visual features.

## Compatibility ladder

```text
8 CPU/browser foundations                    ✓ LOCKED
V36 strict XEX mapper                        ✓ LOCKED
full default.xex STFS extraction             ✓ LOCKED
XEX2 metadata decode                         ✓ LOCKED
decoded metadata → mapper                    ✓ LOCKED
NONE/NONE image preparation                  ✓ LOCKED
BASIC XEX preparation                        ✓ LOCKED
NORMAL block/hash/chunk framing              ✓ LOCKED
upstream Xenia LZX in wasm32                 ✓ LOCKED
XEX session-key / AES-CBC                    ← ACTIVE
retail NORMAL end-to-end preparation
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
Portal 2-class bring-up
```

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, guest FPS, shader translation or title boot unless the event came from genuine execution through the corresponding emulator subsystem.
