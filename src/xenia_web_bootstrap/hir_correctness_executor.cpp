#include "hir_correctness_executor.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <unordered_map>

#include "xenia/cpu/function.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/label.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"
#include "xenia/memory.h"

namespace render360::xenia_web {
namespace {

using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
constexpr uint32_t kMaxCorrectnessInstructions = 4096;

struct RuntimeValue {
  TypeName type = xe::cpu::hir::INT64_TYPE;
  Value::ConstantValue value{};
};
using RuntimeValues = std::unordered_map<const Value*, RuntimeValue>;

std::array<uint64_t, 32> g_initial_gprs{};
HIRCorrectnessCallResolver g_call_resolver = nullptr;
thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;
thread_local uint32_t g_execution_depth = 0;

bool IsIntegerType(TypeName type) {
  return type == xe::cpu::hir::INT8_TYPE || type == xe::cpu::hir::INT16_TYPE ||
         type == xe::cpu::hir::INT32_TYPE || type == xe::cpu::hir::INT64_TYPE;
}

uint32_t IntegerBitWidth(TypeName type) {
  return static_cast<uint32_t>(xe::cpu::hir::GetTypeSize(type) * 8u);
}

void SetUnsigned(RuntimeValue* out, TypeName type, uint64_t value) {
  if (!out) return;
  out->type = type;
  out->value = {};
  switch (type) {
    case xe::cpu::hir::INT8_TYPE: out->value.u8 = static_cast<uint8_t>(value); break;
    case xe::cpu::hir::INT16_TYPE: out->value.u16 = static_cast<uint16_t>(value); break;
    case xe::cpu::hir::INT32_TYPE: out->value.u32 = static_cast<uint32_t>(value); break;
    case xe::cpu::hir::INT64_TYPE: out->value.u64 = value; break;
    default: break;
  }
}

bool GetUnsigned(const RuntimeValue& value, uint64_t* out) {
  if (!out || !IsIntegerType(value.type)) return false;
  switch (value.type) {
    case xe::cpu::hir::INT8_TYPE: *out = value.value.u8; return true;
    case xe::cpu::hir::INT16_TYPE: *out = value.value.u16; return true;
    case xe::cpu::hir::INT32_TYPE: *out = value.value.u32; return true;
    case xe::cpu::hir::INT64_TYPE: *out = value.value.u64; return true;
    default: return false;
  }
}

bool GetSigned(const RuntimeValue& value, int64_t* out) {
  if (!out || !IsIntegerType(value.type)) return false;
  switch (value.type) {
    case xe::cpu::hir::INT8_TYPE: *out = value.value.i8; return true;
    case xe::cpu::hir::INT16_TYPE: *out = value.value.i16; return true;
    case xe::cpu::hir::INT32_TYPE: *out = value.value.i32; return true;
    case xe::cpu::hir::INT64_TYPE: *out = value.value.i64; return true;
    default: return false;
  }
}

bool ResolveRuntimeValue(const Value* value, const RuntimeValues& values,
                         RuntimeValue* out) {
  if (!value || !out) return false;
  if (value->IsConstant()) {
    out->type = value->type;
    out->value = value->constant;
    return true;
  }
  auto it = values.find(value);
  if (it == values.end()) return false;
  *out = it->second;
  return true;
}

bool ResolveUint64(const Value* value, const RuntimeValues& values,
                   uint64_t* out) {
  RuntimeValue resolved;
  return ResolveRuntimeValue(value, values, &resolved) && GetUnsigned(resolved, out);
}

bool ResolveCondition(const Value* value, const RuntimeValues& values, bool* out) {
  uint64_t raw = 0;
  if (!out || !ResolveUint64(value, values, &raw)) return false;
  *out = raw != 0;
  return true;
}

bool StoreResolvedValue(const Value* value, const RuntimeValues& values,
                        void* destination, size_t size) {
  if (!destination || !value || size != xe::cpu::hir::GetTypeSize(value->type)) {
    return false;
  }
  RuntimeValue resolved;
  if (!ResolveRuntimeValue(value, values, &resolved) || resolved.type != value->type) {
    return false;
  }
  std::memcpy(destination, &resolved.value, size);
  return true;
}

bool LoadContextValue(const xe::cpu::ppc::PPCContext& context, uint64_t offset,
                      Value* destination, RuntimeValues& values) {
  if (!destination) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) return false;
  RuntimeValue value;
  value.type = destination->type;
  std::memcpy(&value.value, reinterpret_cast<const uint8_t*>(&context) + offset, size);
  values[destination] = value;
  return true;
}

uint64_t ByteSwapUnsigned(uint64_t value, TypeName type) {
  switch (type) {
    case xe::cpu::hir::INT8_TYPE:
      return value & 0xFFu;
    case xe::cpu::hir::INT16_TYPE:
      return ((value & 0x00FFu) << 8) | ((value & 0xFF00u) >> 8);
    case xe::cpu::hir::INT32_TYPE:
      return ((value & 0x000000FFull) << 24) |
             ((value & 0x0000FF00ull) << 8) |
             ((value & 0x00FF0000ull) >> 8) |
             ((value & 0xFF000000ull) >> 24);
    case xe::cpu::hir::INT64_TYPE:
      return ((value & 0x00000000000000FFull) << 56) |
             ((value & 0x000000000000FF00ull) << 40) |
             ((value & 0x0000000000FF0000ull) << 24) |
             ((value & 0x00000000FF000000ull) << 8) |
             ((value & 0x000000FF00000000ull) >> 8) |
             ((value & 0x0000FF0000000000ull) >> 24) |
             ((value & 0x00FF000000000000ull) >> 40) |
             ((value & 0xFF00000000000000ull) >> 56);
    default:
      return value;
  }
}

bool StoreUnaryInteger(Value* destination, const Value* source,
                       const RuntimeValues& values, RuntimeValues& out_values,
                       uint32_t opcode) {
  if (!destination || !source || !IsIntegerType(destination->type) ||
      !IsIntegerType(source->type)) return false;
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
    case xe::cpu::hir::OPCODE_BYTE_SWAP:
      if (!GetUnsigned(src, &u) || destination->type != source->type) return false;
      SetUnsigned(&result, destination->type, ByteSwapUnsigned(u, destination->type));
      break;
    case xe::cpu::hir::OPCODE_IS_TRUE:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, u != 0);
      break;
    case xe::cpu::hir::OPCODE_IS_FALSE:
      if (!GetUnsigned(src, &u)) return false;
      SetUnsigned(&result, destination->type, u == 0);
      break;
    default:
      return false;
  }
  out_values[destination] = result;
  return true;
}

