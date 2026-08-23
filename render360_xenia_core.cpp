/*
 * Render360 Xenia-Web V30 native bootstrap core.
 *
 * V30 keeps the V29 live runtime + strict XEX inspector and adds a native,
 * pull-driven STFS mount state machine aligned to Xenia's STFS layout and
 * block/hash traversal rules. JavaScript does not parse STFS. It only services
 * byte-range requests against the browser File object and copies those bytes
 * into the shared WASM staging buffer.
 *
 * V30 can:
 *   - validate LIVE/PIRS/CON XContent/STFS headers,
 *   - parse the STFS volume descriptor,
 *   - follow the file-table block chain through L0/L1/L2 hash tables,
 *   - enumerate directory entries in native C++,
 *   - locate root default.xex and probe its first data block for XEX1/XEX2.
 *
 * It does NOT yet extract the complete default.xex block chain, decrypt or
 * decompress XEX images, execute PowerPC code, or render Xbox GPU commands.
 */
#include <stdint.h>
#include <stddef.h>
#include "xenia_port/xex2_layout.h"
#include "xenia_port/stfs_layout.h"

#define R360_BUILD_VERSION 30u
#define R360_ABI_VERSION 0x00030002u
#define R360_IO_CAPACITY (8u * 1024u * 1024u)
#define R360_UNKNOWN_U32 0xFFFFFFFFu
#define R360_STFS_MAX_ENTRIES 2048u

// Freestanding wasm32 build helpers. Clang may lower aggregate clears/copies
// to these even with -nostdlib. Keep them tiny and deterministic.
extern "C" void* memset(void* dst, int value, size_t n) {
  auto* p = static_cast<unsigned char*>(dst);
  for (size_t i = 0; i < n; ++i) p[i] = static_cast<unsigned char>(value);
  return dst;
}

extern "C" void* memcpy(void* dst, const void* src, size_t n) {
  auto* d = static_cast<unsigned char*>(dst);
  const auto* s = static_cast<const unsigned char*>(src);
  for (size_t i = 0; i < n; ++i) d[i] = s[i];
  return dst;
}

namespace {
using r360::xenia_port::XexInspection;
namespace stfs = r360::xenia_port::stfs;

static uint8_t io_buffer[R360_IO_CAPACITY];
static XexInspection xex_info;

struct RuntimeState {
  uint64_t ticks = 0;
  uint64_t host_time_us = 0;
  uint64_t work_units = 0;
  uint32_t input_mask = 0;
  uint32_t checksum = 0x360u;
  uint32_t session_kind = 0;
  uint32_t session_stage = 0;
  uint32_t title_id = 0;
};
static RuntimeState runtime_state;

struct StfsEntryRecord {
  char name[41] = {};
  uint32_t name_length = 0;
  uint32_t flags = 0;
  uint32_t valid_data_blocks = 0;
  uint32_t allocated_data_blocks = 0;
  uint32_t start_block = 0;
  uint32_t parent_index = 0xFFFFu;
  uint32_t length = 0;
};

// Status values are intentionally stable ABI values for the web host.
enum StfsMountStatus : uint32_t {
  kStfsIdle = 0,
  kStfsWorking = 1,
  kStfsMounted = 2,
  kStfsMountedPartial = 3,
  kStfsErrorTooSmall = 100,
  kStfsErrorMagic = 101,
  kStfsErrorHeader = 102,
  kStfsErrorUnsupportedVolume = 103,
  kStfsErrorOutOfRange = 104,
  kStfsErrorShortRead = 105,
  kStfsErrorEntryOverflow = 106,
  kStfsErrorDirectory = 107,
  kStfsErrorHashChain = 108,
};

enum StfsRequestKind : uint32_t {
  kStfsRequestNone = 0,
  kStfsRequestHeader = 1,
  kStfsRequestDirectory = 2,
  kStfsRequestHashL2 = 3,
  kStfsRequestHashL1 = 4,
  kStfsRequestHashL0 = 5,
  kStfsRequestDefaultXexProbe = 6,
};

struct StfsMountState {
  uint32_t status = kStfsIdle;
  uint32_t package_kind = 0;
  uint64_t file_size = 0;

