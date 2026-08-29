import fs from 'node:fs';
import assert from 'node:assert/strict';

const bytes=fs.readFileSync(new URL('./render360_xenia_core.wasm',import.meta.url));
const module=new WebAssembly.Module(bytes);
const exports=new Set(WebAssembly.Module.exports(module).map(x=>x.name));
const required=[
  'memory','r360_build_version','r360_abi_version','r360_feature_bits',
  'r360_io_ptr','r360_io_capacity','r360_probe_container',
  'r360_stfs_mount_begin','r360_stfs_submit_read','r360_stfs_request_pending',
  'r360_stfs_entry_count','r360_stfs_default_xex_index',
  'r360_xex_decode','r360_xex_decode_encryption_type','r360_xex_decode_compression_type','r360_xex_decode_image_size',
  'r360_xex_prepare_none_begin','r360_xex_prepare_none_accept',
  'r360_xex_prepare_basic_begin','r360_xex_prepare_basic_accept_data','r360_xex_prepare_basic_consume_zero',
  'r360_xex_prepare_basic_data_remaining','r360_xex_prepare_basic_zero_remaining',
  'r360_xex_prepare_status','r360_xex_prepare_last_output_kind','r360_xex_prepare_last_output_bytes',
  'r360_xex_prepare_normal_frame_begin','r360_xex_prepare_normal_frame_accept','r360_xex_prepare_normal_window_size',
];
const missing=required.filter(name=>!exports.has(name));
if(missing.length){
  console.error('PACKAGE_CORE_ARTIFACT FAIL');
  console.error(`missing exports (${missing.length}): ${missing.join(', ')}`);
  process.exit(1);
}
const instance=new WebAssembly.Instance(module,{});
const build=instance.exports.r360_build_version()>>>0;
const abi=instance.exports.r360_abi_version()>>>0;
assert.ok(build>=30,`checked-in package core build ${build} is below runtime floor 30`);
assert.ok(abi>=0x00030002,`checked-in package core ABI 0x${abi.toString(16)} is below 0x00030002`);
const nativeExtraction=exports.has('r360_stfs_extract_begin')&&exports.has('r360_stfs_extract_status');
console.log(`PACKAGE_CORE_ARTIFACT PASS build=${build} abi=0x${abi.toString(16)} native_stfs=${nativeExtraction?'yes':'browser-fallback'}`);
