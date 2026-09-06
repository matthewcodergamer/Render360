import fs from 'node:fs';
import assert from 'node:assert/strict';

// This is the release-wide gate: every publish lane must agree with VERSION.
const allowBootstrapPending = process.argv.includes('--allow-bootstrap-pending');
const versionText = fs.readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
assert.match(versionText, /^\d+$/, 'VERSION must contain one integer release number');
const version = Number(versionText);

const read = (name) => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const runtime = read('runtime/render360-runtime.js');
const titleRuntime = read('render360-browser-title-runtime.mjs');
const serviceWorker = read('render360-sw.js');

assert.match(runtime, new RegExp(`const RENDER360_RELEASE=${version};`), 'runtime release drifted from VERSION');
assert.match(titleRuntime, new RegExp(`const RENDER360_RELEASE=${version};`), 'title runtime release drifted from VERSION');
assert.match(runtime, new RegExp(`const REQUIRED_CORE_BUILD=${version};`), 'runtime package-core requirement drifted from VERSION');
assert.match(runtime, new RegExp(`const CONTENT_BRIDGE=\\{release:${version},`), 'content bridge release drifted from VERSION');
assert.match(serviceWorker, new RegExp(`const VERSION=['\"]${version}['\"];`), 'service-worker cache release drifted from VERSION');

const packageMeta = JSON.parse(read('render360_xenia_core.meta.json'));
assert.equal(Number(packageMeta.release), version, 'package-core metadata release drifted from VERSION');
const packageBytes = fs.readFileSync(new URL('./render360_xenia_core.wasm', import.meta.url));
const packageModule = new WebAssembly.Module(packageBytes);
const packageInstance = new WebAssembly.Instance(packageModule, {});
assert.equal(packageInstance.exports.r360_build_version() >>> 0, version, 'package-core binary build drifted from VERSION');

const bootstrapMeta = JSON.parse(read('xenia_ppc_bootstrap.meta.json'));
const bootstrapRelease = bootstrapMeta.release == null ? null : Number(bootstrapMeta.release);
const bootstrapIsPreviousRelease = Number.isInteger(bootstrapRelease) && bootstrapRelease === version - 1;
if (allowBootstrapPending && (bootstrapRelease == null || bootstrapIsPreviousRelease)) {
  console.warn(`BOOTSTRAP_RELEASE_PENDING current=${bootstrapRelease == null ? 'unset' : `V${bootstrapRelease}`} target=V${version}; fastlane must republish target release`);
} else {
  assert.equal(bootstrapRelease, version, 'browser bootstrap metadata release drifted from VERSION');
}

console.log(`RENDER360_VERSION_CONSISTENCY PASS V${version}`);
