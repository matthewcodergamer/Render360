#include "wasm_backend_call_probe.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "xenia/cpu/function.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"

namespace render360::xenia_web {
namespace {
using xe::cpu::hir::HIRBuilder;
using xe::cpu::hir::Instr;
using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
using xe::cpu::ppc::PPCContext;
using Producers = std::unordered_map<const Value*, const Instr*>;

constexpr uint32_t kExecutablePageShift = 12;
constexpr uint32_t kExecutablePageSize = 1u << kExecutablePageShift;
constexpr uint32_t kProbeExecutableBase = 0x80000000u;
constexpr uint32_t kProbeExecutableSize = 64u * 1024u;
constexpr uint32_t kProbeExecutablePageCount =
    kProbeExecutableSize / kExecutablePageSize;

struct CallModule {
  uint32_t address = 0;
  uint32_t generation = 1;
  uint32_t lowered = 0;
  std::vector<uint8_t> bytes;
};

uint32_t g_status = 0;
std::vector<CallModule> g_modules;
std::array<uint32_t, kProbeExecutablePageCount> g_page_generations = {};
alignas(64) uint8_t g_context[sizeof(PPCContext)] = {};
uint32_t g_cache_hits = 0;
uint32_t g_cache_misses = 0;
uint32_t g_cache_rebuilds = 0;
uint32_t g_invalidations = 0;

uint32_t PageIndex(uint32_t address) { return address >> kExecutablePageShift; }
bool TrackedPageSlot(uint32_t address, uint32_t* slot) {
  if (address < kProbeExecutableBase ||
      uint64_t(address) >= uint64_t(kProbeExecutableBase) + kProbeExecutableSize) {
    return false;
  }
  if (slot) *slot = (address - kProbeExecutableBase) >> kExecutablePageShift;
  return true;
}
uint32_t PageGeneration(uint32_t address) {
  uint32_t slot = 0;
  if (!TrackedPageSlot(address, &slot)) return 1u;
  const uint32_t generation = g_page_generations[slot];
  return generation ? generation : 1u;
}
void BumpPageGenerationForAddress(uint32_t address) {
  uint32_t slot = 0;
  if (!TrackedPageSlot(address, &slot)) return;
  uint32_t& generation = g_page_generations[slot];
  if (!generation) generation = 1;
  ++generation;
  if (!generation) generation = 1;
}

void EmitU32Leb(std::vector<uint8_t>& out, uint32_t value) {
  do {
    uint8_t byte = static_cast<uint8_t>(value & 0x7Fu);
    value >>= 7;
    if (value) byte |= 0x80u;
    out.push_back(byte);
  } while (value);
}
void EmitI32Leb(std::vector<uint8_t>& out, int32_t value) {
  bool more = true;
  while (more) {
    uint8_t byte = static_cast<uint8_t>(value & 0x7F);
    const bool sign = (byte & 0x40u) != 0;
    value >>= 7;
    more = !((value == 0 && !sign) || (value == -1 && sign));
    if (more) byte |= 0x80u;
    out.push_back(byte);
  }
}
void EmitI64Leb(std::vector<uint8_t>& out, int64_t value) {
  bool more = true;
  while (more) {
    uint8_t byte = static_cast<uint8_t>(value & 0x7F);
    const bool sign = (byte & 0x40u) != 0;
    value >>= 7;
    more = !((value == 0 && !sign) || (value == -1 && sign));
    if (more) byte |= 0x80u;
    out.push_back(byte);
  }
}
void EmitI64Mask(std::vector<uint8_t>& out, TypeName type) {
  uint64_t mask = 0;
  switch (type) {
    case xe::cpu::hir::INT8_TYPE: mask = 0xFFu; break;
    case xe::cpu::hir::INT16_TYPE: mask = 0xFFFFu; break;
    case xe::cpu::hir::INT32_TYPE: mask = 0xFFFFFFFFu; break;
    case xe::cpu::hir::INT64_TYPE: return;
    default: return;
  }
  out.push_back(0x42);
  EmitI64Leb(out, static_cast<int64_t>(mask));
  out.push_back(0x83);
}

uint32_t ScalarTypeSize(TypeName type) {
  switch (type) {
    case xe::cpu::hir::INT8_TYPE: return 1u;
    case xe::cpu::hir::INT16_TYPE: return 2u;
    case xe::cpu::hir::INT32_TYPE: return 4u;
    case xe::cpu::hir::INT64_TYPE: return 8u;
    default: return 0u;
  }
}

void EmitName(std::vector<uint8_t>& out, const char* name) {
  const auto n = static_cast<uint32_t>(std::strlen(name));
  EmitU32Leb(out, n);
  out.insert(out.end(), name, name + n);
}
void EmitSection(std::vector<uint8_t>& module, uint8_t id,
                 const std::vector<uint8_t>& payload) {
  module.push_back(id);
  EmitU32Leb(module, static_cast<uint32_t>(payload.size()));
  module.insert(module.end(), payload.begin(), payload.end());
}

bool EmitI64Value(const Value* value, const Producers& producers,
                  std::unordered_set<const Value*>& visiting,
                  std::vector<uint8_t>& body, uint32_t* lowered) {
  if (!value) return false;
  if (value->IsConstant()) {
    switch (value->type) {
      case xe::cpu::hir::INT8_TYPE:
      case xe::cpu::hir::INT16_TYPE:
      case xe::cpu::hir::INT32_TYPE:
      case xe::cpu::hir::INT64_TYPE:
        body.push_back(0x42);
        EmitI64Leb(body, value->constant.i64);
        return true;
      default:
        return false;
    }
  }
  if (!visiting.insert(value).second) return false;
  auto it = producers.find(value);
  if (it == producers.end() || !it->second || !it->second->opcode) {
    visiting.erase(value);
    return false;
  }
  const Instr* instr = it->second;
  bool ok = false;
  switch (instr->opcode->num) {
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT: {
      body.push_back(0x20);
      body.push_back(0x00);
      switch (value->type) {
        case xe::cpu::hir::INT8_TYPE:
          body.push_back(0x2D); body.push_back(0x00);
          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
          body.push_back(0xAD);
          break;
        case xe::cpu::hir::INT16_TYPE:
          body.push_back(0x2F); body.push_back(0x01);
          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
          body.push_back(0xAD);
          break;
        case xe::cpu::hir::INT32_TYPE:
          body.push_back(0x28); body.push_back(0x02);
          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
          body.push_back(0xAD);
          break;
        case xe::cpu::hir::INT64_TYPE:
          body.push_back(0x29); body.push_back(0x03);
          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
          break;
        default:
          break;
      }
      ok = ScalarTypeSize(value->type) != 0;
      break;
    }
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_CAST:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
      ok = EmitI64Value(instr->src1.value, producers, visiting, body, lowered);
      if (ok) EmitI64Mask(body, value->type);
      break;
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
      ok = EmitI64Value(instr->src1.value, producers, visiting, body, lowered);
      if (ok) {
        switch (instr->src1.value->type) {
          case xe::cpu::hir::INT8_TYPE: body.push_back(0xC2); break;
          case xe::cpu::hir::INT16_TYPE: body.push_back(0xC3); break;
          case xe::cpu::hir::INT32_TYPE: body.push_back(0xC4); break;
          case xe::cpu::hir::INT64_TYPE: break;
          default: ok = false; break;
        }
      }
      break;
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET: {
      const uint32_t size = ScalarTypeSize(value->type);
      if (!size || (instr->flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP)) break;
      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered))
        break;
      if (instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET) {
        if (!EmitI64Value(instr->src2.value, producers, visiting, body, lowered))
          break;
        body.push_back(0x7C);
      }
      body.push_back(0xA7);
      body.push_back(0x41); EmitI32Leb(body, static_cast<int32_t>(size));
      body.push_back(0x41); EmitI32Leb(body, static_cast<int32_t>(instr->flags));
      body.push_back(0x10); EmitU32Leb(body, 1);
      EmitI64Mask(body, value->type);
      ok = true;
      break;
    }
    case xe::cpu::hir::OPCODE_BYTE_SWAP: {
      const uint32_t size = ScalarTypeSize(value->type);
      if (!size || !instr->src1.value) break;
      // Xenia materializes PPC big-endian scalar loads as LOAD_OFFSET followed
      // by BYTE_SWAP. Keep this in the same callable generated-WASM tier so a
      // loaded function pointer can flow directly into mtctr / CALL_INDIRECT.
      // This is fail-closed to integer scalar values admitted by ScalarTypeSize.
      for (uint32_t byte = 0; byte < size; ++byte) {
        if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered)) {
          ok = false;
          break;
        }
        if (byte) {
          body.push_back(0x42);
          EmitI64Leb(body, static_cast<int64_t>(byte * 8u));
          body.push_back(0x88);  // i64.shr_u
        }
        body.push_back(0x42);
        EmitI64Leb(body, 0xFF);
        body.push_back(0x83);  // i64.and
        const uint32_t target_byte = size - 1u - byte;
        if (target_byte) {
          body.push_back(0x42);
          EmitI64Leb(body, static_cast<int64_t>(target_byte * 8u));
          body.push_back(0x86);  // i64.shl
        }
        if (byte) body.push_back(0x84);  // i64.or
        ok = true;
      }
      if (ok) EmitI64Mask(body, value->type);
      break;
    }
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered) ||
          !EmitI64Value(instr->src2.value, producers, visiting, body, lowered)) {
        break;
      }
      body.push_back(instr->opcode->num == xe::cpu::hir::OPCODE_ADD ? 0x7C :
                     instr->opcode->num == xe::cpu::hir::OPCODE_SUB ? 0x7D :
                     instr->opcode->num == xe::cpu::hir::OPCODE_AND ? 0x83 :
                     instr->opcode->num == xe::cpu::hir::OPCODE_OR ? 0x84 : 0x85);
      ok = true;
      if (ok) EmitI64Mask(body, value->type);
      break;
    default:
      break;
  }
  if (ok && lowered) ++*lowered;
  visiting.erase(value);
  return ok;
}

