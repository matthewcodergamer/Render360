// Render360 V36 unified retail XEX image preparation.
// Supports ordinary XEX compression kinds NONE(0), BASIC(1), NORMAL(2), with
// encryption NONE(0) or NORMAL AES(1). DELTA(3) remains a distinct patch-image
// feature and is intentionally rejected by the XEX decoder.

function findFileFormatInfo(header) {
  if (header.length < 0x18) throw new Error('XEX header too short');
  const count = header.readUInt32BE(0x14);
  let p = 0x18;
  for (let i = 0; i < count; i++, p += 8) {
    if (p + 8 > header.length) throw new Error('XEX optional-header table truncated');
    const key = header.readUInt32BE(p);
    const value = header.readUInt32BE(p + 4);
    if (key === 0x3ff) return value >>> 0;
  }
  throw new Error('XEX file-format info missing');
}

function normalizeDecryptedHeader(header) {
  const out = Buffer.from(header);
  const ffi = findFileFormatInfo(out);
  if (ffi + 8 > out.length) throw new Error('XEX file-format info out of range');
  out.writeUInt16BE(0, ffi + 4);
  return out;
}

function coreStage(core, bytes) {
  const e = core.exports;
  const ptr = e.r360_io_ptr() >>> 0;
  const cap = e.r360_io_capacity() >>> 0;
  if (bytes.length > cap) throw new Error('XEX core staging overflow');
  new Uint8Array(e.memory.buffer).set(bytes, ptr);
}

function bootstrapPick(bootstrap, name) {
  return bootstrap.exports[name] ?? bootstrap.exports[`_${name}`];
}

function validateRequired(core, bootstrap) {
  const ce = core.exports;
  for (const n of [
    'memory','r360_io_ptr','r360_io_capacity','r360_xex_decode',
    'r360_xex_decode_encryption_type','r360_xex_decode_compression_type',
    'r360_xex_decode_image_size','r360_xex_prepare_none_begin',
    'r360_xex_prepare_none_accept','r360_xex_prepare_basic_begin',
    'r360_xex_prepare_basic_accept_data','r360_xex_prepare_basic_consume_zero',
    'r360_xex_prepare_basic_data_remaining','r360_xex_prepare_basic_zero_remaining',
    'r360_xex_prepare_status','r360_xex_prepare_last_output_kind',
    'r360_xex_prepare_last_output_bytes','r360_xex_prepare_normal_frame_begin',
    'r360_xex_prepare_normal_frame_accept','r360_xex_prepare_normal_window_size'
  ]) if (!(n in ce)) throw new Error(`missing core retail pipeline export ${n}`);
  for (const n of [
    'memory','r360_xex_crypto_buffer','r360_xex_crypto_capacity','r360_xex_crypto_reset',
    'r360_xex_crypto_begin_session','r360_xex_crypto_decrypt_chunk',
    'r360_xex_crypto_bytes_done','r360_xex_crypto_status','r360_lzx_input_buffer',
    'r360_lzx_input_capacity','r360_lzx_output_buffer','r360_lzx_output_capacity',
    'r360_lzx_reset','r360_lzx_decompress','r360_lzx_output_size'
  ]) if (typeof bootstrapPick(bootstrap,n) !== 'function' && n !== 'memory') throw new Error(`missing bootstrap retail pipeline export ${n}`);
}

function decryptBody(bootstrap, encryptedSecurityKey, encryptedBody, useDevkitKey) {
  const pick = n => bootstrapPick(bootstrap,n);
  const mem = bootstrap.exports.memory;
  const heap = () => new Uint8Array(mem.buffer);
  const ptr = pick('r360_xex_crypto_buffer')() >>> 0;
  const cap = pick('r360_xex_crypto_capacity')() >>> 0;
  if (!encryptedSecurityKey || encryptedSecurityKey.length !== 16) throw new Error('encrypted XEX security key must be 16 bytes');
  if (!encryptedBody.length || encryptedBody.length > 0xffffffff || (encryptedBody.length & 15)) throw new Error('encrypted XEX body must be non-empty and AES-block aligned');
  pick('r360_xex_crypto_reset')();
  heap().set(encryptedSecurityKey, ptr);
  if ((pick('r360_xex_crypto_begin_session')(useDevkitKey ? 1 : 0) >>> 0) !== 1) throw new Error(`XEX session derivation failed ${pick('r360_xex_crypto_status')()>>>0}`);
  const out = Buffer.alloc(encryptedBody.length);
  let off = 0;
  while (off < encryptedBody.length) {
    let n = Math.min(cap, encryptedBody.length - off);
    n &= ~15;
    if (!n) throw new Error('XEX AES chunk accounting failed');
    heap().set(encryptedBody.subarray(off,off+n),ptr);
    if ((pick('r360_xex_crypto_decrypt_chunk')(n)>>>0)!==1) throw new Error(`XEX AES decrypt failed ${pick('r360_xex_crypto_status')()>>>0}`);
    out.set(heap().subarray(ptr,ptr+n),off);
    off += n;
  }
  if ((pick('r360_xex_crypto_bytes_done')()>>>0)!==encryptedBody.length) throw new Error('XEX AES byte accounting mismatch');
  return out;
}

