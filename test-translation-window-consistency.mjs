// Regression: translating a guest function must not depend on where the
// movable 64 KiB PPC decoder window was left by an earlier translation.
// A function without .pdata is scanned up to the window end; if a previous
// translation left the window starting below the function, the scan stopped
// early and a truncated function was translated (Banjo-Tooie 0x824231E8 and
// its entry function varied between runs).
//
// Usage: node test-translation-window-consistency.mjs [bootstrap.wasm]
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
const pick = (name) => {
  const f = e[name] ?? e[`_${name}`];
  if (typeof f !== 'function') throw new Error(`missing export ${name}`);
  return f;
};

const base = 0x20000000;
const pages = 20;                    // 80 KiB of executable sparse memory
const small = base;                  // li r3,1; blr
const big = base + 0xF000;           // starts inside a window based at `base`
const bigCount = 2048;               // addi r3,r3,1 x 2048, then blr: ends past base+0x10000

pick('r360_sparse_guest_memory_reset')();
const backing = pick('r360_sparse_guest_memory_alloc')(pages) >>> 0;
if (!backing || (pick('r360_sparse_guest_memory_map')(base, pages, backing, 0, 7) >>> 0) !== 1) {
  throw new Error('could not map executable sparse pages');
}
const write = (address, word) => {
  if ((pick('r360_sparse_guest_memory_write_u32_be')(address, word) >>> 0) !== 1) {
    throw new Error(`could not write 0x${address.toString(16)}`);
  }
};
write(small, 0x38600001);       // li r3,1
write(small + 4, 0x4E800020);   // blr
write(big, 0x38600000);         // li r3,0
for (let i = 1; i <= bigCount; i++) write(big + i * 4, 0x38630001);  // addi r3,r3,1
write(big + (bigCount + 1) * 4, 0x4E800020);                          // blr

// One reset: window state carries over between translations, as in a title.
pick('r360_ppc_probe_reset')();
const translate = (address) => {
  pick('r360_ppc_probe_set_execute_on_translate')(1);
  pick('r360_ppc_probe_set_initial_lr')(0xBCBCBCBCn);
  const hir = pick('r360_ppc_probe_translate_scanned_at')(address) >>> 0;
  const status = pick('r360_ppc_probe_correctness_status')() >>> 0;
  const r3 = Number(BigInt.asUintN(32, BigInt(pick('r360_ppc_probe_correctness_r3')())));
  return { hir, status, r3 };
};

// 1. Leave the decoder window based at `base` (it then contains `big`).
const first = translate(small);
if (!first.hir || first.r3 !== 1) throw new Error(`small function failed ${JSON.stringify(first)}`);
// 2. Translate `big` while that window is current.
const afterLow = translate(big);
// 3. Translate `big` again (window now based at big's page) and once more after
//    moving the window back down.
const fresh = translate(big);
translate(small);
const again = translate(big);

const expected = { r3: bigCount };
for (const [name, run] of Object.entries({ afterLow, fresh, again })) {
  if (!run.hir || run.r3 !== expected.r3) {
    throw new Error(`${name}: ${JSON.stringify(run)} (expected r3=${bigCount}: the whole function)`);
  }
}
if (afterLow.hir !== fresh.hir || fresh.hir !== again.hir) {
  throw new Error(`translation depends on window history: ${afterLow.hir}/${fresh.hir}/${again.hir} HIR instructions`);
}
console.log(`translation window consistency: ${fresh.hir} HIR instructions each time, r3=${fresh.r3}`);
console.log('TRANSLATION_WINDOW_CONSISTENCY_PASS');