bool StoreBinaryInteger(Value* destination, const Value* lhs, const Value* rhs,
                        const RuntimeValues& values, RuntimeValues& out_values,
                        uint32_t opcode) {
  if (!destination || !lhs || !rhs || !IsIntegerType(destination->type) ||
      !IsIntegerType(lhs->type) || !IsIntegerType(rhs->type)) return false;
  RuntimeValue a, b;
  if (!ResolveRuntimeValue(lhs, values, &a) || !ResolveRuntimeValue(rhs, values, &b)) {
    return false;
  }
  uint64_t au = 0, bu = 0;
  int64_t as = 0, bs = 0;
  RuntimeValue result;
  const uint32_t shift_mask = IntegerBitWidth(destination->type) - 1u;
  switch (opcode) {
    case xe::cpu::hir::OPCODE_ADD:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au + bu); break;
    case xe::cpu::hir::OPCODE_SUB:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au - bu); break;
    case xe::cpu::hir::OPCODE_MUL:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type, au * bu); break;
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_AND_NOT:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      if (opcode == xe::cpu::hir::OPCODE_AND) au &= bu;
      if (opcode == xe::cpu::hir::OPCODE_AND_NOT) au &= ~bu;
      if (opcode == xe::cpu::hir::OPCODE_OR) au |= bu;
      if (opcode == xe::cpu::hir::OPCODE_XOR) au ^= bu;
      SetUnsigned(&result, destination->type, au); break;
    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  opcode == xe::cpu::hir::OPCODE_SHL
                      ? au << (uint32_t(bu) & shift_mask)
                      : au >> (uint32_t(bu) & shift_mask));
      break;
    case xe::cpu::hir::OPCODE_SHA:
      if (!GetSigned(a, &as) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  static_cast<uint64_t>(as >> (uint32_t(bu) & shift_mask)));
      break;
    case xe::cpu::hir::OPCODE_COMPARE_EQ:
    case xe::cpu::hir::OPCODE_COMPARE_NE:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  opcode == xe::cpu::hir::OPCODE_COMPARE_EQ ? au == bu : au != bu);
      break;
    case xe::cpu::hir::OPCODE_COMPARE_ULT:
    case xe::cpu::hir::OPCODE_COMPARE_ULE:
    case xe::cpu::hir::OPCODE_COMPARE_UGT:
    case xe::cpu::hir::OPCODE_COMPARE_UGE:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_ULT) SetUnsigned(&result, destination->type, au < bu);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_ULE) SetUnsigned(&result, destination->type, au <= bu);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_UGT) SetUnsigned(&result, destination->type, au > bu);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_UGE) SetUnsigned(&result, destination->type, au >= bu);
      break;
    case xe::cpu::hir::OPCODE_COMPARE_SLT:
    case xe::cpu::hir::OPCODE_COMPARE_SLE:
    case xe::cpu::hir::OPCODE_COMPARE_SGT:
    case xe::cpu::hir::OPCODE_COMPARE_SGE:
      if (!GetSigned(a, &as) || !GetSigned(b, &bs)) return false;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLT) SetUnsigned(&result, destination->type, as < bs);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLE) SetUnsigned(&result, destination->type, as <= bs);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGT) SetUnsigned(&result, destination->type, as > bs);
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGE) SetUnsigned(&result, destination->type, as >= bs);
      break;
    default:
      return false;
  }
  out_values[destination] = result;
  return true;
}