bool EmitStoreContext(const Instr* instr, const Producers& producers,
                      std::vector<uint8_t>& body, uint32_t* lowered) {
  if (!instr->src2.value || instr->src2.value->type != xe::cpu::hir::INT64_TYPE)
    return false;
  std::unordered_set<const Value*> visiting;
  body.push_back(0x20);
  body.push_back(0x00);
  if (!EmitI64Value(instr->src2.value, producers, visiting, body, lowered))
    return false;
  body.push_back(0x37);
  body.push_back(0x03);
  EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
  if (lowered) ++*lowered;
  return true;
}

bool BuildModule(uint32_t address, uint32_t generation, HIRBuilder* builder,
                 CallModule* out) {
  Producers producers;
  for (auto* block = builder->first_block(); block; block = block->next) {
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      if (instr->dest) producers[instr->dest] = instr;
    }
  }

  std::vector<uint8_t> body;
  uint32_t lowered = 0;
  bool saw_return = false;
  for (auto* block = builder->first_block(); block && !saw_return;
       block = block->next) {
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      if (!instr->opcode) return false;
      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:
          break;
        case xe::cpu::hir::OPCODE_STORE_CONTEXT:
          if (!EmitStoreContext(instr, producers, body, &lowered)) return false;
          break;
        case xe::cpu::hir::OPCODE_CALL: {
          if (!instr->src1.symbol) return false;
          body.push_back(0x41);
          EmitI32Leb(body, static_cast<int32_t>(instr->src1.symbol->address()));
          body.push_back(0x20);
          body.push_back(0x00);
          body.push_back(0x10);
          EmitU32Leb(body, 0);
          body.push_back(0x1A);
          ++lowered;
          break;
        }
        case xe::cpu::hir::OPCODE_CALL_INDIRECT: {
          if (instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) {
            body.push_back(0x20);
            body.push_back(0x00);
            body.push_back(0x29);
            body.push_back(0x03);
            EmitU32Leb(body, static_cast<uint32_t>(
                                 offsetof(PPCContext, r) + 3 * sizeof(uint64_t)));
            body.push_back(0x0F);
            saw_return = true;
            ++lowered;
            break;
          }
          std::unordered_set<const Value*> visiting;
          if (!EmitI64Value(instr->src1.value, producers, visiting, body, &lowered))
            return false;
          body.push_back(0xA7);
          body.push_back(0x20);
          body.push_back(0x00);
          body.push_back(0x10);
          EmitU32Leb(body, 0);
          body.push_back(0x1A);
          ++lowered;
          break;
        }
        default:
          if (instr->dest &&
              (instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_CONTEXT ||
               instr->opcode->num == xe::cpu::hir::OPCODE_ASSIGN ||
               instr->opcode->num == xe::cpu::hir::OPCODE_CAST ||
               instr->opcode->num == xe::cpu::hir::OPCODE_ZERO_EXTEND ||
               instr->opcode->num == xe::cpu::hir::OPCODE_SIGN_EXTEND ||
               instr->opcode->num == xe::cpu::hir::OPCODE_TRUNCATE ||
               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD ||
               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ||
               instr->opcode->num == xe::cpu::hir::OPCODE_BYTE_SWAP ||
               instr->opcode->num == xe::cpu::hir::OPCODE_ADD ||
               instr->opcode->num == xe::cpu::hir::OPCODE_SUB ||
               instr->opcode->num == xe::cpu::hir::OPCODE_AND ||
               instr->opcode->num == xe::cpu::hir::OPCODE_OR ||
               instr->opcode->num == xe::cpu::hir::OPCODE_XOR)) {
            break;
          }
          return false;
      }
      if (saw_return) break;
    }
  }
  if (!saw_return) return false;
  body.push_back(0x0B);

  std::vector<uint8_t> module = {0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00};
  std::vector<uint8_t> types;
  EmitU32Leb(types, 3);
  types.push_back(0x60);
  EmitU32Leb(types, 2);
  types.push_back(0x7F);
  types.push_back(0x7F);
  EmitU32Leb(types, 1);
  types.push_back(0x7F);
  types.push_back(0x60);
  EmitU32Leb(types, 1);
  types.push_back(0x7F);
  EmitU32Leb(types, 1);
  types.push_back(0x7E);
  types.push_back(0x60);
  EmitU32Leb(types, 3);
  types.push_back(0x7F); types.push_back(0x7F); types.push_back(0x7F);
  EmitU32Leb(types, 1);
  types.push_back(0x7E);
  EmitSection(module, 1, types);
  std::vector<uint8_t> imports;
  EmitU32Leb(imports, 3);
  EmitName(imports, "env");
  EmitName(imports, "guest_call");
  imports.push_back(0x00);
  EmitU32Leb(imports, 0);
  EmitName(imports, "env");
  EmitName(imports, "guest_load");
  imports.push_back(0x00);
  EmitU32Leb(imports, 2);
  EmitName(imports, "env");
  EmitName(imports, "memory");
  imports.push_back(0x02);
  imports.push_back(0x00);
  EmitU32Leb(imports, 0);
  EmitSection(module, 2, imports);
  std::vector<uint8_t> funcs;
  EmitU32Leb(funcs, 1);
  EmitU32Leb(funcs, 1);
  EmitSection(module, 3, funcs);
  std::vector<uint8_t> exports;
  EmitU32Leb(exports, 1);
  EmitName(exports, "run");
  exports.push_back(0x00);
  EmitU32Leb(exports, 2);
  EmitSection(module, 7, exports);
  std::vector<uint8_t> fn;
  EmitU32Leb(fn, 0);
  fn.insert(fn.end(), body.begin(), body.end());
  std::vector<uint8_t> code;
  EmitU32Leb(code, 1);
  EmitU32Leb(code, static_cast<uint32_t>(fn.size()));
  code.insert(code.end(), fn.begin(), fn.end());
  EmitSection(module, 10, code);

  out->address = address;
  out->generation = generation;
  out->lowered = lowered;
  out->bytes = std::move(module);
  return true;
}
}  // namespace

