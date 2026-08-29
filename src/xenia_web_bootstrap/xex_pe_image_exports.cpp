#include <stdint.h>
#include <stddef.h>
#include "xex_pe_image.h"

extern "C" uint32_t r360_io_ptr();
extern "C" uint32_t r360_io_capacity();

namespace {
render360::xex::PEImageMetadata metadata;
}

extern "C" {

__attribute__((visibility("default")))
void r360_xex_pe_reset() {
  render360::xex::ResetPE(&metadata);
}

__attribute__((visibility("default")))
uint32_t r360_xex_pe_decode(uint32_t length) {
  if (length > r360_io_capacity()) {
    render360::xex::ResetPE(&metadata);
    metadata.status = render360::xex::kPEErrorSectionRange;
    return metadata.status;
  }
  const auto* bytes = reinterpret_cast<const uint8_t*>(
      static_cast<uintptr_t>(r360_io_ptr()));
  return render360::xex::DecodePE(bytes, length, &metadata);
}

#define R360_PE_GETTER(name, field) \
  __attribute__((visibility("default"))) uint32_t name() { return metadata.field; }
R360_PE_GETTER(r360_xex_pe_status, status)
R360_PE_GETTER(r360_xex_pe_nt_offset, nt_offset)
R360_PE_GETTER(r360_xex_pe_machine, machine)
R360_PE_GETTER(r360_xex_pe_characteristics, characteristics)
R360_PE_GETTER(r360_xex_pe_section_count, section_count)
R360_PE_GETTER(r360_xex_pe_entry_rva, entry_rva)
R360_PE_GETTER(r360_xex_pe_image_base, image_base)
R360_PE_GETTER(r360_xex_pe_section_alignment, section_alignment)
R360_PE_GETTER(r360_xex_pe_file_alignment, file_alignment)
R360_PE_GETTER(r360_xex_pe_size_of_image, size_of_image)
R360_PE_GETTER(r360_xex_pe_size_of_headers, size_of_headers)
R360_PE_GETTER(r360_xex_pe_subsystem, subsystem)
#undef R360_PE_GETTER

__attribute__((visibility("default")))
uint32_t r360_xex_pe_section_virtual_address(uint32_t index) {
  return index < metadata.section_count ? metadata.sections[index].virtual_address : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_pe_section_virtual_size(uint32_t index) {
  return index < metadata.section_count ? metadata.sections[index].virtual_size : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_pe_section_raw_address(uint32_t index) {
  return index < metadata.section_count ? metadata.sections[index].raw_address : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_pe_section_raw_size(uint32_t index) {
  return index < metadata.section_count ? metadata.sections[index].raw_size : 0u;
}
__attribute__((visibility("default")))
uint32_t r360_xex_pe_section_characteristics(uint32_t index) {
  return index < metadata.section_count ? metadata.sections[index].characteristics : 0u;
}

}  // extern "C"
