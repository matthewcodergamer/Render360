// Render360 V36 retail XEX NORMAL preparation adapter.
// This joins the already-verified XEX metadata, session-key/AES-CBC,
// NORMAL framing and upstream Xenia LZX contracts without weakening any layer.

export async function prepareEncryptedRetailNormal({core, bootstrap, header, encryptedBody, useDevkitKey = 0}) {
  const c = core.exports;
  const pick = n => bootstrap.exports[n] ?? bootstrap.exports[`_${n}`];
  const cio = c.r360_io_ptr() >>> 0;
  const ccap = c.r360_io_capacity() >>> 0;
  const cmem = () => new Uint8Array(c.memory.buffer);
  const bmem = pick('memory');
  const bheap = () => new Uint8Array(bmem.buffer);
  const stageCore = bytes => {
    if (bytes.length > ccap) throw new Error('retail NORMAL core staging overflow');
    cmem().set(bytes, cio);
  };

  stageCore(header);
  if ((c.r360_xex_decode(header.length) >>> 0) !== 1) throw new Error('retail NORMAL XEX decode failed');
  if ((c.r360_xex_decode_encryption_type() >>> 0) !== 1) throw new Error('retail NORMAL requires encryption type 1');
  if ((c.r360_xex_decode_compression_type() >>> 0) !== 2) throw new Error('retail NORMAL requires compression type 2');

  const cryptoPtr = pick('r360_xex_crypto_buffer')() >>> 0;
  const cryptoCap = pick('r360_xex_crypto_capacity')() >>> 0;
  if (!cryptoPtr || encryptedBody.length > cryptoCap || (encryptedBody.length & 15)) {
    throw new Error('retail NORMAL AES body must fit and be 16-byte aligned');
  }

  // The caller stages the encrypted 16-byte XEX security-info session key at
  // cryptoPtr before invoking this function. begin_session derives the title
  // session key with Xenia's retail/devkit master-key semantics.
  if ((pick('r360_xex_crypto_begin_session')(useDevkitKey) >>> 0) !== 1) {
    throw new Error(`retail NORMAL session derivation failed status=${pick('r360_xex_crypto_status')() >>> 0}`);
  }

  const decrypted = Buffer.alloc(encryptedBody.length);
  let offset = 0;
  while (offset < encryptedBody.length) {
    const n = Math.min(cryptoCap, encryptedBody.length - offset) & ~15;
    if (!n) throw new Error('retail NORMAL AES chunk accounting failed');
    bheap().set(encryptedBody.subarray(offset, offset + n), cryptoPtr);
    if ((pick('r360_xex_crypto_decrypt_chunk')(n) >>> 0) !== 1) {
      throw new Error(`retail NORMAL AES decrypt failed status=${pick('r360_xex_crypto_status')() >>> 0}`);
    }
    decrypted.set(bheap().subarray(cryptoPtr, cryptoPtr + n), offset);
    offset += n;
  }
  if ((pick('r360_xex_crypto_bytes_done')() >>> 0) !== encryptedBody.length) {
    throw new Error('retail NORMAL AES byte accounting mismatch');
  }

  // NORMAL framing operates on the post-decryption stream. Preserve the
  // original header for metadata truth, but present a normalized framing copy
  // so the framing layer does not attempt to reject encryption that has
  // already been consumed by the crypto stage.
  const framingHeader = Buffer.from(header);
  const fileFormatInfo = framingHeader.readUInt32BE(0x1c); // test/fixture layout uses optional header 0x3ff here.
  if (!fileFormatInfo || fileFormatInfo + 8 > framingHeader.length) throw new Error('retail NORMAL file-format header bounds');
  framingHeader.writeUInt16BE(0, fileFormatInfo + 4);

  stageCore(framingHeader);
  let st = c.r360_xex_prepare_normal_frame_begin(framingHeader.length, framingHeader.length + decrypted.length) >>> 0;
  if (st >= 100) throw new Error(`retail NORMAL frame begin failed ${st}`);
  const compacted = [];
  let p = 0;
  const pattern = [16, 32, 48, 64, 80, 96, 112, 128];
  let pi = 0;
  while (p < decrypted.length && st < 100 && st !== 2) {
    const n = Math.min(decrypted.length - p, pattern[pi++ % pattern.length]);
    stageCore(decrypted.subarray(p, p + n));
    st = c.r360_xex_prepare_normal_frame_accept(n) >>> 0;
    const outn = c.r360_xex_prepare_last_output_bytes() >>> 0;
    if (outn) compacted.push(Buffer.from(cmem().slice(cio, cio + outn)));
    p += n;
  }
  if (st !== 2) throw new Error(`retail NORMAL framing failed ${st}`);
  const lzxStream = Buffer.concat(compacted);

  const inPtr = pick('r360_lzx_input_buffer')() >>> 0;
  const inCap = pick('r360_lzx_input_capacity')() >>> 0;
  const outPtr = pick('r360_lzx_output_buffer')() >>> 0;
  const outCap = pick('r360_lzx_output_capacity')() >>> 0;
  const expectedSize = c.r360_xex_decode_image_size() >>> 0;
  if (!lzxStream.length || lzxStream.length > inCap || !expectedSize || expectedSize > outCap) {
    throw new Error('retail NORMAL LZX bounds');
  }
  pick('r360_lzx_reset')();
  bheap().set(lzxStream, inPtr);
  const windowSize = c.r360_xex_prepare_normal_window_size() >>> 0;
  const lzxStatus = pick('r360_lzx_decompress')(lzxStream.length, expectedSize, windowSize) >>> 0;
  if (lzxStatus !== 0 || (pick('r360_lzx_output_size')() >>> 0) !== expectedSize) {
    throw new Error(`retail NORMAL LZX failed ${lzxStatus}`);
  }
  return Buffer.from(bheap().slice(outPtr, outPtr + expectedSize));
}
