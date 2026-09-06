#include "hir_correctness_executor.h"

#include <array>
#include <cmath>
#include <cstdio>
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
#include "sparse_guest_memory.h"
#include "title_gpu_runtime.h"

extern "C" {
uint32_t r360_ppc_probe_guest_base();
uint32_t r360_ppc_probe_loaded_size();
}

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
std::array<uint64_t, 32> g_last_gprs{};
HIRCorrectnessCallResolver g_call_resolver = nullptr;
HIRCorrectnessAddressResolver g_address_resolver = nullptr;
thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;
thread_local uint32_t g_execution_depth = 0;
thread_local bool g_context_provenance_recovery_enabled = false;

// Resolver callbacks are boolean, but real title calls may recursively execute
// another HIR builder. Preserve the exact nested blocker across that boundary.
thread_local bool g_pending_nested_failure_valid = false;
thread_local HIRCorrectnessResult g_pending_nested_failure{};

void ClearPendingNestedFailure() {
  g_pending_nested_failure_valid = false;
  g_pending_nested_failure = {};
}
void RecordPendingNestedFailure(const HIRCorrectnessResult& failure) {
  if (failure.supported || failure.blocker_kind == kHIRBlockerNone) return;
  g_pending_nested_failure = failure;
  g_pending_nested_failure_valid = true;
}
bool ConsumePendingNestedFailure(HIRCorrectnessResult* failure) {
  if (!failure || !g_pending_nested_failure_valid) return false;
  *failure = g_pending_nested_failure;
  ClearPendingNestedFailure();
  return true;
}
bool ResolveFunctionCallWithNestedFailure(xe::cpu::Function* function) {
  ClearPendingNestedFailure();
  if (!g_call_resolver || !g_call_resolver(function)) return false;
  ClearPendingNestedFailure();
  return true;
}
bool ResolveAddressCallWithNestedFailure(uint32_t target) {
  ClearPendingNestedFailure();
  if (!g_address_resolver || !g_address_resolver(target)) return false;
  ClearPendingNestedFailure();
  return true;
}

bool IsIntegerType(TypeName type) {
  return type == xe::cpu::hir::INT8_TYPE || type == xe::cpu::hir::INT16_TYPE ||
         type == xe::cpu::hir::INT32_TYPE || type == xe::cpu::hir::INT64_TYPE;
}

bool IsFloatType(TypeName type) {
  return type == xe::cpu::hir::FLOAT32_TYPE ||
         type == xe::cpu::hir::FLOAT64_TYPE;
}

uint32_t IntegerBitWidth(TypeName type) {
  return static_cast<uint32_t>(xe::cpu::hir::GetTypeSize(type) * 8u);
}

