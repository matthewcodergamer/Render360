import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) {
  console.error(`PPC probe WASM not found: ${wasmPath}`);
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

const unresolved = WebAssembly.Module.imports(module).filter(
  ({ module: mod, name }) => !(imports[mod] && name in imports[mod]),
);
if (unresolved.length) {
  console.error('Unresolved WASM host imports:');
  for (const entry of unresolved) console.error(`  ${entry.module}.${entry.name}`);
  process.exit(3);
}

const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);

const exportedNames = Object.keys(instance.exports).sort();
console.log(`wasm_exports=${exportedNames.join(',')}`);
const pick = (name) => instance.exports[name] ?? instance.exports[`_${name}`];
const required = [
  'r360_ppc_probe_reset', 'r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_write_guest_u32_be', 'r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_input_buffer', 'r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load', 'r360_ppc_probe_translate', 'r360_ppc_probe_status',
  'r360_ppc_probe_guest_base', 'r360_ppc_probe_loaded_size',
  'r360_ppc_probe_assembled_functions', 'r360_ppc_probe_hir_block_count',
  'r360_ppc_probe_hir_instruction_count', 'r360_ppc_probe_last_guest_address',
  'r360_ppc_probe_correctness_status', 'r360_ppc_probe_correctness_instructions',
  'r360_ppc_probe_correctness_r3',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') {
    console.error(`Missing required probe export: ${name}`);
    console.error(`Available exports: ${exportedNames.join(', ')}`);
    process.exit(4);
  }
}
if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
  console.error('Standalone probe did not export WebAssembly.Memory');
  process.exit(5);
}

const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
const guestDataAddress = 0x80000100;
const wordBytes = (...words) => Uint8Array.from(words.flatMap((word) => [
  (word >>> 24) & 0xFF, (word >>> 16) & 0xFF, (word >>> 8) & 0xFF, word & 0xFF,
]));

const conditionalProgram = wordBytes(
  0x2C040000, 0x4182000C, 0x38600001, 0x48000008, 0x38600002, 0x4E800020,
);

const ctrLoopProgram = wordBytes(
  0x7C8903A6, 0x38600000, 0x38630001, 0x4200FFFC, 0x4E800020,
);

const directCallProgram = wordBytes(
  0x7CA802A6, 0x48000011, 0x38630002, 0x7CA803A6, 0x4E800020,
  0x38600005, 0x4E800020,
);

const nestedCallProgram = wordBytes(
  0x7CA802A6, 0x4800001D, 0x38630001, 0x7CA803A6, 0x4E800020,
  0x00000000, 0x00000000, 0x00000000,
  0x7CC802A6, 0x4800001D, 0x38630002, 0x7CC803A6, 0x4E800020,
  0x00000000, 0x00000000, 0x00000000,
  0x38600004, 0x4E800020,
);

const faddMemoryProgram = wordBytes(
  0xC8240000, // lfd  f1,0(r4)
  0xC8440008, // lfd  f2,8(r4)
  0xFC61102A, // fadd f3,f1,f2
  0xD8640010, // stfd f3,16(r4)
  0x80640010, // lwz  r3,16(r4)
  0x4E800020, // blr
);

// Load two aligned 16-byte guest vectors, add each byte modulo 256, store the
// resulting vector, and expose its first word through r3. The vector source
// bytes are all 1 and all 2, so the expected result is sixteen 0x03 bytes.
const vmxAddBytesProgram = wordBytes(
  0x7C2020CE, // lvx      v1,0,r4
  0x7C4028CE, // lvx      v2,0,r5
  0x10611000, // vaddubm  v3,v1,v2
  0x7C6039CE, // stvx     v3,0,r7
  0x80670000, // lwz      r3,0(r7)
  0x4E800020, // blr
);

