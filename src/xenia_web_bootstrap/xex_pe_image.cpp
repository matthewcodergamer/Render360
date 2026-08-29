#include "xex_pe_image.h"

namespace render360::xex {
namespace {

constexpr uint16_t kDosSignature = 0x5A4D;
constexpr uint32_t kNtSignature = 0x00004550;
constexpr uint16_t kPowerPcBigEndian = 0x01F2;
constexpr uint16_t kFile32BitMachine = 0x0100;
constexpr uint16_t kOptionalHeaderSize = 224;
constexpr uint16_t kOptionalHeader32Magic = 0x010B;
constexpr uint16_t kXboxSubsystem = 14;
constexpr uint32_t kSectionHeaderSize = 40;
constexpr uint32_t kSectionExecute = 0x20000000u;

uint16_t Read16(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) |
         static_cast<uint16_t>(static_cast<uint16_t>(p[1]) << 8);
}

uint32_t Read32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

bool AddInside(uint32_t start, uint32_t size, uint32_t limit) {
  return start <= limit && size <= limit - start;
}

bool IsPowerOfTwo(uint32_t value) {
  return value && ((value & (value - 1u)) == 0u);
}

uint32_t Fail(PEImageMetadata* out, uint32_t status) {
  out->status = status;
  return status;
}

}  // namespace

void ResetPE(PEImageMetadata* out) {
  if (out) *out = PEImageMetadata{};
}

uint32_t DecodePE(const uint8_t* image, uint32_t length, PEImageMetadata* out) {
  if (!out) return kPEErrorTooSmall;
  ResetPE(out);
  if (!image || length < 64u) return Fail(out, kPEErrorTooSmall);

  if (Read16(image) != kDosSignature) return Fail(out, kPEErrorDosSignature);
  const uint32_t nt_offset = Read32(image + 0x3Cu);
  out->nt_offset = nt_offset;

  // Signature + IMAGE_FILE_HEADER must be present before fields are read.
  if (!AddInside(nt_offset, 24u, length)) return Fail(out, kPEErrorNtRange);
  if (Read32(image + nt_offset) != kNtSignature) {
    return Fail(out, kPEErrorNtSignature);
  }

  const uint8_t* file = image + nt_offset + 4u;
  const uint16_t machine = Read16(file + 0u);
  const uint16_t section_count = Read16(file + 2u);
  const uint16_t optional_size = Read16(file + 16u);
  const uint16_t characteristics = Read16(file + 18u);
  out->machine = machine;
  out->characteristics = characteristics;
  out->section_count = section_count;

  if (machine != kPowerPcBigEndian ||
      (characteristics & kFile32BitMachine) == 0u) {
    return Fail(out, kPEErrorMachine);
  }
  if (section_count == 0u || section_count > kMaxPESections) {
    return Fail(out, kPEErrorSectionTable);
  }
  if (optional_size != kOptionalHeaderSize) {
    return Fail(out, kPEErrorOptionalHeader);
  }

  const uint32_t optional_offset = nt_offset + 24u;
  if (!AddInside(optional_offset, optional_size, length)) {
    return Fail(out, kPEErrorOptionalHeader);
  }
  const uint8_t* optional = image + optional_offset;
  if (Read16(optional + 0u) != kOptionalHeader32Magic) {
    return Fail(out, kPEErrorOptionalHeader);
  }

  out->entry_rva = Read32(optional + 16u);
  out->image_base = Read32(optional + 28u);
  out->section_alignment = Read32(optional + 32u);
  out->file_alignment = Read32(optional + 36u);
  out->size_of_image = Read32(optional + 56u);
  out->size_of_headers = Read32(optional + 60u);
  out->subsystem = Read16(optional + 68u);

  if (out->subsystem != kXboxSubsystem) return Fail(out, kPEErrorSubsystem);
  if (!IsPowerOfTwo(out->section_alignment) ||
      !IsPowerOfTwo(out->file_alignment) ||
      out->section_alignment < out->file_alignment ||
      out->size_of_image == 0u ||
      out->size_of_headers == 0u ||
      out->size_of_headers > length ||
      out->entry_rva >= out->size_of_image) {
    return Fail(out, kPEErrorOptionalHeader);
  }

  const uint32_t section_table = optional_offset + optional_size;
  const uint32_t section_bytes = static_cast<uint32_t>(section_count) * kSectionHeaderSize;
  if (!AddInside(section_table, section_bytes, length) ||
      section_table + section_bytes > out->size_of_headers) {
    return Fail(out, kPEErrorSectionTable);
  }

  bool entry_is_executable = false;
  for (uint32_t i = 0; i < section_count; ++i) {
    const uint8_t* sh = image + section_table + i * kSectionHeaderSize;
    auto& section = out->sections[i];
    for (uint32_t n = 0; n < 8u; ++n) section.name[n] = static_cast<char>(sh[n]);
    section.name[8] = 0;
    section.virtual_size = Read32(sh + 8u);
    section.virtual_address = Read32(sh + 12u);
    section.raw_size = Read32(sh + 16u);
    section.raw_address = Read32(sh + 20u);
    section.characteristics = Read32(sh + 36u);

    const uint32_t virtual_span = section.virtual_size > section.raw_size
                                      ? section.virtual_size
                                      : section.raw_size;
    if (virtual_span != 0u &&
        !AddInside(section.virtual_address, virtual_span, out->size_of_image)) {
      return Fail(out, kPEErrorSectionRange);
    }
    if (section.raw_size != 0u &&
        !AddInside(section.raw_address, section.raw_size, length)) {
      return Fail(out, kPEErrorSectionRange);
    }

    if (virtual_span != 0u &&
        out->entry_rva >= section.virtual_address &&
        out->entry_rva - section.virtual_address < virtual_span &&
        (section.characteristics & kSectionExecute) != 0u) {
      entry_is_executable = true;
    }
  }

  if (!entry_is_executable) return Fail(out, kPEErrorEntry);
  out->status = kPEPass;
  return out->status;
}

}  // namespace render360::xex
