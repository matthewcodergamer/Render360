# Render360 V41 — UI / Runtime Integration

V41 replaces the V40 player shell with a portrait-safe, responsive iOS-style library and connects the library to every browser source type currently understood by the package/XEX layer.

## Player UI

- Uses `visualViewport.height` as the live application height so Safari top/bottom chrome does not trap content below the visible viewport.
- Library, Game Details, Game Settings and global Settings are independent momentum-scrolling surfaces with safe-area padding in portrait and landscape.
- Gameplay remains a black, single-GPU-canvas surface until real Xbox title pixels are presented.
- Supports System, Dark and Light appearance. The gameplay viewport remains black in every appearance.
- Touch controls and the performance HUD exist only in gameplay states.

## Library storage

Global Settings exposes the web equivalent of a games folder: Origin Private File System storage at `Render360/Games`.

Direct ISO/XEX/LIVE/PIRS/CON imports are copied to this folder by default when the browser exposes enough quota. Copying is chunked; the full source is not duplicated in JavaScript memory. If persistent storage is unavailable or quota is insufficient, the library entry remains usable for the current browser session and asks the user to choose the source again after reload.

ZIP extraction keeps its existing streaming/OPFS behavior and hands the seekable extracted source to the same importer/runtime.

## Runtime source routing

The V41 runtime contract accepts:

- ISO -> XDVDFS -> default.xex -> modern ISO bridge
- XEX -> retail XEX preparation -> generated WASM guest scheduler
- LIVE/PIRS/CON -> STFS streaming mount -> default.xex extraction -> retail XEX preparation -> generated WASM guest scheduler

The non-ISO path no longer fails in the UI with `This launch type is not yet wired into the modern browser runtime`.

After PPC translation the content bridge attaches the existing native guest-thread registry and cooperative scheduler, then inspects the native Xenos PM4 ring, captured shaders and real-title frontbuffer. Unsupported CPU, kernel or PM4 behavior remains fail-closed and is reported as the next concrete emulator blocker.

## Configuration model

Global defaults are stored separately from per-title profiles. Game Settings are web equivalents of Xenia configuration rather than desktop Vulkan/D3D settings. They include renderer preference, internal scale, target FPS preference, graphics workaround flags, scheduler quantum, language/audio preferences and developer diagnostics.

Settings that are currently profile plumbing are labeled as such in the UI; V41 does not claim an unimplemented backend switch is active.

## Version contract

The V41 frontend requires Render360 package/XEX Core V30+ and ABI `0x00030002` or later. Startup fails closed if the loaded core is older. The V41 integration workflow also runs the deployed guest scheduler against the checked-in `xenia_ppc_bootstrap.wasm`, so a stale published bootstrap cannot be treated as a green UI/runtime build.

The verified `Xenia WASM32 Bootstrap` workflow remains authoritative for building the browser bootstrap; `Publish Browser Bootstrap` is authoritative for copying that tested artifact to the root file served by GitHub Pages.