void SetUnsigned(RuntimeValue* out, TypeName type, uint64_t value) {
  if (!out) return;
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

bool ResolveRuntimeValue(const Value* value, const RuntimeValues& values,
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

bool ResolveUint64(const Value* value, const RuntimeValues& values,
                   uint64_t* out) {
  RuntimeValue resolved;
  return ResolveRuntimeValue(value, values, &resolved) &&
         GetUnsigned(resolved, out);
}

// Recover a value only when HIR itself proves that the value originated from
// PPCContext. This is intentionally narrow: V59 exact tail fragments can begin
// at a valid PPC instruction whose finalized HIR retains a STORE_CONTEXT using
// a context-derived SSA value whose defining LOAD_CONTEXT is no longer visited
// by the compatibility walk. Reading that proven context source from the live
// PPCContext is equivalent to entering the fragment with the guest registers it
// actually had at the tail boundary. Do not synthesize arbitrary missing SSA.
bool ResolveContextProvenance(const Value* value,
                              const xe::cpu::ppc::PPCContext& context,
                              RuntimeValue* out, uint64_t* context_offset,
                              uint32_t depth = 0) {
  if (!value || !out || depth > 8 || value->IsConstant()) return false;
  auto* def = value->def;
  if (!def || !def->opcode) return false;

  if (def->opcode->num == xe::cpu::hir::OPCODE_LOAD_CONTEXT) {
    const size_t size = xe::cpu::hir::GetTypeSize(value->type);
    const uint64_t offset = def->src1.offset;
    if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) {
      return false;
    }
    RuntimeValue recovered;
    recovered.type = value->type;
    recovered.value = {};
    std::memcpy(&recovered.value,
                reinterpret_cast<const uint8_t*>(&context) + offset, size);
    *out = recovered;
    if (context_offset) *context_offset = offset;
    return true;
  }

  // Context promotion can rewrite a repeated LOAD_CONTEXT as ASSIGN. Follow
  // only that identity chain; conversions/arithmetic are not safe to invent.
  if (def->opcode->num == xe::cpu::hir::OPCODE_ASSIGN && def->src1.value) {
    RuntimeValue recovered;
    uint64_t recovered_offset = 0;
    if (!ResolveContextProvenance(def->src1.value, context, &recovered,
                                  &recovered_offset, depth + 1) ||
        recovered.type != value->type) {
      return false;
    }
    *out = recovered;
    if (context_offset) *context_offset = recovered_offset;
    return true;
  }
  return false;
}

bool ResolveCondition(const Value* value, const RuntimeValues& values,
                      bool* out) {
  uint64_t raw = 0;
  if (!out || !ResolveUint64(value, values, &raw)) return false;
  *out = raw != 0;
  return true;
}

bool StoreResolvedValue(const Value* value, const RuntimeValues& values,
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
  std::memcpy(destination, &resolved.value, size);
  return true;
}

bool LoadContextValue(const xe::cpu::ppc::PPCContext& context, uint64_t offset,
                      Value* destination, RuntimeValues& values) {
  if (!destination) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) {
    return false;
  }
  RuntimeValue value;
  value.type = destination->type;
  std::memcpy(&value.value,
              reinterpret_cast<const uint8_t*>(&context) + offset, size);
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

bool ByteSwapRuntimeValue(RuntimeValue* value) {
  if (!value) return false;
  if (IsIntegerType(value->type)) {
    uint64_t raw = 0;
    if (!GetUnsigned(*value, &raw)) return false;
    SetUnsigned(value, value->type, ByteSwapUnsigned(raw, value->type));
    return true;
  }
  if (value->type == xe::cpu::hir::FLOAT32_TYPE) {
    uint32_t raw = 0;
    std::memcpy(&raw, &value->value.f32, sizeof(raw));
    raw = static_cast<uint32_t>(ByteSwapUnsigned(raw, xe::cpu::hir::INT32_TYPE));
    std::memcpy(&value->value.f32, &raw, sizeof(raw));
    return true;
  }
  if (value->type == xe::cpu::hir::FLOAT64_TYPE) {
    uint64_t raw = 0;
    std::memcpy(&raw, &value->value.f64, sizeof(raw));
    raw = ByteSwapUnsigned(raw, xe::cpu::hir::INT64_TYPE);
    std::memcpy(&value->value.f64, &raw, sizeof(raw));
    return true;
  }
  if (value->type == xe::cpu::hir::VEC128_TYPE) {
    for (size_t i = 0; i < 4; ++i) {
      value->value.v128.u32[i] = static_cast<uint32_t>(
          ByteSwapUnsigned(value->value.v128.u32[i], xe::cpu::hir::INT32_TYPE));
    }
    return true;
  }
  return false;
}

double RoundFloating(double value, uint32_t round_mode) {
  switch (round_mode) {
    case xe::cpu::hir::ROUND_TO_ZERO:
      return std::trunc(value);
    case xe::cpu::hir::ROUND_TO_NEAREST:
      return std::nearbyint(value);
    case xe::cpu::hir::ROUND_TO_MINUS_INFINITY:
      return std::floor(value);
    case xe::cpu::hir::ROUND_TO_POSITIVE_INFINITY:
      return std::ceil(value);
    case xe::cpu::hir::ROUND_DYNAMIC:
      return std::nearbyint(value);
    default:
      return value;
  }
}

bool StoreConvertValue(Value* destination, const RuntimeValue& src,
                       RuntimeValues& out_values, uint32_t round_mode) {
  if (!destination) return false;
  RuntimeValue result;
  result.type = destination->type;
  result.value = {};

  if (IsFloatType(src.type) && IsFloatType(destination->type)) {
    const double input = src.type == xe::cpu::hir::FLOAT32_TYPE
                             ? static_cast<double>(src.value.f32)
                             : src.value.f64;
    if (destination->type == xe::cpu::hir::FLOAT32_TYPE) {
      result.value.f32 = static_cast<float>(input);
    } else {
      result.value.f64 = input;
    }
    out_values[destination] = result;
    return true;
  }

  if (IsIntegerType(src.type) && IsFloatType(destination->type)) {
    int64_t signed_value = 0;
    if (!GetSigned(src, &signed_value)) return false;
    if (destination->type == xe::cpu::hir::FLOAT32_TYPE) {
      result.value.f32 = static_cast<float>(signed_value);
    } else {
      result.value.f64 = static_cast<double>(signed_value);
    }
    out_values[destination] = result;
    return true;
  }

  if (IsFloatType(src.type) && IsIntegerType(destination->type)) {
    const double input = src.type == xe::cpu::hir::FLOAT32_TYPE
                             ? static_cast<double>(src.value.f32)
                             : src.value.f64;
    if (!std::isfinite(input)) return false;
    const double rounded = RoundFloating(input, round_mode);
    if (destination->type == xe::cpu::hir::INT32_TYPE) {
      if (rounded < static_cast<double>(std::numeric_limits<int32_t>::min()) ||
          rounded > static_cast<double>(std::numeric_limits<int32_t>::max())) {
        return false;
      }
      SetUnsigned(&result, destination->type,
                  static_cast<uint64_t>(static_cast<int64_t>(rounded)));
    } else if (destination->type == xe::cpu::hir::INT64_TYPE) {
      const long double wide = static_cast<long double>(rounded);
      if (wide < static_cast<long double>(std::numeric_limits<int64_t>::min()) ||
          wide > static_cast<long double>(std::numeric_limits<int64_t>::max())) {
        return false;
      }
      SetUnsigned(&result, destination->type,
                  static_cast<uint64_t>(static_cast<int64_t>(rounded)));
    } else {
      return false;
    }
    out_values[destination] = result;
    return true;
  }

  return false;
}

bool StoreUnaryValue(Value* destination, const Value* source,
                     const RuntimeValues& values, RuntimeValues& out_values,
                     uint32_t opcode, uint32_t flags) {
  if (!destination || !source) return false;
  RuntimeValue src;
  if (!ResolveRuntimeValue(source, values, &src)) return false;

  if (opcode == xe::cpu::hir::OPCODE_CAST) {
    const size_t source_size = xe::cpu::hir::GetTypeSize(source->type);
    const size_t destination_size = xe::cpu::hir::GetTypeSize(destination->type);
    if (source_size != destination_size) return false;
    RuntimeValue result;
    result.type = destination->type;
    result.value = {};
    std::memcpy(&result.value, &src.value, source_size);
    out_values[destination] = result;
    return true;
  }

  if (opcode == xe::cpu::hir::OPCODE_CONVERT) {
    return StoreConvertValue(destination, src, out_values, flags);
  }

  if (opcode == xe::cpu::hir::OPCODE_IS_NAN &&
      IsFloatType(source->type) && IsIntegerType(destination->type)) {
    const bool is_nan = source->type == xe::cpu::hir::FLOAT32_TYPE
                            ? std::isnan(src.value.f32)
                            : std::isnan(src.value.f64);
    RuntimeValue result;
    SetUnsigned(&result, destination->type, is_nan ? 1u : 0u);
    out_values[destination] = result;
    return true;
  }

  if ((opcode == xe::cpu::hir::OPCODE_NEG ||
       opcode == xe::cpu::hir::OPCODE_ABS) &&
      IsFloatType(destination->type) && destination->type == source->type) {
    RuntimeValue result;
    result.type = destination->type;
    result.value = {};
    if (destination->type == xe::cpu::hir::FLOAT32_TYPE) {
      result.value.f32 = opcode == xe::cpu::hir::OPCODE_NEG
                             ? -src.value.f32
                             : std::fabs(src.value.f32);
    } else {
      result.value.f64 = opcode == xe::cpu::hir::OPCODE_NEG
                             ? -src.value.f64
                             : std::fabs(src.value.f64);
    }
    out_values[destination] = result;
    return true;
  }

  if (opcode == xe::cpu::hir::OPCODE_ROUND && IsFloatType(source->type) &&
      destination->type == source->type) {
    RuntimeValue result;
    result.type = destination->type;
    result.value = {};
    if (destination->type == xe::cpu::hir::FLOAT32_TYPE) {
      result.value.f32 = static_cast<float>(RoundFloating(src.value.f32, flags));
    } else {
      result.value.f64 = RoundFloating(src.value.f64, flags);
    }
    out_values[destination] = result;
    return true;
  }

  if (opcode == xe::cpu::hir::OPCODE_BYTE_SWAP &&
      destination->type == xe::cpu::hir::VEC128_TYPE &&
      source->type == xe::cpu::hir::VEC128_TYPE) {
    RuntimeValue result;
    result.type = xe::cpu::hir::VEC128_TYPE;
    result.value = {};
    for (size_t i = 0; i < 4; ++i) {
      result.value.v128.u32[i] = static_cast<uint32_t>(ByteSwapUnsigned(
          src.value.v128.u32[i], xe::cpu::hir::INT32_TYPE));
    }
    out_values[destination] = result;
    return true;
  }

  if (!IsIntegerType(destination->type) || !IsIntegerType(source->type)) {
    return false;
  }

  uint64_t u = 0;
  int64_t s = 0;
  RuntimeValue result;
  switch (opcode) {
    case xe::cpu::hir::OPCODE_ASSIGN:
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
      if (!GetUnsigned(src, &u) || destination->type != source->type) {
        return false;
      }
      SetUnsigned(&result, destination->type,
                  ByteSwapUnsigned(u, destination->type));
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

bool StoreBinaryValue(Value* destination, const Value* lhs, const Value* rhs,
                      const RuntimeValues& values, RuntimeValues& out_values,
                      uint32_t opcode) {
  if (!destination || !lhs || !rhs) return false;
  RuntimeValue a, b;
  // R360_V61_BINARY_CONTEXT_RECOVERY
  // Exact target-rooted tail fragments may begin after a context LOAD that
  // still defines an operand used by the first arithmetic instruction. Keep
  // normal execution strict; only V60's explicitly-scoped recovery mode may
  // materialize that proven PPCContext source.
  auto resolve_binary_operand = [&](const Value* operand, RuntimeValue* out,
                                    const char* side) -> bool {
    if (ResolveRuntimeValue(operand, values, out)) return true;
    if (!g_context_provenance_recovery_enabled || !g_active_context) {
      return false;
    }
    uint64_t context_offset = 0;
    if (!ResolveContextProvenance(operand, *g_active_context, out,
                                  &context_offset)) {
      return false;
    }
    std::fprintf(
        stderr,
        "R360_CONTEXT_VALUE_RECOVERY stage=binary side=%s load=0x%llX type=%u\n",
        side, static_cast<unsigned long long>(context_offset),
        static_cast<unsigned>(operand->type));
    return true;
  };
  if (!resolve_binary_operand(lhs, &a, "lhs") ||
      !resolve_binary_operand(rhs, &b, "rhs")) {
    return false;
  }

  if (IsFloatType(lhs->type) && lhs->type == rhs->type &&
      IsIntegerType(destination->type) &&
      (opcode == xe::cpu::hir::OPCODE_COMPARE_EQ ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_NE ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SLT ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SLE ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SGT ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SGE)) {
    const double av = lhs->type == xe::cpu::hir::FLOAT32_TYPE
                          ? static_cast<double>(a.value.f32)
                          : a.value.f64;
    const double bv = rhs->type == xe::cpu::hir::FLOAT32_TYPE
                          ? static_cast<double>(b.value.f32)
                          : b.value.f64;
    bool comparison = false;
    switch (opcode) {
      case xe::cpu::hir::OPCODE_COMPARE_EQ:
        comparison = av == bv;
        break;
      case xe::cpu::hir::OPCODE_COMPARE_NE:
        comparison = av != bv;
        break;
      case xe::cpu::hir::OPCODE_COMPARE_SLT:
        comparison = av < bv;
        break;
      case xe::cpu::hir::OPCODE_COMPARE_SLE:
        comparison = av <= bv;
        break;
      case xe::cpu::hir::OPCODE_COMPARE_SGT:
        comparison = av > bv;
        break;
      case xe::cpu::hir::OPCODE_COMPARE_SGE:
        comparison = av >= bv;
        break;
      default:
        return false;
    }
    RuntimeValue result;
    SetUnsigned(&result, destination->type, comparison ? 1u : 0u);
    out_values[destination] = result;
    return true;
  }

  if (IsFloatType(destination->type) && destination->type == lhs->type &&
      destination->type == rhs->type) {
    RuntimeValue result;
    result.type = destination->type;
    result.value = {};
    if (destination->type == xe::cpu::hir::FLOAT32_TYPE) {
      if (opcode == xe::cpu::hir::OPCODE_ADD) {
        result.value.f32 = a.value.f32 + b.value.f32;
      } else if (opcode == xe::cpu::hir::OPCODE_SUB) {
        result.value.f32 = a.value.f32 - b.value.f32;
      } else if (opcode == xe::cpu::hir::OPCODE_MUL) {
        result.value.f32 = a.value.f32 * b.value.f32;
      } else if (opcode == xe::cpu::hir::OPCODE_DIV) {
        result.value.f32 = a.value.f32 / b.value.f32;
      } else {
        return false;
      }
    } else {
      if (opcode == xe::cpu::hir::OPCODE_ADD) {
        result.value.f64 = a.value.f64 + b.value.f64;
      } else if (opcode == xe::cpu::hir::OPCODE_SUB) {
        result.value.f64 = a.value.f64 - b.value.f64;
      } else if (opcode == xe::cpu::hir::OPCODE_MUL) {
        result.value.f64 = a.value.f64 * b.value.f64;
      } else if (opcode == xe::cpu::hir::OPCODE_DIV) {
        result.value.f64 = a.value.f64 / b.value.f64;
      } else {
        return false;
      }
    }
    out_values[destination] = result;
    return true;
  }

  if (!IsIntegerType(destination->type) || !IsIntegerType(lhs->type) ||
      !IsIntegerType(rhs->type)) {
    return false;
  }

  uint64_t au = 0, bu = 0;
  int64_t as = 0, bs = 0;
  RuntimeValue result;
  const uint32_t shift_mask = IntegerBitWidth(destination->type) - 1u;
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
    case xe::cpu::hir::OPCODE_AND_NOT:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      if (opcode == xe::cpu::hir::OPCODE_AND) au &= bu;
      if (opcode == xe::cpu::hir::OPCODE_AND_NOT) au &= ~bu;
      if (opcode == xe::cpu::hir::OPCODE_OR) au |= bu;
      if (opcode == xe::cpu::hir::OPCODE_XOR) au ^= bu;
      SetUnsigned(&result, destination->type, au);
      break;
    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  opcode == xe::cpu::hir::OPCODE_SHL
                      ? au << (uint32_t(bu) & shift_mask)
                      : au >> (uint32_t(bu) & shift_mask));
      break;
    case xe::cpu::hir::OPCODE_ROTATE_LEFT: {
      if (destination->type != lhs->type || !GetUnsigned(a, &au) ||
          !GetUnsigned(b, &bu)) {
        return false;
      }
      const uint32_t width = IntegerBitWidth(destination->type);
      const uint32_t shift = uint32_t(bu) & shift_mask;
      const uint64_t width_mask =
          width == 64u ? ~uint64_t{0} : ((uint64_t{1} << width) - 1u);
      const uint64_t value = au & width_mask;
      const uint64_t rotated =
          shift == 0u
              ? value
              : ((value << shift) | (value >> (width - shift))) & width_mask;
      SetUnsigned(&result, destination->type, rotated);
      break;
    }
    case xe::cpu::hir::OPCODE_SHA:
      if (!GetSigned(a, &as) || !GetUnsigned(b, &bu)) return false;
      SetUnsigned(&result, destination->type,
                  static_cast<uint64_t>(as >> (uint32_t(bu) & shift_mask)));
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

bool StoreVectorAdd(Value* destination, const Value* lhs, const Value* rhs,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if (!destination || !lhs || !rhs ||
      destination->type != xe::cpu::hir::VEC128_TYPE ||
      lhs->type != xe::cpu::hir::VEC128_TYPE ||
      rhs->type != xe::cpu::hir::VEC128_TYPE) {
    return false;
  }
  RuntimeValue a, b;
  if (!ResolveRuntimeValue(lhs, values, &a) ||
      !ResolveRuntimeValue(rhs, values, &b)) {
    return false;
  }
  const auto part_type = static_cast<TypeName>(flags & 0xFFu);
  const uint32_t arithmetic_flags = flags >> 8;
  if (part_type != xe::cpu::hir::INT8_TYPE ||
      arithmetic_flags != xe::cpu::hir::ARITHMETIC_UNSIGNED) {
    return false;
  }
  RuntimeValue result;
  result.type = xe::cpu::hir::VEC128_TYPE;
  result.value = {};
  for (size_t i = 0; i < 16; ++i) {
    result.value.v128.u8[i] =
        static_cast<uint8_t>(a.value.v128.u8[i] + b.value.v128.u8[i]);
  }
  out_values[destination] = result;
  return true;
}

bool ResolveGuestAddress(const Value* address, const Value* offset,
                         const RuntimeValues& values,
                         uint32_t* guest_address) {
  uint64_t base = 0, displacement = 0;
  if (!guest_address || !ResolveUint64(address, values, &base)) return false;
  if (offset && !ResolveUint64(offset, values, &displacement)) return false;
  const uint32_t effective = static_cast<uint32_t>(base) +
                             static_cast<uint32_t>(displacement);
  *guest_address = effective;
  return true;
}

bool TranslateGuestRange(xe::Memory* memory, uint32_t guest_address,
                         size_t size, uint8_t** host_address) {
  if (!memory || !host_address || !size) return false;
  const uint64_t last = uint64_t(guest_address) + size - 1u;
  if (last > std::numeric_limits<uint32_t>::max()) return false;
  auto* first = memory->TranslateVirtual<uint8_t*>(guest_address);
  auto* last_ptr =
      memory->TranslateVirtual<uint8_t*>(static_cast<uint32_t>(last));
  if (!first || !last_ptr) return false;
  *host_address = first;
  return true;
}

bool IsSyntheticProbeWindowRange(uint32_t guest_address, size_t size) {
  if (!size) return false;
  const uint32_t base = r360_ppc_probe_guest_base();
  const uint32_t loaded = r360_ppc_probe_loaded_size();
  if (!loaded || guest_address < base) return false;
  const uint64_t end = uint64_t(guest_address) + size;
  const uint64_t window_end = uint64_t(base) + loaded;
  return end <= window_end && end <= 0x100000000ull;
}

bool LoadGuestValue(xe::Memory* memory, Value* destination,
                    const Value* address, const Value* offset,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if ((flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP) != 0 || !destination) {
    return false;
  }
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) {
    std::fprintf(stderr, "R360_HIR_MEMORY_FAIL op=resolve-load source=0x%08X\n",
                 guest_address);
    return false;
  }
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  RuntimeValue loaded;
  loaded.type = destination->type;
  loaded.value = {};

  // Xenos MMIO is not ordinary sparse RAM.
  if (size == 4 && destination->type == xe::cpu::hir::INT32_TYPE) {
    uint32_t mmio_value = 0;
    if (ReadTitleGpuMmio(guest_address, &mmio_value)) {
      loaded.value.u32 = static_cast<uint32_t>(
          ByteSwapUnsigned(mmio_value, xe::cpu::hir::INT32_TYPE));
      if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
          !ByteSwapRuntimeValue(&loaded)) {
        return false;
      }
      out_values[destination] = loaded;
      return true;
    }
  }

  // SparseGuestMemory is the authoritative Xbox address space. xe::Memory is
  // only the movable 64 KiB decoder window and may be used solely as a fallback
  // for synthetic probe fixtures that don't have a sparse mapping.
  if (!ReadSparseGuestMemory(guest_address, &loaded.value,
                             static_cast<uint32_t>(size))) {
    const uint32_t sparse_fault = SparseGuestLastFaultCode();
    const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();
    const bool in_probe_window = IsSyntheticProbeWindowRange(guest_address, size);
    uint8_t* host = nullptr;
    if (!in_probe_window ||
        !TranslateGuestRange(memory, guest_address, size, &host)) {
      std::fprintf(stderr,
                   "R360_HIR_MEMORY_FAIL op=load address=0x%08X fault=%u fault_address=0x%08X size=%u in_window=%u\n",
                   guest_address, sparse_fault, sparse_fault_address,
                   static_cast<unsigned>(size), in_probe_window ? 1u : 0u);
      return false;
    }
    std::memcpy(&loaded.value, host, size);
  }
  if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
      !ByteSwapRuntimeValue(&loaded)) {
    return false;
  }
  out_values[destination] = loaded;
  return true;
}