  uint32_t header_size = 0;
  uint32_t content_type = 0;
  uint32_t metadata_version = 0;
  uint64_t content_size = 0;
  uint32_t title_id = 0;
  uint32_t media_id = 0;
  uint32_t volume_type = R360_UNKNOWN_U32;
  uint32_t descriptor_length = 0;
  uint32_t descriptor_version = 0;
  uint32_t descriptor_flags = 0;
  uint32_t data_file_count = 0;
  uint32_t file_table_block_count = 0;
  uint32_t file_table_block_number = 0;
  uint32_t total_block_count = 0;
  uint32_t free_block_count = 0;
  uint32_t blocks_per_hash_table = 1;
  uint32_t block_step0 = 0;
  uint32_t block_step1 = 0;

  uint32_t current_table_block = 0;
  uint32_t directory_blocks_read = 0;
  uint32_t entry_count = 0;
  uint32_t default_xex_index = R360_UNKNOWN_U32;
  uint32_t default_xex_kind = 0;

  uint32_t hash_target_block = 0;
  uint32_t hash_secondary_offset = 0;

  uint64_t request_offset = 0;
  uint32_t request_size = 0;
  uint32_t request_kind = kStfsRequestNone;
  uint32_t request_pending = 0;

  uint32_t warnings = 0;
};
static StfsMountState stfs_state;
static StfsEntryRecord stfs_entries[R360_STFS_MAX_ENTRIES];
static char stfs_display_name[129] = {};
static uint32_t stfs_display_name_length = 0;

static bool starts_with(const uint8_t* p, uint32_t n, const char* s,
                        uint32_t s_len) {
  if (n < s_len) return false;
  for (uint32_t i = 0; i < s_len; ++i) {
    if (p[i] != static_cast<uint8_t>(s[i])) return false;
  }
  return true;
}

static uint16_t read_be16(const uint8_t* p) {
  return static_cast<uint16_t>((uint16_t(p[0]) << 8) | uint16_t(p[1]));
}
static uint16_t read_le16(const uint8_t* p) {
  return static_cast<uint16_t>(uint16_t(p[0]) | (uint16_t(p[1]) << 8));
}
static uint32_t read_be32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}
static uint64_t read_be64(const uint8_t* p) {
  return (uint64_t(read_be32(p)) << 32) | uint64_t(read_be32(p + 4));
}
static uint32_t read_le24(const uint8_t* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16);
}

static uint16_t be16(uint32_t off, uint32_t length, bool* ok = nullptr) {
  const bool valid = off <= length && length - off >= 2u;
  if (ok) *ok = valid;
  return valid ? read_be16(io_buffer + off) : 0u;
}
static uint32_t be32(uint32_t off, uint32_t length, bool* ok = nullptr) {
  const bool valid = off <= length && length - off >= 4u;
  if (ok) *ok = valid;
  return valid ? read_be32(io_buffer + off) : 0u;
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
    xex_info.status = 2u;
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
    xex_info.status = 3u;
    return 3u;
  }
  if (length < table_end) {
    xex_info.status = 2u;
    return 2u;
  }

  for (uint32_t i = 0; i < xex_info.header_count; ++i) {
    const uint32_t p = 24u + i * 8u;
    capture_optional_header(be32(p, length), be32(p + 4u, length), length);
  }

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

static uint64_t round_up_block(uint64_t value) {
  return (value + uint64_t(stfs::kBlockSize - 1u)) &
         ~uint64_t(stfs::kBlockSize - 1u);
}

static void clear_stfs_entries() {
  for (uint32_t i = 0; i < R360_STFS_MAX_ENTRIES; ++i) {
    stfs_entries[i] = StfsEntryRecord{};
  }
  stfs_display_name_length = 0;
  for (uint32_t i = 0; i < 129u; ++i) stfs_display_name[i] = 0;
}

static void stfs_fail(uint32_t status) {
  stfs_state.status = status;
  stfs_state.request_pending = 0;
  stfs_state.request_kind = kStfsRequestNone;
  stfs_state.request_size = 0;
  stfs_state.request_offset = 0;
}

