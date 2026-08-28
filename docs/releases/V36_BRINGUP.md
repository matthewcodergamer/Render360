# V36 XEX bring-up

V36 is the transition from closed synthetic CPU/browser foundations to genuine title-image bring-up.

## Locked foundation baseline

The eight CPU/browser foundations remain locked by **Xenia WASM32 Bootstrap Run 254** on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

Hot WasmBackend and Sparse Xbox Memory remain regression-locked foundations; V36 does not reopen their percentages.

## V36 strict mapper closure

`src/xenia_web_bootstrap/xex_guest_mapper.{h,cpp}` is a verified closed component layer on top of `SparseGuestMemory`.

The authoritative mapper gate is **Xenia WASM32 Bootstrap run 261** (Actions run ID `33212297082`) on implementation commit:

`f602d889293440a4840c3310a8e5fbf07ddc7756`

Conclusion: **SUCCESS**.

The mapper proves RX/R/RW section mapping, bounded loading, final permission sealing, overlap and wraparound rejection, executable-entry validation, and post-finalize fail-closed behavior. It closes the mapper component only; it does not claim genuine title execution.

## V36 strict STFS extraction closure

The complete pull-driven `default.xex` STFS extraction path is now verified by **Xenia WASM32 Bootstrap run 265** (Actions run ID `33218179582`) on implementation commit:

`0ba0587bc335ad8391f43cdc8c750da36d149005`

Conclusion: **SUCCESS**.

The run rebuilt `render360_xenia_core.wasm`, passed the strengthened STFS/XEX package critic, then passed the complete Xenia PPC/HIR bootstrap, locked foundation matrix, SparseGuestMemory gate, and V36 XEX mapper gate.

The extractor contract now includes:

```text
root default.xex discovery                    PASS
fragmented block-chain extraction             PASS
byte-for-byte complete reconstruction         PASS
extracted bytes == declared file length       PASS
expected block count == consumed blocks       PASS
declared valid/allocated block validation     PASS
exact 24-bit repeated/cyclic block detection  FAIL CLOSED
early/truncated chain                         FAIL CLOSED
out-of-range package request                  FAIL CLOSED
STFS_DEFAULT_XEX_EXTRACT                      PASS
STFS_CHAIN_CYCLE_FAIL_CLOSED                  PASS
STFS_DECLARED_BLOCK_TRUNCATION_FAIL_CLOSED    PASS
```

Cycle detection uses a compact bitset over the STFS 24-bit block-number space. The source package is still consumed through bounded pull requests, so the browser does not need to duplicate the entire package inside WebAssembly memory.

## Current boundary

A complete synthetic `default.xex` file is now proven through the real STFS block-chain machinery. What is **not** complete yet is full XEX2 image preparation suitable for genuine title execution.

The active real-title sequence is now:

```text
STFS root default.xex
        ↓
complete file extraction                    ✓
        ↓
XEX2 header/security/file-format decode     ← ACTIVE
        ↓
supported decrypt/decompress path
        ↓
real image base / entry / page descriptors
        ↓
real section addresses + permissions
        ↓
V36 XEX guest mapper                        ✓ component
        ↓
real RX / R / RW mappings
        ↓
genuine entry PC validation
        ↓
PPCContext + Xenia frontend / HIR
        ↓
Hot WasmBackend cache / dispatch
        ↓
first genuine title instruction
        ↓
first genuine missing kernel/runtime service
```

## Next CI gate: XEX2 image decode

The next critic must consume the exact reconstructed XEX bytes and prove image metadata rather than relying on synthetic mapper constants:

```text
XEX2 header / magic                    PASS
header table bounds                    PASS
security-info bounds                   PASS
image base                             VALID
entry point                            VALID
page/section descriptors               VALID
loader/security metadata               VALID
file-format metadata                   VALID
supported decode/decompression         PASS
unsupported encryption/compression     FAIL CLOSED
section ranges non-overlapping         PASS
32-bit range/wrap validation           PASS
XEX_IMAGE_DECODE                       PASS
```

Prefer Xenia's existing XEX/XEX2 structures and semantics wherever practical. After decode is green, feed those decoded values directly into the already-closed mapper and prove the integration without hard-coded section addresses.

## Following gate: real entry execution

After decoded XEX sections are mapped and the genuine entry PC is validated:

```text
construct PPCContext
        ↓
set genuine title entry
        ↓
Xenia PPCScanner / frontend
        ↓
finalized HIR
        ↓
Hot WasmBackend dispatch
        ↓
execute until first genuine unresolved dependency
```

That first failure chooses the next subsystem: xboxkrnl, XAM, TLS, threading, memory services, filesystem, or GPU initialization.

## Promotion rule

Do not mark `REAL XEX ENTRY EXECUTION`, kernel bring-up, GPU bring-up, a guest frame, playability, or FPS complete until the corresponding event comes from genuine title execution. Component critics close component contracts only.