void ResetWasmBackendCallProbe() {
  g_status = 0;
  g_modules.clear();
  g_page_generations.fill(0);
  g_cache_hits = g_cache_misses = g_cache_rebuilds = g_invalidations = 0;
  std::memset(g_context, 0, sizeof(g_context));
}

bool RegisterWasmBackendCallFunction(xe::cpu::GuestFunction* function,
                                     HIRBuilder* builder) {
  if (!function || !builder) {
    g_status = 1;
    return false;
  }
  const uint32_t address = function->address();
  const uint32_t generation = PageGeneration(address);
  for (auto& existing : g_modules) {
    if (existing.address != address) continue;
    if (existing.generation == generation) {
      ++g_cache_hits;
      g_status = 2;
      return true;
    }
    CallModule rebuilt;
    if (!BuildModule(address, generation, builder, &rebuilt)) {
      g_status = 1;
      return false;
    }
    existing = std::move(rebuilt);
    ++g_cache_rebuilds;
    g_status = 2;
    return true;
  }
  CallModule module;
  if (!BuildModule(address, generation, builder, &module)) {
    if (g_modules.empty()) g_status = 1;
    return false;
  }
  g_modules.push_back(std::move(module));
  ++g_cache_misses;
  g_status = 2;
  return true;
}

void InvalidateWasmBackendExecutableRange(uint32_t address, uint32_t size) {
  if (!size) return;
  const uint64_t end64 = uint64_t(address) + uint64_t(size) - 1u;
  const uint32_t end_address =
      end64 > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(end64);
  const uint32_t first_page = PageIndex(address);
  const uint32_t last_page = PageIndex(end_address);
  for (uint32_t page = first_page;; ++page) {
    BumpPageGenerationForAddress(page << kExecutablePageShift);
    if (page == last_page) break;
  }
  const size_t old_size = g_modules.size();
  g_modules.erase(
      std::remove_if(g_modules.begin(), g_modules.end(),
                     [first_page, last_page](const CallModule& module) {
                       const uint32_t page = PageIndex(module.address);
                       return page >= first_page && page <= last_page;
                     }),
      g_modules.end());
  ++g_invalidations;
  if (old_size != g_modules.size()) g_status = g_modules.empty() ? 0u : 2u;
}

