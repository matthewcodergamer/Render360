# Render360 browser stack geometry

This file records the stack layout enforced by the browser title handoff and the guest-thread runtime. It also intentionally lives in the Xenia/WASM source closure so changes to these invariants trigger the full bootstrap build and harsh critics.

## Browser main thread

The browser launch context follows Xenia `XThread::AllocateStack` semantics rather than mapping usable stack RAM directly at the raw slot boundary.

- Reserved slot: `0x70000000` through `0x70FFFFFF`.
- Lower guard page: `0x70000000` through `0x70000FFF` (unmapped).
- `stack_limit`: `0x70001000`.
- Usable main-thread stack: 128 pages / 512 KiB, `0x70001000` through `0x70080FFF`.
- `stack_base` high boundary: `0x70081000`.
- Initial PPC `r1`: high boundary minus Xenia's 64 + 112 byte call frame, 16-byte aligned.
- The XTHREAD-compatible stack-base field stores the high boundary, not the low address.

The real-device Braid address `0x70080020` is therefore inside the usable stack. The earlier Render360 layout was shifted down by one guard page and ended at `0x7007FFFF`.

## Kernel-created guest threads

Guest threads use 16 MiB virtual slots beginning at `0x60000000`.

- Default stack size when the title passes zero: 256 KiB (`0x40000`).
- One unmapped guard page is kept below the usable stack.
- One unmapped guard page is kept above the usable stack.
- Slot 16 is reserved because it is owned by the browser main-thread launch context at `0x70000000`.

The runtime must fail closed if a stack mapping would overlap an occupied guest range.

## Diagnostics

PPC blocker reports decode the instruction by primary opcode. Direct/conditional branches are reported as branches and are never interpreted as D-form `rA + displacement` memory operations. A sparse-memory fault captured while the boundary instruction is a branch is explicitly marked as not derived from that boundary instruction.
