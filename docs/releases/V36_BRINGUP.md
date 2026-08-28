# V36 XEX bring-up

V36 is the transition from closed synthetic CPU/browser foundations to genuine title-image bring-up.

## Locked foundation baseline

The eight CPU/browser foundations remain locked by **Xenia WASM32 Bootstrap Run 254** on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

Hot WasmBackend and Sparse Xbox Memory remain regression-locked foundations; V36 does not reopen their percentages.

## V36 strict mapper closure

`src/xenia_web_bootstrap/xex_guest_mapper.{h,cpp}` is now a verified closed component layer on top of `SparseGuestMemory`.

The authoritative mapper gate is **Xenia WASM32 Bootstrap run 261** (Actions run ID `33212297082`) on implementation commit:

`f602d889293440a4840c3310a8e5fbf07ddc7756`

Conclusion: **SUCCESS**.

Contract:

```text
reset
map_section(address, virtual_size, final RX/R/RW protection)
load(address, bytes) in bounded chunks
set_entry(real guest PC)
finalize
status / entry_address / section_count / mapped_bytes
```

Sections are writable only while loading. `finalize` validates that the entry PC lies inside an executable section and then seals each section to its requested final permissions. Overlap, 32-bit wraparound, invalid entry, post-finalize mutation, or underlying sparse-memory failure fails closed.

The bounded WASM staging buffer is deliberate: real section payloads should stream through it rather than requiring another complete in-memory copy of the title image.

## Verified V36 critic

The green run gates:

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
post-finalize mutation              FAIL CLOSED
XEX_GUEST_MAPPING                   PASS
XEX_ENTRY_VALIDATION                PASS
```

The mapper contract is therefore **100% for its defined V36 scope**.

## Boundary: what is not complete yet

The successful mapper critic does **not** mean a genuine title entry has executed. The legacy native STFS path can locate root `default.xex` and inspect initial package data, but the project still needs a proven complete `default.xex` file extraction path and full XEX2 image decode before real sections can feed the mapper.

The active real-title sequence is:

```text
STFS root default.xex
        ↓
walk complete file block chain
        ↓
produce exact complete default.xex bytes
        ↓
XEX2 decode / decompression / metadata
        ↓
real section addresses + permissions
        ↓
V36 XEX guest mapper
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

## Next CI gate: complete STFS `default.xex` extraction

The next critic should prove the file rather than assume it:

```text
root default.xex located             PASS
reported file size validated         PASS
first data block validated           PASS
complete block chain walked          PASS
all file blocks read exactly once    PASS
short/truncated chain                FAIL CLOSED
out-of-range block                   FAIL CLOSED
cycle/repeated block                 FAIL CLOSED
extracted byte count == file size    PASS
STFS_DEFAULT_XEX_EXTRACT             PASS
```

The extractor should expose streaming/random-access reads suitable for browser `Blob`/`File` slices and future OPFS-backed sources. Do not require the full package plus another full package-sized buffer in memory.

## Following gate: XEX2 image decode

Once complete `default.xex` bytes are proven, decode real XEX2 metadata using Xenia structures/semantics wherever possible:

```text
XEX2 header / magic                    PASS
image base                             VALID
entry point                            VALID
section/page descriptors               VALID
loader/security metadata               VALID
supported decode/decompression         PASS
unsupported format                     FAIL CLOSED
section ranges non-overlapping         PASS
32-bit range/wrap validation           PASS
XEX_IMAGE_DECODE                       PASS
```

Then feed those decoded values into the already-closed mapper. The integration critic must consume XEX-derived metadata rather than hard-coded synthetic mappings.

## Promotion rule

Do not mark `REAL XEX ENTRY EXECUTION`, kernel bring-up, GPU bring-up, a guest frame, playability, or FPS complete until the corresponding event comes from genuine title execution. Component critics close component contracts only.
