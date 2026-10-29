// Regression: PM4 type-3 predication (Xenia CommandProcessor::ExecutePacketType3).
// A type-3 packet with header bit 0 set runs only when (bin_select & bin_mask)
// is non-zero, and a predicated XE_SWAP never runs. D3D predicated tiling
// replays one IB per screen bin; without this check every bin-specific packet
// (including D3D's GPU-to-CPU callback requests) ran once per bin.
//
// Usage: node test-xenos-predication.mjs [bootstrap.wasm]
import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(module);
imports.env ||= {};
imports.env.emscripten_notify_memory_growth = () => {};
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const e = instance.exports;
const f = (name) => {
  const fn = e[name] ?? e[`_${name}`];
  if (typeof fn !== 'function') throw new Error(`missing export ${name}`);
  return fn;
};

const type3 = (opcode, count, predicated = false) =>
  ((3 << 30) | ((count - 1) << 16) | (opcode << 8) | (predicated ? 1 : 0)) >>> 0;
const kSetConstant = 0x2D, kSetBinMaskLo = 0x60, kSetBinSelectLo = 0x62, kXeSwap = 0x64;
const setConstant = (register, value, predicated) =>
  [type3(kSetConstant, 2, predicated), (4 << 16) | (register - 0x2000), value];

f('r360_xenos_reset')();
const words = [
  type3(kSetBinMaskLo, 1), 0x1,
  type3(kSetBinSelectLo, 1), 0x2,                 // selected bin not in mask
  ...setConstant(0x2010, 0xAAAA, true),           // skipped
  ...setConstant(0x2011, 0xBBBB, false),          // not predicated: runs
  type3(kSetBinSelectLo, 1), 0x1,                 // selected bin in mask
  ...setConstant(0x2012, 0xCCCC, true),           // runs
  type3(kXeSwap, 4, true), 0x50415753, 0x00123000, 1280, 720,  // predicated swap: skipped
];
const ring = new Uint32Array(e.memory.buffer, f('r360_xenos_ring_buffer')() >>> 0, words.length);
ring.set(words);
if (!(f('r360_xenos_submit')(words.length) >>> 0)) {
  throw new Error(`submit failed status=${f('r360_xenos_status')() >>> 0}`);
}
const reg = (r) => f('r360_xenos_register')(r) >>> 0;
const checks = {
  'predicated packet with no matching bin is skipped': reg(0x2010) === 0,
  'unpredicated packet runs': reg(0x2011) === 0xBBBB,
  'predicated packet with a matching bin runs': reg(0x2012) === 0xCCCC,
  'predicated XE_SWAP is skipped': (f('r360_xenos_swaps')() >>> 0) === 0,
};
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`${name}: failed (0x2010=0x${reg(0x2010).toString(16)} 0x2011=0x${reg(0x2011).toString(16)} 0x2012=0x${reg(0x2012).toString(16)} swaps=${f('r360_xenos_swaps')() >>> 0})`);
  console.log(`ok: ${name}`);
}
console.log('XENOS_PREDICATION_PASS');