static bool stfs_schedule_request(uint64_t offset, uint32_t size,
                                  uint32_t kind) {
  if (!size || size > R360_IO_CAPACITY || offset > stfs_state.file_size ||
      uint64_t(size) > stfs_state.file_size - offset) {
    stfs_fail(kStfsErrorOutOfRange);
    return false;
  }
  stfs_state.request_offset = offset;
  stfs_state.request_size = size;
  stfs_state.request_kind = kind;
  stfs_state.request_pending = 1u;
  stfs_state.status = kStfsWorking;
  return true;
}

static uint64_t stfs_block_to_offset(uint64_t block_index) {
  uint64_t base = stfs::kBlocksPerHashLevel0;
  uint64_t block = block_index;
  for (uint32_t i = 0; i < 3u; ++i) {
    block += ((block_index + base) / base) * stfs_state.blocks_per_hash_table;
    if (block_index < base) break;
    base *= stfs::kBlocksPerHashLevel0;
  }
  return round_up_block(stfs_state.header_size) + (block << 12);
}

static uint32_t stfs_hash_block_number(uint32_t block_index,
                                       uint32_t hash_level) {
  uint32_t block = 0;
  if (hash_level == 0u) {
    if (block_index < stfs::kBlocksPerHashLevel0) return 0u;
    block = (block_index / stfs::kBlocksPerHashLevel0) * stfs_state.block_step0;
    block += ((block_index / stfs::kBlocksPerHashLevel1) + 1u) *
             stfs_state.blocks_per_hash_table;
    if (block_index < stfs::kBlocksPerHashLevel1) return block;
    return block + stfs_state.blocks_per_hash_table;
  }
  if (hash_level == 1u) {
    if (block_index < stfs::kBlocksPerHashLevel1) return stfs_state.block_step0;
    block = (block_index / stfs::kBlocksPerHashLevel1) * stfs_state.block_step1;
    return block + stfs_state.blocks_per_hash_table;
  }
  return stfs_state.block_step1;
}

static uint64_t stfs_hash_offset(uint32_t block_index, uint32_t level) {
  return round_up_block(stfs_state.header_size) +
         (uint64_t(stfs_hash_block_number(block_index, level)) << 12);
}

static bool ascii_equal_ci(const char* a, uint32_t a_len, const char* b) {
  uint32_t b_len = 0;
  while (b[b_len]) ++b_len;
  if (a_len != b_len) return false;
  for (uint32_t i = 0; i < a_len; ++i) {
    uint8_t ac = static_cast<uint8_t>(a[i]);
    uint8_t bc = static_cast<uint8_t>(b[i]);
    if (ac >= 'A' && ac <= 'Z') ac = uint8_t(ac + ('a' - 'A'));
    if (bc >= 'A' && bc <= 'Z') bc = uint8_t(bc + ('a' - 'A'));
    if (ac != bc) return false;
  }
  return true;
}

static void stfs_finish_mount(uint32_t status);

static bool stfs_request_hash_l0() {
  return stfs_schedule_request(
      stfs_hash_offset(stfs_state.hash_target_block, 0u) +
          stfs_state.hash_secondary_offset,
      stfs::kBlockSize, kStfsRequestHashL0);
}

static bool stfs_request_hash_l1() {
  return stfs_schedule_request(
      stfs_hash_offset(stfs_state.hash_target_block, 1u) +
          stfs_state.hash_secondary_offset,
      stfs::kBlockSize, kStfsRequestHashL1);
}

static bool stfs_request_hash_l2() {
  return stfs_schedule_request(
      stfs_hash_offset(stfs_state.hash_target_block, 2u) +
          stfs_state.hash_secondary_offset,
      stfs::kBlockSize, kStfsRequestHashL2);
}