bool StoreGuestValue(xe::Memory* memory, const Value* address,
                     const Value* offset, const Value* source,
                     const RuntimeValues& values, uint32_t flags) {
  if ((flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP) != 0 || !source) {
    return false;
  }
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(source->type);
  RuntimeValue stored;
  if (!ResolveRuntimeValue(source, values, &stored) || stored.type != source->type) {
    return false;
  }
  if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
      !ByteSwapRuntimeValue(&stored)) {
    return false;
  }

  if (size == 4 && source->type == xe::cpu::hir::INT32_TYPE) {
    const uint32_t logical_value = static_cast<uint32_t>(
        ByteSwapUnsigned(stored.value.u32, xe::cpu::hir::INT32_TYPE));
    if (WriteTitleGpuMmio(guest_address, logical_value)) return true;
  }

  if (WriteSparseGuestMemory(guest_address, &stored.value,
                             static_cast<uint32_t>(size))) {
    return true;
  }
  const uint32_t sparse_fault = SparseGuestLastFaultCode();
  const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();
  const bool in_probe_window = IsSyntheticProbeWindowRange(guest_address, size);
  uint8_t* host = nullptr;
  if (!in_probe_window ||
      !TranslateGuestRange(memory, guest_address, size, &host)) {
    std::fprintf(stderr,
                 "R360_HIR_MEMORY_FAIL op=store address=0x%08X fault=%u fault_address=0x%08X size=%u in_window=%u\n",
                 guest_address, sparse_fault, sparse_fault_address,
                 static_cast<unsigned>(size), in_probe_window ? 1u : 0u);
    return false;
  }
  std::memcpy(host, &stored.value, size);
  return true;
}


