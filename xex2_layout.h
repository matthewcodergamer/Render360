/**
 ******************************************************************************
 * Xenia : Xbox 360 Emulator Research Project                                 *
 ******************************************************************************
 * Copyright 2013-2026 Xenia Project contributors.                            *
 * Released under the BSD license - see LICENSE_XENIA.txt in the project root.*
 ******************************************************************************
 *
 * Render360 V30 portability subset (introduced in V28).
 *
 * This file intentionally contains only the XEX constants/layout information
 * needed by the browser-side inspection milestone. The layout and key values
 * are kept aligned with Xenia's:
 *   src/xenia/kernel/util/xex2_info.h
 *
 * The full Xenia implementation remains upstream; this is not a replacement
 * XEX loader.
 */
#ifndef RENDER360_XENIA_PORT_XEX2_LAYOUT_H_
#define RENDER360_XENIA_PORT_XEX2_LAYOUT_H_

#include <stdint.h>

namespace r360::xenia_port {

constexpr uint32_t kXexHeaderResourceInfo = 0x000002FFu;
constexpr uint32_t kXexHeaderFileFormatInfo = 0x000003FFu;
constexpr uint32_t kXexHeaderEntryPoint = 0x00010100u;
constexpr uint32_t kXexHeaderImageBaseAddress = 0x00010201u;
constexpr uint32_t kXexHeaderImportLibraries = 0x000103FFu;
constexpr uint32_t kXexHeaderSystemFlags = 0x00030000u;
constexpr uint32_t kXexHeaderExecutionInfo = 0x00040006u;

constexpr uint32_t kXexModuleTitle = 0x00000001u;

struct XexInspection {
  uint32_t kind = 0;
  uint32_t status = 0;
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

#endif  // RENDER360_XENIA_PORT_XEX2_LAYOUT_H_
