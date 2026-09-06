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
using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
using xe::cpu::ppc::PPCContext;

// status: 0 = no top-level lowering attempted, 1 = unsupported HIR shape,
// 2 = generated child WebAssembly module ready for host instantiation.
uint32_t g_status = 0;
uint32_t g_lowered_instructions = 0;
std::vector<uint8_t> g_module;
alignas(64) uint8_t g_context[sizeof(PPCContext)] = {};

using Producers = std::unordered_map<const Value*, const Instr*>;

bool IsIntegerType(TypeName type) {
  return type == xe::cpu::hir::INT8_TYPE ||
         type == xe::cpu::hir::INT16_TYPE ||
         type == xe::cpu::hir::INT32_TYPE ||
         type == xe::cpu::hir::INT64_TYPE;
}

bool IsI64(TypeName type) { return type == xe::cpu::hir::INT64_TYPE; }

uint32_t TypeBits(TypeName type) {
  switch (type) {
    case xe::cpu::hir::INT8_TYPE:
      return 8;
    case xe::cpu::hir::INT16_TYPE:
      return 16;
    case xe::cpu::hir::INT32_TYPE:
      return 32;
    case xe::cpu::hir::INT64_TYPE:
      return 64;
    default:
      return 0;
  }
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

void EmitI32Const(std::vector<uint8_t>& out, int32_t value) {
  out.push_back(0x41);
  EmitI32Leb(out, value);
}

void EmitI64Const(std::vector<uint8_t>& out, int64_t value) {
  out.push_back(0x42);
  EmitI64Leb(out, value);
}

void EmitMaskForType(std::vector<uint8_t>& body, TypeName type) {
  if (type == xe::cpu::hir::INT8_TYPE) {
    EmitI32Const(body, 0xFF);
    body.push_back(0x71);  // i32.and
  } else if (type == xe::cpu::hir::INT16_TYPE) {
    EmitI32Const(body, 0xFFFF);
    body.push_back(0x71);  // i32.and
  }
}

void EmitSignNormalizeI32(std::vector<uint8_t>& body, TypeName type) {
  if (type == xe::cpu::hir::INT8_TYPE) {
    body.push_back(0xC0);  // i32.extend8_s
  } else if (type == xe::cpu::hir::INT16_TYPE) {
    body.push_back(0xC1);  // i32.extend16_s
  }
}

bool EmitIntegerValue(const Value* value, const Producers& producers,
                      std::unordered_set<const Value*>& visiting,
                      std::vector<uint8_t>& body, uint32_t* lowered);

bool EmitAdaptedIntegerValue(const Value* value, bool want_i64,
                             bool sign_extend, const Producers& producers,
                             std::unordered_set<const Value*>& visiting,
                             std::vector<uint8_t>& body, uint32_t* lowered) {
  if (!value || !IsIntegerType(value->type)) return false;
  if (!EmitIntegerValue(value, producers, visiting, body, lowered)) return false;

  if (IsI64(value->type) == want_i64) {
    if (!want_i64 && sign_extend) EmitSignNormalizeI32(body, value->type);
    return true;
  }

  if (want_i64) {
    if (sign_extend) {
      EmitSignNormalizeI32(body, value->type);
      body.push_back(0xAC);  // i64.extend_i32_s
    } else {
      body.push_back(0xAD);  // i64.extend_i32_u
    }
  } else {
    body.push_back(0xA7);  // i32.wrap_i64
    if (sign_extend) EmitSignNormalizeI32(body, value->type);
  }
  return true;
}

bool EmitCompare(const Instr* instr, const Producers& producers,
                 std::unordered_set<const Value*>& visiting,
                 std::vector<uint8_t>& body, uint32_t* lowered) {
  if (!instr->src1.value || !instr->src2.value ||
      !IsIntegerType(instr->src1.value->type) ||
      !IsIntegerType(instr->src2.value->type)) {
    return false;
  }

  const bool i64 = IsI64(instr->src1.value->type) ||
                   IsI64(instr->src2.value->type);
  const auto opcode = instr->opcode->num;
  const bool signed_compare =
      opcode == xe::cpu::hir::OPCODE_COMPARE_SLT ||
      opcode == xe::cpu::hir::OPCODE_COMPARE_SLE ||
      opcode == xe::cpu::hir::OPCODE_COMPARE_SGT ||
      opcode == xe::cpu::hir::OPCODE_COMPARE_SGE;

  if (!EmitAdaptedIntegerValue(instr->src1.value, i64, signed_compare,
                               producers, visiting, body, lowered) ||
      !EmitAdaptedIntegerValue(instr->src2.value, i64, signed_compare,
                               producers, visiting, body, lowered)) {
    return false;
  }

  if (!i64) {
    switch (opcode) {
      case xe::cpu::hir::OPCODE_COMPARE_EQ: body.push_back(0x46); break;
      case xe::cpu::hir::OPCODE_COMPARE_NE: body.push_back(0x47); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLT: body.push_back(0x48); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULT: body.push_back(0x49); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGT: body.push_back(0x4A); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGT: body.push_back(0x4B); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLE: body.push_back(0x4C); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULE: body.push_back(0x4D); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGE: body.push_back(0x4E); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGE: body.push_back(0x4F); break;
      default: return false;
    }
  } else {
    switch (opcode) {
      case xe::cpu::hir::OPCODE_COMPARE_EQ: body.push_back(0x51); break;
      case xe::cpu::hir::OPCODE_COMPARE_NE: body.push_back(0x52); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLT: body.push_back(0x53); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULT: body.push_back(0x54); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGT: body.push_back(0x55); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGT: body.push_back(0x56); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLE: body.push_back(0x57); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULE: body.push_back(0x58); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGE: body.push_back(0x59); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGE: body.push_back(0x5A); break;
      default: return false;
    }
  }
  return true;
}

bool EmitIntegerValue(const Value* value, const Producers& producers,
                      std::unordered_set<const Value*>& visiting,
                      std::vector<uint8_t>& body, uint32_t* lowered) {
  if (!value || !IsIntegerType(value->type)) return false;

  if (value->IsConstant()) {
    if (IsI64(value->type)) {
      EmitI64Const(body, value->constant.i64);
    } else {
      EmitI32Const(body, value->constant.i32);
      EmitMaskForType(body, value->type);
    }
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
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT: {
      body.push_back(0x20);  // local.get ctx
      body.push_back(0x00);
      switch (value->type) {
        case xe::cpu::hir::INT8_TYPE:
          body.push_back(0x2D);  // i32.load8_u
          body.push_back(0x00);
          break;
        case xe::cpu::hir::INT16_TYPE:
          body.push_back(0x2F);  // i32.load16_u
          body.push_back(0x01);
          break;
        case xe::cpu::hir::INT32_TYPE:
          body.push_back(0x28);  // i32.load
          body.push_back(0x02);
          break;
        case xe::cpu::hir::INT64_TYPE:
          body.push_back(0x29);  // i64.load
          body.push_back(0x03);
          break;
        default:
          visiting.erase(value);
          return false;
      }
      EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));
      supported = true;
      break;
    }

    case xe::cpu::hir::OPCODE_ASSIGN:
      supported = EmitAdaptedIntegerValue(instr->src1.value, IsI64(value->type),
                                           false, producers, visiting, body,
                                           lowered);
      if (supported) EmitMaskForType(body, value->type);
      break;

    case xe::cpu::hir::OPCODE_TRUNCATE:
      if (!instr->src1.value || !IsIntegerType(instr->src1.value->type)) break;
      supported = EmitIntegerValue(instr->src1.value, producers, visiting, body,
                                   lowered);
      if (supported && IsI64(instr->src1.value->type) && !IsI64(value->type)) {
        body.push_back(0xA7);  // i32.wrap_i64
      }
      if (supported) EmitMaskForType(body, value->type);
      break;

    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
      if (!instr->src1.value || !IsIntegerType(instr->src1.value->type)) break;
      supported = EmitAdaptedIntegerValue(instr->src1.value, IsI64(value->type),
                                           false, producers, visiting, body,
                                           lowered);
      if (supported) EmitMaskForType(body, value->type);
      break;

    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
      if (!instr->src1.value || !IsIntegerType(instr->src1.value->type)) break;
      supported = EmitAdaptedIntegerValue(instr->src1.value, IsI64(value->type),
                                           true, producers, visiting, body,
                                           lowered);
      break;

    case xe::cpu::hir::OPCODE_IS_TRUE:
    case xe::cpu::hir::OPCODE_IS_FALSE: {
      if (!instr->src1.value || !IsIntegerType(instr->src1.value->type)) break;
      const bool source_i64 = IsI64(instr->src1.value->type);
      if (!EmitIntegerValue(instr->src1.value, producers, visiting, body,
                            lowered)) break;
      body.push_back(source_i64 ? 0x50 : 0x45);  // *.eqz
      if (instr->opcode->num == xe::cpu::hir::OPCODE_IS_TRUE) {
        body.push_back(0x45);  // i32.eqz, invert eqz -> truthy
      }
      supported = true;
      break;
    }

    case xe::cpu::hir::OPCODE_COMPARE_EQ:
    case xe::cpu::hir::OPCODE_COMPARE_NE:
    case xe::cpu::hir::OPCODE_COMPARE_SLT:
    case xe::cpu::hir::OPCODE_COMPARE_SLE:
    case xe::cpu::hir::OPCODE_COMPARE_SGT:
    case xe::cpu::hir::OPCODE_COMPARE_SGE:
    case xe::cpu::hir::OPCODE_COMPARE_ULT:
    case xe::cpu::hir::OPCODE_COMPARE_ULE:
    case xe::cpu::hir::OPCODE_COMPARE_UGT:
    case xe::cpu::hir::OPCODE_COMPARE_UGE:
      supported = EmitCompare(instr, producers, visiting, body, lowered);
      break;

    case xe::cpu::hir::OPCODE_CNTLZ: {
      // WebAssembly has native i32.clz / i64.clz. Xenia's CNTLZ result is INT8,
      // so narrow 8/16-bit sources subtract the host i32 width bias while a
      // 64-bit count is wrapped back to the backend's i32 representation.
      const Value* source = instr->src1.value;
      if (!source || !IsIntegerType(source->type) ||
          value->type != xe::cpu::hir::INT8_TYPE ||
          !EmitIntegerValue(source, producers, visiting, body, lowered)) {
        break;
      }
      if (source->type == xe::cpu::hir::INT64_TYPE) {
        body.push_back(0x79);  // i64.clz
        body.push_back(0xA7);  // i32.wrap_i64
      } else {
        body.push_back(0x67);  // i32.clz
        const uint32_t bias = 32u - TypeBits(source->type);
        if (bias) {
          EmitI32Const(body, static_cast<int32_t>(bias));
          body.push_back(0x6B);  // i32.sub
        }
      }
      EmitMaskForType(body, value->type);
      supported = true;
      break;
    }

    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
    case xe::cpu::hir::OPCODE_SHA:
    case xe::cpu::hir::OPCODE_ROTATE_LEFT: {
      const bool i64 = IsI64(value->type);
      if (!EmitAdaptedIntegerValue(instr->src1.value, i64, false, producers,
                                   visiting, body, lowered) ||
          !EmitAdaptedIntegerValue(instr->src2.value, i64, false, producers,
                                   visiting, body, lowered)) {
        break;
      }
      if (!i64) {
        switch (instr->opcode->num) {
          case xe::cpu::hir::OPCODE_ADD: body.push_back(0x6A); break;
          case xe::cpu::hir::OPCODE_SUB: body.push_back(0x6B); break;
          case xe::cpu::hir::OPCODE_AND: body.push_back(0x71); break;
          case xe::cpu::hir::OPCODE_OR: body.push_back(0x72); break;
          case xe::cpu::hir::OPCODE_XOR: body.push_back(0x73); break;
          case xe::cpu::hir::OPCODE_SHL: body.push_back(0x74); break;
          case xe::cpu::hir::OPCODE_SHA: body.push_back(0x75); break;
          case xe::cpu::hir::OPCODE_SHR: body.push_back(0x76); break;
          case xe::cpu::hir::OPCODE_ROTATE_LEFT: body.push_back(0x77); break;
          default: break;
        }
      } else {
        switch (instr->opcode->num) {
          case xe::cpu::hir::OPCODE_ADD: body.push_back(0x7C); break;
          case xe::cpu::hir::OPCODE_SUB: body.push_back(0x7D); break;
          case xe::cpu::hir::OPCODE_AND: body.push_back(0x83); break;
          case xe::cpu::hir::OPCODE_OR: body.push_back(0x84); break;
          case xe::cpu::hir::OPCODE_XOR: body.push_back(0x85); break;
          case xe::cpu::hir::OPCODE_SHL: body.push_back(0x86); break;
          case xe::cpu::hir::OPCODE_SHA: body.push_back(0x87); break;
          case xe::cpu::hir::OPCODE_SHR: body.push_back(0x88); break;
          case xe::cpu::hir::OPCODE_ROTATE_LEFT: body.push_back(0x89); break;
          default: break;
        }
      }
      EmitMaskForType(body, value->type);
      supported = true;
      break;
    }

    case xe::cpu::hir::OPCODE_NOT:
      if (EmitAdaptedIntegerValue(instr->src1.value, IsI64(value->type), false,
                                  producers, visiting, body, lowered)) {
        if (IsI64(value->type)) {
          EmitI64Const(body, -1);
          body.push_back(0x85);  // i64.xor
        } else {
          EmitI32Const(body, -1);
          body.push_back(0x73);  // i32.xor
          EmitMaskForType(body, value->type);
        }
        supported = true;
      }
      break;

    case xe::cpu::hir::OPCODE_NEG:
      if (IsI64(value->type)) {
        EmitI64Const(body, 0);
        if (EmitAdaptedIntegerValue(instr->src1.value, true, false, producers,
                                    visiting, body, lowered)) {
          body.push_back(0x7D);  // i64.sub
          supported = true;
        }
      } else {
        EmitI32Const(body, 0);
        if (EmitAdaptedIntegerValue(instr->src1.value, false, false, producers,
                                    visiting, body, lowered)) {
          body.push_back(0x6B);  // i32.sub
          EmitMaskForType(body, value->type);
          supported = true;
        }
      }
      break;

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
  if (!EmitAdaptedIntegerValue(r3_source, true, false, producers, visiting,
                               expression, &lowered)) {
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
  EmitU32Leb(imports, 0);
  EmitSection(module, 2, imports);

  std::vector<uint8_t> functions;
  EmitU32Leb(functions, 1);
  EmitU32Leb(functions, 0);
  EmitSection(module, 3, functions);

  std::vector<uint8_t> exports;
  EmitU32Leb(exports, 1);
  EmitName(exports, "run");
  exports.push_back(0x00);
  EmitU32Leb(exports, 0);
  EmitSection(module, 7, exports);

  std::vector<uint8_t> function_body;
  EmitU32Leb(function_body, 1);
  EmitU32Leb(function_body, 1);
  function_body.push_back(0x7E);  // one i64 result local
  function_body.insert(function_body.end(), expression.begin(), expression.end());

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
      if (instr->opcode &&
          instr->opcode->num == xe::cpu::hir::OPCODE_STORE_CONTEXT &&
          instr->src1.offset == r3_offset && instr->src2.value &&
          IsIntegerType(instr->src2.value->type)) {
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

uint32_t r360_wasm_backend_supports_hir_opcode(uint32_t opcode) {
  switch (opcode) {
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_TRUNCATE:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
    case xe::cpu::hir::OPCODE_IS_TRUE:
    case xe::cpu::hir::OPCODE_IS_FALSE:
    case xe::cpu::hir::OPCODE_COMPARE_EQ:
    case xe::cpu::hir::OPCODE_COMPARE_NE:
    case xe::cpu::hir::OPCODE_COMPARE_SLT:
    case xe::cpu::hir::OPCODE_COMPARE_SLE:
    case xe::cpu::hir::OPCODE_COMPARE_SGT:
    case xe::cpu::hir::OPCODE_COMPARE_SGE:
    case xe::cpu::hir::OPCODE_COMPARE_ULT:
    case xe::cpu::hir::OPCODE_COMPARE_ULE:
    case xe::cpu::hir::OPCODE_COMPARE_UGT:
    case xe::cpu::hir::OPCODE_COMPARE_UGE:
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
    case xe::cpu::hir::OPCODE_SHA:
    case xe::cpu::hir::OPCODE_ROTATE_LEFT:
    case xe::cpu::hir::OPCODE_CNTLZ:
    case xe::cpu::hir::OPCODE_NOT:
    case xe::cpu::hir::OPCODE_NEG:
      return 1;
    default:
      return 0;
  }
}

uint32_t r360_wasm_backend_supported_opcode_count() {
  uint32_t count = 0;
  const uint32_t total = static_cast<uint32_t>(xe::cpu::hir::__OPCODE_MAX_VALUE);
  for (uint32_t opcode = 0; opcode < total; ++opcode) {
    count += r360_wasm_backend_supports_hir_opcode(opcode) ? 1u : 0u;
  }
  return count;
}
}
