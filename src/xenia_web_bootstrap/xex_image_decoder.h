#pragma once
#include <stdint.h>

namespace render360::xex {

enum DecodeStatus : uint32_t {
  kDecodeIdle = 0,
  kDecodePass = 1,
  kDecodeErrorTooSmall = 100,
  kDecodeErrorMagic = 101,
  kDecodeErrorHeader = 102,
  kDecodeErrorSecurity = 103,
  kDecodeErrorOptionalHeader = 104,
  kDecodeErrorEncryption = 105,
  kDecodeErrorCompression = 106,
  kDecodeErrorPageDescriptors = 107,
  kDecodeErrorRange = 108,
};

enum SectionType : uint32_t {
  kSectionCode = 1,
  kSectionData = 2,
  kSectionReadOnlyData = 3,
};

constexpr uint32_t kMaxPageDescriptors = 256;

struct PageDescriptor {
  uint32_t type = 0;
  uint32_t page_count = 0;
  uint32_t guest_address = 0;
  uint32_t byte_size = 0;
};

struct ImageMetadata {
  uint32_t status = kDecodeIdle;
  uint32_t module_flags = 0;
  uint32_t header_size = 0;
  uint32_t security_offset = 0;
  uint32_t header_count = 0;
  uint32_t entry_point = 0;
  uint32_t image_base = 0;
  uint32_t system_flags = 0;
  uint32_t execution_info_offset = 0;
  uint32_t file_format_info_offset = 0;
  uint32_t import_libraries_offset = 0;
  uint32_t title_id = 0;
  uint32_t media_id = 0;
  uint32_t image_size = 0;
  uint32_t image_flags = 0;
  uint32_t load_address = 0;
  uint32_t region = 0;
  uint32_t allowed_media_types = 0;
  uint32_t encryption_type = 0xFFFFFFFFu;
  uint32_t compression_type = 0xFFFFFFFFu;
  uint32_t page_size = 0;
  uint32_t page_descriptor_count = 0;
  uint32_t mapped_span = 0;
  PageDescriptor page_descriptors[kMaxPageDescriptors] = {};
};

void Reset(ImageMetadata* out);
uint32_t Decode(const uint8_t* bytes, uint32_t length, ImageMetadata* out);

}  // namespace render360::xex
