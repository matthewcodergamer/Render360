#include <stdint.h>
#include <stddef.h>
#include "xex_image_preparer.h"

extern "C" uint32_t r360_io_ptr();
extern "C" uint32_t r360_io_capacity();

namespace {
render360::xex::ImageMetadata prepare_metadata;
render360::xex::PrepareState prepare_state;
}

extern "C" {

__attribute__((visibility("default")))
void r360_xex_prepare_reset() {
  render360::xex::Reset(&prepare_metadata);
  render360::xex::ResetPrepare(&prepare_state);
}

static const uint8_t* r360_prepare_staged_bytes(uint32_t staged_header_length) {
  if (!staged_header_length || staged_header_length > r360_io_capacity()) {
    return nullptr;
  }
  return reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(r360_io_ptr()));
}

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_none_begin(uint32_t staged_header_length,
                                     uint32_t file_length) {
  const auto* bytes = r360_prepare_staged_bytes(staged_header_length);
  if (!bytes) {
    r360_xex_prepare_reset();
    prepare_state.status = render360::xex::kPrepareErrorFileRange;
    return prepare_state.status;
  }
  return render360::xex::BeginPrepareNone(
      bytes, staged_header_length, file_length, &prepare_metadata, &prepare_state);
}

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_none_accept(uint32_t chunk_length) {
  if (!chunk_length || chunk_length > r360_io_capacity()) {
    prepare_state.status = render360::xex::kPrepareErrorChunk;
    return prepare_state.status;
  }
  return render360::xex::AcceptPrepareNoneChunk(chunk_length, &prepare_state);
}

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_basic_begin(uint32_t staged_header_length,
                                      uint32_t file_length) {
  const auto* bytes = r360_prepare_staged_bytes(staged_header_length);
  if (!bytes) {
    r360_xex_prepare_reset();
    prepare_state.status = render360::xex::kPrepareErrorFileRange;
    return prepare_state.status;
  }
  return render360::xex::BeginPrepareBasic(
      bytes, staged_header_length, file_length, &prepare_metadata, &prepare_state);
}

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_basic_accept_data(uint32_t chunk_length) {
  if (!chunk_length || chunk_length > r360_io_capacity()) {
    prepare_state.status = render360::xex::kPrepareErrorChunk;
    return prepare_state.status;
  }
  return render360::xex::AcceptPrepareBasicData(chunk_length, &prepare_state);
}

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_basic_consume_zero(uint32_t max_length) {
  if (!max_length) {
    prepare_state.status = render360::xex::kPrepareErrorChunk;
    return prepare_state.status;
  }
  return render360::xex::ConsumePrepareBasicZero(max_length, &prepare_state);
}

#define R360_XEX_PREP_GETTER(name, field) \
  __attribute__((visibility("default"))) uint32_t name() { return prepare_state.field; }
R360_XEX_PREP_GETTER(r360_xex_prepare_status, status)
R360_XEX_PREP_GETTER(r360_xex_prepare_source_offset, source_offset)
R360_XEX_PREP_GETTER(r360_xex_prepare_source_bytes, source_bytes)
R360_XEX_PREP_GETTER(r360_xex_prepare_output_bytes, output_bytes)
R360_XEX_PREP_GETTER(r360_xex_prepare_bytes_done, bytes_done)
R360_XEX_PREP_GETTER(r360_xex_prepare_output_done, output_done)
R360_XEX_PREP_GETTER(r360_xex_prepare_encryption_type, encryption_type)
R360_XEX_PREP_GETTER(r360_xex_prepare_compression_type, compression_type)
R360_XEX_PREP_GETTER(r360_xex_prepare_basic_block_count, basic_block_count)
R360_XEX_PREP_GETTER(r360_xex_prepare_basic_block_index, basic_block_index)
R360_XEX_PREP_GETTER(r360_xex_prepare_last_output_kind, last_output_kind)
R360_XEX_PREP_GETTER(r360_xex_prepare_last_output_bytes, last_output_bytes)
#undef R360_XEX_PREP_GETTER

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_basic_data_remaining() {
  return render360::xex::PrepareBasicDataRemaining(&prepare_state);
}

__attribute__((visibility("default")))
uint32_t r360_xex_prepare_basic_zero_remaining() {
  return render360::xex::PrepareBasicZeroRemaining(&prepare_state);
}

}  // extern "C"
