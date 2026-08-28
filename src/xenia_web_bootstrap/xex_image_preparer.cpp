#include "xex_image_preparer.h"

namespace render360::xex {

namespace {

uint32_t ReadBe32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

uint32_t RotateLeft(uint32_t v, uint32_t n) {
  return (v << n) | (v >> (32u - n));
}

void Sha1Transform(Sha1State* s, const uint8_t* block) {
  uint32_t w[80];
  for (uint32_t i = 0; i < 16u; ++i) w[i] = ReadBe32(block + i * 4u);
  for (uint32_t i = 16u; i < 80u; ++i) {
    w[i] = RotateLeft(w[i - 3u] ^ w[i - 8u] ^ w[i - 14u] ^ w[i - 16u], 1u);
  }
  uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3], e = s->h[4];
  for (uint32_t i = 0; i < 80u; ++i) {
    uint32_t f = 0u, k = 0u;
    if (i < 20u) {
      f = (b & c) | ((~b) & d); k = 0x5A827999u;
    } else if (i < 40u) {
      f = b ^ c ^ d; k = 0x6ED9EBA1u;
    } else if (i < 60u) {
      f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu;
    } else {
      f = b ^ c ^ d; k = 0xCA62C1D6u;
    }
    const uint32_t temp = RotateLeft(a, 5u) + f + e + k + w[i];
    e = d; d = c; c = RotateLeft(b, 30u); b = a; a = temp;
  }
  s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e;
}

void Sha1Reset(Sha1State* s) {
  *s = Sha1State{};
  s->h[0] = 0x67452301u; s->h[1] = 0xEFCDAB89u; s->h[2] = 0x98BADCFEu;
  s->h[3] = 0x10325476u; s->h[4] = 0xC3D2E1F0u;
}

void Sha1UpdateByte(Sha1State* s, uint8_t value) {
  s->buffer[s->buffer_bytes++] = value;
  ++s->total_bytes;
  if (s->buffer_bytes == 64u) {
    Sha1Transform(s, s->buffer);
    s->buffer_bytes = 0u;
  }
}

void Sha1Finalize(const Sha1State* source, uint8_t digest[20]) {
  Sha1State s = *source;
  const uint64_t bit_length = s.total_bytes * 8ull;
  Sha1UpdateByte(&s, 0x80u);
  while (s.buffer_bytes != 56u) Sha1UpdateByte(&s, 0u);
  for (int i = 7; i >= 0; --i) {
    Sha1UpdateByte(&s, static_cast<uint8_t>(bit_length >> (uint32_t(i) * 8u)));
  }
  for (uint32_t i = 0; i < 5u; ++i) {
    digest[i * 4u + 0u] = static_cast<uint8_t>(s.h[i] >> 24u);
    digest[i * 4u + 1u] = static_cast<uint8_t>(s.h[i] >> 16u);
    digest[i * 4u + 2u] = static_cast<uint8_t>(s.h[i] >> 8u);
    digest[i * 4u + 3u] = static_cast<uint8_t>(s.h[i]);
  }
}

bool HashEqual(const uint8_t a[20], const uint8_t b[20]) {
  uint8_t diff = 0u;
  for (uint32_t i = 0; i < 20u; ++i) diff |= uint8_t(a[i] ^ b[i]);
  return diff == 0u;
}

bool IsValidLzxWindow(uint32_t value) {
  return value >= 0x8000u && value <= 0x200000u && (value & (value - 1u)) == 0u;
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

void StartNormalBlock(PrepareState* state, uint32_t size, const uint8_t hash[20]) {
  state->normal_block_size = size;
  state->normal_block_seen = 0u;
  state->normal_next_header_seen = 0u;
  state->normal_chunk_length_bytes = 0u;
  state->normal_chunk_length_value = 0u;
  state->normal_chunk_remaining = 0u;
  state->normal_chunk_terminated = 0u;
  for (uint32_t i = 0; i < 20u; ++i) state->normal_expected_hash[i] = hash[i];
  for (uint32_t i = 0; i < 24u; ++i) state->normal_next_header[i] = 0u;
  Sha1Reset(&state->normal_sha1);
}

uint32_t FinishNormalBlock(PrepareState* state) {
  uint8_t digest[20];
  Sha1Finalize(&state->normal_sha1, digest);
  if (!HashEqual(digest, state->normal_expected_hash)) {
    state->status = kPrepareErrorNormalHash;
    return state->status;
  }
  if (state->normal_next_header_seen != 24u ||
      !state->normal_chunk_terminated || state->normal_chunk_remaining ||
      state->normal_chunk_length_bytes) {
    state->status = kPrepareErrorNormalFormat;
    return state->status;
  }

  ++state->normal_blocks_done;
  const uint32_t next_size = ReadBe32(state->normal_next_header);
  if (!next_size) {
    if (state->bytes_done != state->source_bytes) {
      state->status = kPrepareErrorNormalRange;
      return state->status;
    }
    state->output_bytes = state->output_done;
    state->status = kPrepareComplete;
    return state->status;
  }
  if (next_size < 26u || next_size > state->source_bytes - state->bytes_done) {
    state->status = kPrepareErrorNormalRange;
    return state->status;
  }
  StartNormalBlock(state, next_size, state->normal_next_header + 4u);
  state->status = kPrepareWorking;
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
  state->bytes_done += chunk_length;
  state->output_done += chunk_length;
  state->last_output_kind = kPrepareOutputData;
  state->last_output_bytes = chunk_length;
  if (state->bytes_done == state->source_bytes) state->status = kPrepareComplete;
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
  if (uint32_t(source_total) != payload_bytes) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }
  if (metadata->mapped_span && output_total > metadata->mapped_span) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }

  state->source_offset = metadata->header_size;
  state->source_bytes = uint32_t(source_total);
  state->output_bytes = uint32_t(output_total);
  state->basic_block_count = block_count;
  state->status = kPrepareWorking;
  return FinishOrAdvanceBasic(state);
}

uint32_t PrepareBasicDataRemaining(const PrepareState* state) {
  if (!state || state->basic_block_index >= state->basic_block_count) return 0u;
  const BasicBlock& block = state->basic_blocks[state->basic_block_index];
  return state->basic_block_data_done < block.data_size
             ? block.data_size - state->basic_block_data_done : 0u;
}

uint32_t PrepareBasicZeroRemaining(const PrepareState* state) {
  if (!state || state->basic_block_index >= state->basic_block_count) return 0u;
  const BasicBlock& block = state->basic_blocks[state->basic_block_index];
  if (state->basic_block_data_done != block.data_size ||
      state->basic_block_zero_done >= block.zero_size) return 0u;
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
  const uint32_t count = max_length < remaining ? max_length : remaining;
  if (count > state->output_bytes - state->output_done) {
    state->status = kPrepareErrorBasicRange;
    return state->status;
  }
  state->basic_block_zero_done += count;
  state->output_done += count;
  state->last_output_kind = kPrepareOutputZero;
  state->last_output_bytes = count;
  return FinishOrAdvanceBasic(state);
}

