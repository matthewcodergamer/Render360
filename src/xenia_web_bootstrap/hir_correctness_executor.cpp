#include "hir_correctness_executor.h"

#include <array>
#include <cstring>
#include <unordered_map>

#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/label.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"

namespace render360::xenia_web {
namespace {

using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
constexpr uint32_t kMaxCorrectnessInstructions = 4096;

struct RuntimeValue {
  TypeName type = xe::cpu::hir::INT64_TYPE;
  Value::ConstantValue value{};
};

std::array<uint64_t, 32> g_initial_gprs{};

bool IsIntegerType(TypeName type) {
  return type == xe::cpu::hir::INT8_TYPE || type == xe::cpu::hir::INT16_TYPE ||
         type == xe::cpu::hir::INT32_TYPE || type == xe::cpu::hir::INT64_TYPE;
}

uint32_t IntegerBitWidth(TypeName type) {
  return static_cast<uint32_t>(xe::cpu::hir::GetTypeSize(type) * 8u);
}

void SetUnsigned(RuntimeValue* out, TypeName type, uint64_t value) {
  out->type = type;
  out->value = {};
  switch (type) {
    case xe::cpu::hir::INT8_TYPE:
      out->value.u8 = static_cast<uint8_t>(value);
      break;
    case xe::cpu::hir::INT16_TYPE:
      out->value.u16 = static_cast<uint16_t>(value);
      break;
    case xe::cpu::hir::INT32_TYPE:
      out->value.u32 = static_cast<uint32_t>(value);
      break;
    case xe::cpu::hir::INT64_TYPE:
      out->value.u64 = value;
      break;
    default:
      break;
  }
}

bool GetUnsigned(const RuntimeValue& value, uint64_t* out) {
  if (!out || !IsIntegerType(value.type)) return false;
  switch (value.type) {
    case xe::cpu::hir::INT8_TYPE:
      *out = value.value.u8;
      return true;
    case xe::cpu::hir::INT16_TYPE:
      *out = value.value.u16;
      return true;
    case xe::cpu::hir::INT32_TYPE:
      *out = value.value.u32;
      return true;
    case xe::cpu::hir::INT64_TYPE:
      *out = value.value.u64;
      return true;
    default:
      return false;
  }
}

bool GetSigned(const RuntimeValue& value, int64_t* out) {
  if (!out || !IsIntegerType(value.type)) return false;
  switch (value.type) {
    case xe::cpu::hir::INT8_TYPE:
      *out = value.value.i8;
      return true;
    case xe::cpu::hir::INT16_TYPE:
      *out = value.value.i16;
      return true;
    case xe::cpu::hir::INT32_TYPE:
      *out = value.value.i32;
      return true;
    case xe::cpu::hir::INT64_TYPE:
      *out = value.value.i64;
      return true;
    default:
      return false;
  }
}

bool ResolveRuntimeValue(
    const Value* value,
    const std::unordered_map<const Value*, RuntimeValue>& values,
    RuntimeValue* out) {
  if (!value || !out) return false;
  if (value->IsConstant()) {
    out->type = value->type;
    out->value = value->constant;
    return true;
  }
  const auto it = values.find(value);
  if (it == values.end()) return false;
  *out = it->second;
  return true;
}

bool StoreResolvedValue(
    const Value* value,
    const std::unordered_map<const Value*, RuntimeValue>& values,
    void* destination, size_t size) {
  if (!destination || !value ||
      size != xe::cpu::hir::GetTypeSize(value->type)) {
    return false;
  }
  RuntimeValue resolved;
  if (!ResolveRuntimeValue(value, values, &resolved) ||
      resolved.type != value->type) {
    return false;
  }
  switch (resolved.type) {
    case xe::cpu::hir::INT8_TYPE:
      std::memcpy(destination, &resolved.value.i8, size);
      return true;
    case xe::cpu::hir::INT16_TYPE:
      std::memcpy(destination, &resolved.value.i16, size);
      return true;
    case xe::cpu::hir::INT32_TYPE:
      std::memcpy(destination, &resolved.value.i32, size);
      return true;
    case xe::cpu::hir::INT64_TYPE:
      std::memcpy(destination, &resolved.value.i64, size);
      return true;
    case xe::cpu::hir::FLOAT32_TYPE:
      std::memcpy(destination, &resolved.value.f32, size);
      return true;
    case xe::cpu::hir::FLOAT64_TYPE:
      std::memcpy(destination, &resolved.value.f64, size);
      return true;
    case xe::cpu::hir::VEC128_TYPE:
      std::memcpy(destination, &resolved.value.v128, size);
      return true;
    default:
      return false;
  }
}

bool LoadContextValue(const xe::cpu::ppc::PPCContext& context, uint64_t offset,
                      Value* destination,
                      std::unordered_map<const Value*, RuntimeValue>& values) {
  if (!destination) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) {
    return false;
  }
  RuntimeValue runtime_value;
  runtime_value.type = destination->type;
  const auto* source = reinterpret_cast<const uint8_t*>(&context) + offset;
  std::memcpy(&runtime_value.value, source, size);
  values[destination] = runtime_value;
  return true;
}

bool StoreUnaryInteger(
    Value* destination, const Value* source,
    const std::unordered_map<const Value*, RuntimeValue>& values,
    std::unordered_map<const Value*, RuntimeValue>& out_values,
    uint32_t opcode) {
  if (!destination || !source || !IsIntegerType(destination->type) ||
      !IsIntegerType(source->type)) {
    return false;
  }
  RuntimeValue src;
  if (!ResolveRuntimeValue(source, values, &src)) return false;

  uint64_t u = 0;
  int64_t s = 0;
  RuntimeValue result;
  switch (opcode) {
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_CAST:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, u);
      break;
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
      if (!GetSigned(src, &s)) return false;
      SetUnsigned(&result, destination->type, static_cast<uint64_t>(s));
      break;
    case xe::cpu::hir::OPCODE_NEG:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, uint64_t{0} - u);
      break;
    case xe::cpu::hir::OPCODE_NOT:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, ~u);
      break;
    case xe::cpu::hir::OPCODE_IS_TRUE:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, u != 0 ? 1 : 0);
      break;
    case xe::cpu::hir::OPCODE_IS_FALSE:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, u == 0 ? 1 : 0);
      break;
    default:
      return false;
  }
  out_values[destination] = result;
  return true;
}

