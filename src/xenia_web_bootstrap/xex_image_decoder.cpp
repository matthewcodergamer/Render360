#include "xex_image_decoder.h"

namespace render360::xex {
namespace {

static uint16_t read_be16(const uint8_t* p) {
  return static_cast<uint16_t>((uint16_t(p[0]) << 8) | uint16_t(p[1]));
}
static uint32_t read_be32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}
static bool range_ok(uint32_t off, uint32_t size, uint32_t length) {
  return off <= length && size <= length - off;
}
static bool add_u32(uint32_t a, uint32_t b, uint32_t* out) {
  const uint64_t v = uint64_t(a) + uint64_t(b);
  if (v > 0xFFFFFFFFull) return false;
  *out = static_cast<uint32_t>(v);
  return true;
}

constexpr uint32_t kXexHeaderFileFormatInfo = 0x000003FFu;
constexpr uint32_t kXexHeaderEntryPoint = 0x00010100u;
constexpr uint32_t kXexHeaderImageBaseAddress = 0x00010201u;
constexpr uint32_t kXexHeaderImportLibraries = 0x000103FFu;
constexpr uint32_t kXexHeaderSystemFlags = 0x00030000u;
constexpr uint32_t kXexHeaderExecutionInfo = 0x00040006u;

}  // namespace

void Reset(ImageMetadata* out) {
  if (!out) return;
  *out = ImageMetadata{};
}

