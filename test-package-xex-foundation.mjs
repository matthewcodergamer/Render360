import fs from 'node:fs';
import zlib from 'node:zlib';

function put32be(mem, off, v) {
  mem[off] = (v >>> 24) & 255;
  mem[off + 1] = (v >>> 16) & 255;
  mem[off + 2] = (v >>> 8) & 255;
  mem[off + 3] = v & 255;
}
function put64be(mem, off, v) {
  const hi = Math.floor(v / 0x100000000), lo = v >>> 0;
  put32be(mem, off, hi); put32be(mem, off + 4, lo);
}
function put16be(mem, off, v) { mem[off] = (v >>> 8) & 255; mem[off + 1] = v & 255; }
function put16le(mem, off, v) { mem[off] = v & 255; mem[off + 1] = (v >>> 8) & 255; }
function put24le(mem, off, v) { mem[off] = v & 255; mem[off + 1] = (v >>> 8) & 255; mem[off + 2] = (v >>> 16) & 255; }
function ascii(mem, off, s) { mem.set(Buffer.from(s, 'ascii'), off); }
function utf16be(mem, off, text) {
  for (let i = 0; i < text.length; i++) {
    const v = text.charCodeAt(i); mem[off + i * 2] = (v >>> 8) & 255; mem[off + i * 2 + 1] = v & 255;
  }
}
function u64(lo, hi) { return (hi >>> 0) * 0x100000000 + (lo >>> 0); }

function makeXexPayload() {
  const x = new Uint8Array(0x1800);
  ascii(x, 0, 'XEX2');
  put32be(x, 4, 1);            // module flags
  put32be(x, 8, 0x280);        // header size
  put32be(x, 0x10, 0x80);      // security info offset
  put32be(x, 0x14, 4);         // optional header count
  let h = 0x18;
  put32be(x, h, 0x00010100); put32be(x, h + 4, 0x82001234); h += 8; // entry
  put32be(x, h, 0x00010201); put32be(x, h + 4, 0x82000000); h += 8; // image base
  put32be(x, h, 0x00040006); put32be(x, h + 4, 0x40); h += 8;       // execution info
  put32be(x, h, 0x000003FF); put32be(x, h + 4, 0x58);               // file format
  put32be(x, 0x40, 0xAABBCCDD); put32be(x, 0x4C, 0x584108CE);
  put32be(x, 0x58, 8); put16be(x, 0x5C, 1); put16be(x, 0x5E, 2);
  put32be(x, 0x84, 0x01000000); put32be(x, 0x190, 0x82000000);
  put32be(x, 0x1F8, 0xFFFFFFFF); put32be(x, 0x1FC, 1); put32be(x, 0x200, 12);
  for (let i = 0x1000; i < x.length; i++) x[i] = (i * 17 + 0x36) & 0xFF;
  return x;
}

function makeSyntheticStfs() {
  // Header rounds to A000. Hash L0=A000. Data blocks 0..4=B000..F000.
  // Directory block chain 0 -> 2. default.xex uses data blocks 3 -> 4.
  const bytes = new Uint8Array(0x10000);
  const xex = makeXexPayload();
  ascii(bytes, 0, 'LIVE');
  put32be(bytes, 0x340, 0x971A); put32be(bytes, 0x344, 0x000D0000);
  put32be(bytes, 0x348, 2); put64be(bytes, 0x34C, xex.length);
  put32be(bytes, 0x354, 0xAABBCCDD); put32be(bytes, 0x360, 0x584108CE);
  const d = 0x379;
  bytes[d] = 0x24; bytes[d + 1] = 0; bytes[d + 2] = 1;
  put16le(bytes, d + 3, 2); put24le(bytes, d + 5, 0);
  put32be(bytes, d + 0x1C, 5); put32be(bytes, d + 0x20, 0);
  put32be(bytes, 0x39D, 0); put32be(bytes, 0x3A9, 0);
  utf16be(bytes, 0x411, 'Render360 Foundation Gate');

  // STFS hash records: directory block 0 -> 2; XEX data block 3 -> 4.
  put32be(bytes, 0xA000 + 0 * 0x18 + 0x14, 2);
  put32be(bytes, 0xA000 + 3 * 0x18 + 0x14, 4);

  let e = 0xB000;
  ascii(bytes, e, 'readme.txt'); bytes[e + 0x28] = 0x40 + 10;
  put24le(bytes, e + 0x29, 1); put24le(bytes, e + 0x2C, 1); put24le(bytes, e + 0x2F, 1);
  put16be(bytes, e + 0x32, 0xFFFF); put32be(bytes, e + 0x34, 0x10);

  e = 0xD000;
  ascii(bytes, e, 'default.xex'); bytes[e + 0x28] = 0x40 + 11;
  put24le(bytes, e + 0x29, 2); put24le(bytes, e + 0x2C, 2); put24le(bytes, e + 0x2F, 3);
  put16be(bytes, e + 0x32, 0xFFFF); put32be(bytes, e + 0x34, xex.length);

  bytes.set(xex.subarray(0, 0x1000), 0xE000);
  bytes.set(xex.subarray(0x1000), 0xF000);
  return { bytes, xex };
}

