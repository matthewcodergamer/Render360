#pragma once
#include <stdint.h>
#include "xex_image_decoder.h"

namespace render360::xex {

enum PrepareStatus : uint32_t {
  kPrepareIdle = 0,
  kPrepareWorking = 1,
  kPrepareComplete = 2,
  kPrepareErrorDecode = 100,
  kPrepareErrorFileRange = 101,
  kPrepareErrorUnsupportedEncryption = 102,
  kPrepareErrorUnsupportedCompression = 103,
  kPrepareErrorChunk = 104,
};

struct PrepareState {
  uint32_t status = kPrepareIdle;
  uint32_t source_offset = 0;
  uint32_t source_bytes = 0;
  uint32_t output_bytes = 0;
  uint32_t bytes_done = 0;
  uint32_t encryption_type = 0xFFFFFFFFu;
  uint32_t compression_type = 0xFFFFFFFFu;
};

void ResetPrepare(PrepareState* state);
uint32_t BeginPrepareNone(const uint8_t* staged_header, uint32_t staged_length,
                          uint32_t file_length, ImageMetadata* metadata,
                          PrepareState* state);
uint32_t AcceptPrepareNoneChunk(uint32_t chunk_length, PrepareState* state);

}  // namespace render360::xex