static bool stfs_begin_hash_resolution(uint32_t block_index) {
  if (block_index >= stfs_state.total_block_count &&
      stfs_state.total_block_count != 0u) {
    stfs_fail(kStfsErrorHashChain);
    return false;
  }
  stfs_state.hash_target_block = block_index;
  if (stfs_state.descriptor_flags & 0x01u) {
    // Xenia: read-only STFS has one backing hash block and skips upper active
    // index selection entirely.
    stfs_state.hash_secondary_offset = 0u;
    return stfs_request_hash_l0();
  }

  stfs_state.hash_secondary_offset =
      (stfs_state.descriptor_flags & 0x02u) ? stfs::kBlockSize : 0u;
  if (stfs_state.total_block_count > stfs::kBlocksPerHashLevel1) {
    return stfs_request_hash_l2();
  }
  if (stfs_state.total_block_count > stfs::kBlocksPerHashLevel0) {
    return stfs_request_hash_l1();
  }
  return stfs_request_hash_l0();
}

static uint32_t stfs_hash_info_at(uint32_t record, uint32_t length,
                                  bool* ok) {
  const uint64_t off64 = uint64_t(record) * stfs::kHashEntrySize +
                         stfs::kHashInfoOffset;
  if (record >= stfs::kBlocksPerHashLevel0 || off64 + 4u > length) {
    *ok = false;
    return 0u;
  }
  *ok = true;
  return read_be32(io_buffer + static_cast<uint32_t>(off64));
}

static void stfs_parse_hash_l2(uint32_t length) {
  const uint32_t record =
      (stfs_state.hash_target_block / stfs::kBlocksPerHashLevel1) %
      stfs::kBlocksPerHashLevel0;
  bool ok = false;
  const uint32_t info = stfs_hash_info_at(record, length, &ok);
  if (!ok) return stfs_fail(kStfsErrorHashChain);
  stfs_state.hash_secondary_offset =
      (info & stfs::kHashActiveIndexBit) ? stfs::kBlockSize : 0u;
  stfs_request_hash_l1();
}

static void stfs_parse_hash_l1(uint32_t length) {
  const uint32_t record =
      (stfs_state.hash_target_block / stfs::kBlocksPerHashLevel0) %
      stfs::kBlocksPerHashLevel0;
  bool ok = false;
  const uint32_t info = stfs_hash_info_at(record, length, &ok);
  if (!ok) return stfs_fail(kStfsErrorHashChain);
  stfs_state.hash_secondary_offset =
      (info & stfs::kHashActiveIndexBit) ? stfs::kBlockSize : 0u;
  stfs_request_hash_l0();
}

static void stfs_parse_hash_l0(uint32_t length) {
  const uint32_t record =
      stfs_state.hash_target_block % stfs::kBlocksPerHashLevel0;
  bool ok = false;
  const uint32_t info = stfs_hash_info_at(record, length, &ok);
  if (!ok) return stfs_fail(kStfsErrorHashChain);
  const uint32_t next_block = info & 0xFFFFFFu;
  if (next_block == stfs::kEndOfChain) {
    stfs_state.warnings |= 1u;
    return stfs_finish_mount(kStfsMountedPartial);
  }
  stfs_state.current_table_block = next_block;
  stfs_schedule_request(stfs_block_to_offset(next_block), stfs::kBlockSize,
                        kStfsRequestDirectory);
}

static void stfs_finish_mount(uint32_t status) {
  if (stfs_state.default_xex_index != R360_UNKNOWN_U32) {
    const StfsEntryRecord& entry = stfs_entries[stfs_state.default_xex_index];
    if (!(entry.flags & 0x80u) && entry.length >= 4u) {
      uint64_t offset = stfs_block_to_offset(entry.start_block);
      uint32_t request_size = entry.length < stfs::kBlockSize
                                  ? entry.length
                                  : stfs::kBlockSize;
      // Preserve whether this is a complete or partial directory-table mount.
      if (status == kStfsMountedPartial) stfs_state.warnings |= 2u;
      stfs_state.status = status;
      if (stfs_schedule_request(offset, request_size,
                                kStfsRequestDefaultXexProbe)) {
        // schedule_request changes status to working; bit 31 remembers the
        // desired terminal state without introducing a separate global.
        if (status == kStfsMountedPartial) stfs_state.warnings |= 0x80000000u;
        return;
      }
      return;
    }
  }
  stfs_state.status = status;
  stfs_state.request_pending = 0u;
  stfs_state.request_kind = kStfsRequestNone;
}

