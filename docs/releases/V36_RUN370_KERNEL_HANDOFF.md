# V36 Run 370 — Kernel ABI handoff

Run 370 (Actions ID `33233219983`) completed successfully after the Run 369 kernel-execution closure was promoted into the public status board.

## Verified state

The controlled browser/Wasm bring-up path is closed through:

- retail XEX preparation and strict PE mapping;
- prepared entry into Xenia PPC/HIR;
- runtime-boundary telemetry;
- XEX import-library discovery;
- descriptor/thunk pairing through real PE RVA mapping;
- PPC → kernel HLE dispatch;
- automatic XEX import → kernel execution integration;
- exact fail-closed reporting for an unimplemented module/ordinal/thunk.

The root README remains intentionally at an overall weighted engineering estimate of about **50%**. This is not a title compatibility percentage.

## Active closure: D2B minimum kernel ABI + services

The next critic must prove the real guest-visible ABI, not merely dispatch:

```text
translated PPC caller
  → r3..r10 / FPR / vector arguments as required
  → exact xboxkrnl/XAM HLE export
  → validated guest pointer/range access
  → guest-visible mutation when required
  → r3 / NTSTATUS return value
  → normal guest return path
  → translated PPC continues
  → exact next blocker
```

No blanket success stubs are allowed. Service implementation order is selected by genuine execution blockers.

## First-frame rule

After the minimum kernel/runtime surface, work advances through guest threads/TLS and Xenos command processing toward WebGPU/WGSL. `FIRST GENUINE GUEST FRAME` is only promoted when the framebuffer originates from guest Xbox 360 GPU work; a browser-side test triangle does not count.

The first-frame workload should then remain permanently in CI and become the basis for performance work (Wasm reuse, SIMD, fewer JS↔Wasm transitions, worker queues, low internal resolution, shader/resource caching and EDRAM traffic optimization).
