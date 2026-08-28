#include "wasm_backend_probe.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>

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

// status: 0 = no top-level lowering attempted, 1 = unsupported HIR shape,
// 2 = generated child WebAssembly module ready for host instantiation.
uint32_t g_status = 0;
uint32_t g_lowered_instructions = 0;
std::vector<uint8_t> g_module;
alignas(64) uint8_t g_context[sizeof(PPCContext)] = {};

using Producers = std::unordered_map<const Value*, const Instr*>;

void EmitU32Leb(std::vector<uint8_t>& out, uint32_t value) {
  do {
    uint8_t byte = static_cast<uint8_t>(value & 0x7Fu);
    value >>= 7;
    if (value) byte |= 0x80u;
    out.push_back(byte);
  } while (value);
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
  const auto length = static_cast<uint32_t>(std::strlen(name));
  EmitU32Leb(out, length);
  out.insert(out.end(), name, name + length);
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
  if (!value || value->type != xe::cpu::hir::INT64_TYPE) return false;

  if (value->IsConstant()) {
    body.push_back(0x42);  // i64.const
    EmitI64Leb(body, value->constant.i64);
    return true;
  }

  if (!visiting.insert(value).second) return false;
  const auto it = producers.find(value);
  if (it == producers.end() || !it->second || !it->second->opcode) {
    visiting.erase(value);
    return false;
  }

  const Instr* instr = it->second;
  bool supported = false;
  switch (instr->opcode->num) {
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      // run(ctx_ptr: i32) -> i64. The generated module imports the parent
      // WebAssembly.Memory, so this is a direct load from Xenia PPCContext.
      body.push_back(0x20);  // local.get
      body.push_back(0x00);  // parameter 0
      body.push_back(0x29);  // i64.load
      body.push_back(0x03);  // align = 2^3 = 8
      EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
      supported = true;
      break;

    case xe::cpu::hir::OPCODE_ASSIGN:
      supported = EmitI64Value(instr->src1.value, producers, visiting, body,
                               lowered);
      break;

    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR: {
      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered) ||
          !EmitI64Value(instr->src2.value, producers, visiting, body, lowered)) {
        supported = false;
        break;
      }
      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_ADD:
          body.push_back(0x7C);  // i64.add
          break;
        case xe::cpu::hir::OPCODE_SUB:
          body.push_back(0x7D);  // i64.sub
          break;
        case xe::cpu::hir::OPCODE_AND:
          body.push_back(0x83);  // i64.and
          break;
        case xe::cpu::hir::OPCODE_OR:
          body.push_back(0x84);  // i64.or
          break;
        case xe::cpu::hir::OPCODE_XOR:
          body.push_back(0x85);  // i64.xor
          break;
        default:
          break;
      }
      supported = true;
      break;
    }

    default:
      supported = false;
      break;
  }

  if (supported && lowered) ++*lowered;
  visiting.erase(value);
  return supported;
}