static void stfs_parse_default_xex_probe(uint32_t length) {
  stfs_state.default_xex_kind = classify_container(length);
  if (stfs_state.default_xex_kind != 1u && stfs_state.default_xex_kind != 2u) {
    stfs_state.warnings |= 4u;
  }
  const uint32_t terminal = (stfs_state.warnings & 0x80000000u)
                                ? kStfsMountedPartial
                                : kStfsMounted;
  stfs_state.warnings &= ~0x80000000u;
  stfs_state.status = terminal;
  stfs_state.request_pending = 0u;
  stfs_state.request_kind = kStfsRequestNone;
}

static void stfs_parse_directory(uint32_t length) {
  if (length < stfs::kBlockSize) return stfs_fail(kStfsErrorShortRead);

  for (uint32_t i = 0; i < stfs::kDirectoryEntriesPerBlock; ++i) {
    const uint32_t off = i * stfs::kDirectoryEntrySize;
    if (io_buffer[off] == 0u) break;
    const uint32_t flags = io_buffer[off + stfs::kDirectoryFlagsOffset];
    const uint32_t name_length = flags & 0x3Fu;
    if (!name_length || name_length > stfs::kDirectoryNameBytes) {
      return stfs_fail(kStfsErrorDirectory);
    }
    if (stfs_state.entry_count >= R360_STFS_MAX_ENTRIES) {
      return stfs_fail(kStfsErrorEntryOverflow);
    }

    StfsEntryRecord& out = stfs_entries[stfs_state.entry_count];
    out = StfsEntryRecord{};
    out.name_length = name_length;
    out.flags = flags;
    for (uint32_t n = 0; n < name_length; ++n) out.name[n] = char(io_buffer[off + n]);
    out.name[name_length] = 0;
    out.valid_data_blocks =
        read_le24(io_buffer + off + stfs::kDirectoryValidBlocksOffset);
    out.allocated_data_blocks =
        read_le24(io_buffer + off + stfs::kDirectoryAllocatedBlocksOffset);
    out.start_block =
        read_le24(io_buffer + off + stfs::kDirectoryStartBlockOffset);
    out.parent_index =
        read_be16(io_buffer + off + stfs::kDirectoryParentIndexOffset);
    out.length = read_be32(io_buffer + off + stfs::kDirectoryLengthOffset);

    // Xenia builds a flat all_entries vector in file-table order and uses the
    // directory index as a parent reference. Keep that exact index model here.
    if (out.parent_index != 0xFFFFu && out.parent_index >= stfs_state.entry_count) {
      stfs_state.warnings |= 8u;
    }
    if (!(flags & 0x80u) && out.parent_index == 0xFFFFu &&
        ascii_equal_ci(out.name, out.name_length, "default.xex")) {
      stfs_state.default_xex_index = stfs_state.entry_count;
    }
    ++stfs_state.entry_count;
  }

  ++stfs_state.directory_blocks_read;
  if (stfs_state.directory_blocks_read >= stfs_state.file_table_block_count) {
    return stfs_finish_mount(kStfsMounted);
  }
  stfs_begin_hash_resolution(stfs_state.current_table_block);
}

