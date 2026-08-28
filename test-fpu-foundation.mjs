import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) {
  console.error(`FPU foundation WASM not found: ${wasmPath}`);
  process.exit(2);
}

const bytes = fs.readFileSync(wasmPath);
const module = await WebAssembly.compile(bytes);
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(module);
for (const entry of WebAssembly.Module.imports(module)) {
  if (entry.module === 'env' && entry.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const pick = (name) => instance.exports[name] ?? instance.exports[`_${name}`];

const required = [
  'r360_ppc_probe_reset', 'r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_write_guest_u32_be', 'r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_input_buffer', 'r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load', 'r360_ppc_probe_translate', 'r360_ppc_probe_status',
  'r360_ppc_probe_correctness_status', 'r360_ppc_probe_correctness_r3',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') {
    console.error(`Missing required FPU probe export: ${name}`);
    process.exit(3);
  }
}

const wordBytes = (...words) => Uint8Array.from(words.flatMap((word) => [
  (word >>> 24) & 0xFF, (word >>> 16) & 0xFF, (word >>> 8) & 0xFF, word & 0xFF,
]));
const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
const data = 0x80000100;

const programs = {
  div: wordBytes(
    0xC8240000, // lfd   f1,0(r4)  = 6.0
    0xC8440008, // lfd   f2,8(r4)  = 2.0
    0xFC611024, // fdiv  f3,f1,f2
    0xD8640010, // stfd  f3,16(r4)
    0x80640010, // lwz   r3,16(r4)
    0x4E800020, // blr
  ),
  compare: wordBytes(
    0xC8240000, // lfd   f1,0(r4)  = 1.0
    0xC8440008, // lfd   f2,8(r4)  = 2.0
    0xFC011000, // fcmpu cr0,f1,f2
    0x7C600026, // mfcr  r3
    0x4E800020, // blr
  ),
  convertToIntZero: wordBytes(
    0xC8240000, // lfd    f1,0(r4) = 3.75
    0xFC60081E, // fctiwz f3,f1
    0xD8640010, // stfd   f3,16(r4) -> integer result as FPR bit pattern
    0x80640014, // lwz    r3,20(r4) -> low 32 bits
    0x4E800020, // blr
  ),
  roundSingle: wordBytes(
    0xC8240000, // lfd  f1,0(r4) = 3.0
    0xFC600818, // frsp f3,f1
    0xD8640010, // stfd f3,16(r4)
    0x80640010, // lwz  r3,16(r4)
    0x4E800020, // blr
  ),
  fpscrReadback: wordBytes(
    0xC8240000, // lfd  f1,0(r4) = 6.0
    0xC8440008, // lfd  f2,8(r4) = 2.0
    0xFC611024, // fdiv f3,f1,f2 (runs Xenia UpdateFPSCR)
    0xFC80048E, // mffs f4
    0xD8840018, // stfd f4,24(r4)
    0x8064001C, // lwz  r3,28(r4)
    0x4E800020, // blr
  ),
};

const tests = [
  {
    name: 'fpu-fdiv-six-by-two-three',
    ppc: programs.div,
    seeds: [[data,0x40180000],[data+4,0],[data+8,0x40000000],[data+12,0],[data+16,0],[data+20,0]],
    expectedR3: 0x40080000n,
    expectedMemory: [[data+16,0x40080000],[data+20,0]],
  },
  {
    name: 'fpu-fcmpu-less-than-cr0',
    ppc: programs.compare,
    seeds: [[data,0x3FF00000],[data+4,0],[data+8,0x40000000],[data+12,0]],
    expectedR3: 0x80000000n,
  },
  {
    name: 'fpu-fctiwz-three-point-seven-five-to-three',
    ppc: programs.convertToIntZero,
    seeds: [[data,0x400E0000],[data+4,0],[data+16,0],[data+20,0]],
    expectedR3: 3n,
    expectedMemory: [[data+16,0],[data+20,3]],
  },
  {
    name: 'fpu-frsp-f64-f32-f64-round-chain',
    ppc: programs.roundSingle,
    seeds: [[data,0x40080000],[data+4,0],[data+16,0],[data+20,0]],
    expectedR3: 0x40080000n,
    expectedMemory: [[data+16,0x40080000],[data+20,0]],
  },
  {
    name: 'fpu-fpscr-current-xenia-update-readback',
    ppc: programs.fpscrReadback,
    seeds: [[data,0x40180000],[data+4,0],[data+8,0x40000000],[data+12,0],[data+24,0xFFFFFFFF],[data+28,0xFFFFFFFF]],
    expectedR3: 0n,
    expectedMemory: [[data+24,0],[data+28,0]],
  },
];

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

for (const test of tests) {
  pick('r360_ppc_probe_reset')();
  if ((pick('r360_ppc_probe_set_initial_gpr')(4, BigInt(data)) >>> 0) !== 1) {
    fail(`Failed to seed r4 for ${test.name}`, 4);
  }
  for (const [address, value] of test.seeds) {
    if ((pick('r360_ppc_probe_write_guest_u32_be')(address, value) >>> 0) !== 1) {
      fail(`Failed guest seed for ${test.name} at 0x${address.toString(16)}`, 5);
    }
  }
  if (capacity < test.ppc.length) fail(`Probe capacity too small for ${test.name}`, 6);
  new Uint8Array(instance.exports.memory.buffer, inputPtr, test.ppc.length).set(test.ppc);
  if ((pick('r360_ppc_probe_load')(inputPtr, test.ppc.length) >>> 0) !== test.ppc.length) {
    fail(`Load failed for ${test.name}`, 7);
  }
  if ((pick('r360_ppc_probe_translate')() >>> 0) === 0 ||
      (pick('r360_ppc_probe_status')() >>> 0) !== 3 ||
      (pick('r360_ppc_probe_correctness_status')() >>> 0) !== 3) {
    fail(`FPU finalized-HIR execution failed for ${test.name}`, 8);
  }
  const r3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
  if (r3 !== test.expectedR3) {
    fail(`${test.name}: expected r3=${test.expectedR3}, got ${r3}`, 9);
  }
  for (const [address, expected] of test.expectedMemory ?? []) {
    const actual = pick('r360_ppc_probe_read_guest_u32_be')(address) >>> 0;
    if (actual !== (expected >>> 0)) {
      fail(`${test.name}: guest[0x${address.toString(16)}] expected 0x${(expected>>>0).toString(16)}, got 0x${actual.toString(16)}`, 10);
    }
  }
  console.log(`PASS: ${test.name}`);
}

console.log('FPU_FOUNDATION=PASS');
console.log(`fpu_cases=${tests.length}`);
console.log('PASS: real PPC DIV, floating compare, float-to-int conversion, f64/f32 rounding conversion and current upstream Xenia FPSCR update/readback execute through finalized Xenia HIR.');
console.log('NOTE: FPSCR exception-detail behavior remains bounded by current upstream Xenia UpdateFPSCR semantics; Render360 does not invent missing hardware flags.');
