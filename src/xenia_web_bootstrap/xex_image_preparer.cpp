#include "xex_image_preparer.h"

namespace render360::xex {

namespace {

uint32_t ReadBe32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

uint32_t FinishOrAdvanceBasic(PrepareState* state) {
  while (state->basic_block_index < state->basic_block_count) {
    const BasicBlock& block = state->basic_blocks[state->basic_block_index];
    if (state->basic_block_data_done < block.data_size ||
        state->basic_block_zero_done < block.zero_size) {
      state->status = kPrepareWorking;
      return state->status;
    }
    ++state->basic_block_index;
    state->basic_block_data_done = 0u;
    state->basic_block_zero_done = 0u;
  }
  if (state->bytes_done != state->source_bytes ||
      state->output_done != state->output_bytes) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }
  state->status = kPrepareComplete;
  return state->status;
}

}  // namespace

void ResetPrepare(PrepareState* state) {
  if (!state) return;
  *state = PrepareState{};
}

uint32_t BeginPrepareNone(const uint8_t* staged_header, uint32_t staged_length,
                          uint32_t file_length, ImageMetadata* metadata,
                          PrepareState* state) {
  if (!metadata || !state) return kPrepareErrorDecode;
  ResetPrepare(state);
  const uint32_t decode_status = Decode(staged_header, staged_length, metadata);
  if (decode_status != kDecodePass) {
    state->status = kPrepareErrorDecode;
    return state->status;
  }

  state->encryption_type = metadata->encryption_type;
  state->compression_type = metadata->compression_type;
  if (metadata->encryption_type != 0u) {
    state->status = kPrepareErrorUnsupportedEncryption;
    return state->status;
  }
  if (metadata->compression_type != 0u) {
    state->status = kPrepareErrorUnsupportedCompression;
    return state->status;
  }
  if (metadata->header_size > file_length) {
    state->status = kPrepareErrorFileRange;
    return state->status;
  }

  // Same source range used by Xenia's ReadImageUncompressed.
  state->source_offset = metadata->header_size;
  state->source_bytes = file_length - metadata->header_size;
  state->output_bytes = state->source_bytes;
  state->bytes_done = 0u;
  state->output_done = 0u;
  state->status = state->source_bytes ? kPrepareWorking : kPrepareComplete;
  return state->status;
}

uint32_t AcceptPrepareNoneChunk(uint32_t chunk_length, PrepareState* state) {
  if (!state || state->status != kPrepareWorking || !chunk_length) {
    if (state) state->status = kPrepareErrorChunk;
    return kPrepareErrorChunk;
  }
  const uint32_t remaining = state->source_bytes - state->bytes_done;
  if (chunk_length > remaining) {
    state->status = kPrepareErrorChunk;
    return state->status;
  }
  // NONE/NONE is intentionally in-place: staged source bytes are already the
  // prepared bytes, avoiding a second full-image allocation.
  state->bytes_done += chunk_length;
  state->output_done += chunk_length;
  state->last_output_kind = kPrepareOutputData;
  state->last_output_bytes = chunk_length;
  if (state->bytes_done == state->source_bytes) {
    state->status = kPrepareComplete;
  }
  return state->status;
}