bool DecodeDirectBranchTarget(uint32_t source_address, uint32_t ppc,
                                  uint32_t* target) {
  if (!target) return false;
  const uint32_t primary = ppc >> 26;
  int32_t displacement = 0;
  if (primary == 18u) {
    // I-form b/bl. LK is deliberately not part of validation: upstream Xenia
    // emits HIR CALL with CALL_TAIL for a direct b (LK=0), and HIR CALL for bl.
    displacement = static_cast<int32_t>(ppc & 0x03FFFFFCu);
    if (displacement & 0x02000000) {
      displacement |= static_cast<int32_t>(0xFC000000u);
    }
  } else if (primary == 16u) {
    // B-form bc/bcl. Xenia may lower an out-of-function conditional branch to
    // CALL_TRUE. BD||00 is a signed 16-bit displacement.
    displacement = static_cast<int32_t>(ppc & 0x0000FFFCu);
    if (displacement & 0x00008000) {
      displacement |= static_cast<int32_t>(0xFFFF0000u);
    }
  } else {
    return false;
  }
  *target = (ppc & 0x2u)
                ? static_cast<uint32_t>(displacement)
                : source_address + static_cast<uint32_t>(displacement);
  return true;
}

bool DecodeDirectBranchFromSource(uint32_t source_address, uint32_t* target) {
  uint8_t raw[4] = {};
  if (!ReadSparseGuestMemory(source_address, raw, sizeof(raw))) return false;
  const uint32_t ppc = (uint32_t(raw[0]) << 24) |
                       (uint32_t(raw[1]) << 16) |
                       (uint32_t(raw[2]) << 8) | uint32_t(raw[3]);
  return DecodeDirectBranchTarget(source_address, ppc, target);
}

