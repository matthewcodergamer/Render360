import assert from 'node:assert/strict';
import {PC_WASM_PACKAGE_SCHEMA,validateCommunityWasmManifest,checkCommunityRuntimeRequirements,communityWasmPackageContract} from './runtime/community-wasm-package.js';

const valid=validateCommunityWasmManifest({
  schema:PC_WASM_PACKAGE_SCHEMA,
  gameId:'portal-1-pc',
  name:'Portal Community Wasm',
  format:'render360-adapter',
  entry:'runtime/portal.mjs',
  requirements:{webassembly:true,webgl2:false,threads:false},
},{expectedGameId:'portal-1-pc'});
assert.equal(valid.gameId,'portal-1-pc');
assert.equal(valid.entry,'runtime/portal.mjs');
assert.equal(valid.adapterExport,'createRender360PcPort');

assert.throws(()=>validateCommunityWasmManifest({...valid,gameId:'gta4-pc'},{expectedGameId:'portal-1-pc'}),/targets gta4-pc/);
assert.throws(()=>validateCommunityWasmManifest({...valid,entry:'https://example.com/runtime.mjs'}),/relative file/);
assert.throws(()=>validateCommunityWasmManifest({...valid,format:'emscripten-esm',wasm:null}),/must declare their \.wasm/);

const emscripten=validateCommunityWasmManifest({...valid,format:'emscripten-esm',entry:'portal.mjs',wasm:'portal.wasm'});
assert.equal(emscripten.wasm,'portal.wasm');

const capability=checkCommunityRuntimeRequirements({requirements:{webassembly:true,webgpu:true,threads:true}},{navigatorImpl:{gpu:null},crossOriginIsolatedValue:false});
assert.equal(capability.ok,false);
assert.ok(capability.missing.includes('WebGPU'));
assert.ok(capability.missing.includes('cross-origin isolation'));

const contract=communityWasmPackageContract();
assert.equal(contract.remoteEntriesAllowed,false);
assert.equal(contract.userSuppliedRuntime,true);
assert.equal(contract.userSuppliedGameData,true);
assert.equal(contract.wholeGameEmbeddedInWasm,false);

console.log('COMMUNITY_WASM_MANIFEST=PASS');
console.log('COMMUNITY_WASM_LOCAL_ONLY=PASS');
console.log('COMMUNITY_WASM_CAPABILITY_GATE=PASS');
