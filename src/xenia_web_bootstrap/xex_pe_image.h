#pragma once
#include <stdint.h>

namespace render360::xex {

enum PEStatus : uint32_t {
  kPEIdle = 0,
  kPEPass = 1,
  kPEErrorTooSmall = 100,
  kPEErrorDosSignature = 101,
  kPEErrorNtRange = 102,
  kPEErrorNtSignature = 103,
  kPEErrorMachine = 104,
  kPEErrorOptionalHeader = 105,
  kPEErrorSubsystem = 106,
  kPEErrorSectionTable = 107,
  kPEErrorSectionRange = 108,
  kPEErrorEntry = 109,
};

constexpr uint32_t kMaxPESections = 96;

struct PESectionMetadata {
  char name[9] = {};
  uint32_t virtual_address = 0;
  uint32_t virtual_size = 0;
  uint32_t raw_address = 0;
  uint32_t raw_size = 0;
  uint32_t characteristics = 0;
};

struct PEImageMetadata {
  uint32_t status = kPEIdle;
  uint32_t nt_offset = 0;
  uint32_t machine = 0;
  uint32_t characteristics = 0;
  uint32_t section_count = 0;
  uint32_t entry_rva = 0;
  uint32_t image_base = 0;
  uint32_t section_alignment = 0;
  uint32_t file_alignment = 0;
  uint32_t size_of_image = 0;
  uint32_t size_of_headers = 0;
  uint32_t subsystem = 0;
  PESectionMetadata sections[kMaxPESections] = {};
};

void ResetPE(PEImageMetadata* out);
uint32_t DecodePE(const uint8_t* image, uint32_t length, PEImageMetadata* out);

}  // namespace render360::xex
