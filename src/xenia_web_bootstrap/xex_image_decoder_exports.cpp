#include <stdint.h>
#include <stddef.h>
#include "xex_image_decoder.h"

extern "C" uint32_t r360_io_ptr();
extern "C" uint32_t r360_io_capacity();

namespace {
render360::xex::ImageMetadata metadata;
}

extern "C" {

__attribute__((visibility("default")))
void r360_xex_image_decode_reset() {
  render360::xex::Reset(&metadata);
}

__attribute__((visibility("default")))
uint32_t r360_xex_image_decode(uint32_t length) {
  if (length > r360_io_capacity()) {
    render360::xex::Reset(&metadata);
    metadata.status = render360::xex::kDecodeErrorRange;
    return metadata.status;
  }
  const auto* bytes = reinterpret_cast<const uint8_t*>(
      static_cast<uintptr_t>(r360_io_ptr()));
  return render360::xex::Decode(bytes, length, &metadata);
}

#define R360_XEX_IMAGE_GETTER(name, field) \
  __attribute__((visibility("default"))) uint32_t name() { return metadata.field; }
R360_XEX_IMAGE_GETTER(r360_xex_image_status, status)
R360_XEX_IMAGE_GETTER(r360_xex_image_module_flags, module_flags)
R360_XEX_IMAGE_GETTER(r360_xex_image_header_size, header_size)
R360_XEX_IMAGE_GETTER(r360_xex_image_security_offset, security_offset)
R360_XEX_IMAGE_GETTER(r360_xex_image_header_count, header_count)
R360_XEX_IMAGE_GETTER(r360_xex_image_entry_point, entry_point)
R360_XEX_IMAGE_GETTER(r360_xex_image_base, image_base)
R360_XEX_IMAGE_GETTER(r360_xex_image_system_flags, system_flags)
R360_XEX_IMAGE_GETTER(r360_xex_image_execution_info_offset, execution_info_offset)
R360_XEX_IMAGE_GETTER(r360_xex_image_file_format_info_offset, file_format_info_offset)
R360_XEX_IMAGE_GETTER(r360_xex_image_import_libraries_offset, import_libraries_offset)
R360_XEX_IMAGE_GETTER(r360_xex_image_title_id, title_id)
R360_XEX_IMAGE_GETTER(r360_xex_image_media_id, media_id)
R360_XEX_IMAGE_GETTER(r360_xex_image_size, image_size)
R360_XEX_IMAGE_GETTER(r360_xex_image_flags, image_flags)
R360_XEX_IMAGE_GETTER(r360_xex_image_load_address, load_address)
R360_XEX_IMAGE_GETTER(r360_xex_image_region, region)
R360_XEX_IMAGE_GETTER(r360_xex_image_allowed_media_types, allowed_media_types)
R360_XEX_IMAGE_GETTER(r360_xex_image_encryption_type, encryption_type)
R360_XEX_IMAGE_GETTER(r360_xex_image_compression_type, compression_type)
R360_XEX_IMAGE_GETTER(r360_xex_image_page_size, page_size)
R360_XEX_IMAGE_GETTER(r360_xex_image_page_descriptor_count, page_descriptor_count)
R360_XEX_IMAGE_GETTER(r360_xex_image_mapped_span, mapped_span)
#undef R360_XEX_IMAGE_GETTER

__attribute__((visibility("default")))
uint32_t r360_xex_image_page_type(uint32_t index) {
  return index < metadata.page_descriptor_count
             ? metadata.page_descriptors[index].type
             : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_image_page_count(uint32_t index) {
  return index < metadata.page_descriptor_count
             ? metadata.page_descriptors[index].page_count
             : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_image_page_address(uint32_t index) {
  return index < metadata.page_descriptor_count
             ? metadata.page_descriptors[index].guest_address
             : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_image_page_bytes(uint32_t index) {
  return index < metadata.page_descriptor_count
             ? metadata.page_descriptors[index].byte_size
             : 0u;
}

}  // extern "C"
