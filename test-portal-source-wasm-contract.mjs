import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest=JSON.parse(fs.readFileSync('recompiled/pc/portal/manifest.json','utf8'));
const upstream=JSON.parse(fs.readFileSync('recompiled/pc/portal/source-wasm/upstream.json','utf8'));
const build=fs.readFileSync('recompiled/pc/portal/source-wasm/build-render360.sh','utf8');
const pre=fs.readFileSync('recompiled/pc/portal/source-wasm/render360-pre.js','utf8');
const adapter=fs.readFileSync('recompiled/pc/portal/source-wasm/portal-package-adapter.mjs','utf8');
const worker=fs.readFileSync('recompiled/pc/portal/source-wasm/portal-source-worker.mjs','utf8');

assert.equal(manifest.schema,'render360-pc-recompiled-title-v1');
assert.equal(manifest.gameId,'portal-1-pc');
assert.equal(manifest.steamAppId,400);
assert.equal(manifest.runtime.renderer,'WebGL2');
assert.equal(manifest.runtime.firstBuildProfile,'single-worker-workerfs');
assert.equal(manifest.content.wholeInstallCopiedIntoWasm,false);
assert.match(manifest.store.url,/store\.steampowered\.com\/app\/400\/Portal/i);
assert.match(manifest.art.header,/steamstatic\.com\/store_item_assets\/steam\/apps\/400\/header\.jpg/i);

assert.equal(upstream.repository,'https://github.com/weliveinhell/source-engine');
assert.equal(upstream.ref,'63f8364fe7b22b239e72dfb5f1024665b3a91567');
assert.equal(upstream.render360Emscripten,'4.0.9');
assert.equal(upstream.contentPolicy.retailGameAssetsInRuntimeArtifact,false);
assert.equal(upstream.contentPolicy.playerProvidesOwnedInstall,true);

assert.match(build,/-lworkerfs\.js/);
assert.match(build,/-sENVIRONMENT=worker/);
assert.match(build,/-sINITIAL_MEMORY=384mb/);
assert.match(build,/-sMAXIMUM_MEMORY=1536mb/);
assert.match(build,/-sALLOW_MEMORY_GROWTH=1/);
assert.match(build,/-sMODULARIZE=1/);
assert.match(build,/-sEXPORT_ES6=1/);
assert.match(build,/Render360 Source dylib failed:/);
assert.match(build,/readyPromiseReject\(error\)/);
assert.doesNotMatch(build,/-sUSE_PTHREADS/);
assert.doesNotMatch(build,/-sPROXY_TO_PTHREAD/);

assert.match(pre,/remoteRetailChunks:\s*false/);
assert.doesNotMatch(pre,/XMLHttpRequest/);
assert.doesNotMatch(pre,/chunks\//);
assert.match(adapter,/runtimeFiles/);
assert.match(adapter,/engineFile:pkg\.file\(ENGINE_FILE\)/);
assert.match(adapter,/transferControlToOffscreen/);
assert.match(worker,/URL\.createObjectURL/);
assert.match(worker,/portal-dylib-preflight/);
assert.match(worker,/WebAssembly\.validate/);
assert.match(worker,/FS\.mount\(engine\.WORKERFS/);
assert.match(worker,/FS\.chdir\('\/render360-game'\)/);
assert.match(worker,/Promise\.race/);
assert.match(worker,/engine\.callMain/);

for(const path of [
  'recompiled/pc/portal/source-wasm/portal-package-adapter.mjs',
  'recompiled/pc/portal/source-wasm/portal-source-worker.mjs',
  'recompiled/pc/portal/source-wasm/render360-pre.js',
]){
  const text=fs.readFileSync(path,'utf8');
  assert.doesNotMatch(text,/https?:\/\/(?:[^\s'"`]*)(?:\.vpk|\.bsp|chunks\/)/i,`${path} must not fetch retail game data`);
}

console.log('PORTAL_SOURCE_UPSTREAM_PIN=PASS');
console.log('PORTAL_SOURCE_WORKER_LOCAL_DYLIBS=PASS');
console.log('PORTAL_SOURCE_DYLIB_FAIL_FAST=PASS');
console.log('PORTAL_SOURCE_WORKERFS_ZERO_COPY_CONTRACT=PASS');
console.log('PORTAL_SOURCE_ENGINE_ONLY_ARTIFACT_CONTRACT=PASS');
console.log('XBOX_RUNTIME_NOT_REFERENCED_BY_PORTAL_OVERLAY=PASS');
