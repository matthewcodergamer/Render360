# Braid runtime gate

This marker documents the commercial-title CPU regression that must remain green before publishing the browser bootstrap.

The Braid startup path under test is: PPC scalar load -> HIR `LOAD_OFFSET` (opcode 37) -> `BYTE_SWAP` -> CTR -> HIR `CALL_INDIRECT` (opcode 9) -> XAM thunk dispatch (`xam.xex` ordinal `0x28B`).

The authoritative gate is `test-wasm-backend-calls.mjs`, which must print `BRAID_LOAD_OFFSET_CALL_INDIRECT_XAM=PASS`. The native HIR executor must also preserve 32-bit PPC effective-address wrap semantics for signed displacements.
