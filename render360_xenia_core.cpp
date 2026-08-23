/*
 * Render360 Xenia-Web V28 bootstrap core.
 *
 * Freestanding C++ -> wasm32. V28 moves beyond magic-only probing and adds a
 * strict XEX header inspector aligned to Xenia's public XEX layout definitions.
 * It does NOT claim to decrypt/decompress/execute the XEX yet.
 */
#include <stdint.h>
#include <stddef.h>
#include "xenia_port/xex2_layout.h"

#define R360_BUILD_VERSION 28u
#define R360_ABI_VERSION 0x00030000u
#define R360_IO_CAPACITY (8u * 1024u * 1024u)
#define R360_UNKNOWN_U32 0xFFFFFFFFu

namespace {
using r360::xenia_port::XexInspection;
static uint8_t io_buffer[R360_IO_CAPACITY];
static XexInspection xex_info;

static bool starts_with(const uint8_t* p, uint32_t n, const char* s,
                        uint32_t s_len) {
  if (n < s_len) return false;
  for (uint32_t i = 0; i < s_len; ++i) {
    if (p[i] != static_cast<uint8_t>(s[i])) return false;
  }
  return true;
}

static uint16_t be16(uint32_t off, uint32_t length, bool* ok = nullptr) {
  const bool valid = off <= length && length - off >= 2u;
  if (ok) *ok = valid;
  if (!valid) return 0;
  return static_cast<uint16_t>((uint16_t(io_buffer[off]) << 8) |
                               uint16_t(io_buffer[off + 1]));
}

static uint32_t be32(uint32_t off, uint32_t length, bool* ok = nullptr) {
  const bool valid = off <= length && length - off >= 4u;
  if (ok) *ok = valid;
  if (!valid) return 0;
  return (uint32_t(io_buffer[off]) << 24) |
         (uint32_t(io_buffer[off + 1]) << 16) |
         (uint32_t(io_buffer[off + 2]) << 8) |
         uint32_t(io_buffer[off + 3]);
}

static uint32_t classify_container(uint32_t length) {
  if (length < 4u || length > R360_IO_CAPACITY) return 0u;
  const uint8_t* p = io_buffer;
  if (starts_with(p, length, "XEX2", 4)) return 2u;
  if (starts_with(p, length, "XEX1", 4)) return 1u;
  if (starts_with(p, length, "LIVE", 4)) return 10u;
  if (starts_with(p, length, "PIRS", 4)) return 11u;
  if (starts_with(p, length, "CON ", 4) || starts_with(p, length, "CON", 3)) return 12u;
  if (p[0] == 0x7Fu && p[1] == 'E' && p[2] == 'L' && p[3] == 'F') return 20u;
  return 0u;
}

static void clear_xex_info() { xex_info = XexInspection{}; }

static void capture_optional_header(uint32_t key, uint32_t value,
                                    uint32_t length) {
  using namespace r360::xenia_port;
  switch (key) {
    case kXexHeaderEntryPoint:
      xex_info.entry_point = value;
      break;
    case kXexHeaderImageBaseAddress:
      xex_info.image_base = value;
      break;
    case kXexHeaderSystemFlags:
      xex_info.system_flags = value;
      break;
    case kXexHeaderImportLibraries:
      xex_info.import_libraries_offset = value;
      break;
    case kXexHeaderExecutionInfo: {
      xex_info.execution_info_offset = value;
      if (value <= length && length - value >= 0x18u) {
        xex_info.media_id = be32(value + 0x00u, length);
        xex_info.title_id = be32(value + 0x0Cu, length);
      }
      break;
    }
    case kXexHeaderFileFormatInfo: {
      xex_info.file_format_info_offset = value;
      if (value <= length && length - value >= 8u) {
        xex_info.encryption_type = be16(value + 4u, length);
        xex_info.compression_type = be16(value + 6u, length);
      }
      break;
    }
    default:
      break;
  }
}

static uint32_t inspect_xex(uint32_t length) {
  clear_xex_info();
  const uint32_t kind = classify_container(length);
  xex_info.kind = kind;
  if (kind != 1u && kind != 2u) return 0u;
  if (length < 24u) {
    xex_info.status = 2u;  // truncated base header
    return 2u;
  }

  xex_info.module_flags = be32(4u, length);
  xex_info.header_size = be32(8u, length);
  xex_info.security_offset = be32(16u, length);
  xex_info.header_count = be32(20u, length);

  if (xex_info.header_count > 8192u) {
    xex_info.status = 3u;
    return 3u;
  }
  const uint64_t table_end64 = 24ull + uint64_t(xex_info.header_count) * 8ull;
  if (table_end64 > 0xFFFFFFFFull) {
    xex_info.status = 3u;
    return 3u;
  }
  const uint32_t table_end = static_cast<uint32_t>(table_end64);
  if (xex_info.header_size < table_end || xex_info.header_size < 24u) {
    xex_info.status = 3u;  // structurally invalid header
    return 3u;
  }
  if (length < table_end) {
    xex_info.status = 2u;
    return 2u;
  }

  for (uint32_t i = 0; i < xex_info.header_count; ++i) {
    const uint32_t p = 24u + i * 8u;
    const uint32_t key = be32(p, length);
    const uint32_t value = be32(p + 4u, length);
    capture_optional_header(key, value, length);
  }

  // XEX2 security info offsets below are from Xenia's xex2_security_info.
  // XEX1 has a different security-info layout, so V28 deliberately doesn't
  // reinterpret it as XEX2.
  if (kind == 2u && xex_info.security_offset != 0u) {
    const uint32_t s = xex_info.security_offset;
    if (s <= length && length - s >= 0x184u) {
      xex_info.image_size = be32(s + 0x004u, length);
      xex_info.load_address = be32(s + 0x110u, length);
      xex_info.region = be32(s + 0x178u, length);
      xex_info.allowed_media_types = be32(s + 0x17Cu, length);
      xex_info.page_descriptor_count = be32(s + 0x180u, length);
    }
  }

  xex_info.status = 1u;
  return 1u;
}
}  // namespace