uint32_t GetWasmBackendExecutablePageGeneration(uint32_t address) {
  return PageGeneration(address);
}
uint32_t GetWasmBackendCallStatus() { return g_status; }
uint32_t GetWasmBackendCallFunctionCount() {
  return static_cast<uint32_t>(g_modules.size());
}
uint32_t GetWasmBackendCallFunctionAddress(uint32_t i) {
  return i < g_modules.size() ? g_modules[i].address : 0;
}
uint32_t GetWasmBackendCallFunctionGeneration(uint32_t i) {
  return i < g_modules.size() ? g_modules[i].generation : 0;
}
uint8_t* GetWasmBackendCallFunctionModuleData(uint32_t i) {
  return i < g_modules.size() && !g_modules[i].bytes.empty()
             ? g_modules[i].bytes.data()
             : nullptr;
}
uint32_t GetWasmBackendCallFunctionModuleSize(uint32_t i) {
  return i < g_modules.size() ? static_cast<uint32_t>(g_modules[i].bytes.size()) : 0;
}
uint32_t GetWasmBackendCallFunctionLowered(uint32_t i) {
  return i < g_modules.size() ? g_modules[i].lowered : 0;
}
uint8_t* GetWasmBackendCallContextData() { return g_context; }
uint32_t GetWasmBackendCallCacheHits() { return g_cache_hits; }
uint32_t GetWasmBackendCallCacheMisses() { return g_cache_misses; }
uint32_t GetWasmBackendCallCacheRebuilds() { return g_cache_rebuilds; }
uint32_t GetWasmBackendCallInvalidations() { return g_invalidations; }
}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_call_status() {
  return render360::xenia_web::GetWasmBackendCallStatus();
}
uint32_t r360_wasm_backend_call_function_count() {
  return render360::xenia_web::GetWasmBackendCallFunctionCount();
}
uint32_t r360_wasm_backend_call_function_address(uint32_t i) {
  return render360::xenia_web::GetWasmBackendCallFunctionAddress(i);
}
uint32_t r360_wasm_backend_call_function_generation(uint32_t i) {
  return render360::xenia_web::GetWasmBackendCallFunctionGeneration(i);
}
uint32_t r360_wasm_backend_call_module_ptr(uint32_t i) {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
      render360::xenia_web::GetWasmBackendCallFunctionModuleData(i)));
}
uint32_t r360_wasm_backend_call_module_size(uint32_t i) {
  return render360::xenia_web::GetWasmBackendCallFunctionModuleSize(i);
}
uint32_t r360_wasm_backend_call_lowered_instructions(uint32_t i) {
  return render360::xenia_web::GetWasmBackendCallFunctionLowered(i);
}
uint32_t r360_wasm_backend_call_context_ptr() {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
      render360::xenia_web::GetWasmBackendCallContextData()));
}
uint32_t r360_wasm_backend_call_cache_hits() {
  return render360::xenia_web::GetWasmBackendCallCacheHits();
}
uint32_t r360_wasm_backend_call_cache_misses() {
  return render360::xenia_web::GetWasmBackendCallCacheMisses();
}
uint32_t r360_wasm_backend_call_cache_rebuilds() {
  return render360::xenia_web::GetWasmBackendCallCacheRebuilds();
}
uint32_t r360_wasm_backend_call_invalidations() {
  return render360::xenia_web::GetWasmBackendCallInvalidations();
}
uint32_t r360_wasm_backend_executable_page_generation(uint32_t address) {
  return render360::xenia_web::GetWasmBackendExecutablePageGeneration(address);
}
void r360_wasm_backend_invalidate_executable_range(uint32_t address,
                                                   uint32_t size) {
  render360::xenia_web::InvalidateWasmBackendExecutableRange(address, size);
}
}