bool ExecuteIndirect(uint64_t target, uint32_t flags, bool* reached_return,
                     bool* block_terminated) {
  if (!reached_return || !block_terminated) return false;
  if (flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) {
    *reached_return = true;
    *block_terminated = true;
    return true;
  }
  if (target > std::numeric_limits<uint32_t>::max()) return false;
  if (!ResolveAddressCallWithNestedFailure(static_cast<uint32_t>(target))) {
    return false;
  }
  if (flags & xe::cpu::hir::CALL_TAIL) {
    *reached_return = true;
    *block_terminated = true;
  }
  return true;
}

HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,
                                    xe::Memory* memory,
                                    xe::cpu::ppc::PPCContext& context) {
  HIRCorrectnessResult result;
  if (!builder || !memory) return result;

  RuntimeValues values;
  bool supported = true;
  bool reached_return = false;
  uint32_t current_source_address = 0;
  auto* block = builder->first_block();

  while (block && supported && !reached_return) {
    auto* next_block = block->next;
    bool block_terminated = false;
    for (auto* instr = block->instr_head;
         instr && supported && !reached_return; instr = instr->next) {
      if (++result.instructions_executed > kMaxCorrectnessInstructions) {
        result.blocker_kind = kHIRBlockerInstructionLimit;
        result.blocker_address = current_source_address;
        supported = false;
        break;
      }
      if (!instr->opcode) {
        result.blocker_kind = kHIRBlockerUnsupportedOpcode;
        result.blocker_address = current_source_address;
        supported = false;
        break;
      }

      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
          current_source_address = static_cast<uint32_t>(instr->src1.offset);
          break;
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
        case xe::cpu::hir::OPCODE_MEMORY_BARRIER:
          break;

        case xe::cpu::hir::OPCODE_CACHE_CONTROL:
          // Xenia lowers PPC cache-management instructions (for example Braid's
          // dcbt 0x7C00222C) to HIR CACHE_CONTROL. On x64, DATA_TOUCH is a host
          // prefetch and DATA_STORE/FLUSH becomes a host cache-line flush. The
          // browser runtime has one coherent sparse guest-memory backing and no
          // emulated CPU data cache, so these operations have no architectural
          // guest state to mutate. Treat the four Xenia-defined cache-control
          // kinds as semantic no-ops instead of converting a cache hint into a
          // false guest-memory dependency. Unknown flags remain fail-closed.
          switch (static_cast<xe::cpu::hir::CacheControlType>(instr->flags)) {
            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_TOUCH:
            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_TOUCH_FOR_STORE:
            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_STORE:
            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_STORE_AND_FLUSH:
              break;
            default:
              supported = false;
              break;
          }
          break;

        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS: {
          uint64_t return_address = 0;
          supported = ResolveUint64(instr->src1.value, values, &return_address);
          break;
        }

        case xe::cpu::hir::OPCODE_STORE_CONTEXT: {
          auto* source = instr->src2.value;
          if (!source) {
            supported = false;
            break;
          }
          const size_t size = xe::cpu::hir::GetTypeSize(source->type);
          const uint64_t offset = instr->src1.offset;
          if (offset > sizeof(context) ||
              size > sizeof(context) - size_t(offset)) {
            supported = false;
            break;
          }
          supported = StoreResolvedValue(
              source, values, reinterpret_cast<uint8_t*>(&context) + offset,
              size);
          if (!supported && g_context_provenance_recovery_enabled) {
            RuntimeValue recovered;
            uint64_t recovered_offset = 0;
            if (ResolveContextProvenance(source, context, &recovered,
                                         &recovered_offset)) {
              values[source] = recovered;
              supported = StoreResolvedValue(
                  source, values,
                  reinterpret_cast<uint8_t*>(&context) + offset, size);
              if (supported) {
                const uint32_t def_opcode =
                    source->def && source->def->opcode
                        ? source->def->opcode->num
                        : 0u;
                std::fprintf(
                    stderr,
                    "R360_CONTEXT_VALUE_RECOVERY ppc=0x%08X store=0x%llX "
                    "load=0x%llX def=%u type=%u\n",
                    current_source_address,
                    static_cast<unsigned long long>(offset),
                    static_cast<unsigned long long>(recovered_offset),
                    def_opcode, static_cast<unsigned>(source->type));
              }
            }
          }
          break;
        }
        case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
          supported = LoadContextValue(context, instr->src1.offset,
                                       instr->dest, values);
          break;

        case xe::cpu::hir::OPCODE_LOAD:
          supported = LoadGuestValue(memory, instr->dest, instr->src1.value,
                                     nullptr, values, values, instr->flags);
          break;
        case xe::cpu::hir::OPCODE_LOAD_OFFSET:
          supported = LoadGuestValue(memory, instr->dest, instr->src1.value,
                                     instr->src2.value, values, values,
                                     instr->flags);
          break;
        case xe::cpu::hir::OPCODE_STORE:
          supported = StoreGuestValue(memory, instr->src1.value, nullptr,
                                      instr->src2.value, values, instr->flags);
          break;
        case xe::cpu::hir::OPCODE_STORE_OFFSET:
          supported = StoreGuestValue(memory, instr->src1.value,
                                      instr->src2.value, instr->src3.value,
                                      values, instr->flags);
          break;

        case xe::cpu::hir::OPCODE_ASSIGN:
        case xe::cpu::hir::OPCODE_CAST:
        case xe::cpu::hir::OPCODE_ZERO_EXTEND:
        case xe::cpu::hir::OPCODE_SIGN_EXTEND:
        case xe::cpu::hir::OPCODE_TRUNCATE:
        case xe::cpu::hir::OPCODE_CONVERT:
        case xe::cpu::hir::OPCODE_ROUND:
        case xe::cpu::hir::OPCODE_NEG:
        case xe::cpu::hir::OPCODE_ABS:
        case xe::cpu::hir::OPCODE_NOT:
        case xe::cpu::hir::OPCODE_BYTE_SWAP:
        case xe::cpu::hir::OPCODE_IS_TRUE:
        case xe::cpu::hir::OPCODE_IS_FALSE:
        case xe::cpu::hir::OPCODE_IS_NAN:
          supported = StoreUnaryValue(instr->dest, instr->src1.value, values,
                                      values, instr->opcode->num, instr->flags);
          break;

        case xe::cpu::hir::OPCODE_VECTOR_ADD:
          supported = StoreVectorAdd(instr->dest, instr->src1.value,
                                     instr->src2.value, values, values,
                                     instr->flags);
          break;

        case xe::cpu::hir::OPCODE_ADD:
        case xe::cpu::hir::OPCODE_SUB:
        case xe::cpu::hir::OPCODE_MUL:
        case xe::cpu::hir::OPCODE_DIV:
        case xe::cpu::hir::OPCODE_AND:
        case xe::cpu::hir::OPCODE_AND_NOT:
        case xe::cpu::hir::OPCODE_OR:
        case xe::cpu::hir::OPCODE_XOR:
        case xe::cpu::hir::OPCODE_SHL:
        case xe::cpu::hir::OPCODE_SHR:
        case xe::cpu::hir::OPCODE_SHA:
        case xe::cpu::hir::OPCODE_ROTATE_LEFT:
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
          supported = StoreBinaryValue(instr->dest, instr->src1.value,
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
                                ? condition
                                : !condition;
          if (supported && take) {
            supported = instr->src2.label && instr->src2.label->block;
            if (supported) next_block = instr->src2.label->block;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL: {
          uint32_t target = 0;
          bool call_resolved = false;
          if (instr->src1.symbol) {
            // A real HIR symbol is authoritative. If its resolver rejects the
            // target, do not reinterpret the instruction as a different call.
            target = instr->src1.symbol->address();
            call_resolved =
                ResolveFunctionCallWithNestedFailure(instr->src1.symbol);
          } else if (g_address_resolver &&
                     DecodeDirectBranchFromSource(current_source_address,
                                                  &target)) {
            std::fprintf(stderr,
                         "R360_DIRECT_CALL_FALLBACK source=0x%08X target=0x%08X flags=0x%X\n",
                         current_source_address, target, instr->flags);
            call_resolved = ResolveAddressCallWithNestedFailure(target);
          }
          supported = call_resolved;
          if (supported && (instr->flags & xe::cpu::hir::CALL_TAIL)) {
            // Match Xenia's direct b semantics: after the callee returns there
            // is no continuation in this function.
            reached_return = true;
            block_terminated = true;
          }
          break;
        }
        case xe::cpu::hir::OPCODE_CALL_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (supported && condition) {
            uint32_t target = 0;
            bool call_resolved = false;
            if (instr->src2.symbol) {
              target = instr->src2.symbol->address();
              call_resolved =
                  ResolveFunctionCallWithNestedFailure(instr->src2.symbol);
            } else if (g_address_resolver &&
                       DecodeDirectBranchFromSource(current_source_address,
                                                    &target)) {
              std::fprintf(stderr,
                           "R360_DIRECT_CALL_TRUE_FALLBACK source=0x%08X target=0x%08X flags=0x%X\n",
                           current_source_address, target, instr->flags);
              call_resolved = ResolveAddressCallWithNestedFailure(target);
            }
            supported = call_resolved;
            if (supported && (instr->flags & xe::cpu::hir::CALL_TAIL)) {
              reached_return = true;
              block_terminated = true;
            }
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
          uint64_t target = 0;
          supported = ResolveUint64(instr->src1.value, values, &target);
          if (supported) {
            supported = ExecuteIndirect(target, instr->flags, &reached_return,
                                        &block_terminated);
          }
          break;
        }
        case xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (!supported || !condition) break;
          uint64_t target = 0;
          supported = ResolveUint64(instr->src2.value, values, &target);
          if (supported) {
            supported = ExecuteIndirect(target, instr->flags, &reached_return,
                                        &block_terminated);
          }
          break;
        }

        default:
          supported = false;
          break;
      }
      if (!supported && result.blocker_kind == kHIRBlockerNone) {
        HIRCorrectnessResult nested_failure;
        if (ConsumePendingNestedFailure(&nested_failure)) {
          result.blocker_kind = nested_failure.blocker_kind;
          result.blocker_opcode = nested_failure.blocker_opcode;
          result.blocker_address = nested_failure.blocker_address;
          std::fprintf(stderr,
                       "R360_NESTED_BLOCKER propagated kind=%u opcode=%u address=0x%08X outer=0x%08X\n",
                       result.blocker_kind, result.blocker_opcode,
                       result.blocker_address, current_source_address);
        }
      }
      if (!supported && result.blocker_kind == kHIRBlockerNone) {
        const uint32_t opcode = instr->opcode ? instr->opcode->num : 0;
        const bool call_boundary =
            opcode == xe::cpu::hir::OPCODE_CALL ||
            opcode == xe::cpu::hir::OPCODE_CALL_TRUE ||
            opcode == xe::cpu::hir::OPCODE_CALL_INDIRECT ||
            opcode == xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE;
        const bool memory_boundary =
            opcode == xe::cpu::hir::OPCODE_LOAD ||
            opcode == xe::cpu::hir::OPCODE_LOAD_OFFSET ||
            opcode == xe::cpu::hir::OPCODE_STORE ||
            opcode == xe::cpu::hir::OPCODE_STORE_OFFSET;
        result.blocker_kind = call_boundary
                                  ? kHIRBlockerUnresolvedCall
                                  : memory_boundary ? kHIRBlockerGuestMemory
                                                    : kHIRBlockerUnsupportedOpcode;
        result.blocker_opcode = opcode;
        result.blocker_address = current_source_address;
      }
      if (block_terminated) break;
    }
    block = next_block;
  }

  result.supported = supported;
  result.reached_return_boundary = reached_return;
  result.r3 = context.r[3];
  if (supported && !reached_return && result.blocker_kind == kHIRBlockerNone) {
    result.blocker_kind = kHIRBlockerNoReturnBoundary;
    result.blocker_address = current_source_address;
  }
  return result;
}

}  // namespace

