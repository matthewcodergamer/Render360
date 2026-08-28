import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`Foundation bootstrap WASM not found: ${wasmPath}`);

const critics = [
  {
    file: 'test-wasm-backend.mjs',
    markers: [
      'WASM_BACKEND_SCALAR_DATAFLOW=PASS',
      'WASM_BACKEND_SCALAR_TYPES_COMPARE_SHIFT=PASS',
      'WASM_BACKEND_CFG_BRANCH=PASS',
      'WASM_BACKEND_CFG_LOOP=PASS',
    ],
  },
  { file: 'test-wasm-backend-memory.mjs', markers: ['WASM_BACKEND_MEMORY_ENDIAN=PASS'] },
  {
    file: 'test-wasm-backend-calls.mjs',
    markers: [
      'WASM_BACKEND_CALL_DIRECT=PASS',
      'WASM_BACKEND_CALL_NESTED=PASS',
      'WASM_BACKEND_CALL_INDIRECT=PASS',
      'WASM_BACKEND_CALL_FAIL_CLOSED=PASS',
    ],
  },
  {
    file: 'test-wasm-backend-fpu.mjs',
    markers: ['WASM_BACKEND_FPU_ADD=PASS', 'WASM_BACKEND_FPU_SUB=PASS', 'WASM_BACKEND_FPU_MUL=PASS', 'WASM_BACKEND_FPU_DIV=PASS'],
  },
  {
    file: 'test-wasm-backend-fpu-semantics.mjs',
    markers: ['WASM_BACKEND_FPU_SEMANTICS=PASS'],
  },
  {
    file: 'test-wasm-backend-vmx.mjs',
    markers: [
      'WASM_BACKEND_VMX_STANDARD=PASS',
      'WASM_BACKEND_VMX128=PASS',
      'WASM_BACKEND_VMX_REUSE=PASS',
      'WASM_BACKEND_VMX_SIMD=PASS',
    ],
  },
  {
    file: 'test-wasm-backend-cache.mjs',
    markers: [
      'WASM_BACKEND_CACHE_ADDRESS_VERSION=PASS',
      'WASM_BACKEND_COMPILED_MODULE_REUSE=PASS',
      'WASM_BACKEND_EXECUTABLE_INVALIDATION=PASS',
      'WASM_BACKEND_STALE_TARGET_FAIL_CLOSED=PASS',
    ],
  },
];

let markerCount = 0;
for (const critic of critics) {
  if (!fs.existsSync(critic.file)) throw new Error(`Missing independent critic ${critic.file}`);
  const run = spawnSync(process.execPath, [critic.file, wasmPath], { encoding: 'utf8' });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (run.status !== 0) {
    process.stdout.write(output);
    throw new Error(`Independent critic ${critic.file} failed with exit=${run.status}`);
  }
  for (const marker of critic.markers) {
    if (!output.includes(marker)) {
      process.stdout.write(output);
      throw new Error(`Independent critic ${critic.file} did not emit required marker ${marker}`);
    }
    markerCount++;
  }
  console.log(`foundation_critic=${critic.file} result=PASS markers=${critic.markers.length}`);
}

if (critics.length !== 7 || markerCount < 20) {
  throw new Error(`Foundation breadth unexpectedly shrank critics=${critics.length} markers=${markerCount}`);
}

console.log(`WASM_BACKEND_EQUIVALENCE_CRITICS=${critics.length}`);
console.log(`WASM_BACKEND_EQUIVALENCE_MARKERS=${markerCount}`);
console.log('WASM_BACKEND_BROAD_EQUIVALENCE=PASS');
console.log('WASM_BACKEND_CACHE_INVALIDATION=PASS');
console.log('WASM_BACKEND_FAIL_CLOSED=PASS');
console.log('WASM_BACKEND_FOUNDATION=PASS');
