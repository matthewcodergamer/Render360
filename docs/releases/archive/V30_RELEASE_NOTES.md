# V30 release notes — native STFS mount

V30 replaces the old “LIVE magic recognized” boundary with a native C++/WASM STFS mount state machine.

## Added
- `src/xenia_port/stfs_layout.h`, a small Xenia-aligned STFS on-disk contract.
- Pull I/O ABI: WASM requests an exact 64-bit package offset and byte count; JavaScript only performs the browser `File.slice()` and returns bytes.
- Native XContent/STFS header and volume-descriptor parsing.
- Xenia-aligned STFS block-to-offset math.
- Native L0/L1/L2 hash-table active-index traversal for resilient layouts; read-only packages skip secondary tables as Xenia does.
- Native 0x40-byte directory-entry parsing.
- Native file-table chain traversal with bounded entry storage.
- Root `default.xex` lookup and first-data-block XEX1/XEX2 probe.
- STFS mount/request/entry telemetry in the UI.
- Browser bridge integration test plus native smoke test.
- Three.js diagnostic automatically disabled when content is selected.

## Verified by the included smoke test
A synthetic LIVE package uses two non-adjacent directory blocks linked through the STFS level-0 hash table. V30 follows the chain, enumerates both entries, finds `default.xex`, requests its real STFS data block and identifies `XEX2`.

## Strict boundary
V30 does **not** extract the entire executable, decrypt/decompress XEX, map a PE image, execute PowerPC, start the Xbox kernel or render Xenos commands. V31 is full `default.xex` block-chain extraction/VFS.
