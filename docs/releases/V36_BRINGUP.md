# V36 XEX bring-up

V36 is the transition from closed synthetic CPU/browser foundations to title-image bring-up.

## Locked baseline

The baseline remains Xenia WASM32 Bootstrap Run 254 / commit `3b39da31b6fc3e296e356f7143574951f7fc8861` until a newer aggregate run completes green. Hot WasmBackend and Sparse Xbox Memory remain regression-locked foundations; V36 does not reopen their percentages.

## V36 implementation

`src/xenia_web_bootstrap/xex_guest_mapper.{h,cpp}` adds the first strict title-image mapping layer on top of SparseGuestMemory.

Contract:

```text
reset
map_section(address, virtual_size, final RX/R/RW protection)
load(address, bytes) in chunks
set_entry(real guest PC)
finalize
status / entry_address / section_count / mapped_bytes
```

Sections are writable only during loading. `finalize` validates that the entry PC lies inside an executable section and then seals each section to its final permissions. Any overlap, wraparound, invalid entry, post-finalize mutation, or underlying sparse-memory failure fails closed.

The WASM staging buffer is deliberately bounded. Real section payloads are intended to stream through it in chunks rather than requiring a second copy of the full title image in browser memory.

## V36 CI critic

`test-xex-guest-mapper.mjs` requires:

```text
RX code mapping                     PASS
R rodata mapping                    PASS
RW data mapping                     PASS
section byte loading                PASS
RX write rejection                  PASS
R write rejection                   PASS
RW write/read                        PASS
overlapping section rejection       PASS
32-bit wraparound rejection         PASS
entry outside executable mapping    FAIL CLOSED
entry inside executable mapping     PASS
post-finalize remap                 FAIL CLOSED
XEX_GUEST_MAPPING                   PASS
XEX_ENTRY_VALIDATION                PASS
```

## Important real-title prerequisite discovered

The legacy native STFS core currently locates root `default.xex` and probes its first data block, but does not yet extract the complete `default.xex` block chain or perform all XEX image decode work needed to feed real sections into the V36 mapper.

Therefore the real bring-up sequence is:

```text
STFS default.xex full-chain extraction
        ↓
XEX image decode / section metadata
        ↓
V36 XEX guest mapper
        ↓
real RX / R / RW mappings
        ↓
real entry PC validation
        ↓
PPCContext + Xenia frontend/HIR
        ↓
Hot WasmBackend dispatch
        ↓
first title instruction
        ↓
first genuine missing kernel/runtime service
```

Do not mark `REAL XEX MAPPER / ENTRY` complete merely because the synthetic mapper critic passes. The mapper layer may be promoted as complete, but real-title entry execution remains active until actual extracted title metadata and bytes pass through it.