static void stfs_parse_header(uint32_t length) {
  if (length < stfs::kHeaderStructSize) return stfs_fail(kStfsErrorShortRead);
  const uint32_t kind = classify_container(length);
  if (kind < 10u || kind > 12u) return stfs_fail(kStfsErrorMagic);

  stfs_state.package_kind = kind;
  stfs_state.header_size = read_be32(io_buffer + stfs::kHeaderSizeOffset);
  stfs_state.content_type = read_be32(io_buffer + stfs::kContentTypeOffset);
  stfs_state.metadata_version = read_be32(io_buffer + stfs::kMetadataVersionOffset);
  stfs_state.content_size = read_be64(io_buffer + stfs::kContentSizeOffset);
  stfs_state.media_id = read_be32(io_buffer + stfs::kExecutionMediaIdOffset);
  stfs_state.title_id = read_be32(io_buffer + stfs::kExecutionTitleIdOffset);
  stfs_state.descriptor_length = io_buffer[stfs::kDescriptorLengthOffset];
  stfs_state.descriptor_version = io_buffer[stfs::kDescriptorVersionOffset];
  stfs_state.descriptor_flags = io_buffer[stfs::kDescriptorFlagsOffset];
  stfs_state.file_table_block_count =
      read_le16(io_buffer + stfs::kFileTableBlockCountOffset);
  stfs_state.file_table_block_number =
      read_le24(io_buffer + stfs::kFileTableBlockNumberOffset);
  stfs_state.total_block_count = read_be32(io_buffer + stfs::kTotalBlockCountOffset);
  stfs_state.free_block_count = read_be32(io_buffer + stfs::kFreeBlockCountOffset);
  stfs_state.data_file_count = read_be32(io_buffer + stfs::kDataFileCountOffset);
  stfs_state.volume_type = read_be32(io_buffer + stfs::kVolumeTypeOffset);

  // First XContent display-name language slot. Xenia stores these as
  // big-endian UTF-16; keep an ASCII-safe diagnostic copy for the web UI.
  constexpr uint32_t kDisplayNameOffset = 0x411u;
  for (uint32_t i = 0; i < 128u; ++i) {
    const uint16_t ch = read_be16(io_buffer + kDisplayNameOffset + i * 2u);
    if (!ch) break;
    stfs_display_name[stfs_display_name_length++] =
        ch < 0x80u ? static_cast<char>(ch) : '?';
  }
  stfs_display_name[stfs_display_name_length] = 0;

  if (stfs_state.header_size < stfs::kXContentHeaderSize ||
      stfs_state.header_size > stfs_state.file_size) {
    return stfs_fail(kStfsErrorHeader);
  }
  if (stfs_state.volume_type != stfs::kVolumeTypeStfs) {
    return stfs_fail(kStfsErrorUnsupportedVolume);
  }
  if (stfs_state.descriptor_length != stfs::kVolumeDescriptorSize) {
    return stfs_fail(kStfsErrorHeader);
  }

  stfs_state.blocks_per_hash_table =
      (stfs_state.descriptor_flags & 0x01u) ? 1u : 2u;
  stfs_state.block_step0 =
      stfs::kBlocksPerHashLevel0 + stfs_state.blocks_per_hash_table;
  stfs_state.block_step1 =
      stfs::kBlocksPerHashLevel1 +
      ((stfs::kBlocksPerHashLevel0 + 1u) * stfs_state.blocks_per_hash_table);

  if (!stfs_state.file_table_block_count) {
    return stfs_finish_mount(kStfsMounted);
  }
  if (stfs_state.total_block_count &&
      stfs_state.file_table_block_number >= stfs_state.total_block_count) {
    return stfs_fail(kStfsErrorHeader);
  }
  stfs_state.current_table_block = stfs_state.file_table_block_number;
  stfs_schedule_request(stfs_block_to_offset(stfs_state.current_table_block),
                        stfs::kBlockSize, kStfsRequestDirectory);
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

__attribute__((visibility("default")))
void r360_runtime_reset() { runtime_state = RuntimeState{}; }

__attribute__((visibility("default")))
void r360_runtime_set_input(uint32_t mask) { runtime_state.input_mask = mask; }

__attribute__((visibility("default")))
void r360_runtime_set_session(uint32_t kind, uint32_t stage, uint32_t title_id) {
  runtime_state.session_kind = kind;
  runtime_state.session_stage = stage;
  runtime_state.title_id = title_id;
}

__attribute__((visibility("default")))
void r360_runtime_tick(uint32_t dt_us) {
  if (dt_us > 100000u) dt_us = 100000u;
  runtime_state.ticks += 1u;
  runtime_state.host_time_us += dt_us;
  uint32_t x = runtime_state.checksum ^ runtime_state.input_mask ^ dt_us ^
               runtime_state.session_kind ^ (runtime_state.session_stage << 16u) ^
               runtime_state.title_id;
  const uint32_t iterations = 256u + (runtime_state.session_stage * 32u);
  for (uint32_t i = 0; i < iterations; ++i) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x += 0x9E3779B9u + i;
  }
  runtime_state.checksum = x;
  runtime_state.work_units += iterations;
}

