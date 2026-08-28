# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence and do not override the verified status below.

## Authoritative verified gates

- **Run 254** — eight CPU/browser foundations, implementation commit `3b39da31b6fc3e296e356f7143574951f7fc8861`.
- **Run 261** (Actions ID `33212297082`) — strict V36 XEX guest mapper, implementation commit `f602d889293440a4840c3310a8e5fbf07ddc7756`.
- **Run 265** (Actions ID `33218179582`) — strict full pull-driven STFS `default.xex` extraction, implementation commit `0ba0587bc335ad8391f43cdc8c750da36d149005`.
- **Run 276** (Actions ID `33219831630`) — strict XEX2 metadata decode plus decoded-metadata → `XexGuestMapper` integration, implementation commit `c9fe8dec88e47b2ded17a0ede461bcf3d44acbe7`.

Run 276 completed successfully after rebuilding the package/XEX WASM core, passing the STFS regression, passing the new XEX2 decode critic, checking current Xenia contracts, compiling/linking the Xenia PPC/HIR WASM bootstrap, and re-running all locked foundations plus the decoded mapper-integration critic.

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
XEX DECODED-METADATA → MAPPER INTEGRATION
████████████████████  100% ✓
```

These percentages close **defined CI contracts**, not universal Xbox 360 compatibility.

## Run 276 XEX decode contract

The new decoder lives under `src/xenia_web_bootstrap/xex_image_decoder.{h,cpp}` with a dedicated `r360_xex_decode_*` ABI so it does not collide with the older lightweight XEX inspector.

It validates:

```text
XEX2 magic / top-level header                 PASS
optional-header table bounds                  PASS
security-info bounds                          PASS
image base / load address / image size        VALID
entry point                                    VALID
execution title/media metadata                VALID
file-format metadata                          VALID
encryption NONE / NORMAL classification       PASS
compression NONE / BASIC / NORMAL metadata    PASS
DELTA compression before patch support        FAIL CLOSED
page-descriptor table                         PASS
code/data/readonly section types              PASS
Xenia 64 KiB / 4 KiB image-page rule          PASS
image/descriptor 32-bit range checks          PASS
entry outside image                           FAIL CLOSED
corrupt/truncated descriptor/header data      FAIL CLOSED
XEX_IMAGE_DECODE                              PASS
```

The page layout follows current Xenia behavior: images based at or below `0x90000000` use 64 KiB image pages, while higher images use 4 KiB pages. Page descriptors are decoded from Xenia's type/page-count representation rather than from a Render360-only section format.

### Important boundary

`XEX2 IMAGE METADATA DECODE = 100%` does **not** mean compressed/encrypted executable payloads are already prepared for execution. Run 276 closes metadata interpretation and validation. Actual image decryption/decompression/materialization is the next gate.

## Run 276 decoded mapper integration

The integration critic loads the package/XEX decoder WASM and the real Xenia PPC/HIR bootstrap WASM together. Section types, guest addresses, byte sizes and the entry PC are read from decoder exports and passed directly to `XexGuestMapper`.

```text
XEX descriptor code       → R|X mapping
XEX descriptor readonly   → R mapping
XEX descriptor data       → R|W mapping
decoded entry PC          → mapper set_entry / finalize
RX after finalize         → write rejected
RW after finalize         → writable
second relocated XEX base → independently derived mapping
XEX_REAL_MAPPER_INTEGRATION=PASS
```

The critic runs the same metadata path at two different Xbox guest bases so a hard-coded `0x82...` mapper result cannot satisfy the gate.

## Active milestone — XEX image preparation

The next real implementation is the payload path that sits between decoded XEX metadata and the already-closed mapper:

```text
STFS default.xex extraction                  ✓
        ↓
XEX2 metadata decode                         ✓
        ↓
XEX IMAGE PREPARATION                        ← ACTIVE
        ├── unencrypted / uncompressed first
        ├── BASIC compression
        ├── NORMAL LZX compression
        └── NORMAL encryption / session key
        ↓
prepared executable image bytes
        ↓
decoded section/page layout                  ✓
        ↓
XexGuestMapper + SparseGuestMemory           ✓
        ↓
real entry PC
        ↓
PPCContext
        ↓
Xenia PPCScanner / frontend / finalized HIR
        ↓
Hot WasmBackend
        ↓
FIRST GENUINE TITLE INSTRUCTIONS
        ↓
first real unresolved kernel/runtime service
```

Image preparation must follow Xenia semantics. Unsupported patch/delta forms remain fail-closed until their real patch path is implemented. Browser integration should remain pull-driven/chunked rather than duplicating an entire package in JavaScript or WASM memory unnecessarily.

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

XEX IMAGE PREPARATION / DECOMPRESS / DECRYPT
██░░░░░░░░░░░░░░░░░░  ← ACTIVE
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

## Next execution rule

Once image preparation is proven, the prepared image must be loaded at the decoder-derived guest addresses, final RX/R/RW protections applied, the genuine XEX entry address validated, and an initial `PPCContext` sent through Xenia's scanner/frontend/HIR and the Hot WasmBackend. Execution stops visibly at the first genuine missing dependency. That real failure becomes the next implementation target — `xboxkrnl`, XAM, TLS, threading, memory services, VFS or Xenos — rather than being hidden behind broad success stubs.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native Xenia/PPC/title bring-up, SparseGuestMemory, Hot WasmBackend, XEX decoder and XEX guest mapper.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `xenia_port/` — older imported/ported Xenia-facing surface retained until references can be migrated safely.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

Working root tests are migrated only when references and CI can move atomically. See [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

A subsystem reaches **100%** only when its defined aggregate CI gate proves that exact contract. Metadata decode is not image preparation; mapper integration is not real title execution; a synthetic component critic cannot be used to claim a genuine title boot, guest frame, playability or FPS.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — V36 real-title implementation order
- [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md) — verified V36 bring-up gates
- [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md) — repository ownership/layout policy
- [`XENIA_WEB_BOOTSTRAP.md`](XENIA_WEB_BOOTSTRAP.md) — Xenia/WebAssembly bootstrap details
- [`WASM_BACKEND_FOUNDATION.md`](WASM_BACKEND_FOUNDATION.md) — WasmBackend implementation history
- [`FPU_FOUNDATION.md`](FPU_FOUNDATION.md) — FPU foundation
- [`VMX_FOUNDATION.md`](VMX_FOUNDATION.md) — VMX / VMX128 foundation
- [`BROWSER_NATIVE_ARCHITECTURE.md`](BROWSER_NATIVE_ARCHITECTURE.md) — browser-native architecture
- [`UPSTREAM_PORT_MAP.md`](UPSTREAM_PORT_MAP.md) — upstream Xenia port map

Older root `V*_RELEASE_NOTES.md` files are historical records only.

## License

Xenia-derived portions remain subject to the upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
