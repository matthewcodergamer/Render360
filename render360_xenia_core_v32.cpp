// Render360 V32 package/XEX extension.
//
// Keep the proven V30 mount/XEX implementation intact, but supersede the
// build-version, STFS submit-read dispatcher and feature-bits exports so the
// checked-in source can reproduce the V32 complete-entry extraction ABI used
// by wasm-core-v32.js.
#define r360_build_version r360_build_version_v30
#define r360_stfs_submit_read r360_stfs_submit_read_v30
#define r360_feature_bits r360_feature_bits_v30
#include "render360_xenia_core.cpp"
#undef r360_build_version
#undef r360_stfs_submit_read
#undef r360_feature_bits

namespace {

enum StfsExtractStatus : uint32_t {
  kExtractIdle = 0,
  kExtractWorking = 1,
  kExtractComplete = 2,
  kExtractErrorEntry = 100,
  kExtractErrorDirectory = 101,
  kExtractErrorChain = 102,
  kExtractErrorShortRead = 103,
};

enum StfsExtractRequestKind : uint32_t {
  kExtractRequestData = 20,
  kExtractRequestHashL2 = 21,
  kExtractRequestHashL1 = 22,
  kExtractRequestHashL0 = 23,
};

struct StfsExtractState {
  uint32_t status = kExtractIdle;
  uint32_t entry_index = R360_UNKNOWN_U32;
  uint32_t current_block = 0;
  uint32_t logical_offset = 0;
  uint32_t bytes_total = 0;
  uint32_t bytes_done = 0;
  uint32_t blocks_done = 0;
  uint32_t contiguous = 0;
  uint32_t hash_target_block = 0;
  uint32_t hash_secondary_offset = 0;
};
static StfsExtractState extract_state;

static void extract_clear_request() {
  stfs_state.request_pending = 0u;
  stfs_state.request_kind = kStfsRequestNone;
  stfs_state.request_size = 0u;
  stfs_state.request_offset = 0u;
}

static void extract_fail(uint32_t status) {
  extract_state.status = status;
  extract_clear_request();
}

static bool extract_schedule(uint64_t offset, uint32_t size, uint32_t kind) {
  if (!size || size > R360_IO_CAPACITY || offset > stfs_state.file_size ||
      uint64_t(size) > stfs_state.file_size - offset) {
    extract_fail(kExtractErrorChain);
    return false;
  }
  stfs_state.request_offset = offset;
  stfs_state.request_size = size;
  stfs_state.request_kind = kind;
  stfs_state.request_pending = 1u;
  extract_state.status = kExtractWorking;
  return true;
}

static bool extract_schedule_data() {
  if (extract_state.bytes_done >= extract_state.bytes_total) {
    extract_state.status = kExtractComplete;
    extract_clear_request();
    return true;
  }
  const uint32_t remain = extract_state.bytes_total - extract_state.bytes_done;
  const uint32_t size = remain < stfs::kBlockSize ? remain : stfs::kBlockSize;
  return extract_schedule(stfs_block_to_offset(extract_state.current_block),
                          size, kExtractRequestData);
}

static bool extract_request_hash_l0() {
  return extract_schedule(
      stfs_hash_offset(extract_state.hash_target_block, 0u) +
          extract_state.hash_secondary_offset,
      stfs::kBlockSize, kExtractRequestHashL0);
}
static bool extract_request_hash_l1() {
  return extract_schedule(
      stfs_hash_offset(extract_state.hash_target_block, 1u) +
          extract_state.hash_secondary_offset,
      stfs::kBlockSize, kExtractRequestHashL1);
}
static bool extract_request_hash_l2() {
  return extract_schedule(
      stfs_hash_offset(extract_state.hash_target_block, 2u) +
          extract_state.hash_secondary_offset,
      stfs::kBlockSize, kExtractRequestHashL2);
}

static bool extract_begin_hash_resolution(uint32_t block_index) {
  if (block_index >= stfs_state.total_block_count && stfs_state.total_block_count) {
    extract_fail(kExtractErrorChain);
    return false;
  }
  extract_state.hash_target_block = block_index;
  if (stfs_state.descriptor_flags & 0x01u) {
    extract_state.hash_secondary_offset = 0u;
    return extract_request_hash_l0();
  }
  extract_state.hash_secondary_offset =
      (stfs_state.descriptor_flags & 0x02u) ? stfs::kBlockSize : 0u;
  if (stfs_state.total_block_count > stfs::kBlocksPerHashLevel1) {
    return extract_request_hash_l2();
  }
  if (stfs_state.total_block_count > stfs::kBlocksPerHashLevel0) {
    return extract_request_hash_l1();
  }
  return extract_request_hash_l0();
}

static void extract_parse_hash_l2(uint32_t length) {
  const uint32_t record =
      (extract_state.hash_target_block / stfs::kBlocksPerHashLevel1) %
      stfs::kBlocksPerHashLevel0;
  bool ok = false;
  const uint32_t info = stfs_hash_info_at(record, length, &ok);
  if (!ok) return extract_fail(kExtractErrorChain);
  extract_state.hash_secondary_offset =
      (info & stfs::kHashActiveIndexBit) ? stfs::kBlockSize : 0u;
  extract_request_hash_l1();
}

static void extract_parse_hash_l1(uint32_t length) {
  const uint32_t record =
      (extract_state.hash_target_block / stfs::kBlocksPerHashLevel0) %
      stfs::kBlocksPerHashLevel0;
  bool ok = false;
  const uint32_t info = stfs_hash_info_at(record, length, &ok);
  if (!ok) return extract_fail(kExtractErrorChain);
  extract_state.hash_secondary_offset =
      (info & stfs::kHashActiveIndexBit) ? stfs::kBlockSize : 0u;
  extract_request_hash_l0();
}

static void extract_parse_hash_l0(uint32_t length) {
  const uint32_t record =
      extract_state.hash_target_block % stfs::kBlocksPerHashLevel0;
  bool ok = false;
  const uint32_t info = stfs_hash_info_at(record, length, &ok);
  if (!ok) return extract_fail(kExtractErrorChain);
  const uint32_t next_block = info & 0xFFFFFFu;
  if (next_block == stfs::kEndOfChain ||
      (stfs_state.total_block_count && next_block >= stfs_state.total_block_count)) {
    return extract_fail(kExtractErrorChain);
  }
  extract_state.current_block = next_block;
  extract_schedule_data();
}

static void extract_accept_data(uint32_t length, uint32_t expected) {
  if (length < expected) return extract_fail(kExtractErrorShortRead);
  extract_state.bytes_done += expected;
  extract_state.logical_offset = extract_state.bytes_done;
  ++extract_state.blocks_done;
  if (extract_state.bytes_done >= extract_state.bytes_total) {
    extract_state.status = kExtractComplete;
    extract_clear_request();
    return;
  }
  if (extract_state.contiguous) {
    ++extract_state.current_block;
    if (stfs_state.total_block_count &&
        extract_state.current_block >= stfs_state.total_block_count) {
      return extract_fail(kExtractErrorChain);
    }
    extract_schedule_data();
  } else {
    extract_begin_hash_resolution(extract_state.current_block);
  }
}

}  // namespace

