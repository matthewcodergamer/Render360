# Render360 V74 diagnostic plan

The verified V74 browser bootstrap remains the runtime baseline. The first post-rollback change is intentionally JavaScript-only: map the already-captured PPC call timeline back to the decoded XEX kernel import plan so we can identify every kernel service reached before the final xboxkrnl ordinal 0x28 boundary.

No WebAssembly, PPC translation, stack geometry, sparse guest memory, kernel service behavior, or GPU behavior is changed by this diagnostic step.

Observed Braid checkpoint from the iPhone V74 report:

- Runtime release: 74
- Entry: `0x8236EF38`
- Native HIR compatibility execution: 38 instructions
- Final call site: `0x8237386C -> 0x82559584`
- Final import: `xboxkrnl.exe` ordinal `0x28`
- Sparse-memory fault code: 0 (`none`)
- Kernel calls observed: 5

Goal: expose the exact module/ordinal sequence for those five calls before changing emulator behavior.
