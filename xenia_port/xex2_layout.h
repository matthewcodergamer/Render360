#pragma once
#include <stdint.h>

// Narrow, browser-portable XEX layout contract mirrored from upstream Xenia's
// xex2_info.h. This header contains layout constants/data only; Xenia remains
// the semantic authority and xenia_contract_check.py detects upstream drift.
namespace r360::xenia_port {

constexpr uint32_t kXexHeaderFileFormatInfo = 0x000003FFu;
constexpr uint32_t kXexHeaderEntryPoint = 0x00010100u;
constexpr uint32_t kXexHeaderImageBaseAddress = 0x00010201u;
constexpr uint32_t kXexHeaderImportLibraries = 0x000103FFu;
constexpr uint32_t kXexHeaderSystemFlags = 0x00030000u;
constexpr uint32_t kXexHeaderExecutionInfo = 0x00040006u;

struct XexInspection {
  uint32_t status = 0;
  uint32_t kind = 0;
  uint32_t module_flags = 0;
  uint32_t header_size = 0;
  uint32_t security_offset = 0;
  uint32_t header_count = 0;
  uint32_t entry_point = 0;
  uint32_t image_base = 0;
  uint32_t system_flags = 0;
  uint32_t title_id = 0;
  uint32_t media_id = 0;
  uint32_t image_size = 0;
  uint32_t load_address = 0;
  uint32_t region = 0;
  uint32_t allowed_media_types = 0;
  uint32_t page_descriptor_count = 0;
  uint32_t encryption_type = 0xFFFFFFFFu;
  uint32_t compression_type = 0xFFFFFFFFu;
  uint32_t import_libraries_offset = 0;
  uint32_t execution_info_offset = 0;
  uint32_t file_format_info_offset = 0;
};

}  // namespace r360::xenia_port