bool BuildChildModule(const Value* r3_source, const Producers& producers) {
  std::vector<uint8_t> expression;
  std::unordered_set<const Value*> visiting;
  uint32_t lowered = 0;
  if (!EmitI64Value(r3_source, producers, visiting, expression, &lowered)) {
    return false;
  }

  // Save the computed r3 into local 1, write it to PPCContext.r[3], then
  // return it. The second local allows one expression to feed both store and
  // return without re-lowering or leaving an invalid extra stack value.
  expression.push_back(0x21);  // local.set
  expression.push_back(0x01);
  expression.push_back(0x20);  // local.get ctx
  expression.push_back(0x00);
  expression.push_back(0x20);  // local.get result
  expression.push_back(0x01);
  expression.push_back(0x37);  // i64.store
  expression.push_back(0x03);  // alignment
  EmitU32Leb(expression, static_cast<uint32_t>(offsetof(PPCContext, r) +
                                                3 * sizeof(uint64_t)));
  expression.push_back(0x20);  // local.get result
  expression.push_back(0x01);
  expression.push_back(0x0B);  // end

  std::vector<uint8_t> module = {0x00, 0x61, 0x73, 0x6D,
                                 0x01, 0x00, 0x00, 0x00};

  // Type section: type 0 = (i32) -> i64.
  std::vector<uint8_t> type;
  EmitU32Leb(type, 1);
  type.push_back(0x60);
  EmitU32Leb(type, 1);
  type.push_back(0x7F);  // i32
  EmitU32Leb(type, 1);
  type.push_back(0x7E);  // i64
  EmitSection(module, 1, type);

  // Import the parent module's memory so the generated function operates on
  // the exact same wasm32 address space containing Xenia PPCContext.
  std::vector<uint8_t> imports;
  EmitU32Leb(imports, 1);
  EmitName(imports, "env");
  EmitName(imports, "memory");
  imports.push_back(0x02);  // external kind: memory
  imports.push_back(0x00);  // limits: minimum only
  EmitU32Leb(imports, 0);   // any parent memory with >= 0 pages is accepted
  EmitSection(module, 2, imports);

  // Function section: one function of type 0.
  std::vector<uint8_t> functions;
  EmitU32Leb(functions, 1);
  EmitU32Leb(functions, 0);
  EmitSection(module, 3, functions);

  // Export section: run -> function index 0.
  std::vector<uint8_t> exports;
  EmitU32Leb(exports, 1);
  EmitName(exports, "run");
  exports.push_back(0x00);  // external kind: function
  EmitU32Leb(exports, 0);
  EmitSection(module, 7, exports);

  // Code section. One local group containing local 1 as i64.
  std::vector<uint8_t> function_body;
  EmitU32Leb(function_body, 1);  // local declaration groups
  EmitU32Leb(function_body, 1);  // one local
  function_body.push_back(0x7E); // i64
  function_body.insert(function_body.end(), expression.begin(),
                       expression.end());

  std::vector<uint8_t> code;
  EmitU32Leb(code, 1);
  EmitU32Leb(code, static_cast<uint32_t>(function_body.size()));
  code.insert(code.end(), function_body.begin(), function_body.end());
  EmitSection(module, 10, code);

  g_module = std::move(module);
  g_lowered_instructions = lowered;
  return true;
}

}  // namespace

void ResetWasmBackendProbe() {
  g_status = 0;
  g_lowered_instructions = 0;
  g_module.clear();
  std::memset(g_context, 0, sizeof(g_context));
}

bool BuildWasmBackendProbe(HIRBuilder* builder) {
  ResetWasmBackendProbe();
  if (!builder) {
    g_status = 1;
    return false;
  }

  Producers producers;
  const Value* r3_source = nullptr;
  const uint64_t r3_offset = offsetof(PPCContext, r) + 3 * sizeof(uint64_t);

  for (auto* block = builder->first_block(); block; block = block->next) {
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      if (instr->dest) producers[instr->dest] = instr;
      if (instr->opcode && instr->opcode->num == xe::cpu::hir::OPCODE_STORE_CONTEXT &&
          instr->src1.offset == r3_offset && instr->src2.value &&
          instr->src2.value->type == xe::cpu::hir::INT64_TYPE) {
        r3_source = instr->src2.value;
      }
    }
  }

  if (!r3_source || !BuildChildModule(r3_source, producers)) {
    g_status = 1;
    g_module.clear();
    g_lowered_instructions = 0;
    return false;
  }

  g_status = 2;
  return true;
}

uint32_t GetWasmBackendProbeStatus() { return g_status; }
uint32_t GetWasmBackendProbeModuleSize() {
  return static_cast<uint32_t>(g_module.size());
}
uint32_t GetWasmBackendProbeLoweredInstructions() {
  return g_lowered_instructions;
}
uint8_t* GetWasmBackendProbeModuleData() {
  return g_module.empty() ? nullptr : g_module.data();
}
uint8_t* GetWasmBackendProbeContextData() { return g_context; }

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_status() {
  return render360::xenia_web::GetWasmBackendProbeStatus();
}
uint32_t r360_wasm_backend_module_ptr() {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
      render360::xenia_web::GetWasmBackendProbeModuleData()));
}
uint32_t r360_wasm_backend_module_size() {
  return render360::xenia_web::GetWasmBackendProbeModuleSize();
}
uint32_t r360_wasm_backend_lowered_instructions() {
  return render360::xenia_web::GetWasmBackendProbeLoweredInstructions();
}
uint32_t r360_wasm_backend_context_ptr() {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
      render360::xenia_web::GetWasmBackendProbeContextData()));
}
}
