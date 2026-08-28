#include "hir_correctness_executor.h"

#include <cstring>
#include <unordered_map>

#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"

namespace render360::xenia_web {
namespace {

using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;

struct RuntimeValue {
  TypeName type = xe::cpu::hir::INT64_TYPE;
  Value::ConstantValue value{};
};

bool CopyValueBytes(const Value* value, void* destination, size_t size) {
  if (!value || !value->IsConstant() || !destination ||
      size != xe::cpu::hir::GetTypeSize(value->type)) {
    return false;
  }
  switch (value->type) {
    case xe::cpu::hir::INT8_TYPE:
      std::memcpy(destination, &value->constant.i8, size);
      return true;
    case xe::cpu::hir::INT16_TYPE:
      std::memcpy(destination, &value->constant.i16, size);
      return true;
    case xe::cpu::hir::INT32_TYPE:
      std::memcpy(destination, &value->constant.i32, size);
      return true;
    case xe::cpu::hir::INT64_TYPE:
      std::memcpy(destination, &value->constant.i64, size);
      return true;
    case xe::cpu::hir::FLOAT32_TYPE:
      std::memcpy(destination, &value->constant.f32, size);
      return true;
    case xe::cpu::hir::FLOAT64_TYPE:
      std::memcpy(destination, &value->constant.f64, size);
      return true;
    case xe::cpu::hir::VEC128_TYPE:
      std::memcpy(destination, &value->constant.v128, size);
      return true;
    default:
      return false;
  }
}

bool LoadContextValue(const xe::cpu::ppc::PPCContext& context, uint64_t offset,
                      Value* destination,
                      std::unordered_map<const Value*, RuntimeValue>& values) {
  if (!destination) {
    return false;
  }
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

bool ResolveUint64(const Value* value,
                   const std::unordered_map<const Value*, RuntimeValue>& values,
                   uint64_t* out_value) {
  if (!value || !out_value) {
    return false;
  }
  if (value->IsConstant()) {
    switch (value->type) {
      case xe::cpu::hir::INT8_TYPE:
        *out_value = value->constant.u8;
        return true;
      case xe::cpu::hir::INT16_TYPE:
        *out_value = value->constant.u16;
        return true;
      case xe::cpu::hir::INT32_TYPE:
        *out_value = value->constant.u32;
        return true;
      case xe::cpu::hir::INT64_TYPE:
        *out_value = value->constant.u64;
        return true;
      default:
        return false;
    }
  }
  const auto it = values.find(value);
  if (it == values.end()) {
    return false;
  }
  switch (it->second.type) {
    case xe::cpu::hir::INT8_TYPE:
      *out_value = it->second.value.u8;
      return true;
    case xe::cpu::hir::INT16_TYPE:
      *out_value = it->second.value.u16;
      return true;
    case xe::cpu::hir::INT32_TYPE:
      *out_value = it->second.value.u32;
      return true;
    case xe::cpu::hir::INT64_TYPE:
      *out_value = it->second.value.u64;
      return true;
    default:
      return false;
  }
}

}  // namespace

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(
    xe::cpu::hir::HIRBuilder* builder) {
  HIRCorrectnessResult result;
  if (!builder) {
    return result;
  }

  xe::cpu::ppc::PPCContext context{};
  std::unordered_map<const Value*, RuntimeValue> values;
  bool supported = true;
  bool reached_return = false;

  for (auto* block = builder->first_block(); block && supported && !reached_return;
       block = block->next) {
    for (auto* instr = block->instr_head; instr && supported && !reached_return;
         instr = instr->next) {
      ++result.instructions_executed;
      if (!instr->opcode) {
        supported = false;
        break;
      }

      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
          // Metadata / ordering for this single-threaded correctness probe.
          break;

        case xe::cpu::hir::OPCODE_STORE_CONTEXT: {
          const uint64_t offset = instr->src1.offset;
          Value* source_value = instr->src2.value;
          if (!source_value) {
            supported = false;
            break;
          }
          const size_t size = xe::cpu::hir::GetTypeSize(source_value->type);
          if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) {
            supported = false;
            break;
          }
          auto* destination = reinterpret_cast<uint8_t*>(&context) + offset;
          supported = CopyValueBytes(source_value, destination, size);
          break;
        }

        case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
          supported = LoadContextValue(context, instr->src1.offset, instr->dest,
                                       values);
          break;

        case xe::cpu::hir::OPCODE_CALL_INDIRECT: {
          // Xenia marks LR-based `blr` as CALL_POSSIBLE_RETURN. The initial
          // correctness tier treats only that marked indirect call as the
          // function-return boundary; arbitrary indirect guest calls remain
          // unsupported until general control-flow execution is implemented.
          if (!(instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN)) {
            supported = false;
            break;
          }
          uint64_t return_target = 0;
          supported = ResolveUint64(instr->src1.value, values, &return_target);
          if (supported) {
            (void)return_target;
            reached_return = true;
          }
          break;
        }

        default:
          supported = false;
          break;
      }
    }
  }

  result.supported = supported;
  result.reached_return_boundary = reached_return;
  result.r3 = context.r[3];
  return result;
}

}  // namespace render360::xenia_web