uint32_t Decode(const uint8_t* bytes, uint32_t length, ImageMetadata* out) {
  if (!out) return kDecodeErrorHeader;
  Reset(out);
  auto fail = [&](uint32_t status) -> uint32_t {
    out->status = status;
    return status;
  };

  if (!bytes || length < 24u) return fail(kDecodeErrorTooSmall);
  if (bytes[0] != 'X' || bytes[1] != 'E' || bytes[2] != 'X' || bytes[3] != '2') {
    return fail(kDecodeErrorMagic);
  }

  out->module_flags = read_be32(bytes + 4u);
  out->header_size = read_be32(bytes + 8u);
  out->security_offset = read_be32(bytes + 16u);
  out->header_count = read_be32(bytes + 20u);

  if (out->header_count > 8192u) return fail(kDecodeErrorHeader);
  const uint64_t table_end64 = 24ull + uint64_t(out->header_count) * 8ull;
  if (table_end64 > 0xFFFFFFFFull) return fail(kDecodeErrorHeader);
  const uint32_t table_end = static_cast<uint32_t>(table_end64);
  if (out->header_size < table_end || out->header_size > length) {
    return fail(kDecodeErrorHeader);
  }
  if (!range_ok(out->security_offset, 0x184u, out->header_size)) {
    return fail(kDecodeErrorSecurity);
  }

  for (uint32_t i = 0; i < out->header_count; ++i) {
    const uint32_t off = 24u + i * 8u;
    const uint32_t key = read_be32(bytes + off);
    const uint32_t value = read_be32(bytes + off + 4u);
    switch (key) {
      case kXexHeaderEntryPoint:
        out->entry_point = value;
        break;
      case kXexHeaderImageBaseAddress:
        out->image_base = value;
        break;
      case kXexHeaderSystemFlags:
        out->system_flags = value;
        break;
      case kXexHeaderExecutionInfo:
        out->execution_info_offset = value;
        break;
      case kXexHeaderFileFormatInfo:
        out->file_format_info_offset = value;
        break;
      case kXexHeaderImportLibraries:
        out->import_libraries_offset = value;
        break;
      default:
        break;
    }
  }

  if (!out->entry_point || !out->image_base || !out->file_format_info_offset) {
    return fail(kDecodeErrorOptionalHeader);
  }
  if (out->execution_info_offset) {
    if (!range_ok(out->execution_info_offset, 0x18u, out->header_size)) {
      return fail(kDecodeErrorOptionalHeader);
    }
    out->media_id = read_be32(bytes + out->execution_info_offset);
    out->title_id = read_be32(bytes + out->execution_info_offset + 0x0Cu);
  }
  if (out->import_libraries_offset &&
      !range_ok(out->import_libraries_offset, 4u, out->header_size)) {
    return fail(kDecodeErrorOptionalHeader);
  }
  if (!range_ok(out->file_format_info_offset, 8u, out->header_size)) {
    return fail(kDecodeErrorOptionalHeader);
  }

  const uint32_t format_size = read_be32(bytes + out->file_format_info_offset);
  if (format_size < 8u ||
      !range_ok(out->file_format_info_offset, format_size, out->header_size)) {
    return fail(kDecodeErrorOptionalHeader);
  }
  out->encryption_type = read_be16(bytes + out->file_format_info_offset + 4u);
  out->compression_type = read_be16(bytes + out->file_format_info_offset + 6u);
  if (out->encryption_type > 1u) return fail(kDecodeErrorEncryption);
  // Xenia defines NONE, BASIC, NORMAL and DELTA. V36 metadata/image bring-up
  // supports the first three and deliberately rejects DELTA until the patch
  // path is implemented rather than silently treating it as a normal image.
  if (out->compression_type > 2u) return fail(kDecodeErrorCompression);

  const uint32_t sec = out->security_offset;
  const uint32_t security_size = read_be32(bytes + sec + 0x00u);
  out->image_size = read_be32(bytes + sec + 0x04u);
  out->image_flags = read_be32(bytes + sec + 0x10Cu);
  out->load_address = read_be32(bytes + sec + 0x110u);
  out->region = read_be32(bytes + sec + 0x178u);
  out->allowed_media_types = read_be32(bytes + sec + 0x17Cu);
  out->page_descriptor_count = read_be32(bytes + sec + 0x180u);

  if (security_size < 0x184u || security_size > out->header_size - sec) {
    return fail(kDecodeErrorSecurity);
  }
  if (!out->image_size || !out->load_address ||
      out->page_descriptor_count > kMaxPageDescriptors) {
    return fail(kDecodeErrorSecurity);
  }
  const uint64_t descriptor_bytes64 =
      uint64_t(out->page_descriptor_count) * 0x18ull;
  if (descriptor_bytes64 > 0xFFFFFFFFull) return fail(kDecodeErrorPageDescriptors);
  const uint32_t descriptor_bytes = static_cast<uint32_t>(descriptor_bytes64);
  if (security_size < 0x184u + descriptor_bytes ||
      !range_ok(sec + 0x184u, descriptor_bytes, out->header_size)) {
    return fail(kDecodeErrorPageDescriptors);
  }

  // Keep this exactly aligned with Xenia's XexModule: titles at/below
  // 0x90000000 use 64 KiB image pages, higher images use 4 KiB pages.
  out->page_size = out->image_base <= 0x90000000u ? 0x10000u : 0x1000u;
  uint64_t running_bytes = 0;
  uint32_t previous_end = out->image_base;
  for (uint32_t i = 0; i < out->page_descriptor_count; ++i) {
    const uint32_t p = sec + 0x184u + i * 0x18u;
    const uint32_t value = read_be32(bytes + p);
    // Xenia byteswaps this word before reading its bitfield. read_be32 already
    // gives that converted host value: low 4 bits are section info, upper 28
    // bits are the page count.
    const uint32_t type = value & 0xFu;
    const uint32_t page_count = value >> 4u;
    if ((type < kSectionCode || type > kSectionReadOnlyData) || !page_count) {
      return fail(kDecodeErrorPageDescriptors);
    }
    const uint64_t byte_size64 = uint64_t(page_count) * uint64_t(out->page_size);
    if (byte_size64 > 0xFFFFFFFFull) return fail(kDecodeErrorRange);
    const uint32_t byte_size = static_cast<uint32_t>(byte_size64);
    uint32_t end = 0;
    if (!add_u32(previous_end, byte_size, &end) || end <= previous_end) {
      return fail(kDecodeErrorRange);
    }
    out->page_descriptors[i].type = type;
    out->page_descriptors[i].page_count = page_count;
    out->page_descriptors[i].guest_address = previous_end;
    out->page_descriptors[i].byte_size = byte_size;
    previous_end = end;
    running_bytes += byte_size64;
  }
  if (running_bytes > 0xFFFFFFFFull) return fail(kDecodeErrorRange);
  out->mapped_span = static_cast<uint32_t>(running_bytes);

  // Page descriptors are rounded to Xenia's image page size and may cover the
  // final partial image page, but must never describe less than image_size.
  if (running_bytes < out->image_size) return fail(kDecodeErrorPageDescriptors);
  uint32_t image_end = 0;
  if (!add_u32(out->image_base, out->image_size, &image_end)) {
    return fail(kDecodeErrorRange);
  }
  if (out->entry_point < out->image_base || out->entry_point >= image_end) {
    return fail(kDecodeErrorRange);
  }

  out->status = kDecodePass;
  return kDecodePass;
}

}  // namespace render360::xex
