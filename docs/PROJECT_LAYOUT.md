# Render360 repository layout

This document defines the repository organization from V36 forward. Existing root-level historical files are intentionally left in place until their references are audited; stability takes priority over cosmetic moves.

## Authoritative surfaces

- `/README.md` — single public status board and current milestone.
- `/VERSION` — current promoted project version.
- `/.github/workflows/` — CI gates. A milestone is not promoted to complete until its critic is green here.
- `/src/xenia_web_bootstrap/` — browser-native Xenia/PPC bring-up code, including sparse guest memory, Hot WasmBackend probes, and the V36 XEX guest mapper.
- `/src/xenia_web_shims/` — browser/wasm portability shims required by upstream Xenia code.
- `/xenia_port/` — imported/ported Xenia-facing source surface that predates the newer bootstrap organization; keep stable while migration is measured.

## Documentation

- `/docs/` — current project organization and future maintained documentation.
- Root `*_FOUNDATION.md`, `BROWSER_*.md`, `XENIA_WEB_BOOTSTRAP.md`, and `V*_RELEASE_NOTES.md` files are supporting/historical documents, not competing status boards.
- New release notes should be written under `/docs/releases/` once V36 is promoted. Legacy release-note paths should not be deleted until inbound references are checked.

## Tests

The existing root `test-*.mjs` files remain in place because CI references them directly. New bring-up critics may stay root-level until a single atomic test-directory migration can update every workflow and script together.

Current primary transition critic:

- `test-xex-guest-mapper.mjs` — RX/R/RW XEX mapping, chunk loading, overlap/wraparound rejection, entry validation, and fail-closed final permissions.

Synthetic PPC/Hot-WASM tests remain regression locks, but they are no longer the roadmap driver after the V36 XEX mapper passes.

## Build policy

1. Keep upstream Xenia-derived CPU/HIR sources separate from Render360 browser glue.
2. Do not delete or move working legacy paths just to make the tree look cleaner.
3. Add new title-bring-up code under `src/xenia_web_bootstrap/` until subsystem boundaries justify new directories.
4. Every new executable surface must be linked with `ERROR_ON_UNDEFINED_SYMBOLS=1` and have a fail-closed critic.
5. Update `README.md` and `VERSION` only after the corresponding CI gate is green.

## Next directory split

Once real `default.xex` metadata is feeding the V36 mapper, the next stable split is expected to be:

```text
src/
  xenia_web_bootstrap/
    xex_guest_mapper.*
    ...CPU/browser bootstrap...
  xenia_web_kernel/
    xboxkrnl_*.cpp
    xam_*.cpp
  xenia_web_gpu/
    xenos_*.cpp
    webgpu_*.cpp
    webgl2_*.cpp
  xenia_web_shims/
```

Those directories should be created when real title execution reaches the corresponding missing subsystem, rather than populated with speculative stubs.
