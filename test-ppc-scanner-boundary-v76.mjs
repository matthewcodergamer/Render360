import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = name => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const overlay = read('prepare-xenia-web-overlay.py');
const build = read('build-xenia-ppc-bootstrap.sh');
const probe = read('src/xenia_web_bootstrap/ppc_translation_probe.cpp');
const loader = read('src/xenia_web_bootstrap/xex_pe_guest_loader.cpp');

assert.match(overlay, /PPC_SCANNER_SOURCE = XENIA \/ "src\/xenia\/cpu\/ppc\/ppc_scanner\.cc"/);
assert.match(overlay, /PPC_SCANNER_DEST = OVERLAY \/ "xenia\/cpu\/ppc\/ppc_scanner\.cc"/);
assert.match(overlay, /if \(end_address && address > end_address\) \{[\s\S]*?address = end_address;[\s\S]*?function->set_end_address\(address\);/);
assert.match(build, /"src\/xenia\/cpu\/ppc\/ppc_scanner\.cc"\) queue_cpp "\$rel" "\$OVERLAY\/xenia\/cpu\/ppc\/ppc_scanner\.cc"/);

// Render360's PE runtime-function table stores an exclusive end, while the PPC
// probe converts that to Xenia's inclusive GuestFunction end with fn_end - 4.
assert.match(loader, /end_exclusive/);
assert.match(loader, /a>=it->begin&&a<it->end/);
assert.match(probe, /const uint32_t scan_end=pdata\?fn_end-4:/);

// Exact Braid regression from the iPhone report. Before V76, Xenia's scanner
// could advance 0x8236F0F8 to 0x8236F0FC and publish that widened value. The
// overlay must retain 0x8236F0F8 as the final inclusive instruction address.
const begin = 0x8236EF38;
const endExclusive = 0x8236F0FC;
const inclusiveEnd = endExclusive - 4;
const scannerCursorAfterBound = endExclusive;
const clampedEnd = Math.min(scannerCursorAfterBound, inclusiveEnd);
assert.equal(inclusiveEnd >>> 0, 0x8236F0F8);
assert.equal(clampedEnd >>> 0, 0x8236F0F8);
assert.ok(begin < clampedEnd);

assert.equal(Number(read('VERSION').trim()), 76);
console.log('R360_V76_PPC_SCANNER_BOUNDARY=PASS entry=0x8236EF38 end=0x8236F0F8');
