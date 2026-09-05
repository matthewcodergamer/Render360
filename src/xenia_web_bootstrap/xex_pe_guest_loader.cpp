#include "xex_pe_guest_loader.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <vector>

#include "sparse_guest_memory.h"
#include "xex_guest_mapper.h"
#include "xex_pe_image.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kPeMemExecute = 0x20000000u;
constexpr uint32_t kPeMemRead = 0x40000000u;
constexpr uint32_t kPeMemWrite = 0x80000000u;
constexpr uint32_t kGuestPageSize = 4096u;
constexpr uint32_t kGuestPageMask = kGuestPageSize - 1u;

uint32_t g_status = kPeGuestIdle;
uint32_t g_entry = 0;
uint32_t g_pe_entry = 0;
uint32_t g_sections = 0;
uint32_t g_raw_bytes = 0;

struct PeRuntimeFunction { uint32_t begin=0,end=0,prolog_bytes=0; };
std::vector<PeRuntimeFunction> g_runtime_functions;
uint32_t ReadBe32(const uint8_t* p){return (uint32_t(p[0])<<24)|(uint32_t(p[1])<<16)|(uint32_t(p[2])<<8)|p[3];}
bool ExecutableAddress(const render360::xex::PEImageMetadata& m,uint32_t a){
  for(uint32_t i=0;i<m.section_count;++i){const auto& q=m.sections[i];if(!(q.characteristics&kPeMemExecute))continue;const uint32_t n=q.virtual_size>q.raw_size?q.virtual_size:q.raw_size;const uint64_t b=uint64_t(m.image_base)+q.virtual_address,e=b+n;if(uint64_t(a)>=b&&uint64_t(a)<e)return true;}return false;
}
void ParseRuntimeFunctions(const uint8_t* image,uint32_t length,const render360::xex::PEImageMetadata& m){
  g_runtime_functions.clear();
  for(uint32_t i=0;i<m.section_count;++i){const auto& q=m.sections[i];if(std::strncmp(q.name,".pdata",8)!=0)continue;if(uint64_t(q.raw_address)+q.raw_size>length)break;
    for(uint32_t o=0;o+8<=q.raw_size;o+=8){const uint8_t* p=image+q.raw_address+o;uint32_t begin=ReadBe32(p),data=ReadBe32(p+4);const uint32_t prolog=data&0xFFu,count=(data>>8)&0x003FFFFFu,insn=4u;if(!begin||!count)continue;
      if(!ExecutableAddress(m,begin)){const uint64_t rebased=uint64_t(m.image_base)+begin;if(rebased>UINT32_MAX||!ExecutableAddress(m,uint32_t(rebased)))continue;begin=uint32_t(rebased);}const uint64_t bytes=uint64_t(count)*insn,end=uint64_t(begin)+bytes;if(!bytes||end>UINT32_MAX||!ExecutableAddress(m,uint32_t(end-1)))continue;g_runtime_functions.push_back({begin,uint32_t(end),uint32_t(uint64_t(prolog)*insn)});
    }break;
  }
  std::sort(g_runtime_functions.begin(),g_runtime_functions.end(),[](const auto&a,const auto&b){return a.begin<b.begin;});
}
const PeRuntimeFunction* FindRuntimeFunction(uint32_t a){if(g_runtime_functions.empty())return nullptr;auto it=std::upper_bound(g_runtime_functions.begin(),g_runtime_functions.end(),a,[](uint32_t v,const auto&f){return v<f.begin;});if(it==g_runtime_functions.begin())return nullptr;--it;return a>=it->begin&&a<it->end?&*it:nullptr;}

bool Fail(uint32_t status) {
  g_status = status;
  return false;
}

bool Add32(uint32_t a, uint32_t b, uint32_t* out) {
  const uint64_t value = uint64_t(a) + uint64_t(b);
  if (value > UINT32_MAX) return false;
  *out = static_cast<uint32_t>(value);
  return true;
}

uint32_t ProtectionFromCharacteristics(uint32_t characteristics) {
  uint32_t protection = 0;
  if (characteristics & kPeMemRead) protection |= kGuestRead;
  if (characteristics & kPeMemWrite) protection |= kGuestWrite;
  if (characteristics & kPeMemExecute) protection |= kGuestExecute;
  return protection;
}