bool StoreBinaryInteger(
    Value* destination, const Value* lhs, const Value* rhs,
    const std::unordered_map<const Value*, RuntimeValue>& values,
    std::unordered_map<const Value*, RuntimeValue>& out_values,
    uint32_t opcode) {
  if (!destination || !lhs || !rhs || !IsIntegerType(destination->type) ||
      !IsIntegerType(lhs->type) || !IsIntegerType(rhs->type)) {
    return false;
  }
  RuntimeValue a, b;
  if (!ResolveRuntimeValue(lhs, values, &a) ||
      !ResolveRuntimeValue(rhs, values, &b)) {
    return false;
  }

  uint64_t au = 0, bu = 0;
  int64_t as = 0, bs = 0;
  RuntimeValue result;
  const uint32_t bits = IntegerBitWidth(destination->type);
  const uint32_t shift_mask = bits ? bits - 1u : 0u;

  switch (opcode) {
    case xe::cpu::hir::OPCODE_ADD:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au + bu);
      break;
    case xe::cpu::hir::OPCODE_SUB:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au - bu);
      break;
    case xe::cpu::hir::OPCODE_MUL:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au * bu);
      break;
    case xe::cpu::hir::OPCODE_AND:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au & bu);
      break;
    case xe::cpu::hir::OPCODE_AND_NOT:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au & ~bu);
      break;
    case xe::cpu::hir::OPCODE_OR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au | bu);
      break;
    case xe::cpu::hir::OPCODE_XOR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au ^ bu);
      break;
    case xe::cpu::hir::OPCODE_SHL:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  au << (static_cast<uint32_t>(bu) & shift_mask));
      break;
    case xe::cpu::hir::OPCODE_SHR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  au >> (static_cast<uint32_t>(bu) & shift_mask));
      break;
    case xe::cpu::hir::OPCODE_SHA:
      if (!GetSigned(a, &as) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  static_cast<uint64_t>(
                      as >> (static_cast<uint32_t>(bu) & shift_mask)));
      break;
    case xe::cpu::hir::OPCODE_COMPARE_EQ:
    case xe::cpu::hir::OPCODE_COMPARE_NE:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  opcode == xe::cpu::hir::OPCODE_COMPARE_EQ ? au == bu
                                                            : au != bu);
      break;
    case xe::cpu::hir::OPCODE_COMPARE_ULT:
    case xe::cpu::hir::OPCODE_COMPARE_ULE:
    case xe::cpu::hir::OPCODE_COMPARE_UGT:
    case xe::cpu::hir::OPCODE_COMPARE_UGE:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_ULT)
        SetUnsigned(&result, destination->type, au < bu);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_ULE)
        SetUnsigned(&result, destination->type, au <= bu);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_UGT)
        SetUnsigned(&result, destination->type, au > bu);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_UGE)
        SetUnsigned(&result, destination->type, au >= bu);
      break;
    case xe::cpu::hir::OPCODE_COMPARE_SLT:
    case xe::cpu::hir::OPCODE_COMPARE_SLE:
    case xe::cpu::hir::OPCODE_COMPARE_SGT:
    case xe::cpu::hir::OPCODE_COMPARE_SGE:
      if (!GetSigned(a, &as) || !GetSigned(b, &bs)) return false;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLT)
        SetUnsigned(&result, destination->type, as < bs);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLE)
        SetUnsigned(&result, destination->type, as <= bs);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGT)
        SetUnsigned(&result, destination->type, as > bs);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGE)
        SetUnsigned(&result, destination->type, as >= bs);
      break;
    default:
      return false;
  }

  out_values[destination] = result;
  return true;
}

