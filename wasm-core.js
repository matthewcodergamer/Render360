export class Render360Core {
  constructor(url = './render360_xenia_core.wasm') {
    this.url = url;
    this.instance = null;
    this.exports = null;
  }

  async init() {
    const response = await fetch(this.url, {cache: 'no-store'});
    if (!response.ok) throw new Error(`WASM fetch failed: HTTP ${response.status}`);
    let result;
    try {
      result = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch {
      result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
    this.instance = result.instance;
    this.exports = this.instance.exports;
    if (!this.exports.memory) throw new Error('WASM memory export is missing');
    return this;
  }

  get buildVersion() { return this.exports.r360_build_version() >>> 0; }
  get abiVersion() { return this.exports.r360_abi_version() >>> 0; }
  get featureBits() { return this.exports.r360_feature_bits() >>> 0; }

  async stageFilePrefix(file) {
    const ptr = this.exports.r360_io_ptr() >>> 0;
    const cap = this.exports.r360_io_capacity() >>> 0;
    const bytes = new Uint8Array(await file.slice(0, cap).arrayBuffer());
    const view = new Uint8Array(this.exports.memory.buffer, ptr, bytes.length);
    view.set(bytes);
    return {ptr, cap, bytesRead: bytes.length};
  }

  async probeFile(file) {
    const staged = await this.stageFilePrefix(file);
    const kind = this.exports.r360_probe_container(staged.bytesRead) >>> 0;
    const result = {kind, ...staged, xex: null};
    if (kind === 1 || kind === 2) {
      const inspectStatus = this.exports.r360_inspect_xex(staged.bytesRead) >>> 0;
      result.xex = {
        inspectStatus,
        moduleFlags: this.exports.r360_xex_module_flags() >>> 0,
        headerSize: this.exports.r360_xex_header_size() >>> 0,
        securityOffset: this.exports.r360_xex_security_offset() >>> 0,
        headerCount: this.exports.r360_xex_header_count() >>> 0,
        entryPoint: this.exports.r360_xex_entry_point() >>> 0,
        imageBase: this.exports.r360_xex_image_base() >>> 0,
        systemFlags: this.exports.r360_xex_system_flags() >>> 0,
        titleId: this.exports.r360_xex_title_id() >>> 0,
        mediaId: this.exports.r360_xex_media_id() >>> 0,
        imageSize: this.exports.r360_xex_image_size() >>> 0,
        loadAddress: this.exports.r360_xex_load_address() >>> 0,
        region: this.exports.r360_xex_region() >>> 0,
        allowedMediaTypes: this.exports.r360_xex_allowed_media_types() >>> 0,
        pageDescriptorCount: this.exports.r360_xex_page_descriptor_count() >>> 0,
        encryptionType: this.exports.r360_xex_encryption_type() >>> 0,
        compressionType: this.exports.r360_xex_compression_type() >>> 0,
        importsOffset: this.exports.r360_xex_import_libraries_offset() >>> 0,
        executionInfoOffset: this.exports.r360_xex_execution_info_offset() >>> 0,
        fileFormatInfoOffset: this.exports.r360_xex_file_format_info_offset() >>> 0,
      };
    }
    return result;
  }

  xamScalar(ordinal) {
    return this.exports.r360_xam_scalar_value(ordinal >>> 0) >>> 0;
  }
}

export function containerName(kind) {
  return ({1:'XEX1',2:'XEX2',10:'STFS LIVE',11:'STFS PIRS',12:'STFS CON',20:'PowerPC ELF'})[kind] || 'Unknown';
}

export function compressionName(value) {
  return ({0:'None',1:'Basic',2:'Normal / LZX',3:'Delta'})[value] ?? 'Unknown';
}

export function encryptionName(value) {
  return ({0:'None',1:'Normal'})[value] ?? 'Unknown';
}
