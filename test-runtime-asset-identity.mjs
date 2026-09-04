import assert from 'node:assert/strict';
import fs from 'node:fs';

const productionFiles=[
  'app.js','wasm-core.js','settings/app-settings-store.js','render360-browser-features.mjs',
  'render360-browser-title-runtime.mjs','render360-browser-modern-content-bridge.mjs',
  'render360-browser-modern-iso-bridge.mjs','render360-browser-iso-hook.mjs',
  'render360-iso-title-controller.mjs',
];
for(const file of productionFiles){
  const source=fs.readFileSync(file,'utf8');
  assert.equal(source.includes('?v='),false,`${file} uses a versioned production URL`);
  assert.equal(source.includes('wasm-core-v32.js'),false,`${file} imports the deleted versioned core`);
}
assert.ok(fs.readFileSync('app.js','utf8').includes('Emulator ready · Core build'),'header uses semantic runtime status');

const titleRuntime=fs.readFileSync('render360-browser-title-runtime.mjs','utf8');
for(const marker of [
  "PPC_BOOTSTRAP_URL='./xenia_ppc_bootstrap.stable.wasm'",
  "PPC_BOOTSTRAP_META_URL='./xenia_ppc_bootstrap.stable.meta.json'",
  "Symbol.for('render360.ppc.bootstrap.singleton')",
  'validatePpcBootstrapAsset(bytes,metadata',
  "cryptoImpl.subtle.digest('SHA-256',view)",
  'globalThis.render360PpcRuntimeIdentity=',
])assert.ok(titleRuntime.includes(marker),`missing runtime identity invariant: ${marker}`);

for(const bridge of ['render360-browser-modern-content-bridge.mjs','render360-browser-modern-iso-bridge.mjs']){
  assert.equal(fs.readFileSync(bridge,'utf8').includes('let bootstrapPromise'),false,`${bridge} owns a duplicate bootstrap promise`);
}

const developerConsole=fs.readFileSync('developer-console.js','utf8');
for(const marker of ['render360-blocker-report-v1','render360PpcRuntimeIdentity','document.execCommand(\'copy\')','translatedFunctions']){
  assert.ok(developerConsole.includes(marker),`missing compact console invariant: ${marker}`);
}
assert.equal(developerConsole.includes('runtime:globalThis.render360ModernTitle'),false,'developer report copies the entire live runtime');

const buildWorkflow=fs.readFileSync('.github/workflows/xenia-wasm32-bootstrap.yml','utf8');
const publishWorkflow=fs.readFileSync('.github/workflows/publish-browser-bootstrap.yml','utf8');
assert.equal(buildWorkflow.includes('git push origin'),false,'build workflow publishes a second runtime copy');
assert.ok(publishWorkflow.includes("workflows: ['Xenia WASM32 Bootstrap']"),'publisher is not bound to the verified build');
assert.ok(publishWorkflow.includes('Refuse stale runtime artifacts'),'publisher lacks the stale-source gate');

console.log('CANONICAL_RUNTIME_URLS=PASS');
console.log('PPC_BOOTSTRAP_SINGLETON=PASS');
console.log('PPC_BOOTSTRAP_PROVENANCE=PASS');
console.log('COMPACT_DEVELOPER_REPORT=PASS');
console.log('SINGLE_RUNTIME_PUBLISHER=PASS');