__attribute__((visibility("default")))
uint32_t r360_runtime_ticks_lo() { return static_cast<uint32_t>(runtime_state.ticks); }

__attribute__((visibility("default")))
uint32_t r360_runtime_time_ms() { return static_cast<uint32_t>(runtime_state.host_time_us / 1000u); }

__attribute__((visibility("default")))
uint32_t r360_runtime_work_lo() { return static_cast<uint32_t>(runtime_state.work_units); }

__attribute__((visibility("default")))
uint32_t r360_runtime_checksum() { return runtime_state.checksum; }

__attribute__((visibility("default")))
uint32_t r360_runtime_input_mask() { return runtime_state.input_mask; }

__attribute__((visibility("default")))
uint32_t r360_runtime_session_kind() { return runtime_state.session_kind; }

__attribute__((visibility("default")))
uint32_t r360_runtime_session_stage() { return runtime_state.session_stage; }

__attribute__((visibility("default")))
uint32_t r360_runtime_title_id() { return runtime_state.title_id; }

// Native STFS pull-I/O ABI ---------------------------------------------------
__attribute__((visibility("default")))
void r360_stfs_mount_reset() {
  stfs_state = StfsMountState{};
  clear_stfs_entries();
}

__attribute__((visibility("default")))
uint32_t r360_stfs_mount_begin(uint32_t file_size_lo, uint32_t file_size_hi) {
  r360_stfs_mount_reset();
  stfs_state.file_size = (uint64_t(file_size_hi) << 32) | uint64_t(file_size_lo);
  if (stfs_state.file_size < stfs::kHeaderStructSize) {
    stfs_fail(kStfsErrorTooSmall);
    return stfs_state.status;
  }
  stfs_schedule_request(0u, stfs::kHeaderStructSize, kStfsRequestHeader);
  return stfs_state.status;
}

__attribute__((visibility("default")))
uint32_t r360_stfs_submit_read(uint32_t length) {
  if (!stfs_state.request_pending) return stfs_state.status;
  const uint32_t kind = stfs_state.request_kind;
  const uint32_t expected = stfs_state.request_size;
  stfs_state.request_pending = 0u;
  if (length < expected || length > R360_IO_CAPACITY) {
    stfs_fail(kStfsErrorShortRead);
    return stfs_state.status;
  }
  switch (kind) {
    case kStfsRequestHeader: stfs_parse_header(length); break;
    case kStfsRequestDirectory: stfs_parse_directory(length); break;
    case kStfsRequestHashL2: stfs_parse_hash_l2(length); break;
    case kStfsRequestHashL1: stfs_parse_hash_l1(length); break;
    case kStfsRequestHashL0: stfs_parse_hash_l0(length); break;
    case kStfsRequestDefaultXexProbe: stfs_parse_default_xex_probe(length); break;
    default: stfs_fail(kStfsErrorHeader); break;
  }
  return stfs_state.status;
}

#define R360_STFS_GETTER(name, field) \
  __attribute__((visibility("default"))) uint32_t name() { return stfs_state.field; }
