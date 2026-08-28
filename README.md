# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.**  
> Historical release notes and foundation documents are supporting evidence; they do not override the verified status below.

## Authoritative verified gates

The eight CPU/browser foundations remain closed by **Xenia WASM32 Bootstrap Run 254** on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

The V36 strict XEX guest mapper is separately closed by **run 261** (Actions run ID `33212297082`) on implementation commit:

`f602d889293440a4840c3310a8e5fbf07ddc7756`

The full pull-driven STFS `default.xex` extraction contract is closed by **run 265** (Actions run ID `33218179582`) on implementation commit:

`0ba0587bc335ad8391f43cdc8c750da36d149005`

Run 265 completed successfully after rebuilding the package/XEX WASM core, passing the strengthened STFS extraction critic, compiling/linking the Xenia PPC/HIR bootstrap, and re-running the locked foundations plus the V36 mapper regression.

## Foundation and bring-up status

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
  root default.xex discovery
  fragmented block-chain extraction
  exact byte-for-byte reconstruction
  extracted bytes == declared file length
  expected block accounting
  valid/allocated block validation
  24-bit cycle/repeated-block detection
  truncated/early chain fail closed
  out-of-range source request fail closed
  STFS_DEFAULT_XEX_EXTRACT=PASS
```

## What run 265 added

The older V32 package core already had a pull-driven fragmented entry extractor. V36 hardens that path rather than replacing it.

```text
STFS file entry
   ↓
validate declared length / valid blocks / allocated blocks
   ↓
mark first 24-bit data block
   ↓
request one bounded package range
   ↓
copy only that chunk through WASM staging memory
   ↓
resolve next STFS hash-chain block
   ↓
reject repeated/cyclic block
   ↓
continue until exact declared byte length
   ↓
require blocks_done == expected_blocks
   ↓
COMPLETE
```

The cycle detector is a compact bitset covering the STFS 24-bit block-number space. This keeps extraction exact without buffering another whole package in WebAssembly memory.

Verified critic lines include:

```text
PACKAGE_XEX_FOUNDATION=PASS
STFS_DEFAULT_XEX_EXTRACT=PASS
STFS_CHAIN_CYCLE_FAIL_CLOSED=PASS
STFS_DECLARED_BLOCK_TRUNCATION_FAIL_CLOSED=PASS
```

## Active milestone — XEX2 image decode / real title metadata

Synthetic CPU expansion and STFS extraction are no longer the roadmap driver. The active implementation path is now:

```text
STFS package
       ↓
complete default.xex extraction             ✓
       ↓
XEX2 header / optional-header decode        ← ACTIVE
       ↓
security + file-format metadata
       ↓
supported decrypt/decompress path
       ↓
real image base / entry / page descriptors
       ↓
derive real RX / R / RW guest sections
       ↓
V36 XEX guest mapper                        ✓ component
       ↓
validate genuine XEX entry address
       ↓
construct PPCContext / initial state
       ↓
Xenia PPCScanner / frontend
       ↓
Xenia finalized HIR
       ↓
Hot WasmBackend cache / dispatch
       ↓
EXECUTE FIRST TITLE INSTRUCTIONS
       ↓
FAIL CLOSED on first missing import / kernel / runtime service
```

The next gate is `XEX_IMAGE_DECODE=PASS`. It must consume the exact extracted XEX bytes and validate real XEX-derived metadata rather than feeding hard-coded addresses into the mapper.

## Next decode contract

```text
XEX2 magic/header                     PASS
header table bounds                   PASS
security-info bounds                  PASS
image base                            VALID
entry point                           VALID
page/section descriptors              VALID
loader/security metadata              VALID
file-format metadata                  VALID
supported compression/decode          PASS
unsupported encryption/compression    FAIL CLOSED
section ranges non-overlapping         PASS
32-bit range/wrap validation           PASS
XEX_IMAGE_DECODE                       PASS
```

Prefer Xenia's existing XEX/XEX2 structures and semantics wherever practical instead of creating a second incompatible parser.

## After XEX image decode

```text
XEX-derived sections
       ↓
V36 mapper integration critic
       ↓
real entry PC validation
       ↓
PPCContext
       ↓
Xenia scanner / frontend / HIR
       ↓
Hot WasmBackend
       ↓
first genuine title instruction
       ↓
first genuine unresolved dependency
```

That first real failure chooses the next subsystem automatically: minimum required `xboxkrnl`, XAM, TLS, guest threading, memory services, browser-backed VFS, or Xenos GPU initialization. Broad unknown-import “return success” stubs are not used to fake progress.

## Public board

```text
8 CPU/browser foundations
████████████████████  100% ✓
V36 STRICT XEX GUEST MAPPER
████████████████████  100% ✓
FULL default.xex STFS EXTRACTION
████████████████████  100% ✓

XEX2 IMAGE DECODE / REAL METADATA
██░░░░░░░░░░░░░░░░░░  ← ACTIVE
REAL XEX MAPPER INTEGRATION
░░░░░░░░░░░░░░░░░░░░
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

## Repository organization

Current maintained ownership remains intentionally incremental:

- `src/xenia_web_bootstrap/` — browser-native Xenia/PPC bring-up, SparseGuestMemory, Hot WasmBackend probes, and V36 XEX guest mapper.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `xenia_port/` — older imported/ported Xenia-facing source retained until references can be migrated safely.
- `docs/` — maintained project organization and release documentation.
- `.github/workflows/` — aggregate regression gates.

Working root tests and historical documents are not mass-moved merely for cosmetic organization. References and CI must be migrated atomically. See [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Current engineering rule

A subsystem reaches **100%** only when its defined CI gate proves that exact contract. A component critic cannot be used to claim genuine title execution, a guest frame, playability, or FPS.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — V36 real-title implementation order and gates
- [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md) — V36 mapper/STFS closures and title bring-up boundary
- [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md) — stable repository ownership/layout policy
- [`XENIA_WEB_BOOTSTRAP.md`](XENIA_WEB_BOOTSTRAP.md) — Xenia/WebAssembly bootstrap details
- [`WASM_BACKEND_FOUNDATION.md`](WASM_BACKEND_FOUNDATION.md) — WasmBackend implementation history and probes
- [`FPU_FOUNDATION.md`](FPU_FOUNDATION.md) — floating-point foundation
- [`VMX_FOUNDATION.md`](VMX_FOUNDATION.md) — VMX / VMX128 foundation
- [`BROWSER_NATIVE_ARCHITECTURE.md`](BROWSER_NATIVE_ARCHITECTURE.md) — browser-native architecture
- [`UPSTREAM_PORT_MAP.md`](UPSTREAM_PORT_MAP.md) — upstream Xenia port map

Older root `V*_RELEASE_NOTES.md` files are retained as historical records only.

## License

Xenia-derived portions remain subject to the upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
