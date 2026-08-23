/*
 * Render360 Web-port STFS layout contract.
 *
 * Layout constants and field semantics are adapted from Xenia's
 * src/xenia/vfs/devices/stfs_xbox.h and stfs_container_device.cc.
 * Xenia is BSD 3-Clause licensed; see LICENSE_XENIA.txt.
 *
 * This header intentionally contains only the stable on-disk layout needed by
 * the freestanding wasm32 mount state machine. Browser file I/O stays outside
 * the Xbox format logic: JavaScript only services byte-range requests.
 */
#ifndef RENDER360_XENIA_PORT_STFS_LAYOUT_H_
#define RENDER360_XENIA_PORT_STFS_LAYOUT_H_

#include <stdint.h>

namespace r360::xenia_port::stfs {

constexpr uint32_t kBlockSize = 0x1000u;
constexpr uint32_t kHeaderStructSize = 0x971Au;
constexpr uint32_t kXContentHeaderSize = 0x344u;
constexpr uint32_t kMetadataOffset = 0x344u;
constexpr uint32_t kHeaderSizeOffset = 0x340u;
constexpr uint32_t kVolumeDescriptorOffset = 0x379u;
constexpr uint32_t kVolumeDescriptorSize = 0x24u;
constexpr uint32_t kDataFileCountOffset = 0x39Du;
constexpr uint32_t kVolumeTypeOffset = 0x3A9u;
constexpr uint32_t kContentTypeOffset = 0x344u;
constexpr uint32_t kMetadataVersionOffset = 0x348u;
constexpr uint32_t kContentSizeOffset = 0x34Cu;
constexpr uint32_t kExecutionInfoOffset = 0x354u;
constexpr uint32_t kExecutionMediaIdOffset = kExecutionInfoOffset + 0x00u;
constexpr uint32_t kExecutionTitleIdOffset = kExecutionInfoOffset + 0x0Cu;

constexpr uint32_t kDescriptorLengthOffset = kVolumeDescriptorOffset + 0x00u;
constexpr uint32_t kDescriptorVersionOffset = kVolumeDescriptorOffset + 0x01u;
constexpr uint32_t kDescriptorFlagsOffset = kVolumeDescriptorOffset + 0x02u;
constexpr uint32_t kFileTableBlockCountOffset = kVolumeDescriptorOffset + 0x03u;
constexpr uint32_t kFileTableBlockNumberOffset = kVolumeDescriptorOffset + 0x05u;
constexpr uint32_t kTotalBlockCountOffset = kVolumeDescriptorOffset + 0x1Cu;
constexpr uint32_t kFreeBlockCountOffset = kVolumeDescriptorOffset + 0x20u;

constexpr uint32_t kBlocksPerHashLevel0 = 170u;
constexpr uint32_t kBlocksPerHashLevel1 = 28900u;
constexpr uint32_t kBlocksPerHashLevel2 = 4913000u;
constexpr uint32_t kEndOfChain = 0xFFFFFFu;
constexpr uint32_t kHashEntrySize = 0x18u;
constexpr uint32_t kHashInfoOffset = 0x14u;
constexpr uint32_t kHashActiveIndexBit = 0x40000000u;

constexpr uint32_t kDirectoryEntrySize = 0x40u;
constexpr uint32_t kDirectoryEntriesPerBlock = 0x40u;
constexpr uint32_t kDirectoryNameBytes = 40u;
constexpr uint32_t kDirectoryFlagsOffset = 0x28u;
constexpr uint32_t kDirectoryValidBlocksOffset = 0x29u;
constexpr uint32_t kDirectoryAllocatedBlocksOffset = 0x2Cu;
constexpr uint32_t kDirectoryStartBlockOffset = 0x2Fu;
constexpr uint32_t kDirectoryParentIndexOffset = 0x32u;
constexpr uint32_t kDirectoryLengthOffset = 0x34u;

constexpr uint32_t kVolumeTypeStfs = 0u;
constexpr uint32_t kVolumeTypeSvod = 1u;
constexpr uint32_t kPackageCon = 0x434F4E20u;
constexpr uint32_t kPackagePirs = 0x50495253u;
constexpr uint32_t kPackageLive = 0x4C495645u;

}  // namespace r360::xenia_port::stfs

#endif  // RENDER360_XENIA_PORT_STFS_LAYOUT_H_
