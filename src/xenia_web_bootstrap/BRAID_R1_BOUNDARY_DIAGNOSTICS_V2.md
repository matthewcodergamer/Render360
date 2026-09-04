# Braid r1 boundary diagnostics v2

Real-device blocker `0xEB61FFD0` decodes as PPC64 `ld r27,-48(r1)` (primary opcode 58, RA=1, RT=27). With the captured effective address `0x70081020`, the live base register is therefore `r1=0x70081050`, above the Xenia stack high boundary `0x70081000`.

The upper page is intentionally a no-access guard in Xenia and must not be mapped writable to hide the fault. This diagnostic pass exports the native HIR executor's blocker r1, initial r1, last r1 write, and last guest-call trace so the exact state transition causing the boundary crossing can be identified on the next device run.