uint32_t BeginPrepareBasic(const uint8_t* staged_header, uint32_t staged_length,
                           uint32_t file_length, ImageMetadata* metadata,
                           PrepareState* state) {
  if (!metadata || !state || !staged_header) return kPrepareErrorDecode;
  ResetPrepare(state);
  const uint32_t decode_status = Decode(staged_header, staged_length, metadata);
  if (decode_status != kDecodePass) {
    state->status = kPrepareErrorDecode;
    return state->status;
  }

  state->encryption_type = metadata->encryption_type;
  state->compression_type = metadata->compression_type;
  if (metadata->encryption_type != 0u) {
    state->status = kPrepareErrorUnsupportedEncryption;
    return state->status;
  }
  if (metadata->compression_type != 1u) {
    state->status = kPrepareErrorUnsupportedCompression;
    return state->status;
  }
  if (metadata->header_size > file_length) {
    state->status = kPrepareErrorFileRange;
    return state->status;
  }

  const uint32_t info_offset = metadata->file_format_info_offset;
  if (info_offset > staged_length || staged_length - info_offset < 8u) {
    state->status = kPrepareErrorBasicFormat;
    return state->status;
  }
  const uint32_t info_size = ReadBe32(staged_header + info_offset);
  if (info_size < 8u || ((info_size - 8u) & 7u) != 0u ||
      info_size > staged_length - info_offset) {
    state->status = kPrepareErrorBasicFormat;
    return state->status;
  }

  const uint32_t block_count = (info_size - 8u) / 8u;
  if (!block_count || block_count > kMaxBasicBlocks) {
    state->status = kPrepareErrorBasicFormat;
    return state->status;
  }

  uint64_t source_total = 0u;
  uint64_t output_total = 0u;
  for (uint32_t i = 0; i < block_count; ++i) {
    const uint32_t off = info_offset + 8u + i * 8u;
    const uint32_t data_size = ReadBe32(staged_header + off);
    const uint32_t zero_size = ReadBe32(staged_header + off + 4u);
    state->basic_blocks[i].data_size = data_size;
    state->basic_blocks[i].zero_size = zero_size;
    source_total += uint64_t(data_size);
    output_total += uint64_t(data_size) + uint64_t(zero_size);
    if (source_total > 0xFFFFFFFFull || output_total > 0xFFFFFFFFull) {
      state->status = kPrepareErrorBasicRange;
      return state->status;
    }
  }

  const uint32_t payload_bytes = file_length - metadata->header_size;
  // BASIC stores only the concatenated data portions in the XEX payload.
  // Requiring an exact match rejects both truncated and trailing source bytes.
  if (uint32_t(source_total) != payload_bytes) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }
  // Xenia allocates the image span described by the page descriptors, then
  // writes data_size bytes and advances across zero_size holes. Never permit a
  // BASIC table to describe output beyond that decoded image span.
  if (metadata->mapped_span && output_total > metadata->mapped_span) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }

  state->source_offset = metadata->header_size;
  state->source_bytes = uint32_t(source_total);
  state->output_bytes = uint32_t(output_total);
  state->bytes_done = 0u;
  state->output_done = 0u;
  state->basic_block_count = block_count;
  state->basic_block_index = 0u;
  state->basic_block_data_done = 0u;
  state->basic_block_zero_done = 0u;
  state->last_output_kind = kPrepareOutputNone;
  state->last_output_bytes = 0u;
  state->status = kPrepareWorking;
  return FinishOrAdvanceBasic(state);
}

uint32_t PrepareBasicDataRemaining(const PrepareState* state) {
  if (!state || state->basic_block_index >= state->basic_block_count) return 0u;
  const BasicBlock& block = state->basic_blocks[state->basic_block_index];
  if (state->basic_block_data_done >= block.data_size) return 0u;
  return block.data_size - state->basic_block_data_done;
}

uint32_t PrepareBasicZeroRemaining(const PrepareState* state) {
  if (!state || state->basic_block_index >= state->basic_block_count) return 0u;
  const BasicBlock& block = state->basic_blocks[state->basic_block_index];
  if (state->basic_block_data_done != block.data_size ||
      state->basic_block_zero_done >= block.zero_size) {
    return 0u;
  }
  return block.zero_size - state->basic_block_zero_done;
}

uint32_t AcceptPrepareBasicData(uint32_t chunk_length, PrepareState* state) {
  if (!state || state->status != kPrepareWorking || !chunk_length) {
    if (state) state->status = kPrepareErrorChunk;
    return kPrepareErrorChunk;
  }
  state->last_output_kind = kPrepareOutputNone;
  state->last_output_bytes = 0u;
  if (PrepareBasicZeroRemaining(state)) {
    state->status = kPrepareErrorBasicState;
    return state->status;
  }
  const uint32_t remaining = PrepareBasicDataRemaining(state);
  if (!remaining) {
    state->status = kPrepareErrorBasicState;
    return state->status;
  }
  if (chunk_length > remaining || chunk_length > state->source_bytes - state->bytes_done ||
      chunk_length > state->output_bytes - state->output_done) {
    state->status = kPrepareErrorChunk;
    return state->status;
  }

  // BASIC data portions are identity bytes for the unencrypted path. The
  // caller stages them and can stream them directly to the output mapping.
  state->basic_block_data_done += chunk_length;
  state->bytes_done += chunk_length;
  state->output_done += chunk_length;
  state->last_output_kind = kPrepareOutputData;
  state->last_output_bytes = chunk_length;
  return FinishOrAdvanceBasic(state);
}

uint32_t ConsumePrepareBasicZero(uint32_t max_length, PrepareState* state) {
  if (!state || state->status != kPrepareWorking || !max_length) {
    if (state) state->status = kPrepareErrorChunk;
    return kPrepareErrorChunk;
  }
  state->last_output_kind = kPrepareOutputNone;
  state->last_output_bytes = 0u;
  const uint32_t remaining = PrepareBasicZeroRemaining(state);
  if (!remaining) {
    state->status = kPrepareErrorBasicState;
    return state->status;
  }
  uint32_t count = max_length < remaining ? max_length : remaining;
  if (count > state->output_bytes - state->output_done) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }

  // No source bytes are consumed for BASIC zero ranges. The caller can leave
  // newly mapped sparse memory zeroed or explicitly emit count zero bytes.
  state->basic_block_zero_done += count;
  state->output_done += count;
  state->last_output_kind = kPrepareOutputZero;
  state->last_output_bytes = count;
  return FinishOrAdvanceBasic(state);
}

}  // namespace render360::xex
