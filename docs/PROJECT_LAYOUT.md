# Render360 repository layout

This document defines the current repository ownership model. Production code uses semantic filenames. Do not create `app-vXX`, `ui-vXX`, `runtime-vXX`, `*-hotfix` copies, or other parallel generations for ordinary changes; edit the authoritative file in place.

## Browser application

- `/index.html` — one browser entry document. It loads the final production CSS before first paint and the canonical JavaScript entrypoints.
- `/app.js` — application state, library, import, settings, input, storage and runtime orchestration.
- `/ui-behavior.js` — browser/iOS interaction behavior, artwork hydration, direct-play gestures and storage UI helpers.
- `/ui.js` — Settings/Profile chrome, controller UI helpers and performance HUD behavior.
- `/developer-console.js` — local developer console and runtime diagnostics UI.
- `/styles/base.css` — application layout and base appearance.
- `/styles/interactions.css` — touch/library interaction styling.
- `/styles/xenios.css` — XeniOS-inspired library/settings/HUD styling.
- `/styles/controller.css` — touch-controller geometry and control palette.

There is no supported production V41/V42/V44 UI patch chain. Changes to the browser application should modify the files above directly.

## Browser runtime

- `/runtime/render360-runtime.js` — high-level title runtime API and telemetry.
- `/runtime-host.js` — browser worker host/input bridge.
- `/runtime-worker.js` — runtime worker loop.
- `/wasm-core.js` — package/XEX WebAssembly loader.
- `/render360-browser-title-runtime.mjs` — PPC title runtime/session bridge.
- `/render360-browser-thread-scheduler.mjs` — cooperative Xbox thread scheduler.
- `/render360-browser-modern-content-bridge.mjs` — XEX/STFS launch bridge.
- `/render360-browser-modern-iso-bridge.mjs` — ISO/XDVDFS launch bridge.

Runtime modules may be split by responsibility, but not duplicated by release number.

## Package/XEX core

- `/package-core.cpp` — canonical package-core build entry. It extends the base package/STFS implementation with complete-entry extraction.
- `/render360_xenia_core.cpp` — internal package/STFS base implementation used by `package-core.cpp`.
- `/build-core.sh` — canonical package-core build script; it builds `render360_xenia_core.wasm` from `package-core.cpp` plus the current XEX preparation/PE layers.
- `/render360_xenia_core.wasm` and `/render360_xenia_core.meta.json` — generated browser package-core artifact and metadata.

Do not add another `render360_xenia_core_vXX.cpp`. Extend the current package core or move reusable implementation into a semantically named module.

## Xenia PPC/WebAssembly bootstrap

- `/src/xenia_web_bootstrap/` — browser-native Xenia PPC/HIR, sparse guest memory, kernel/runtime and Xenos bootstrap code.
- `/src/xenia_web_shims/` — browser/WASM portability shims.
- `/xenia_ppc_bootstrap.wasm` and `/xenia_ppc_bootstrap.meta.json` — the one published PPC bootstrap artifact and provenance metadata.
- `/build-xenia-ppc-bootstrap.sh` and `/link-xenia-ppc-bootstrap.sh` — canonical PPC bootstrap build/link path.

Generated WASM metadata must identify the source/build provenance used to create the artifact. A source change is not considered deployed runtime behavior until the rebuilt artifact has passed its publication gates.

## Workflows

`/.github/workflows/` contains durable build/test pipelines only. Do not add one-shot workflows that edit source code or bump cache/version strings.

Key durable gates include:

- `ui.yml` — canonical browser/UI integration contract.
- `r360-browser-features.yml` — browser capability integration.
- `braid-startup-gate.yml` — published Braid/PPC startup contract.
- `xenia-wasm32-bootstrap.yml` — full Xenia PPC/WASM build and regression gate.
- `publish-browser-bootstrap.yml` — publication path for the browser bootstrap.

Hotfix mutation workflows are obsolete; fixes belong in the authoritative source and normal build pipeline.

## Documentation

- `/README.md` — public project/status entrypoint.
- `/VERSION` — promoted application release.
- `/docs/` — maintained architecture/project documentation.
- `/docs/releases/` — release/bring-up documentation.
- `/docs/releases/archive/` — historical release notes moved out of the repository root.

Historical version numbers are acceptable in release documentation because they describe history, not competing implementations.

## Tests

Root `test-*.mjs` files remain because durable CI pipelines reference them directly. Tests should describe a subsystem/contract rather than the version of the file under test.

## Development rules

1. One authoritative implementation per responsibility.
2. Edit current files in place; do not create a new versioned copy for ordinary fixes.
3. Keep browser UI, runtime, PPC, kernel and GPU responsibilities modular, but name modules for what they do rather than when they were created.
4. Never use a one-shot workflow to rewrite production source. Make the source change directly and let durable CI build/test it.
5. Generated WASM must be rebuilt from current source and carry verifiable provenance before device results are attributed to that source.
6. Preserve streaming/random-access package reads suitable for browser `Blob`/`File` slices and OPFS instead of unnecessary whole-image copies.
7. Keep unsupported emulator behavior fail-closed with a concrete blocker; do not fake kernel/GPU/frame success.
8. Move/rename active files atomically: update imports/includes/build scripts/workflows/tests in the same commit, then keep the change only when affected gates are green.

## Current high-level layout

```text
Render360/
  index.html
  app.js
  ui-behavior.js
  ui.js
  developer-console.js
  styles/
    base.css
    interactions.css
    xenios.css
    controller.css

  runtime/
    render360-runtime.js
    title-controls.js
  runtime-host.js
  runtime-worker.js
  wasm-core.js

  package-core.cpp
  render360_xenia_core.cpp
  render360_xenia_core.wasm

  src/
    xenia_web_bootstrap/
    xenia_web_shims/

  library/
  import/
  profiles/
  settings/
  storage/

  docs/
    PROJECT_LAYOUT.md
    releases/
      archive/

  .github/workflows/
```
