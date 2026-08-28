# Render360 repository layout — V36

This document defines repository ownership from V36 forward. Existing root-level historical files are intentionally left in place until their references are audited; stability takes priority over cosmetic moves.

## Authoritative surfaces

- `/README.md` — single public status board and current milestone.
- `/VERSION` — current promoted project version (`36`).
- `/.github/workflows/` — CI gates. A component or milestone is promoted only after its defined critic is green.
- `/src/xenia_web_bootstrap/` — browser-native Xenia/PPC bring-up code, SparseGuestMemory, Hot WasmBackend probes, and the closed V36 XEX guest mapper.
- `/src/xenia_web_shims/` — browser/WASM portability shims required by upstream Xenia-facing code.
- `/xenia_port/` — imported/ported Xenia-facing source surface that predates the newer bootstrap organization; keep stable while migration is measured.

## Documentation

- `/docs/` — maintained project organization and current/future documentation.
- `/docs/releases/` — promoted release/bring-up notes beginning with `V36_BRINGUP.md`.
- Root `*_FOUNDATION.md`, `BROWSER_*.md`, `XENIA_WEB_BOOTSTRAP.md`, and older `V*_RELEASE_NOTES.md` files are supporting/historical documents, not competing status boards.
- Legacy documentation paths should not be deleted or moved until inbound references and workflow/script references are checked.

## Tests

The existing root `test-*.mjs` files remain in place because CI and scripts reference them directly. New title-bring-up critics may remain root-level until a single atomic test-directory migration can update every reference together.

Current V36 closed component critic:

- `test-xex-guest-mapper.mjs` — RX/R/RW XEX mapping, bounded chunk loading, overlap/wraparound rejection, entry validation, permission sealing, and fail-closed post-finalize behavior.

Next active critic should prove complete STFS extraction of root `default.xex`, including the full file block chain and exact byte count.

Synthetic PPC/Hot-WASM tests remain regression locks, but they are no longer the roadmap driver.

## Build policy

1. Keep upstream Xenia-derived CPU/HIR semantics separate from Render360 browser glue.
2. Do not delete or move working legacy paths merely to make the tree look cleaner.
3. Add title bring-up code under `src/xenia_web_bootstrap/` until genuine execution reaches a new subsystem boundary.
4. Prefer streaming/random-access package reads suitable for browser `Blob`/`File` slices and OPFS rather than whole-image duplication in memory.
5. Every new executable surface must preserve strict linking (`ERROR_ON_UNDEFINED_SYMBOLS=1`) and fail closed on unsupported behavior.
6. Keep Run-254 foundations regression-locked while new real-title gates are added.
7. Update public completion claims only after their corresponding aggregate critic is green.

## Planned subsystem split

Do not create empty speculative subsystem trees. Create these directories only when genuine title execution reaches the relevant boundary:

```text
src/
  xenia_web_bootstrap/
    xex_guest_mapper.*
    stfs_default_xex_reader.*      # next, once implemented
    xex_image_loader.*             # after extraction gate
    title_entry_bootstrap.*        # after real metadata gate
    ...existing CPU/browser bootstrap...

  xenia_web_kernel/                # create on first genuine kernel/XAM failure
    xboxkrnl_*.cpp
    xam_*.cpp

  xenia_web_gpu/                   # create when title execution reaches Xenos
    xenos_*.cpp
    webgpu_*.cpp
    webgl2_*.cpp

  xenia_web_shims/
```

Names above describe intended ownership; they are not claims that those future files already exist.

## Migration rule

When legacy root code or tests are moved, perform the move as one measured change:

```text
move files
  → update include/import paths
  → update build scripts
  → update workflow references
  → update browser/runtime references if applicable
  → run the full affected critic
  → keep the move only if green
```

This keeps repository cleanup from becoming an emulator regression source.