bool ResolveGuestAddress(const Value* address, const Value* offset,
                         const RuntimeValues& values, uint32_t* guest_address) {
  uint64_t base = 0, displacement = 0;
  if (!guest_address || !ResolveUint64(address, values, &base)) return false;
  if (offset && !ResolveUint64(offset, values, &displacement)) return false;
  const uint64_t effective = base + displacement;
  if (effective > std::numeric_limits<uint32_t>::max()) return false;
  *guest_address = static_cast<uint32_t>(effective);
  return true;
}

bool TranslateGuestRange(xe::Memory* memory, uint32_t guest_address,
                         size_t size, uint8_t** host_address) {
  if (!memory || !host_address || !size) return false;
  const uint64_t last = uint64_t(guest_address) + size - 1u;
  if (last > std::numeric_limits<uint32_t>::max()) return false;
  auto* first = memory->TranslateVirtual<uint8_t*>(guest_address);
  auto* last_ptr = memory->TranslateVirtual<uint8_t*>(static_cast<uint32_t>(last));
  if (!first || !last_ptr) return false;
  *host_address = first;
  return true;
}

bool LoadGuestValue(xe::Memory* memory, Value* destination,
                    const Value* address, const Value* offset,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if (flags != 0 || !destination) return false;
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  uint8_t* host = nullptr;
  if (!TranslateGuestRange(memory, guest_address, size, &host)) return false;
  RuntimeValue loaded;
  loaded.type = destination->type;
  std::memcpy(&loaded.value, host, size);
  out_values[destination] = loaded;
  return true;
}

bool StoreGuestValue(xe::Memory* memory, const Value* address,
                     const Value* offset, const Value* source,
                     const RuntimeValues& values, uint32_t flags) {
  if (flags != 0 || !source) return false;
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(source->type);
  uint8_t* host = nullptr;
  if (!TranslateGuestRange(memory, guest_address, size, &host)) return false;
  return StoreResolvedValue(source, values, host, size);
}

HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,
                                    xe::Memory* memory,
                                    xe::cpu::ppc::PPCContext& context) {
  HIRCorrectnessResult result;
  if (!builder || !memory) return result;

  RuntimeValues values;
  bool supported = true;
  bool reached_return = false;
  auto* block = builder->first_block();

  while (block && supported && !reached_return) {
    auto* next_block = block->next;
    bool block_terminated = false;
    for (auto* instr = block->instr_head; instr && supported && !reached_return;
         instr = instr->next) {
      if (++result.instructions_executed > kMaxCorrectnessInstructions || !instr->opcode) {
        supported = false;
        break;
      }

      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
        case xe::cpu::hir::OPCODE_MEMORY_BARRIER:
          break;

        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS: {
          uint64_t return_address = 0;
          supported = ResolveUint64(instr->src1.value, values, &return_address);
          (void)return_address;
          break;
        }

        case xe::cpu::hir::OPCODE_STORE_CONTEXT: {
          auto* source = instr->src2.value;
          if (!source) { supported = false; break; }
          const size_t size = xe::cpu::hir::GetTypeSize(source->type);
          const uint64_t offset = instr->src1.offset;
          if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) {
            supported = false;
            break;
          }
          supported = StoreResolvedValue(
              source, values, reinterpret_cast<uint8_t*>(&context) + offset, size);
          break;
        }
        case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
          supported = LoadContextValue(context, instr->src1.offset, instr->dest, values);
          break;

        case xe::cpu::hir::OPCODE_LOAD:
          supported = LoadGuestValue(memory, instr->dest, instr->src1.value, nullptr,
                                     values, values, instr->flags);
          break;
        case xe::cpu::hir::OPCODE_LOAD_OFFSET:
          supported = LoadGuestValue(memory, instr->dest, instr->src1.value,
                                     instr->src2.value, values, values, instr->flags);
          break;
        case xe::cpu::hir::OPCODE_STORE:
          supported = StoreGuestValue(memory, instr->src1.value, nullptr,
                                      instr->src2.value, values, instr->flags);
          break;
        case xe::cpu::hir::OPCODE_STORE_OFFSET:
          supported = StoreGuestValue(memory, instr->src1.value, instr->src2.value,
                                      instr->src3.value, values, instr->flags);
          break;

        case xe::cpu::hir::OPCODE_ASSIGN:
        case xe::cpu::hir::OPCODE_CAST:
        case xe::cpu::hir::OPCODE_ZERO_EXTEND:
        case xe::cpu::hir::OPCODE_SIGN_EXTEND:
        case xe::cpu::hir::OPCODE_TRUNCATE:
        case xe::cpu::hir::OPCODE_NEG:
        case xe::cpu::hir::OPCODE_NOT:
        case xe::cpu::hir::OPCODE_BYTE_SWAP:
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
          supported = StoreBinaryInteger(instr->dest, instr->src1.value,
                                         instr->src2.value, values, values,
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
          const bool take = instr->opcode->num == xe::cpu::hir::OPCODE_BRANCH_TRUE
                                ? condition : !condition;
          if (supported && take) {
            supported = instr->src2.label && instr->src2.label->block;
            if (supported) next_block = instr->src2.label->block;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL:
          supported = g_call_resolver && instr->src1.symbol &&
                      g_call_resolver(instr->src1.symbol);
          break;
        case xe::cpu::hir::OPCODE_CALL_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (supported && condition) {
            supported = g_call_resolver && instr->src2.symbol &&
                        g_call_resolver(instr->src2.symbol);
          }
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
          uint64_t target = 0;
          supported = ResolveUint64(instr->src1.value, values, &target);
          if (supported) {
            (void)target;
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
            uint64_t target = 0;
            supported = ResolveUint64(instr->src2.value, values, &target);
            if (supported) {
              (void)target;
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

}  // namespace

void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver) {
  g_call_resolver = resolver;
}

bool IsHIRCorrectnessExecutionActive() { return g_execution_depth != 0; }

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(
    xe::cpu::hir::HIRBuilder* builder, xe::Memory* memory) {
  HIRCorrectnessResult result;
  if (!builder || !memory) return result;

  const bool outermost = g_active_context == nullptr;
  xe::cpu::ppc::PPCContext local_context{};
  if (outermost) {
    for (size_t i = 0; i < g_initial_gprs.size(); ++i) {
      local_context.r[i] = g_initial_gprs[i];
    }
    g_active_context = &local_context;
  }

  ++g_execution_depth;
  result = ExecuteBuilder(builder, memory, *g_active_context);
  --g_execution_depth;

  if (outermost) g_active_context = nullptr;
  return result;
}

}  // namespace render360::xenia_web