bool ResolveUint64(
    const Value* value,
    const std::unordered_map<const Value*, RuntimeValue>& values,
    uint64_t* out_value) {
  RuntimeValue runtime_value;
  if (!ResolveRuntimeValue(value, values, &runtime_value)) return false;
  return GetUnsigned(runtime_value, out_value);
}

bool ResolveCondition(
    const Value* value,
    const std::unordered_map<const Value*, RuntimeValue>& values,
    bool* out_condition) {
  uint64_t raw = 0;
  if (!out_condition || !ResolveUint64(value, values, &raw)) return false;
  *out_condition = raw != 0;
  return true;
}

}  // namespace

void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(
    xe::cpu::hir::HIRBuilder* builder) {
  HIRCorrectnessResult result;
  if (!builder) return result;

  xe::cpu::ppc::PPCContext context{};
  for (size_t i = 0; i < g_initial_gprs.size(); ++i) {
    context.r[i] = g_initial_gprs[i];
  }

  std::unordered_map<const Value*, RuntimeValue> values;
  bool supported = true;
  bool reached_return = false;
  auto* block = builder->first_block();

  while (block && supported && !reached_return) {
    auto* next_block = block->next;
    bool block_terminated = false;

    for (auto* instr = block->instr_head;
         instr && supported && !reached_return; instr = instr->next) {
      if (++result.instructions_executed > kMaxCorrectnessInstructions) {
        supported = false;
        break;
      }
      if (!instr->opcode) {
        supported = false;
        break;
      }

      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
          break;

        case xe::cpu::hir::OPCODE_STORE_CONTEXT: {
          const uint64_t offset = instr->src1.offset;
          Value* source_value = instr->src2.value;
          if (!source_value) {
            supported = false;
            break;
          }
          const size_t size = xe::cpu::hir::GetTypeSize(source_value->type);
          if (offset > sizeof(context) ||
              size > sizeof(context) - size_t(offset)) {
            supported = false;
            break;
          }
          auto* destination = reinterpret_cast<uint8_t*>(&context) + offset;
          supported =
              StoreResolvedValue(source_value, values, destination, size);
          break;
        }

        case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
          supported = LoadContextValue(context, instr->src1.offset, instr->dest,
                                       values);
          break;

        case xe::cpu::hir::OPCODE_ASSIGN:
        case xe::cpu::hir::OPCODE_CAST:
        case xe::cpu::hir::OPCODE_ZERO_EXTEND:
        case xe::cpu::hir::OPCODE_SIGN_EXTEND:
        case xe::cpu::hir::OPCODE_TRUNCATE:
        case xe::cpu::hir::OPCODE_NEG:
        case xe::cpu::hir::OPCODE_NOT:
        case xe::cpu::hir::OPCODE_IS_TRUE:
        case xe::cpu::hir::OPCODE_IS_FALSE:
          supported = StoreUnaryInteger(instr->dest, instr->src1.value, values,
                                        values, instr->opcode->num);
          break;

        case xe::cpu::hir::OPCODE_ADD:
        case xe::cpu::hir::OPCODE_SUB:
        case xe::cpu::hir::OPCODE_MUL:
        case xe::cpu::hir::OPCODE_AND:
        case xe::cpu::hir::OPCODE_AND_NOT:
        case xe::cpu::hir::OPCODE_OR:
        case xe::cpu::hir::OPCODE_XOR:
        case xe::cpu::hir::OPCODE_SHL:
        case xe::cpu::hir::OPCODE_SHR:
        case xe::cpu::hir::OPCODE_SHA:
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
          supported = StoreBinaryInteger(
              instr->dest, instr->src1.value, instr->src2.value, values, values,
              instr->opcode->num);
          break;

        case xe::cpu::hir::OPCODE_BRANCH:
          supported = instr->src1.label && instr->src1.label->block;
          if (supported) next_block = instr->src1.label->block;
          block_terminated = true;
          break;

        case xe::cpu::hir::OPCODE_BRANCH_TRUE:
        case xe::cpu::hir::OPCODE_BRANCH_FALSE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          const bool take_branch =
              instr->opcode->num == xe::cpu::hir::OPCODE_BRANCH_TRUE
                  ? condition
                  : !condition;
          if (supported && take_branch) {
            supported = instr->src2.label && instr->src2.label->block;
            if (supported) next_block = instr->src2.label->block;
            block_terminated = true;
          }
          // A false conditional branch falls through to instr->next. Xenia's
          // CFG simplification may leave conditional branches mid-block.
          break;
        }

        case xe::cpu::hir::OPCODE_RETURN:
          reached_return = true;
          block_terminated = true;
          break;

        case xe::cpu::hir::OPCODE_RETURN_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (supported && condition) {
            reached_return = true;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL_INDIRECT: {
          if (!(instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN)) {
            supported = false;
            break;
          }
          uint64_t return_target = 0;
          supported =
              ResolveUint64(instr->src1.value, values, &return_target);
          if (supported) {
            (void)return_target;
            reached_return = true;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (!supported) break;
          if (condition) {
            if (!(instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN)) {
              supported = false;
              break;
            }
            uint64_t return_target = 0;
            supported =
                ResolveUint64(instr->src2.value, values, &return_target);
            if (supported) {
              (void)return_target;
              reached_return = true;
              block_terminated = true;
            }
          }
          break;
        }

        default:
          supported = false;
          break;
      }

      if (block_terminated) break;
    }

    block = next_block;
  }

  result.supported = supported;
  result.reached_return_boundary = reached_return;
  result.r3 = context.r[3];
  return result;
}

}  // namespace render360::xenia_web
