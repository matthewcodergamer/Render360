# Render360 Recompiled Titles

Render360 supports two CPU execution engines:

1. **Xbox 360 Emulator** — the existing Xenia-derived PPC → HIR → generated-WASM / native-HIR compatibility path.
2. **Recompiled WebAssembly** — a title-specific ahead-of-time path intended for XenonRecomp / ReXGlue-style static recompilation.

The graphics renderer remains a separate setting (Auto / WebGPU / WebGL2). Execution Engine chooses how Xbox 360 CPU code reaches the browser.

## Selection

- `Auto` checks for a title-specific recompiled manifest first. If none is installed, Render360 uses the Xbox 360 Emulator.
- `Xbox 360 Emulator` always uses the general emulator path.
- `Recompiled WebAssembly` requires a title-specific build and fails closed if none is installed.

A per-title override can replace the global setting.

## Directory contract

Each supported title has its own directory named by 8-digit Title ID:

```text
recompiled/
  58410968/
    manifest.json
    adapter.mjs
    title.wasm
```

Example `manifest.json`:

```json
{
  "schema": "render360-recompiled-title-v1",
  "titleId": "58410968",
  "name": "Example title",
  "adapter": "./adapter.mjs",
  "wasm": "./title.wasm",
  "toolchain": {
    "cpu": "XenonRecomp",
    "compiler": "Emscripten"
  }
}
```

The manifest does not contain game assets. Render360 still requires the user's legally acquired Xbox 360 game source.

## Adapter contract

`adapter.mjs` exports either `createRender360RecompiledTitle(host)` or a default function. It returns a session object with `start()` or `run()` and may optionally expose `pause()` and `resume()`.

The host includes the imported game source, Render360 core, canvas, input host, configuration, and helpers for boot-stage, log, blocker, frame and normalized runtime-state reporting.

```js
export async function createRender360RecompiledTitle(host) {
  // Load Emscripten glue / title.wasm here.
  return {
    async start() {
      host.emitStage({stage:'title', message:'Recompiled title running'});
      return {runtimeBoundary:'recompiled-running'};
    },
    pause() {},
    resume() {},
  };
}
```

## Intended toolchain

The target pipeline is:

```text
Xbox 360 default.xex
  → XenonRecomp / compatible PPC static recompiler
  → generated portable C++
  → Emscripten / Clang
  → WebAssembly + browser adapter
  → Render360 kernel / memory / GPU / audio / input services
```

ReXGlue-style projects are useful architectural references because they also replace runtime PPC JIT work with precompiled C++ while retaining Xbox kernel, memory, filesystem and Xenos runtime services.

## Game assets and copyright

Do not commit retail game code, game assets, decrypted XEX files, RPF archives, audio, textures or other copyrighted title payloads to this repository. Recompiled adapters should require the user to provide their own legally acquired game files.
