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
  kPrepareErrorBasicFormat = 105,
  kPrepareErrorBasicRange = 106,
  kPrepareErrorBasicState = 107,
};

enum PrepareOutputKind : uint32_t {
  kPrepareOutputNone = 0,
  kPrepareOutputData = 1,
  kPrepareOutputZero = 2,
};

constexpr uint32_t kMaxBasicBlocks = 2048;

struct BasicBlock {
  uint32_t data_size = 0;
  uint32_t zero_size = 0;
};

struct PrepareState {
  uint32_t status = kPrepareIdle;
  uint32_t source_offset = 0;
  uint32_t source_bytes = 0;
  uint32_t output_bytes = 0;
  uint32_t bytes_done = 0;
  uint32_t output_done = 0;
  uint32_t encryption_type = 0xFFFFFFFFu;
  uint32_t compression_type = 0xFFFFFFFFu;

  uint32_t basic_block_count = 0;
  uint32_t basic_block_index = 0;
  uint32_t basic_block_data_done = 0;
  uint32_t basic_block_zero_done = 0;
  uint32_t last_output_kind = kPrepareOutputNone;
  uint32_t last_output_bytes = 0;
  BasicBlock basic_blocks[kMaxBasicBlocks] = {};
};

void ResetPrepare(PrepareState* state);
uint32_t BeginPrepareNone(const uint8_t* staged_header, uint32_t staged_length,
                          uint32_t file_length, ImageMetadata* metadata,
                          PrepareState* state);
uint32_t AcceptPrepareNoneChunk(uint32_t chunk_length, PrepareState* state);

uint32_t BeginPrepareBasic(const uint8_t* staged_header, uint32_t staged_length,
                           uint32_t file_length, ImageMetadata* metadata,
                           PrepareState* state);
uint32_t AcceptPrepareBasicData(uint32_t chunk_length, PrepareState* state);
uint32_t ConsumePrepareBasicZero(uint32_t max_length, PrepareState* state);
uint32_t PrepareBasicDataRemaining(const PrepareState* state);
uint32_t PrepareBasicZeroRemaining(const PrepareState* state);

}  // namespace render360::xex