extern "C" {

__attribute__((visibility("default")))
uint32_t r360_build_version() { return 32u; }

__attribute__((visibility("default")))
void r360_stfs_extract_reset() {
  extract_state = StfsExtractState{};
  if (stfs_state.request_kind >= kExtractRequestData &&
      stfs_state.request_kind <= kExtractRequestHashL0) {
    extract_clear_request();
  }
}

__attribute__((visibility("default")))
uint32_t r360_stfs_extract_begin(uint32_t entry_index) {
  r360_stfs_extract_reset();
  if (entry_index >= stfs_state.entry_count) {
    extract_state.status = kExtractErrorEntry;
    return extract_state.status;
  }
  const StfsEntryRecord& entry = stfs_entries[entry_index];
  if (entry.flags & 0x80u) {
    extract_state.status = kExtractErrorDirectory;
    return extract_state.status;
  }
  extract_state.entry_index = entry_index;
  extract_state.current_block = entry.start_block;
  extract_state.bytes_total = entry.length;
  extract_state.contiguous = (entry.flags & 0x40u) ? 1u : 0u;
  if (entry.length == 0u) {
    extract_state.status = kExtractComplete;
    return extract_state.status;
  }
  if (stfs_state.total_block_count && entry.start_block >= stfs_state.total_block_count) {
    extract_state.status = kExtractErrorChain;
    return extract_state.status;
  }
  extract_schedule_data();
  return extract_state.status;
}

__attribute__((visibility("default")))
uint32_t r360_stfs_submit_read(uint32_t length) {
  if (!stfs_state.request_pending) return stfs_state.status;
  const uint32_t kind = stfs_state.request_kind;
  if (kind < kExtractRequestData || kind > kExtractRequestHashL0) {
    return r360_stfs_submit_read_v30(length);
  }
  const uint32_t expected = stfs_state.request_size;
  stfs_state.request_pending = 0u;
  if (length < expected || length > R360_IO_CAPACITY) {
    extract_fail(kExtractErrorShortRead);
    return extract_state.status;
  }
  switch (kind) {
    case kExtractRequestData: extract_accept_data(length, expected); break;
    case kExtractRequestHashL2: extract_parse_hash_l2(length); break;
    case kExtractRequestHashL1: extract_parse_hash_l1(length); break;
    case kExtractRequestHashL0: extract_parse_hash_l0(length); break;
    default: extract_fail(kExtractErrorChain); break;
  }
  return extract_state.status;
}

#define R360_EXTRACT_GETTER(name, field) \
  __attribute__((visibility("default"))) uint32_t name() { return extract_state.field; }
R360_EXTRACT_GETTER(r360_stfs_extract_status, status)
R360_EXTRACT_GETTER(r360_stfs_extract_entry_index, entry_index)
R360_EXTRACT_GETTER(r360_stfs_extract_current_block, current_block)
R360_EXTRACT_GETTER(r360_stfs_extract_logical_offset, logical_offset)
R360_EXTRACT_GETTER(r360_stfs_extract_bytes_total, bytes_total)
R360_EXTRACT_GETTER(r360_stfs_extract_bytes_done, bytes_done)
R360_EXTRACT_GETTER(r360_stfs_extract_blocks_done, blocks_done)
R360_EXTRACT_GETTER(r360_stfs_extract_is_contiguous, contiguous)
#undef R360_EXTRACT_GETTER

__attribute__((visibility("default")))
uint32_t r360_feature_bits() {
  // V30 bits 0..10 + V32 bit 11: complete native STFS entry extraction.
  return r360_feature_bits_v30() | (1u << 11);
}

}  // extern "C"
