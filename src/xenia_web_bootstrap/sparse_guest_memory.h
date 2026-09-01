#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_SPARSE_GUEST_MEMORY_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_SPARSE_GUEST_MEMORY_H_

#include <cstdint>

namespace render360::xenia_web {

enum SparseGuestProtection : uint32_t {
  kGuestRead = 1u,
  kGuestWrite = 2u,
  kGuestExecute = 4u,
};

void ResetSparseGuestMemory();
uint32_t AllocateSparseGuestBacking(uint32_t page_count);
bool MapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count,
                          uint32_t backing_id, uint32_t backing_page_offset,
                          uint32_t protection);
bool ProtectSparseGuestMemory(uint32_t virtual_address, uint32_t page_count,
                              uint32_t protection);
bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count);
bool ReadSparseGuestMemory(uint32_t virtual_address, void* out, uint32_t size);
bool WriteSparseGuestMemory(uint32_t virtual_address, const void* data,
                            uint32_t size);
// Returns the contiguous readable+executable byte span beginning at
// virtual_address, capped at max_size. This is a side-effect-free permission
// query used by the bounded PPC code pager; data-only pages must never be
// decoded as guest instructions.
uint32_t SparseGuestExecutableSpan(uint32_t virtual_address,
                                   uint32_t max_size);
uint32_t SparseGuestMappedPageCount();
uint32_t SparseGuestBackingPageCount();
uint32_t SparseGuestLastFaultAddress();
uint32_t SparseGuestLastFaultCode();

}  // namespace render360::xenia_web

extern "C" {
void r360_sparse_guest_memory_reset();
uint32_t r360_sparse_guest_memory_alloc(uint32_t page_count);
uint32_t r360_sparse_guest_memory_map(uint32_t virtual_address,
                                      uint32_t page_count,
                                      uint32_t backing_id,
                                      uint32_t backing_page_offset,
                                      uint32_t protection);
uint32_t r360_sparse_guest_memory_protect(uint32_t virtual_address,
                                          uint32_t page_count,
                                          uint32_t protection);
uint32_t r360_sparse_guest_memory_unmap(uint32_t virtual_address,
                                        uint32_t page_count);
uint32_t r360_sparse_guest_memory_read_u8(uint32_t virtual_address);
uint32_t r360_sparse_guest_memory_write_u8(uint32_t virtual_address,
                                           uint32_t value);
uint32_t r360_sparse_guest_memory_read_u32_be(uint32_t virtual_address,
                                              uint32_t* out_value);
uint32_t r360_sparse_guest_memory_write_u32_be(uint32_t virtual_address,
                                               uint32_t value);
uint32_t r360_sparse_guest_memory_mapped_pages();
uint32_t r360_sparse_guest_memory_backing_pages();
uint32_t r360_sparse_guest_memory_last_fault_address();
uint32_t r360_sparse_guest_memory_last_fault_code();
uint64_t r360_generated_guest_load_scalar(uint32_t virtual_address,
                                           uint32_t size, uint32_t flags);
uint32_t r360_generated_guest_load_status();
}

#endif