R360_STFS_GETTER(r360_stfs_mount_status, status)
R360_STFS_GETTER(r360_stfs_package_kind, package_kind)
R360_STFS_GETTER(r360_stfs_header_size, header_size)
R360_STFS_GETTER(r360_stfs_content_type, content_type)
R360_STFS_GETTER(r360_stfs_metadata_version, metadata_version)
R360_STFS_GETTER(r360_stfs_title_id, title_id)
R360_STFS_GETTER(r360_stfs_media_id, media_id)
R360_STFS_GETTER(r360_stfs_volume_type, volume_type)
R360_STFS_GETTER(r360_stfs_descriptor_length, descriptor_length)
R360_STFS_GETTER(r360_stfs_descriptor_version, descriptor_version)
R360_STFS_GETTER(r360_stfs_descriptor_flags, descriptor_flags)
R360_STFS_GETTER(r360_stfs_data_file_count, data_file_count)
R360_STFS_GETTER(r360_stfs_file_table_block_count, file_table_block_count)
R360_STFS_GETTER(r360_stfs_file_table_block_number, file_table_block_number)
R360_STFS_GETTER(r360_stfs_total_block_count, total_block_count)
R360_STFS_GETTER(r360_stfs_free_block_count, free_block_count)
R360_STFS_GETTER(r360_stfs_directory_blocks_read, directory_blocks_read)
R360_STFS_GETTER(r360_stfs_entry_count, entry_count)
R360_STFS_GETTER(r360_stfs_default_xex_index, default_xex_index)
R360_STFS_GETTER(r360_stfs_default_xex_kind, default_xex_kind)
R360_STFS_GETTER(r360_stfs_warnings, warnings)
R360_STFS_GETTER(r360_stfs_request_pending, request_pending)
R360_STFS_GETTER(r360_stfs_request_size, request_size)
R360_STFS_GETTER(r360_stfs_request_kind, request_kind)
#undef R360_STFS_GETTER

__attribute__((visibility("default")))
uint32_t r360_stfs_display_name_ptr() {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(stfs_display_name));
}
__attribute__((visibility("default")))
uint32_t r360_stfs_display_name_length() { return stfs_display_name_length; }

__attribute__((visibility("default")))
uint32_t r360_stfs_content_size_lo() { return static_cast<uint32_t>(stfs_state.content_size); }
__attribute__((visibility("default")))
uint32_t r360_stfs_content_size_hi() { return static_cast<uint32_t>(stfs_state.content_size >> 32); }
__attribute__((visibility("default")))
uint32_t r360_stfs_request_offset_lo() { return static_cast<uint32_t>(stfs_state.request_offset); }
__attribute__((visibility("default")))
uint32_t r360_stfs_request_offset_hi() { return static_cast<uint32_t>(stfs_state.request_offset >> 32); }

__attribute__((visibility("default")))
uint32_t r360_stfs_entry_name_ptr(uint32_t index) {
  if (index >= stfs_state.entry_count) return 0u;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(stfs_entries[index].name));
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_name_length(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].name_length : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_flags(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].flags : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_valid_blocks(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].valid_data_blocks : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_allocated_blocks(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].allocated_data_blocks : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_start_block(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].start_block : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_parent_index(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].parent_index : 0xFFFFu;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_length(uint32_t index) {
  return index < stfs_state.entry_count ? stfs_entries[index].length : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_is_directory(uint32_t index) {
  return index < stfs_state.entry_count && (stfs_entries[index].flags & 0x80u) ? 1u : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_stfs_entry_is_contiguous(uint32_t index) {
  return index < stfs_state.entry_count && (stfs_entries[index].flags & 0x40u) ? 1u : 0u;
}

// Debug/contract helpers used by smoke tests and future streaming extraction.
__attribute__((visibility("default")))
uint32_t r360_stfs_block_offset_lo(uint32_t block_index) {
  return static_cast<uint32_t>(stfs_block_to_offset(block_index));
}
__attribute__((visibility("default")))
uint32_t r360_stfs_block_offset_hi(uint32_t block_index) {
  return static_cast<uint32_t>(stfs_block_to_offset(block_index) >> 32);
}

__attribute__((visibility("default")))
uint32_t r360_feature_bits() {
  // 0 container probe
  // 1 strict scalar XAM bridge
  // 2 XEX base/header validation
  // 3 XEX optional-header scan
  // 4 XEX execution info extraction
  // 5 XEX file-format/security metadata
  // 6 continuous native runtime
  // 7 STFS/XContent header + volume descriptor
  // 8 native STFS directory enumeration
  // 9 native STFS hash-chain traversal
  // 10 default.xex first-block XEX probe
  return (1u << 11) - 1u;
}

}  // extern "C"
