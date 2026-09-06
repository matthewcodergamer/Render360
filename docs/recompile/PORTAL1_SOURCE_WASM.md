# Portal 1 · Source → WebAssembly bring-up

Portal is the first target for Render360's **PC Recompiled WebAssembly** lane. This work is intentionally separate from the Xbox 360/Xenia lane.

## Source baseline

Render360 pins the community Source Engine WebAssembly port at:

- Repository: `weliveinhell/source-engine`
- Commit: `63f8364fe7b22b239e72dfb5f1024665b3a91567`
- Upstream Emscripten SDK snapshot: `2d480a1b7c7a34a354188d93f3e89190a44a1d21`
- Render360 build compiler: Emscripten `4.0.9`

The upstream README says the Emscripten port has only been tested with Portal. It also lists sound, browser save persistence, and occasional rendering/lightmap problems as known limitations. Render360 treats that project as the engine source baseline, not as a source of retail Portal data.

## Why Render360 does not use the upstream chunk downloader

The upstream browser demo's `pre.js` downloads pre-generated `chunks/*.data` containing game resources. Render360 must not depend on redistributed Portal retail assets. The player owns/installs Portal and selects their own files locally.

The first Render360 runtime profile therefore compiles an **engine-only** package and replaces the remote chunk model with Emscripten `WORKERFS`:

1. The user selects the Portal install (`portal/`, `hl2/`, `platform/`).
2. The Render360 adapter structured-clones browser `File`/`Blob` handles into a dedicated Worker.
3. The Worker mounts those files read-only through `WORKERFS` at `/render360-game`.
4. `WORKERFS` reads `Blob.slice()` ranges with `FileReaderSync`, so large VPKs do not need to be copied wholesale into WebAssembly linear memory.
5. The Source executable is started with `-game portal` from that mount.

This is the important architectural difference between a browser game port and simply trying to put an entire multi-gigabyte PC install into MEMFS.

## First runtime profile

The first profile is deliberately conservative for iPhone-class devices:

- dedicated browser Worker;
- WebGL 2 / Emscripten OpenGL translation first;
- no SharedArrayBuffer requirement in the first build profile;
- no eight-thread pool;
- 384 MiB initial Wasm memory;
- growth enabled up to 1.5 GiB;
- engine-only package;
- player-owned content mounted read-only with WORKERFS.

The upstream build currently links with approximately 2 GiB initial memory, shared memory, eight pthread workers, `PROXY_TO_PTHREAD`, and OffscreenCanvas. That is a useful upstream reference profile, but it is not a good first iPhone 11 target.

If the Source code proves to require pthread support at link/runtime, the next profile will preserve pthreads and solve cross-origin isolation separately rather than faking thread semantics.

## Renderer order

Portal's existing community port already targets Emscripten OpenGL/WebGL, so the shortest path to a real frame is:

`Source OpenGL calls → Emscripten GL shim → WebGL 2`

WebGPU is a later optimization/renderer project. Replacing a still-unproven Source browser renderer with WebGPU now would make CPU, filesystem, shader, and renderer bugs indistinguishable.

## Player instructions

Portal is Steam App `400`.

1. Own/install Portal from Steam.
2. On a PC, use Steam's **Browse local files** command for Portal.
3. Keep the `portal`, `hl2`, and `platform` directories together.
4. On iPhone/iPad, copy that installed folder to Files/iCloud/USB storage.
5. In Render360 choose **PC → Portal**, select the game folder, then select a verified Render360 Portal Source WebAssembly runtime ZIP.
6. The game files stay player-supplied and are not added to the Render360 repository/runtime artifact.

## Runtime package contents

A successful CI build produces a `render360-pc-wasm-package-v1` ZIP containing only engine/runtime files, including:

- `render360-port.json`
- `portal-package-adapter.mjs`
- `portal-source-worker.mjs`
- `portal-source-engine.mjs`
- `portal-source-engine.wasm`
- any Source side modules produced by the build
- `SOURCE_SDK_LICENSE.txt`

CI fails if VPK, BSP, VTF, or VMT retail assets enter the package.

## Legal/distribution note

The community repository contains Valve's Source 1 SDK license. That license includes conditions around free distribution and third-party notices. The current upstream/community tree does not contain a clearly named `thirdpartylegalnotices.txt`, so Render360 treats the generated engine ZIP as a development/verification artifact while notice compliance is reviewed. Portal retail content is never bundled.

## What this does and does not generalize to GTA IV

The reusable Render360 pieces are title manifests, owned-content selection, engine/runtime provenance, executable-package validation, Worker hosting, zero-copy local file access, artwork/store metadata, and CI isolation from the Xbox path.

The Portal Source engine itself does **not** run GTA IV. GTA IV will need a separate community/native recompiler or engine/runtime project, but it can plug into the same Render360 PC WebAssembly package contract once Portal proves the lane.
