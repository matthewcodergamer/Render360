# Upload Render360 V30 to GitHub

Your Pages setting does **not** need to change:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/(root)**

Extract this ZIP and upload/replace its **contents at the repository root**. Do not upload the ZIP as a single file.

Make sure these V30 additions are present:

- `src/xenia_port/stfs_layout.h`
- updated `src/render360_xenia_core.cpp`
- updated `render360_xenia_core.wasm`
- updated `wasm-core.js`
- `scripts/test_mount_node.mjs`
- `docs/V30_RELEASE_NOTES.md`
- `docs/WEB_IOS_SHARED_CORE.md`
- `upstream/README.md`

Keep `.github/workflows/` too so GitHub can rebuild/smoke-test the WASM core and periodically check the Xenia contract.

After Pages republishes, open:

`https://matthewcodergamer.github.io/Render360/?v=30`

The `?v=30` is only a cache buster for Safari; the normal site remains `/Render360/`.