const embedded = fs.readFileSync('render360_xenia_core_embedded.js', 'utf8');
const match = embedded.match(/CORE_WASM_GZIP_BASE64\s*=\s*['\"]([^'\"]+)['\"]/);
if (!match) throw new Error('Embedded V32 core payload not found');
const wasm = zlib.gunzipSync(Buffer.from(match[1], 'base64'));
const { instance } = await WebAssembly.instantiate(wasm, {});
const e = instance.exports;
const required = [
  'memory','r360_io_ptr','r360_io_capacity','r360_probe_container','r360_inspect_xex','r360_xex_status',
  'r360_xex_entry_point','r360_xex_image_base','r360_xex_title_id','r360_xex_media_id',
  'r360_stfs_mount_begin','r360_stfs_submit_read','r360_stfs_request_pending','r360_stfs_request_offset_lo',
  'r360_stfs_request_offset_hi','r360_stfs_request_size','r360_stfs_mount_status','r360_stfs_entry_count',
  'r360_stfs_default_xex_index','r360_stfs_default_xex_kind','r360_stfs_extract_begin','r360_stfs_extract_status',
  'r360_stfs_extract_bytes_total','r360_stfs_extract_bytes_done','r360_stfs_extract_blocks_done'
];
for (const name of required) if (!(name in e)) throw new Error(`Missing V32 package/XEX ABI export: ${name}`);

const io = e.r360_io_ptr() >>> 0, cap = e.r360_io_capacity() >>> 0;
const memory = () => new Uint8Array(e.memory.buffer);
const stage = (chunk) => { if (chunk.length > cap) throw new Error('I/O staging overflow'); memory().set(chunk, io); };
const image = makeSyntheticStfs();

let status = e.r360_stfs_mount_begin(image.bytes.length >>> 0, 0) >>> 0;
let mountReads = 0;
while ((e.r360_stfs_request_pending() >>> 0) !== 0) {
  if (++mountReads > 64) throw new Error('STFS mount request loop runaway');
  const off = u64(e.r360_stfs_request_offset_lo(), e.r360_stfs_request_offset_hi());
  const size = e.r360_stfs_request_size() >>> 0;
  const chunk = image.bytes.slice(off, off + size);
  if (chunk.length !== size) throw new Error(`STFS mount short read @0x${off.toString(16)}`);
  stage(chunk); status = e.r360_stfs_submit_read(chunk.length) >>> 0;
}
if (status !== 2 || (e.r360_stfs_mount_status() >>> 0) !== 2) throw new Error(`STFS mount failed: ${status}`);
if ((e.r360_stfs_entry_count() >>> 0) !== 2) throw new Error('STFS directory enumeration mismatch');
const xexIndex = e.r360_stfs_default_xex_index() >>> 0;
if (xexIndex !== 1 || (e.r360_stfs_default_xex_kind() >>> 0) !== 2) throw new Error('default.xex discovery/classification failed');

status = e.r360_stfs_extract_begin(xexIndex) >>> 0;
const captured = new Uint8Array(image.xex.length);
let extractReads = 0;
while ((e.r360_stfs_request_pending() >>> 0) !== 0) {
  if (++extractReads > 64) throw new Error('STFS extraction request loop runaway');
  const off = u64(e.r360_stfs_request_offset_lo(), e.r360_stfs_request_offset_hi());
  const size = e.r360_stfs_request_size() >>> 0;
  const dest = e.r360_stfs_extract_bytes_done() >>> 0;
  const chunk = image.bytes.slice(off, off + size);
  if (chunk.length !== size) throw new Error(`STFS extraction short read @0x${off.toString(16)}`);
  captured.set(chunk.subarray(0, Math.min(chunk.length, captured.length - dest)), dest);
  stage(chunk); status = e.r360_stfs_submit_read(chunk.length) >>> 0;
}
if ((e.r360_stfs_extract_status() >>> 0) !== 2) throw new Error(`default.xex extraction failed: ${status}`);
if ((e.r360_stfs_extract_bytes_total() >>> 0) !== image.xex.length || (e.r360_stfs_extract_bytes_done() >>> 0) !== image.xex.length) throw new Error('default.xex extraction byte count mismatch');
if ((e.r360_stfs_extract_blocks_done() >>> 0) !== 2) throw new Error('default.xex did not traverse two data blocks');
if (!Buffer.from(captured).equals(Buffer.from(image.xex))) throw new Error('complete default.xex capture differs from STFS payload');

stage(captured);
if ((e.r360_inspect_xex(captured.length) >>> 0) !== 1 || (e.r360_xex_status() >>> 0) !== 1) throw new Error('captured default.xex structural inspection failed');
if ((e.r360_xex_entry_point() >>> 0) !== 0x82001234 || (e.r360_xex_image_base() >>> 0) !== 0x82000000) throw new Error('XEX execution metadata mismatch');
if ((e.r360_xex_title_id() >>> 0) !== 0x584108CE || (e.r360_xex_media_id() >>> 0) !== 0xAABBCCDD) throw new Error('XEX execution info mismatch');

for (const [magic, expected] of [['XEX2',2],['LIVE',10],['PIRS',11],['CON ',12]]) {
  const probe = new Uint8Array(16); ascii(probe, 0, magic); stage(probe);
  if ((e.r360_probe_container(probe.length) >>> 0) !== expected) throw new Error(`${magic} classification failed`);
}

console.log('PACKAGE_XEX_FOUNDATION=PASS');
console.log(`mount_reads=${mountReads}`);
console.log(`extract_reads=${extractReads}`);
console.log(`default_xex_bytes=${image.xex.length}`);
console.log(`default_xex_blocks=${e.r360_stfs_extract_blocks_done() >>> 0}`);
console.log('xex_entry=0x82001234');
console.log('PASS: LIVE/PIRS/CON classification, STFS mount/directory/hash-chain traversal, complete multi-block default.xex extraction, and XEX structural metadata inspection are runtime-gated.');