function prepareNone(core, header, body) {
  const e=core.exports; coreStage(core,header);
  let st=e.r360_xex_prepare_none_begin(header.length,header.length+body.length)>>>0;
  if(st!==1) throw new Error(`NONE begin failed ${st}`);
  const out=[]; let off=0;
  while(off<body.length){const n=Math.min(body.length-off,0x7000);const chunk=body.subarray(off,off+n);coreStage(core,chunk);st=e.r360_xex_prepare_none_accept(n)>>>0;out.push(Buffer.from(chunk));off+=n;}
  if(st!==2) throw new Error(`NONE preparation failed ${st}`);
  return Buffer.concat(out);
}

function prepareBasic(core, header, body) {
  const e=core.exports; coreStage(core,header);
  let st=e.r360_xex_prepare_basic_begin(header.length,header.length+body.length)>>>0;
  if(st!==1) throw new Error(`BASIC begin failed ${st}`);
  const out=[];let off=0,guard=0;
  while((e.r360_xex_prepare_status()>>>0)===1){
    if(++guard>100000) throw new Error('BASIC preparation loop runaway');
    const zero=e.r360_xex_prepare_basic_zero_remaining()>>>0;
    if(zero){const n=Math.min(zero,0x4000);st=e.r360_xex_prepare_basic_consume_zero(n)>>>0;const outn=e.r360_xex_prepare_last_output_bytes()>>>0;if(!outn||(e.r360_xex_prepare_last_output_kind()>>>0)!==2)throw new Error('BASIC zero event mismatch');out.push(Buffer.alloc(outn));continue;}
    const data=e.r360_xex_prepare_basic_data_remaining()>>>0;if(!data)throw new Error('BASIC state has no work');const n=Math.min(data,body.length-off,0x7000);if(!n)throw new Error('BASIC encrypted source truncated');const chunk=body.subarray(off,off+n);coreStage(core,chunk);st=e.r360_xex_prepare_basic_accept_data(n)>>>0;const outn=e.r360_xex_prepare_last_output_bytes()>>>0;if(outn!==n||(e.r360_xex_prepare_last_output_kind()>>>0)!==1)throw new Error('BASIC data event mismatch');out.push(Buffer.from(chunk));off+=n;
  }
  if(st!==2||off!==body.length) throw new Error(`BASIC preparation failed status=${st} source=${off}/${body.length}`);
  return Buffer.concat(out);
}

function prepareNormal(core, bootstrap, header, body) {
  const e=core.exports;coreStage(core,header);
  let st=e.r360_xex_prepare_normal_frame_begin(header.length,header.length+body.length)>>>0;
  if(st>=100)throw new Error(`NORMAL begin failed ${st}`);
  const compact=[];let off=0,pi=0;const pattern=[17,31,67,127,251,509];
  while(off<body.length&&st!==2&&st<100){const n=Math.min(body.length-off,pattern[pi++%pattern.length]);coreStage(core,body.subarray(off,off+n));st=e.r360_xex_prepare_normal_frame_accept(n)>>>0;const outn=e.r360_xex_prepare_last_output_bytes()>>>0;if(outn)compact.push(Buffer.from(new Uint8Array(e.memory.buffer,e.r360_io_ptr()>>>0,outn)));off+=n;}
  if(st!==2)throw new Error(`NORMAL framing failed ${st}`);
  const stream=Buffer.concat(compact);const pick=n=>bootstrapPick(bootstrap,n);const mem=bootstrap.exports.memory;const heap=()=>new Uint8Array(mem.buffer);const ip=pick('r360_lzx_input_buffer')()>>>0,ic=pick('r360_lzx_input_capacity')()>>>0,op=pick('r360_lzx_output_buffer')()>>>0,oc=pick('r360_lzx_output_capacity')()>>>0,expected=e.r360_xex_decode_image_size()>>>0;
  if(!stream.length||stream.length>ic||!expected||expected>oc)throw new Error('NORMAL LZX bounds');pick('r360_lzx_reset')();heap().set(stream,ip);const ls=pick('r360_lzx_decompress')(stream.length,expected,e.r360_xex_prepare_normal_window_size()>>>0)>>>0;if(ls!==0||(pick('r360_lzx_output_size')()>>>0)!==expected)throw new Error(`NORMAL LZX failed ${ls}`);return Buffer.from(heap().slice(op,op+expected));
}

export async function prepareRetailXexImage({core,bootstrap,header,body,encryptedSecurityKey=null,useDevkitKey=false}) {
  validateRequired(core,bootstrap);
  const h=Buffer.from(header);coreStage(core,h);
  if((core.exports.r360_xex_decode(h.length)>>>0)!==1)throw new Error('XEX metadata decode failed');
  const enc=core.exports.r360_xex_decode_encryption_type()>>>0;
  const comp=core.exports.r360_xex_decode_compression_type()>>>0;
  if(comp>2)throw new Error(`unsupported XEX patch/delta compression ${comp}`);
  let plainBody=Buffer.from(body),effectiveHeader=h;
  if(enc===1){plainBody=decryptBody(bootstrap,encryptedSecurityKey,plainBody,useDevkitKey);effectiveHeader=normalizeDecryptedHeader(h);}else if(enc!==0){throw new Error(`unsupported XEX encryption ${enc}`);}
  if(comp===0)return prepareNone(core,effectiveHeader,plainBody);
  if(comp===1)return prepareBasic(core,effectiveHeader,plainBody);
  return prepareNormal(core,bootstrap,effectiveHeader,plainBody);
}