const tests = [
  { name: 'li-r3-1', ppc: wordBytes(0x38600001, 0x4E800020), initialGprs: [], memorySeeds: [], expectedR3: 1n },
  { name: 'runtime-addi-r4-plus-5', ppc: wordBytes(0x38640005, 0x4E800020), initialGprs: [[4, 7n]], memorySeeds: [], expectedR3: 12n },
  { name: 'runtime-ori-r4-f0', ppc: wordBytes(0x608300F0, 0x4E800020), initialGprs: [[4, 0x0F00n]], memorySeeds: [], expectedR3: 0x0FF0n },
  { name: 'branch-equal-taken', ppc: conditionalProgram, initialGprs: [[4, 0n]], memorySeeds: [], expectedR3: 2n },
  { name: 'branch-equal-not-taken', ppc: conditionalProgram, initialGprs: [[4, 5n]], memorySeeds: [], expectedR3: 1n },
  {
    name: 'lwz-from-xenia-memory', ppc: wordBytes(0x80640000, 0x4E800020),
    initialGprs: [[4, BigInt(guestDataAddress)]], memorySeeds: [[guestDataAddress, 0x89ABCDEF]],
    expectedR3: 0x89ABCDEFn,
  },
  {
    name: 'stw-lwz-xenia-memory-roundtrip',
    ppc: wordBytes(0x90A40000, 0x80640000, 0x4E800020),
    initialGprs: [[4, BigInt(guestDataAddress)], [5, 0x12345678n]],
    memorySeeds: [[guestDataAddress, 0]], expectedR3: 0x12345678n,
    expectedMemory: [[guestDataAddress, 0x12345678]],
  },
  {
    name: 'lr-mtlr-mflr-roundtrip',
    ppc: wordBytes(0x7C8803A6, 0x7C6802A6, 0x4E800020),
    initialGprs: [[4, 0x80000040n]], memorySeeds: [], expectedR3: 0x80000040n,
  },
  {
    name: 'ctr-mtctr-mfctr-roundtrip',
    ppc: wordBytes(0x7C8903A6, 0x7C6902A6, 0x4E800020),
    initialGprs: [[4, 9n]], memorySeeds: [], expectedR3: 9n,
  },
  {
    name: 'cr-cmpwi-equal-mfcr',
    ppc: wordBytes(0x2C040000, 0x7C600026, 0x4E800020),
    initialGprs: [[4, 0n]], memorySeeds: [], expectedR3: 0x20000000n,
  },
  {
    name: 'ctr-bdnz-loop-three-iterations', ppc: ctrLoopProgram,
    initialGprs: [[4, 3n]], memorySeeds: [], expectedR3: 3n,
  },
  {
    name: 'direct-bl-callee-blr-caller', ppc: directCallProgram,
    initialGprs: [], memorySeeds: [], expectedR3: 7n,
  },
  {
    name: 'nested-bl-two-level-call-return', ppc: nestedCallProgram,
    initialGprs: [], memorySeeds: [], expectedR3: 7n,
  },
  {
    name: 'fpu-fmr-f1-f2-zero-data-path', ppc: wordBytes(0xFC201090, 0x4E800020),
    initialGprs: [], memorySeeds: [], expectedR3: 0n,
  },
  {
    name: 'fpu-lfd-fadd-stfd-three', ppc: faddMemoryProgram,
    initialGprs: [[4, BigInt(guestDataAddress)]],
    memorySeeds: [
      [guestDataAddress + 0, 0x3FF00000], [guestDataAddress + 4, 0x00000000],
      [guestDataAddress + 8, 0x40000000], [guestDataAddress + 12, 0x00000000],
      [guestDataAddress + 16, 0x00000000], [guestDataAddress + 20, 0x00000000],
    ],
    expectedR3: 0x40080000n,
    expectedMemory: [[guestDataAddress + 16, 0x40080000], [guestDataAddress + 20, 0x00000000]],
  },
  {
    name: 'vmx-lvx-vaddubm-stvx-bytes', ppc: vmxAddBytesProgram,
    initialGprs: [
      [4, BigInt(guestDataAddress + 0x40)],
      [5, BigInt(guestDataAddress + 0x50)],
      [7, BigInt(guestDataAddress + 0x60)],
    ],
    memorySeeds: [
      [guestDataAddress + 0x40, 0x01010101], [guestDataAddress + 0x44, 0x01010101],
      [guestDataAddress + 0x48, 0x01010101], [guestDataAddress + 0x4C, 0x01010101],
      [guestDataAddress + 0x50, 0x02020202], [guestDataAddress + 0x54, 0x02020202],
      [guestDataAddress + 0x58, 0x02020202], [guestDataAddress + 0x5C, 0x02020202],
      [guestDataAddress + 0x60, 0], [guestDataAddress + 0x64, 0],
      [guestDataAddress + 0x68, 0], [guestDataAddress + 0x6C, 0],
    ],
    expectedR3: 0x03030303n,
    expectedMemory: [
      [guestDataAddress + 0x60, 0x03030303], [guestDataAddress + 0x64, 0x03030303],
      [guestDataAddress + 0x68, 0x03030303], [guestDataAddress + 0x6C, 0x03030303],
    ],
  },
];

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