extern "C" {

__attribute__((visibility("default")))
uint32_t r360_build_version() { return R360_BUILD_VERSION; }

__attribute__((visibility("default")))
uint32_t r360_abi_version() { return R360_ABI_VERSION; }

__attribute__((visibility("default")))
uint32_t r360_io_capacity() { return R360_IO_CAPACITY; }

__attribute__((visibility("default")))
uint32_t r360_io_ptr() {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(io_buffer));
}

__attribute__((visibility("default")))
uint32_t r360_probe_container(uint32_t length) { return classify_container(length); }

__attribute__((visibility("default")))
uint32_t r360_probe_xex(uint32_t length) {
  const uint32_t kind = classify_container(length);
  return kind == 1u || kind == 2u ? kind : 0u;
}

__attribute__((visibility("default")))
uint32_t r360_inspect_xex(uint32_t length) { return inspect_xex(length); }

#define R360_XEX_GETTER(name, field) \
  __attribute__((visibility("default"))) uint32_t name() { return xex_info.field; }
R360_XEX_GETTER(r360_xex_status, status)
R360_XEX_GETTER(r360_xex_module_flags, module_flags)
R360_XEX_GETTER(r360_xex_header_size, header_size)
R360_XEX_GETTER(r360_xex_security_offset, security_offset)
R360_XEX_GETTER(r360_xex_header_count, header_count)
R360_XEX_GETTER(r360_xex_entry_point, entry_point)
R360_XEX_GETTER(r360_xex_image_base, image_base)
R360_XEX_GETTER(r360_xex_system_flags, system_flags)
R360_XEX_GETTER(r360_xex_title_id, title_id)
R360_XEX_GETTER(r360_xex_media_id, media_id)
R360_XEX_GETTER(r360_xex_image_size, image_size)
R360_XEX_GETTER(r360_xex_load_address, load_address)
R360_XEX_GETTER(r360_xex_region, region)
R360_XEX_GETTER(r360_xex_allowed_media_types, allowed_media_types)
R360_XEX_GETTER(r360_xex_page_descriptor_count, page_descriptor_count)
R360_XEX_GETTER(r360_xex_encryption_type, encryption_type)
R360_XEX_GETTER(r360_xex_compression_type, compression_type)
R360_XEX_GETTER(r360_xex_import_libraries_offset, import_libraries_offset)
R360_XEX_GETTER(r360_xex_execution_info_offset, execution_info_offset)
R360_XEX_GETTER(r360_xex_file_format_info_offset, file_format_info_offset)
#undef R360_XEX_GETTER

/* Transitional scalar XAM values verified against Xenia upstream. */
__attribute__((visibility("default")))
uint32_t r360_xam_scalar_value(uint32_t ordinal) {
  switch (ordinal) {
    case 0x0282u: return 0u;
    case 0x03CBu: return 6u;
    case 0x03CCu: return 0xFFFFu;
    case 0x03CDu: return 1u;
    case 0x03D2u: return 1u;
    default: return R360_UNKNOWN_U32;
  }
}

/*
 * Feature bits:
 * 0 container probe
 * 1 strict scalar XAM bridge
 * 2 XEX base/header validation
 * 3 XEX optional-header scan
 * 4 XEX execution info extraction
 * 5 XEX file-format/security metadata extraction
 */
__attribute__((visibility("default")))
uint32_t r360_feature_bits() {
  return (1u << 0) | (1u << 1) | (1u << 2) | (1u << 3) | (1u << 4) |
         (1u << 5);
}

}