void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_last_gprs.fill(0);
}

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

uint64_t GetHIRCorrectnessLastGPR(uint32_t index) {
  return index < g_last_gprs.size() ? g_last_gprs[index] : 0;
}

void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver) {
  g_call_resolver = resolver;
}

void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver) {
  g_address_resolver = resolver;
}

void SetHIRCorrectnessContextProvenanceRecovery(bool enabled) {
  g_context_provenance_recovery_enabled = enabled;
}

bool IsHIRCorrectnessExecutionActive() { return g_execution_depth != 0; }

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(
    xe::cpu::hir::HIRBuilder* builder, xe::Memory* memory) {
  HIRCorrectnessResult result;
  if (!builder || !memory) return result;

  const bool outermost = g_active_context == nullptr;
  if (outermost) ClearPendingNestedFailure();
  xe::cpu::ppc::PPCContext local_context{};
  if (outermost) {
    for (size_t i = 0; i < g_initial_gprs.size(); ++i) {
      local_context.r[i] = g_initial_gprs[i];
    }
    g_active_context = &local_context;
  }

  ++g_execution_depth;
  result = ExecuteBuilder(builder, memory, *g_active_context);
  // Snapshot after the builder returns, including failure. The context still
  // contains the exact architectural state at the blocker, and outermost
  // execution owns that state for the complete title call chain.
  if (outermost && g_active_context) {
    for (size_t i = 0; i < g_last_gprs.size(); ++i) {
      g_last_gprs[i] = g_active_context->r[i];
    }
  }
  --g_execution_depth;

  if (!outermost && !result.supported &&
      result.blocker_kind != kHIRBlockerNone) {
    RecordPendingNestedFailure(result);
  }
  if (outermost) g_active_context = nullptr;
  return result;
}

}  // namespace render360::xenia_web