bool AddPagesForSpan(std::map<uint32_t, uint32_t>* pages, uint32_t address,
                     uint32_t size, uint32_t protection) {
  if (!pages || !size || !protection) return false;
  const uint64_t end = uint64_t(address) + uint64_t(size);
  if (end > (uint64_t{1} << 32)) return false;

  const uint64_t first_page = uint64_t(address & ~kGuestPageMask);
  const uint64_t last_page = (end - 1u) & ~uint64_t(kGuestPageMask);
  for (uint64_t page = first_page; page <= last_page; page += kGuestPageSize) {
    (*pages)[static_cast<uint32_t>(page)] |= protection;
  }
  return true;
}

bool MapPreparedPePages(const std::map<uint32_t, uint32_t>& pages) {
  if (pages.empty()) return false;

  auto it = pages.begin();
  uint32_t range_start = it->first;
  uint32_t range_protection = it->second;
  uint64_t range_end = uint64_t(it->first) + kGuestPageSize;
  ++it;

  auto flush = [&]() -> bool {
    const uint64_t size = range_end - uint64_t(range_start);
    if (!size || size > UINT32_MAX) return false;
    return MapXexGuestSection(range_start, static_cast<uint32_t>(size),
                              range_protection);
  };

  for (; it != pages.end(); ++it) {
    const uint32_t page = it->first;
    const uint32_t protection = it->second;
    if (uint64_t(page) == range_end && protection == range_protection) {
      range_end += kGuestPageSize;
      continue;
    }
    if (!flush()) return false;
    range_start = page;
    range_protection = protection;
    range_end = uint64_t(page) + kGuestPageSize;
  }
  return flush();
}

}  // namespace

void ResetPreparedPeGuestLoad() {
  g_status = kPeGuestIdle;
  g_entry = 0;
  g_pe_entry = 0;
  g_sections = 0;
  g_raw_bytes = 0;
  g_runtime_functions.clear();
  ResetXexGuestMapper();
}

bool LoadPreparedPeImageToGuestAtEntry(const uint8_t* image, uint32_t length,
                                       uint32_t entry_override) {
  ResetPreparedPeGuestLoad();
  if (!image || !length) return Fail(kPeGuestInvalidArgument);

  render360::xex::PEImageMetadata metadata{};
  if (render360::xex::DecodePE(image, length, &metadata) !=
      render360::xex::kPEPass) {
    return Fail(kPeGuestDecodeFailed);
  }
  ParseRuntimeFunctions(image, length, metadata);

  // Build a page-level mapping plan before touching guest memory. PE section
  // alignment is not guaranteed to equal our 4 KiB sparse-memory page size.
  // Real titles may place multiple sections in one guest page. Mapping each PE
  // section independently would then either reject an unaligned address or try
  // to map the same page twice. Merge every section onto guest pages first and
  // union permissions only on pages that are genuinely shared.
  std::map<uint32_t, uint32_t> page_protections;
  for (uint32_t i = 0; i < metadata.section_count; ++i) {
    const auto& section = metadata.sections[i];
    const uint32_t virtual_span =
        section.virtual_size > section.raw_size ? section.virtual_size
                                                : section.raw_size;
    if (!virtual_span) continue;

    uint32_t guest_address = 0;
    if (!Add32(metadata.image_base, section.virtual_address, &guest_address)) {
      return Fail(kPeGuestAddressOverflow);
    }

    const uint32_t protection =
        ProtectionFromCharacteristics(section.characteristics);
    // The strict guest mapper requires readable final mappings. Xbox PE
    // executable/data sections used by titles should describe read access
    // explicitly; do not silently widen malformed section permissions.
    if (!(protection & kGuestRead)) return Fail(kPeGuestProtectionInvalid);
    if (!AddPagesForSpan(&page_protections, guest_address, virtual_span,
                         protection)) {
      return Fail(kPeGuestAddressOverflow);
    }
  }

  if (!MapPreparedPePages(page_protections)) return Fail(kPeGuestMapFailed);

  // Copy the original section bytes only after all required pages are mapped.
  // LoadXexGuestSectionData accepts spans covered by multiple adjacent mapping
  // ranges, so a single PE section may cross page-protection boundaries safely.
  for (uint32_t i = 0; i < metadata.section_count; ++i) {
    const auto& section = metadata.sections[i];
    const uint32_t virtual_span =
        section.virtual_size > section.raw_size ? section.virtual_size
                                                : section.raw_size;
    if (!virtual_span) continue;

    uint32_t guest_address = 0;
    if (!Add32(metadata.image_base, section.virtual_address, &guest_address)) {
      return Fail(kPeGuestAddressOverflow);
    }
    if (section.raw_size) {
      if (!LoadXexGuestSectionData(guest_address, image + section.raw_address,
                                   section.raw_size)) {
        return Fail(kPeGuestLoadFailed);
      }
      const uint64_t total = uint64_t(g_raw_bytes) + section.raw_size;
      g_raw_bytes = total > UINT32_MAX ? UINT32_MAX
                                      : static_cast<uint32_t>(total);
    }
    ++g_sections;
  }

  uint32_t pe_entry = 0;
  if (!Add32(metadata.image_base, metadata.entry_rva, &pe_entry)) {
    return Fail(kPeGuestAddressOverflow);
  }
  g_pe_entry = pe_entry;
  const uint32_t entry = entry_override ? entry_override : pe_entry;
  if (!SetXexGuestEntry(entry)) return Fail(kPeGuestEntryFailed);
  if (!FinalizeXexGuestMapping()) return Fail(kPeGuestFinalizeFailed);

  g_entry = entry;
  g_status = kPeGuestPass;
  return true;
}

