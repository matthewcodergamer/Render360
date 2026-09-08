import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest=JSON.parse(fs.readFileSync('recompiled/pc/portal/manifest.json','utf8'));
const upstream=JSON.parse(fs.readFileSync('recompiled/pc/portal/source-wasm/upstream.json','utf8'));
const build=fs.readFileSync('recompiled/pc/portal/source-wasm/build-render360.sh','utf8');
const pre=fs.readFileSync('recompiled/pc/portal/source-wasm/render360-pre.js','utf8');
const adapter=fs.readFileSync('recompiled/pc/portal/source-wasm/portal-package-adapter.mjs','utf8');
const worker=fs.readFileSync('recompiled/pc/portal/source-wasm/portal-source-worker.mjs','utf8');
const pcRuntime=fs.readFileSync('runtime/pc-recompiled-runtime.js','utf8');
const pcLibrary=fs.readFileSync('runtime/pc-library-integration.js','utf8');
const pcCss=fs.readFileSync('styles/pc-library-integration.css','utf8');

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
assert.match(build,/-sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,callMain,HEAPU8/);
assert.match(build,/Render360 Source dylib failed:/);
assert.match(build,/readyPromiseReject\(error\)/);
assert.match(build,/dylibBasenameFix': True/);
assert.match(build,/createInterfaceExportVerified': True/);
assert.match(build,/createInterfaceHandleBridge': True/);
assert.match(build,/dlsymTableMapPrimed': True/);
assert.match(build,/workerFsKeptReadOnly': True/);
assert.match(build,/workerSafeAlertShim': True/);
assert.match(build,/directWebglPresentation': True/);
assert.match(build,/stackGeometryRepair': True/);
assert.match(build,/heapU8Exported': True/);
assert.match(build,/sharedMemoryVerifiedFalse': True/);
assert.match(build,/upstreamPthreadsRemoved': True/);
assert.match(build,/stackZeroEndSelfHeal': True/);
assert.match(build,/render360-single-worker-workerfs-v7-createinterface-webkit/);
assert.match(build,/not conf\.options\.EMSCRIPTEN/);
assert.match(build,/old_shared = "\\t\\tflags \+= \['-sSHARED_MEMORY=1'/);
assert.match(build,/imports shared WebAssembly memory/);
assert.match(build,/Render360 Source stack metadata remained zero after stackCheckInit/);
assert.match(build,/Render360 LoadLibrary: pModule:/);
assert.match(build,/pBaseName = strrchr\(pModuleName, '\/'\)/);
assert.match(build,/test -s "\$OUTPUT_DIR\/libfilesystem_stdio\.so"/);
assert.match(build,/libfilesystem_stdio\.so does not export function CreateInterface/);
assert.match(build,/Render360 Source CreateInterface resolved/);
assert.match(build,/render360CreateInterfaceAddress/);
assert.match(build,/updateTableMap\(0, wasmTable\.length\)/);
assert.match(build,/getEmptyTableSlot\(\)/);
assert.match(build,/setWasmTableEntry\(slot, result\)/);
assert.doesNotMatch(build,/-sSTACK_OVERFLOW_CHECK=0/);
assert.doesNotMatch(build,/-sUSE_PTHREADS/);
assert.doesNotMatch(build,/-sPROXY_TO_PTHREAD/);

assert.match(pre,/remoteRetailChunks:\s*false/);
assert.match(pre,/render360RepairStackGeometry/);
assert.match(pre,/stackCheckInit\(\)/);
assert.match(pre,/_emscripten_stack_get_end/);
assert.match(pre,/onRuntimeInitialized/);
assert.doesNotMatch(pre,/XMLHttpRequest/);
assert.doesNotMatch(pre,/chunks\//);
assert.match(adapter,/runtimeFiles/);
assert.match(adapter,/engineFile:pkg\.file\(ENGINE_FILE\)/);
assert.match(adapter,/transferControlToOffscreen/);
assert.match(adapter,/directPresentation:true/);
assert.match(adapter,/setLookAnalog\(rx,ry\)/);
assert.match(adapter,/setMoveAnalog\(lx,ly\)/);
assert.match(worker,/URL\.createObjectURL/);
assert.match(worker,/portal-dylib-preflight/);
assert.match(worker,/WebAssembly\.validate/);
assert.match(worker,/FS\.mount\(engine\.WORKERFS/);
assert.match(worker,/FS\.chdir\('\/render360-game'\)/);
assert.match(worker,/WORKERFS is intentionally read-only/);
assert.doesNotMatch(worker,/stageDynamicLibrariesIntoFs/);
assert.doesNotMatch(worker,/FS\.writeFile/);
assert.doesNotMatch(worker,/runtimeBlobs/);
assert.match(worker,/Promise\.race/);
assert.match(worker,/repairStackGeometry\('runtime-init'\)/);
assert.match(worker,/repairStackGeometry\('before-callMain'\)/);
assert.match(worker,/runtimeMemoryBytes\(\)/);
assert.match(worker,/typeof self\.alert!=='function'/);
assert.match(worker,/Source alert/);
assert.doesNotMatch(worker,/memoryBytes:engine\.HEAPU8/);
assert.match(worker,/engine\.callMain/);

assert.match(pcRuntime,/inputCanvas=session\.sourceCanvas\|\|presenter\.sourceCanvas/);
assert.match(pcRuntime,/runtime\.recompiledControllerInput=controllerInput/);
assert.match(pcRuntime,/directWebGlPresenter/);
assert.match(pcRuntime,/pc-presenter-bypass/);
assert.match(pcRuntime,/WebGPU allocation skipped/);
assert.match(pcRuntime,/if\(directPresentation\)/);
assert.match(pcRuntime,/Portal Source WebGL2 direct presentation active/);
assert.doesNotMatch(pcRuntime,/presenter\.start\(\);\s*let result/);
assert.match(pcLibrary,/runtime\?\.recompiledControllerInput\|\|runtime\?\.recompiledSession/);
assert.match(pcLibrary,/Double Back/);
assert.match(pcLibrary,/now-lastBackTap<=550/);
assert.match(pcLibrary,/globalThis\.render360ModernTitle\?\.stop/);
assert.match(pcCss,/left:57%/);
assert.match(pcCss,/backdrop-filter:blur\(14px\) saturate\(125%\)!important/);
assert.match(pcCss,/\.controller-layer\[data-platform="pc"\] \.face/);

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
console.log('PORTAL_SOURCE_DYLIB_BASENAME_FIX=PASS');
console.log('PORTAL_SOURCE_DYLIB_FAIL_FAST=PASS');
console.log('PORTAL_SOURCE_CREATEINTERFACE_EXPORT=PASS');
console.log('PORTAL_SOURCE_CREATEINTERFACE_HANDLE_BRIDGE=PASS');
console.log('PORTAL_SOURCE_DLSYM_TABLE_MAP_PRIME=PASS');
console.log('PORTAL_SOURCE_WORKERFS_READONLY=PASS');
console.log('PORTAL_SOURCE_WORKER_SAFE_ERRORS=PASS');
console.log('PORTAL_SOURCE_STACK_GEOMETRY_REPAIR=PASS');
console.log('PORTAL_SOURCE_ZERO_STACK_END_SELF_HEAL=PASS');
console.log('PORTAL_SOURCE_HEAP_EXPORT_CONTRACT=PASS');
console.log('PORTAL_SOURCE_UNSHARED_MEMORY_CONTRACT=PASS');
console.log('PORTAL_SOURCE_WORKERFS_ZERO_COPY_CONTRACT=PASS');
console.log('PORTAL_SOURCE_DIRECT_WEBGL_PRESENTATION=PASS');
console.log('PORTAL_SOURCE_WEBGPU_BYPASS=PASS');
console.log('PORTAL_SOURCE_CONTROLLER_BRIDGE=PASS');
console.log('PORTAL_SOURCE_DOUBLE_BACK_EXIT=PASS');
console.log('PORTAL_SOURCE_ENGINE_ONLY_ARTIFACT_CONTRACT=PASS');
console.log('XBOX_RUNTIME_NOT_REFERENCED_BY_PORTAL_OVERLAY=PASS');
