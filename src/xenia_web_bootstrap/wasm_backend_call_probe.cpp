#include "wasm_backend_call_probe.h"

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
using xe::cpu::hir::Value;
using xe::cpu::ppc::PPCContext;
using Producers = std::unordered_map<const Value*, const Instr*>;

struct CallModule {
  uint32_t address = 0;
  uint32_t lowered = 0;
  std::vector<uint8_t> bytes;
};

uint32_t g_status = 0;
std::vector<CallModule> g_modules;
alignas(64) uint8_t g_context[sizeof(PPCContext)] = {};

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
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      if (value->type != xe::cpu::hir::INT64_TYPE) break;
      body.push_back(0x20); body.push_back(0x00);
      body.push_back(0x29); body.push_back(0x03);
      EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
      ok = true;
      break;
    case xe::cpu::hir::OPCODE_ASSIGN:
      ok = EmitI64Value(instr->src1.value, producers, visiting, body, lowered);
      break;
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
      if (value->type != xe::cpu::hir::INT64_TYPE) break;
      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered) ||
          !EmitI64Value(instr->src2.value, producers, visiting, body, lowered)) break;
      body.push_back(instr->opcode->num == xe::cpu::hir::OPCODE_ADD ? 0x7C :
                     instr->opcode->num == xe::cpu::hir::OPCODE_SUB ? 0x7D :
                     instr->opcode->num == xe::cpu::hir::OPCODE_AND ? 0x83 :
                     instr->opcode->num == xe::cpu::hir::OPCODE_OR  ? 0x84 : 0x85);
      ok = true;
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
  body.push_back(0x20); body.push_back(0x00);
  if (!EmitI64Value(instr->src2.value, producers, visiting, body, lowered))
    return false;
  body.push_back(0x37); body.push_back(0x03);
  EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
  if (lowered) ++*lowered;
  return true;
}

bool BuildModule(uint32_t address, HIRBuilder* builder, CallModule* out) {
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
          body.push_back(0x41);  // i32.const uses signed LEB128.
          EmitI32Leb(body, static_cast<int32_t>(instr->src1.symbol->address()));
          body.push_back(0x20); body.push_back(0x00);
          body.push_back(0x10); EmitU32Leb(body, 0);
          body.push_back(0x1A);
          ++lowered;
          break;
        }
        case xe::cpu::hir::OPCODE_CALL_INDIRECT: {
          if (instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) {
            body.push_back(0x20); body.push_back(0x00);
            body.push_back(0x29); body.push_back(0x03);
            EmitU32Leb(body, static_cast<uint32_t>(offsetof(PPCContext, r) + 3 * sizeof(uint64_t)));
            body.push_back(0x0F);
            saw_return = true;
            ++lowered;
            break;
          }
          std::unordered_set<const Value*> visiting;
          if (!EmitI64Value(instr->src1.value, producers, visiting, body, &lowered))
            return false;
          body.push_back(0xA7);
          body.push_back(0x20); body.push_back(0x00);
          body.push_back(0x10); EmitU32Leb(body, 0);
          body.push_back(0x1A);
          ++lowered;
          break;
        }
        default:
          if (instr->dest && (instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_CONTEXT ||
              instr->opcode->num == xe::cpu::hir::OPCODE_ASSIGN ||
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

  std::vector<uint8_t> module = {0x00,0x61,0x73,0x6D,0x01,0x00,0x00,0x00};
  std::vector<uint8_t> types;
  EmitU32Leb(types, 2);
  types.push_back(0x60); EmitU32Leb(types,2); types.push_back(0x7F); types.push_back(0x7F); EmitU32Leb(types,1); types.push_back(0x7F);
  types.push_back(0x60); EmitU32Leb(types,1); types.push_back(0x7F); EmitU32Leb(types,1); types.push_back(0x7E);
  EmitSection(module,1,types);
  std::vector<uint8_t> imports;
  EmitU32Leb(imports,2);
  EmitName(imports,"env"); EmitName(imports,"guest_call"); imports.push_back(0x00); EmitU32Leb(imports,0);
  EmitName(imports,"env"); EmitName(imports,"memory"); imports.push_back(0x02); imports.push_back(0x00); EmitU32Leb(imports,0);
  EmitSection(module,2,imports);
  std::vector<uint8_t> funcs; EmitU32Leb(funcs,1); EmitU32Leb(funcs,1); EmitSection(module,3,funcs);
  std::vector<uint8_t> exports; EmitU32Leb(exports,1); EmitName(exports,"run"); exports.push_back(0x00); EmitU32Leb(exports,1); EmitSection(module,7,exports);
  std::vector<uint8_t> fn; EmitU32Leb(fn,0); fn.insert(fn.end(),body.begin(),body.end());
  std::vector<uint8_t> code; EmitU32Leb(code,1); EmitU32Leb(code,static_cast<uint32_t>(fn.size())); code.insert(code.end(),fn.begin(),fn.end()); EmitSection(module,10,code);

  out->address = address;
  out->lowered = lowered;
  out->bytes = std::move(module);
  return true;
}
}  // namespace

void ResetWasmBackendCallProbe() {
  g_status = 0;
  g_modules.clear();
  std::memset(g_context, 0, sizeof(g_context));
}

bool RegisterWasmBackendCallFunction(xe::cpu::GuestFunction* function,
                                     HIRBuilder* builder) {
  if (!function || !builder) { g_status = 1; return false; }
  const uint32_t address = function->address();
  for (auto& existing : g_modules) {
    if (existing.address == address) return true;
  }
  CallModule module;
  if (!BuildModule(address, builder, &module)) {
    if (g_modules.empty()) g_status = 1;
    return false;
  }
  g_modules.push_back(std::move(module));
  g_status = 2;
  return true;
}
uint32_t GetWasmBackendCallStatus() { return g_status; }
uint32_t GetWasmBackendCallFunctionCount() { return static_cast<uint32_t>(g_modules.size()); }
uint32_t GetWasmBackendCallFunctionAddress(uint32_t i) { return i < g_modules.size() ? g_modules[i].address : 0; }
uint8_t* GetWasmBackendCallFunctionModuleData(uint32_t i) { return i < g_modules.size() && !g_modules[i].bytes.empty() ? g_modules[i].bytes.data() : nullptr; }
uint32_t GetWasmBackendCallFunctionModuleSize(uint32_t i) { return i < g_modules.size() ? static_cast<uint32_t>(g_modules[i].bytes.size()) : 0; }
uint32_t GetWasmBackendCallFunctionLowered(uint32_t i) { return i < g_modules.size() ? g_modules[i].lowered : 0; }
uint8_t* GetWasmBackendCallContextData() { return g_context; }
}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_call_status() { return render360::xenia_web::GetWasmBackendCallStatus(); }
uint32_t r360_wasm_backend_call_function_count() { return render360::xenia_web::GetWasmBackendCallFunctionCount(); }
uint32_t r360_wasm_backend_call_function_address(uint32_t i) { return render360::xenia_web::GetWasmBackendCallFunctionAddress(i); }
uint32_t r360_wasm_backend_call_module_ptr(uint32_t i) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCallFunctionModuleData(i))); }
uint32_t r360_wasm_backend_call_module_size(uint32_t i) { return render360::xenia_web::GetWasmBackendCallFunctionModuleSize(i); }
uint32_t r360_wasm_backend_call_lowered_instructions(uint32_t i) { return render360::xenia_web::GetWasmBackendCallFunctionLowered(i); }
uint32_t r360_wasm_backend_call_context_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCallContextData())); }
}
