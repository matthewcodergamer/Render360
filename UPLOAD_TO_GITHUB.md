# Upload V29 to GitHub

Your GitHub Pages setting can stay exactly as it is:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/(root)**

Upload/replace the V29 files at the repository root. In particular, make sure these root files are present:

- `index.html`
- `app.css`
- `app.js`
- `wasm-core.js`
- `runtime-host.js`
- `three-host.js`
- `gpu-web.js`
- `render360_xenia_core.wasm`
- `manifest.webmanifest`
- `.nojekyll`

Also upload the `worker/` folder. `worker/runtime-worker.js` is what keeps the native WASM runtime ticking away from the UI thread.

Keep `src/`, `scripts/`, `docs/`, and `.github/` too — they are the source/build/test side of the project.

After the commit finishes, GitHub Pages will republish the same project URL:

`https://matthewcodergamer.github.io/Render360/`

If the page still says V28 after upload, reload once with a cache-busting query such as `?v=29`. The V29 HTML already uses versioned CSS/JS URLs.
