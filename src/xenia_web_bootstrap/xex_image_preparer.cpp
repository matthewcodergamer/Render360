#include "xex_image_preparer.h"

namespace render360::xex {

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

  // This is the same source range used by Xenia's ReadImageUncompressed:
  // executable payload begins immediately after the XEX header and its
  // uncompressed size is xex_length - header_size.
  state->source_offset = metadata->header_size;
  state->source_bytes = file_length - metadata->header_size;
  state->output_bytes = state->source_bytes;
  state->bytes_done = 0u;
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
  // NONE/NONE is intentionally in-place: the caller places the requested
  // source range in the shared staging buffer, and the bytes are already the
  // prepared payload. This avoids a second full-image allocation.
  state->bytes_done += chunk_length;
  if (state->bytes_done == state->source_bytes) {
    state->status = kPrepareComplete;
  }
  return state->status;
}

}  // namespace render360::xex