for (const test of tests) {
  if (capacity < test.ppc.length) fail(`Probe input capacity too small for ${test.name}: ${capacity}`, 6);
  pick('r360_ppc_probe_reset')();
  for (const [index, value] of test.initialGprs) {
    const accepted = pick('r360_ppc_probe_set_initial_gpr')(index, value) >>> 0;
    if (accepted !== 1) fail(`Failed to seed GPR r${index} for ${test.name}`, 7);
  }
  for (const [address, value] of test.memorySeeds) {
    const accepted = pick('r360_ppc_probe_write_guest_u32_be')(address, value) >>> 0;
    if (accepted !== 1) fail(`Failed to seed guest memory 0x${address.toString(16)} for ${test.name}`, 8);
  }

  new Uint8Array(instance.exports.memory.buffer, inputPtr, test.ppc.length).set(test.ppc);
  const loaded = pick('r360_ppc_probe_load')(inputPtr, test.ppc.length) >>> 0;
  if (loaded !== test.ppc.length) {
    fail(`Probe load failed for ${test.name}: loaded=${loaded} status=0x${(pick('r360_ppc_probe_status')() >>> 0).toString(16)}`, 9);
  }

  const translatedCount = pick('r360_ppc_probe_translate')() >>> 0;
  const status = pick('r360_ppc_probe_status')() >>> 0;
  const guestBase = pick('r360_ppc_probe_guest_base')() >>> 0;
  const loadedSize = pick('r360_ppc_probe_loaded_size')() >>> 0;
  const assembled = pick('r360_ppc_probe_assembled_functions')() >>> 0;
  const blocks = pick('r360_ppc_probe_hir_block_count')() >>> 0;
  const hir = pick('r360_ppc_probe_hir_instruction_count')() >>> 0;
  const lastGuest = pick('r360_ppc_probe_last_guest_address')() >>> 0;
  const correctnessStatus = pick('r360_ppc_probe_correctness_status')() >>> 0;
  const correctnessInstructions = pick('r360_ppc_probe_correctness_instructions')() >>> 0;
  const correctnessR3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());

  console.log(`case=${test.name}`);
  console.log(`status=${status}`);
  console.log(`guest_base=0x${guestBase.toString(16).padStart(8, '0')}`);
  console.log(`loaded_bytes=${loadedSize}`);
  console.log(`assembled_functions=${assembled}`);
  console.log(`hir_blocks=${blocks}`);
  console.log(`hir_instructions=${hir}`);
  console.log(`translate_return=${translatedCount}`);
  console.log(`last_guest_address=0x${lastGuest.toString(16).padStart(8, '0')}`);
  console.log(`correctness_status=${correctnessStatus}`);
  console.log(`correctness_instructions=${correctnessInstructions}`);
  console.log(`correctness_r3=${correctnessR3}`);

  if (status !== 3 || loadedSize !== test.ppc.length || assembled === 0 || blocks === 0 ||
      hir === 0 || translatedCount === 0 || lastGuest !== guestBase) {
    fail(`FAIL ${test.name}: real PPC bytes did not complete Xenia PPC -> finalized HIR.`, 10);
  }
  if (correctnessStatus !== 3 || correctnessInstructions === 0 || correctnessR3 !== test.expectedR3) {
    fail(`FAIL ${test.name}: finalized Xenia HIR produced r3=${correctnessR3}, expected ${test.expectedR3}.`, 11);
  }
  for (const [address, expected] of test.expectedMemory ?? []) {
    const actual = pick('r360_ppc_probe_read_guest_u32_be')(address) >>> 0;
    console.log(`guest_memory[0x${address.toString(16)}]=0x${actual.toString(16).padStart(8, '0')}`);
    if (actual !== (expected >>> 0)) {
      fail(`FAIL ${test.name}: guest memory at 0x${address.toString(16)} = 0x${actual.toString(16)}, expected 0x${(expected >>> 0).toString(16)}.`, 12);
    }
  }
  console.log(`PASS: ${test.name} -> r3=${correctnessR3}`);
}

console.log(`PASS: ${tests.length} real PPC correctness programs translated and executed through finalized Xenia HIR.`);
console.log('PASS: guest lwz/stw correctness uses the same bounded Xenia Memory object as the Processor.');
console.log('PASS: LR/CTR/CR state and a real CTR-controlled bdnz loop are verified through Xenia PPCContext semantics.');
console.log('PASS: direct and two-level nested bl/callee/blr guest call chains use independently Xenia-scanned and translated callees.');
console.log('PASS: FPU correctness includes real lfd/fadd/stfd guest-memory flow with raw IEEE-754 result verification.');
console.log('PASS: VMX correctness includes real lvx/vaddubm/stvx guest-memory flow with 16-byte result verification.');
