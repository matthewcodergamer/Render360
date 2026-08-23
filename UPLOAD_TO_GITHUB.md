# Upload V28 to GitHub

Your current GitHub Pages setting can stay exactly as it is:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/(root)**

Upload/replace the V28 files at the repository root. In particular, make sure these root files are present:

- `index.html`
- `app.css`
- `app.js`
- `wasm-core.js`
- `gpu-web.js`
- `render360_xenia_core.wasm`
- `manifest.webmanifest`
- `.nojekyll`

Keep `src/`, `scripts/`, `docs/`, and `.github/` too — they are the source/build/test side of the project.

After the commit finishes, GitHub Pages will republish the same project URL:

`https://matthewcodergamer.github.io/Render360/`
