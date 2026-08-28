#pragma once
#include <stdint.h>

// Narrow STFS layout constants mirrored from upstream Xenia's stfs_xbox.h and
// stfs_container_device.cc. xenia_contract_check.py guards these assumptions
// against upstream drift.
namespace r360::xenia_port::stfs {

constexpr uint32_t kBlockSize = 0x1000u;
constexpr uint32_t kBlocksPerHashLevel0 = 170u;
constexpr uint32_t kBlocksPerHashLevel1 = kBlocksPerHashLevel0 * kBlocksPerHashLevel0;
constexpr uint32_t kHashEntrySize = 0x18u;
constexpr uint32_t kHashInfoOffset = 0x14u;
constexpr uint32_t kHashActiveIndexBit = 0x40000000u;
constexpr uint32_t kEndOfChain = 0x00FFFFFFu;

constexpr uint32_t kDirectoryEntrySize = 0x40u;
constexpr uint32_t kDirectoryEntriesPerBlock = kBlockSize / kDirectoryEntrySize;
constexpr uint32_t kDirectoryNameBytes = 40u;
constexpr uint32_t kDirectoryFlagsOffset = 0x28u;
constexpr uint32_t kDirectoryValidBlocksOffset = 0x29u;
constexpr uint32_t kDirectoryAllocatedBlocksOffset = 0x2Cu;
constexpr uint32_t kDirectoryStartBlockOffset = 0x2Fu;
constexpr uint32_t kDirectoryParentIndexOffset = 0x32u;
constexpr uint32_t kDirectoryLengthOffset = 0x34u;

constexpr uint32_t kXContentHeaderSize = 0x344u;
constexpr uint32_t kHeaderStructSize = 0x971Au;
constexpr uint32_t kHeaderSizeOffset = 0x340u;
constexpr uint32_t kContentTypeOffset = 0x344u;
constexpr uint32_t kMetadataVersionOffset = 0x348u;
constexpr uint32_t kContentSizeOffset = 0x34Cu;
constexpr uint32_t kExecutionMediaIdOffset = 0x354u;
constexpr uint32_t kExecutionTitleIdOffset = 0x360u;

constexpr uint32_t kDescriptorLengthOffset = 0x379u;
constexpr uint32_t kDescriptorVersionOffset = 0x37Au;
constexpr uint32_t kDescriptorFlagsOffset = 0x37Bu;
constexpr uint32_t kFileTableBlockCountOffset = 0x37Cu;
constexpr uint32_t kFileTableBlockNumberOffset = 0x37Eu;
constexpr uint32_t kTotalBlockCountOffset = 0x395u;
constexpr uint32_t kFreeBlockCountOffset = 0x399u;
constexpr uint32_t kVolumeDescriptorSize = 0x24u;
constexpr uint32_t kDataFileCountOffset = 0x39Du;
constexpr uint32_t kVolumeTypeOffset = 0x3A9u;
constexpr uint32_t kVolumeTypeStfs = 0u;

}  // namespace r360::xenia_port::stfs