uint32_t BeginPrepareNormalFrame(const uint8_t* staged_header,
                                 uint32_t staged_length,
                                 uint32_t file_length,
                                 ImageMetadata* metadata,
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
  if (metadata->compression_type != 2u) {
    state->status = kPrepareErrorUnsupportedCompression;
    return state->status;
  }
  if (metadata->header_size > file_length) {
    state->status = kPrepareErrorFileRange;
    return state->status;
  }

  const uint32_t info_offset = metadata->file_format_info_offset;
  if (info_offset > staged_length || staged_length - info_offset < 36u) {
    state->status = kPrepareErrorNormalFormat;
    return state->status;
  }
  const uint32_t info_size = ReadBe32(staged_header + info_offset);
  if (info_size < 36u || info_size > staged_length - info_offset) {
    state->status = kPrepareErrorNormalFormat;
    return state->status;
  }
  const uint32_t window_size = ReadBe32(staged_header + info_offset + 8u);
  const uint32_t first_block_size = ReadBe32(staged_header + info_offset + 12u);
  if (!IsValidLzxWindow(window_size) || first_block_size < 26u) {
    state->status = kPrepareErrorNormalFormat;
    return state->status;
  }

  const uint32_t source_bytes = file_length - metadata->header_size;
  if (!source_bytes || first_block_size > source_bytes) {
    state->status = kPrepareErrorNormalRange;
    return state->status;
  }

  state->source_offset = metadata->header_size;
  state->source_bytes = source_bytes;
  state->output_bytes = 0u;  // deblocked compressed size becomes known at completion
  state->normal_window_size = window_size;
  StartNormalBlock(state, first_block_size, staged_header + info_offset + 16u);
  state->status = kPrepareWorking;
  return state->status;
}

uint32_t AcceptPrepareNormalFrameChunk(uint8_t* staged_chunk,
                                       uint32_t chunk_length,
                                       PrepareState* state) {
  if (!state || !staged_chunk || state->status != kPrepareWorking || !chunk_length) {
    if (state) state->status = kPrepareErrorChunk;
    return kPrepareErrorChunk;
  }
  if (chunk_length > state->source_bytes - state->bytes_done) {
    state->status = kPrepareErrorChunk;
    return state->status;
  }

  state->last_output_kind = kPrepareOutputNone;
  state->last_output_bytes = 0u;
  uint32_t write_index = 0u;

  for (uint32_t read_index = 0u; read_index < chunk_length; ++read_index) {
    if (state->status != kPrepareWorking || !state->normal_block_size ||
        state->normal_block_seen >= state->normal_block_size) {
      state->status = kPrepareErrorNormalState;
      return state->status;
    }

    const uint8_t value = staged_chunk[read_index];
    Sha1UpdateByte(&state->normal_sha1, value);
    ++state->normal_block_seen;
    ++state->bytes_done;

    if (state->normal_next_header_seen < 24u) {
      state->normal_next_header[state->normal_next_header_seen++] = value;
    } else if (!state->normal_chunk_terminated) {
      if (state->normal_chunk_remaining) {
        staged_chunk[write_index++] = value;
        --state->normal_chunk_remaining;
      } else if (!state->normal_chunk_length_bytes) {
        state->normal_chunk_length_value = uint32_t(value) << 8u;
        state->normal_chunk_length_bytes = 1u;
      } else {
        state->normal_chunk_length_value |= uint32_t(value);
        state->normal_chunk_length_bytes = 0u;
        if (!state->normal_chunk_length_value) {
          state->normal_chunk_terminated = 1u;
        } else {
          state->normal_chunk_remaining = state->normal_chunk_length_value;
          state->normal_chunk_length_value = 0u;
          const uint32_t bytes_left_in_block =
              state->normal_block_size - state->normal_block_seen;
          if (state->normal_chunk_remaining > bytes_left_in_block) {
            state->status = kPrepareErrorNormalFormat;
            return state->status;
          }
        }
      }
    }

    if (state->normal_block_seen == state->normal_block_size) {
      const uint32_t result = FinishNormalBlock(state);
      if (result != kPrepareWorking && result != kPrepareComplete) return result;
      if (result == kPrepareComplete && read_index + 1u != chunk_length) {
        state->status = kPrepareErrorNormalRange;
        return state->status;
      }
    }
  }

  state->output_done += write_index;
  if (write_index) {
    state->last_output_kind = kPrepareOutputData;
    state->last_output_bytes = write_index;
  }
  if (state->status == kPrepareComplete) state->output_bytes = state->output_done;
  return state->status;
}

}  // namespace render360::xex
