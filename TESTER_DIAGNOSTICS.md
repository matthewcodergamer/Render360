# Render360 Tester Diagnostics

Render360 V44 includes an opt-in tester diagnostic client for browser/iPhone testing.

## What a report contains

- Render360 release and runtime state
- boot pipeline stage states
- the current concrete blocker (for example PPC/HIR opcode/address)
- translated-function count and runtime boundary
- kernel import/call counts
- scheduler readiness
- Xenos PM4/draw/swap state
- selected browser/WebKit capability details
- a bounded tail of Render360/Xenia technical logs

The reporter does **not** upload game image/file contents. It redacts common GitHub token formats, bearer credentials, URL token parameters, email addresses and local filesystem paths before a report leaves the page.

## Current GitHub Pages mode

GitHub Pages is a static host and cannot safely contain a repository write token. Therefore the public build does not silently create GitHub issues.

When a tester enables **Settings → Tester Diagnostics**, concrete runtime blockers are de-duplicated and queued locally. **Send Latest Diagnostic** opens a pre-filled issue in `matthewcodergamer/Render360` for the tester to review and submit. GitHub sign-in may be required. The Developer Console also gains a **Send** button. Existing Copy/Share actions remain available for testers without GitHub accounts.

## Fully automatic collector mode

The client is already prepared for a future owner-controlled HTTPS ingestion endpoint. Set `window.RENDER360_DIAGNOSTICS_ENDPOINT` to an HTTPS endpoint before `tester-diagnostics-v44.mjs` boots. The endpoint must accept JSON POST bodies using schema `render360-tester-diagnostic/1` and return a 2xx status.

Do not put a GitHub personal access token, repository token or other write credential in the public JavaScript bundle. The collector must keep server-side credentials on the server side.

Once a collector is configured, Render360 can submit queued diagnostics programmatically while keeping the same privacy filter and de-duplication layer.
