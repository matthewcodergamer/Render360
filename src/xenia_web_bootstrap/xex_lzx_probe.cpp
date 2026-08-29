#include <cstdint>
#include <cstring>

#include "xenia/cpu/lzx.h"

namespace {
constexpr uint32_t kInputCapacity = 64 * 1024;
constexpr uint32_t kOutputCapacity = 256 * 1024;
alignas(16) uint8_t input_buffer[kInputCapacity] = {};
alignas(16) uint8_t output_buffer[kOutputCapacity] = {};
uint32_t last_status = 0xFFFFFFFFu;
uint32_t last_output_size = 0;
}

extern "C" {

__attribute__((used, visibility("default"))) uint8_t* r360_lzx_input_buffer() {
  return input_buffer;
}
__attribute__((used, visibility("default"))) uint32_t r360_lzx_input_capacity() {
  return kInputCapacity;
}
__attribute__((used, visibility("default"))) uint8_t* r360_lzx_output_buffer() {
  return output_buffer;
}
__attribute__((used, visibility("default"))) uint32_t r360_lzx_output_capacity() {
  return kOutputCapacity;
}
__attribute__((used, visibility("default"))) uint32_t r360_lzx_status() {
  return last_status;
}
__attribute__((used, visibility("default"))) uint32_t r360_lzx_output_size() {
  return last_output_size;
}

__attribute__((used, visibility("default"))) void r360_lzx_reset() {
  std::memset(input_buffer, 0, sizeof(input_buffer));
  std::memset(output_buffer, 0, sizeof(output_buffer));
  last_status = 0xFFFFFFFFu;
  last_output_size = 0;
}

__attribute__((used, visibility("default"))) uint32_t r360_lzx_decompress(
    uint32_t input_size, uint32_t output_size, uint32_t window_size) {
  if (!input_size || input_size > kInputCapacity || !output_size ||
      output_size > kOutputCapacity) {
    last_status = 0xFFFFFFFEu;
    last_output_size = 0;
    return last_status;
  }
  // Xenia's lzx_decompress validates the LZX window and delegates to its
  // vendored libmspack decoder. Keep this probe intentionally thin so CI is
  // exercising upstream semantics rather than a Render360 replacement.
  std::memset(output_buffer, 0xCD, output_size);
  const int result = lzx_decompress(input_buffer, input_size, output_buffer,
                                    output_size, window_size, nullptr, 0);
  last_status = static_cast<uint32_t>(result);
  last_output_size = result == 0 ? output_size : 0;
  return last_status;
}

}  // extern "C"
