// Replays a local GPU capture (run-title.mjs --gpu-capture M:SWAPS:FILE) in
// headless Chromium WebGPU (tests/browser/webgpu-replay-capture.mjs).
// Captures hold game data: they stay outside the repository and the test
// skips without one.
//   node test-webgpu-replay-capture-browser.mjs /path/to/capture.bin [out.png]
import fs from 'node:fs';
import path from 'node:path';
import {runBrowserTest} from './tools/browser-test.mjs';

const capture=process.argv[2]||process.env.R360_GPU_CAPTURE;
if(!capture||!fs.existsSync(capture)){console.log('WEBGPU_REPLAY_CAPTURE_SKIP (no local capture)');process.exit(0);}
const dir=path.dirname(path.resolve(capture)),name=path.basename(capture);
const reference=fs.existsSync(`${capture}.png`)?`/__data__/${name}.png`:null;
const result=await runBrowserTest('tests/browser/webgpu-replay-capture.mjs',{args:[`/__data__/${name}`,reference],dataRoot:dir,
  onConsole:t=>process.env.VERBOSE&&console.log(t)});
if(result.png){if(process.argv[3])fs.writeFileSync(process.argv[3],Buffer.from(result.png,'base64'));delete result.png;}
console.log(JSON.stringify(result,null,1));
if(!result.ok)process.exit(1);
console.log('WEBGPU_REPLAY_CAPTURE_PASS');
