// WebGPU shared memory end to end in headless Chromium (SwiftShader): uploads
// the core records are replayed into the GPU buffer, which then matches guest
// memory (tests/browser/webgpu-shared-memory.mjs).
import {runBrowserTest} from './tools/browser-test.mjs';

const wasm=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const result=await runBrowserTest('tests/browser/webgpu-shared-memory.mjs',{args:[`/${wasm}`],onConsole:t=>process.env.VERBOSE&&console.log(t)});
console.log(JSON.stringify(result));
if(!result.ok)process.exit(1);
if(result.secondUploads!==1){console.log('expected exactly one page re-uploaded after the CPU write');process.exit(1);}
console.log('WEBGPU_SHARED_MEMORY_BROWSER_PASS');