bool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length) {
  return LoadPreparedPeImageToGuestAtEntry(image, length, 0);
}

uint32_t PreparedPeGuestLoadStatus() { return g_status; }
uint32_t PreparedPeGuestEntryAddress() { return g_entry; }
uint32_t PreparedPeGuestPeEntryAddress() { return g_pe_entry; }
uint32_t PreparedPeGuestSectionCount() { return g_sections; }
uint32_t PreparedPeGuestRawBytes() { return g_raw_bytes; }
bool PreparedPeGuestFindRuntimeFunction(uint32_t address,uint32_t* begin,uint32_t* end_exclusive,uint32_t* prolog_bytes){const auto* f=FindRuntimeFunction(address);if(!f)return false;if(begin)*begin=f->begin;if(end_exclusive)*end_exclusive=f->end;if(prolog_bytes)*prolog_bytes=f->prolog_bytes;return true;}

}  // namespace render360::xenia_web

extern "C" {
void r360_pe_guest_reset() { render360::xenia_web::ResetPreparedPeGuestLoad(); }
uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length) {
  const auto* source =
      reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(source_ptr));
  return render360::xenia_web::LoadPreparedPeImageToGuest(source, length) ? 1u
                                                                         : 0u;
}
uint32_t r360_pe_guest_load_at_entry(uint32_t source_ptr, uint32_t length,
                                      uint32_t entry_address) {
  const auto* source =
      reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(source_ptr));
  return render360::xenia_web::LoadPreparedPeImageToGuestAtEntry(
             source, length, entry_address)
             ? 1u
             : 0u;
}
uint32_t r360_pe_guest_status() {
  return render360::xenia_web::PreparedPeGuestLoadStatus();
}
uint32_t r360_pe_guest_entry_address() {
  return render360::xenia_web::PreparedPeGuestEntryAddress();
}
uint32_t r360_pe_guest_pe_entry_address() {
  return render360::xenia_web::PreparedPeGuestPeEntryAddress();
}
uint32_t r360_pe_guest_section_count() {
  return render360::xenia_web::PreparedPeGuestSectionCount();
}
uint32_t r360_pe_guest_raw_bytes() {
  return render360::xenia_web::PreparedPeGuestRawBytes();
}
uint32_t r360_pe_guest_runtime_function_begin(uint32_t address) {
  uint32_t begin = 0;
  return render360::xenia_web::PreparedPeGuestFindRuntimeFunction(
             address, &begin, nullptr, nullptr)
             ? begin
             : 0u;
}
uint32_t r360_pe_guest_runtime_function_end(uint32_t address) {
  uint32_t end = 0;
  return render360::xenia_web::PreparedPeGuestFindRuntimeFunction(
             address, nullptr, &end, nullptr)
             ? end
             : 0u;
}
uint32_t r360_pe_guest_runtime_function_prolog_bytes(uint32_t address) {
  uint32_t prolog = 0;
  return render360::xenia_web::PreparedPeGuestFindRuntimeFunction(
             address, nullptr, nullptr, &prolog)
             ? prolog
             : 0u;
}
}
