#include "hir_correctness_executor.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <limits>
#include <string>
#include <utility>
#include <unordered_map>
#include <vector>

#include "xenia/cpu/function.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/label.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"
#include "xenia/memory.h"
#include "hir_vector_semantics.h"
#include "sparse_guest_memory.h"
#include "title_gpu_runtime.h"

extern "C" {
uint32_t r360_ppc_probe_guest_base();
uint32_t r360_ppc_probe_loaded_size();
}

namespace render360::xenia_web {

bool g_r360_verbose_trace = false;

namespace {

using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
constexpr uint32_t kMaxCorrectnessInstructions = 4096;

struct RuntimeValue {
  TypeName type = xe::cpu::hir::INT64_TYPE;
  Value::ConstantValue value{};
};
// SSA value storage indexed by Xenia's per-builder Value::ordinal. Ordinals
// are unique within a builder (HIRBuilder::AllocValue/CloneValue hand out
// next_value_ordinal_++, and ValueReductionPass, the only pass that reuses
// them, is disabled in Xenia's PPCTranslator). Each slot also records its
// owning Value, so a lookup can only ever miss, never alias another value.
// This replaces a pointer-hash map on the interpreter's hottest path while
// keeping the find()/end()/operator[] shape the executor overlays rely on.
class RuntimeValues {
 public:
  struct Slot {
    const Value* first = nullptr;
    RuntimeValue second{};
  };
  const Slot* find(const Value* value) const {
    const uint32_t ordinal = value->ordinal;
    if (ordinal >= slots_.size() || slots_[ordinal].first != value) {
      return nullptr;
    }
    return &slots_[ordinal];
  }
  const Slot* end() const { return nullptr; }
  RuntimeValue& operator[](const Value* value) {
    const uint32_t ordinal = value->ordinal;
    if (ordinal >= slots_.size()) {
      size_t grown = slots_.size() * 2 + 64;
      if (grown <= ordinal) grown = size_t(ordinal) + 64;
      slots_.resize(grown);
    }
    Slot& slot = slots_[ordinal];
    if (slot.first != value) {
      slot.first = value;
      slot.second = RuntimeValue{};
    }
    return slot.second;
  }

 private:
  std::vector<Slot> slots_;
};

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
    case xe::cpu::hir::OPCODE_CNTLZ: {
      // Xenia's HIR CNTLZ always returns the count in an INT8 value while
      // preserving the source width (8/16/32/64) for the leading-zero count.
      // The all-zero input therefore returns the exact source width.
      if (destination->type != xe::cpu::hir::INT8_TYPE ||
          !GetUnsigned(src, &u)) {
        return false;
      }
      const uint32_t width = IntegerBitWidth(source->type);
      if (!width || width > 64u) return false;
      uint32_t leading = 0;
      for (uint32_t bit = width; bit > 0; --bit) {
        if ((u >> (bit - 1u)) & uint64_t{1}) break;
        ++leading;
      }
      SetUnsigned(&result, destination->type, leading);
      break;
    }
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
    if (g_debug_watch_address && g_debug_watch_address - guest_address < size) {
      std::fprintf(stderr, "R360_WATCH cpu pc=0x%08X address=0x%08X size=%u value=0x%llX\n",
                   g_current_source_address, guest_address, unsigned(size),
                   static_cast<unsigned long long>(stored.value.u64));
    }
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

// Optional cap on guest instructions across every frame of one title run
// (r360_hir_set_total_instruction_budget; 0 = unlimited). Lets a headless
// run stop at a chosen point and report where the title is.
// Debug watchpoint (r360_debug_watch): logs every guest store to it.
uint32_t g_debug_watch_address = 0;
uint64_t g_total_instruction_budget = 0;
uint64_t g_total_instructions = 0;
uint64_t g_opcode_histogram[256] = {};  // executed HIR opcodes (run-title R360_OPHIST)
// Guest address of the last SOURCE_OFFSET executed (diagnostics).
uint32_t g_last_source_address = 0;

// PPC FPSCR[RN] as set through SET_ROUNDING_MODE (Xenia loads the matching
// MXCSR: 0 nearest, 1 toward zero, 2 toward +inf, 3 toward -inf; bit 2 is
// FPSCR[NI] flush-to-zero). WebAssembly arithmetic always rounds to nearest,
// so the mode is applied where Xenia's x64 code reads MXCSR explicitly:
// non-truncating float -> integer conversion.
thread_local uint32_t g_ppc_rounding_mode = 0;

double RoundWithPpcMode(double v) {
  switch (g_ppc_rounding_mode & 3u) {
    case 1: return std::trunc(v);
    case 2: return std::ceil(v);
    case 3: return std::floor(v);
    default: return std::nearbyint(v);
  }
}

// Vector (VMX/VMX128) and floating-point HIR operations, ported from Xenia's
// x64 sequences via hir_vector_semantics.h. Returns false when the opcode is
// not handled here; *supported reports the outcome when it is.
bool ExecuteVectorOperation(const xe::cpu::hir::Instr* instr,
                            RuntimeValues& values, bool* supported) {
  using namespace xe::cpu::hir;
  namespace vs = vector_semantics;
  const auto opcode = instr->opcode->num;
  Value* dest = instr->dest;
  const Value* s1 = instr->src1.value;
  auto is_vec = [](const Value* v) { return v && v->type == VEC128_TYPE; };
  switch (opcode) {
    case OPCODE_PACK: case OPCODE_UNPACK: case OPCODE_PERMUTE:
    case OPCODE_SWIZZLE: case OPCODE_EXTRACT: case OPCODE_INSERT:
    case OPCODE_SPLAT: case OPCODE_VECTOR_CONVERT_I2F:
    case OPCODE_VECTOR_CONVERT_F2I: case OPCODE_LOAD_VECTOR_SHL:
    case OPCODE_LOAD_VECTOR_SHR: case OPCODE_VECTOR_MAX:
    case OPCODE_VECTOR_MIN: case OPCODE_VECTOR_ADD: case OPCODE_VECTOR_SUB:
    case OPCODE_VECTOR_ROTATE_LEFT: case OPCODE_VECTOR_AVERAGE:
    case OPCODE_DOT_PRODUCT_3: case OPCODE_DOT_PRODUCT_4:
    case OPCODE_MUL_ADD: case OPCODE_MUL_SUB: case OPCODE_SQRT:
    case OPCODE_RSQRT: case OPCODE_RECIP: case OPCODE_POW2: case OPCODE_LOG2:
      break;
    case OPCODE_VECTOR_COMPARE_EQ: case OPCODE_VECTOR_COMPARE_SGT:
    case OPCODE_VECTOR_COMPARE_SGE: case OPCODE_VECTOR_COMPARE_UGT:
    case OPCODE_VECTOR_COMPARE_UGE:
      // Integer lanes stay on the VMX overlay path.
      if (instr->flags != FLOAT32_TYPE) return false;
      break;
    case OPCODE_MUL: case OPCODE_DIV: case OPCODE_ADD: case OPCODE_SUB:
    case OPCODE_MAX: case OPCODE_MIN:
      if (!is_vec(dest)) return false;
      break;
    case OPCODE_SELECT:
      if (!is_vec(s1)) return false;
      break;
    case OPCODE_NOT: case OPCODE_NEG: case OPCODE_SHL: case OPCODE_SHR:
    case OPCODE_ROUND:
      if (!is_vec(dest)) return false;
      break;
    case OPCODE_IS_TRUE: case OPCODE_IS_FALSE:  // vptest + setnz/setz
      if (!is_vec(s1)) return false;
      break;
    case OPCODE_CONVERT:
      // Float -> integer keeps x86's out-of-range behaviour as Xenia does.
      if (!dest || !IsIntegerType(dest->type) || !s1 || !IsFloatType(s1->type)) return false;
      break;
    case OPCODE_DID_SATURATE:
      // x64 DID_SATURATE: "TODO: implement saturation check" -> always 0.
      *supported = dest != nullptr;
      if (dest) { RuntimeValue zero; SetUnsigned(&zero, dest->type, 0); values[dest] = zero; }
      return true;
    default:
      return false;
  }
  *supported = false;
  if (!dest) return true;
  RuntimeValue a{}, b{}, c{};
  const bool has2 = instr->src2.value && opcode != OPCODE_SWIZZLE;
  if (!ResolveRuntimeValue(s1, values, &a)) return true;
  if (has2 && !ResolveRuntimeValue(instr->src2.value, values, &b)) return true;
  const bool has3 = opcode == OPCODE_PERMUTE || opcode == OPCODE_INSERT ||
                    opcode == OPCODE_MUL_ADD || opcode == OPCODE_MUL_SUB ||
                    opcode == OPCODE_SELECT;
  if (has3 && !ResolveRuntimeValue(instr->src3.value, values, &c)) return true;
  const vec128_t& va = a.value.v128;
  const vec128_t& vb = b.value.v128;
  const vec128_t& vc = c.value.v128;
  RuntimeValue result;
  result.type = dest->type;
  result.value = {};
  vec128_t& out = result.value.v128;
  bool ok = true;
  // Applies a float function lane-wise for F32/F64/V128 destinations.
  auto unary_float = [&](auto fn) {
    if (dest->type == FLOAT32_TYPE) result.value.f32 = float(fn(double(a.value.f32), true));
    else if (dest->type == FLOAT64_TYPE) result.value.f64 = fn(a.value.f64, false);
    else if (dest->type == VEC128_TYPE) for (int i = 0; i < 4; ++i) out.f32[i] = float(fn(double(va.f32[i]), true));
    else ok = false;
  };
  switch (opcode) {
    case OPCODE_PACK: ok = vs::Pack(instr->flags, va, vb, &out); break;
    case OPCODE_UNPACK: ok = vs::Unpack(instr->flags, va, &out); break;
    case OPCODE_PERMUTE:
      if (s1->type == INT32_TYPE) out = vs::PermuteI32(a.value.u32, vb, vc);
      else if (instr->flags == INT8_TYPE) out = vs::PermuteBytes(va, vb, vc);
      else if (instr->flags == INT16_TYPE) out = vs::PermuteHalves(va, vb, vc);
      else ok = false;
      break;
    case OPCODE_SWIZZLE:
      if (instr->flags == INT32_TYPE || instr->flags == FLOAT32_TYPE)
        out = vs::PShufD(va, uint8_t(instr->src2.offset));
      else ok = false;
      break;
    case OPCODE_EXTRACT: {
      const uint32_t index = b.value.u8;
      switch (dest->type) {
        case INT8_TYPE: result.value.u8 = va.u8[(index ^ 3) & 0xF]; break;
        case INT16_TYPE: result.value.u16 = va.u16[(index ^ 1) & 7]; break;
        case INT32_TYPE: result.value.u32 = va.u32[index & 3]; break;
        case FLOAT32_TYPE: result.value.f32 = va.f32[index & 3]; break;
        default: ok = false;
      }
      break;
    }
    case OPCODE_INSERT: {
      out = va;
      const uint32_t index = b.value.u8;
      switch (instr->src3.value->type) {
        case INT8_TYPE: out.u8[(index ^ 3) & 0xF] = c.value.u8; break;
        case INT16_TYPE: out.u16[(index ^ 1) & 7] = c.value.u16; break;
        case INT32_TYPE: out.u32[index & 3] = c.value.u32; break;
        case FLOAT32_TYPE: out.f32[index & 3] = c.value.f32; break;
        default: ok = false;
      }
      break;
    }
    case OPCODE_SPLAT:
      switch (s1->type) {
        case INT8_TYPE: for (int i = 0; i < 16; ++i) out.u8[i] = a.value.u8; break;
        case INT16_TYPE: for (int i = 0; i < 8; ++i) out.u16[i] = a.value.u16; break;
        case INT32_TYPE: for (int i = 0; i < 4; ++i) out.u32[i] = a.value.u32; break;
        case FLOAT32_TYPE: for (int i = 0; i < 4; ++i) out.f32[i] = a.value.f32; break;
        default: ok = false;
      }
      break;
    case OPCODE_VECTOR_CONVERT_I2F:
      out = vs::VectorConvertI2F(va, instr->flags & ARITHMETIC_UNSIGNED);
      break;
    case OPCODE_VECTOR_CONVERT_F2I:
      out = vs::VectorConvertF2I(va, instr->flags & ARITHMETIC_UNSIGNED);
      break;
    case OPCODE_LOAD_VECTOR_SHL:
    case OPCODE_LOAD_VECTOR_SHR: {
      // lvsl_table / lvsr_table: PPC byte j = sh + j (lvsl) or 16 - sh + j.
      const uint32_t sh = a.value.u8 & 0xF;
      for (int j = 0; j < 16; ++j)
        out.u8[j ^ 3] = uint8_t(opcode == OPCODE_LOAD_VECTOR_SHL ? sh + j : 16 - sh + j);
      break;
    }
    case OPCODE_VECTOR_MAX: case OPCODE_VECTOR_MIN:
      ok = vs::VectorMinMax(instr->flags, opcode == OPCODE_VECTOR_MAX, va, vb, &out);
      break;
    case OPCODE_VECTOR_ADD: case OPCODE_VECTOR_SUB:
      ok = vs::VectorAddSub(instr->flags, opcode == OPCODE_VECTOR_SUB, va, vb, &out);
      break;
    case OPCODE_VECTOR_COMPARE_EQ: case OPCODE_VECTOR_COMPARE_SGT:
    case OPCODE_VECTOR_COMPARE_SGE: case OPCODE_VECTOR_COMPARE_UGT:
    case OPCODE_VECTOR_COMPARE_UGE:
      ok = vs::VectorCompareFloat(opcode, va, vb, &out);
      break;
    case OPCODE_VECTOR_ROTATE_LEFT:
      ok = vs::VectorRotateLeft(instr->flags, va, vb, &out);
      break;
    case OPCODE_VECTOR_AVERAGE:
      ok = vs::VectorAverage(instr->flags, va, vb, &out);
      break;
    case OPCODE_DOT_PRODUCT_3: case OPCODE_DOT_PRODUCT_4:
      result.value.f32 = vs::DotProduct(va, vb, opcode == OPCODE_DOT_PRODUCT_3 ? 3 : 4);
      break;
    case OPCODE_MUL_ADD: case OPCODE_MUL_SUB: {
      const bool sub = opcode == OPCODE_MUL_SUB;
      if (dest->type == FLOAT64_TYPE) {
        // vfmadd/vfmsub (fused) as Xenia emits with FMA.
        result.value.f64 = std::fma(a.value.f64, b.value.f64, sub ? -c.value.f64 : c.value.f64);
      } else if (dest->type == FLOAT32_TYPE) {
        result.value.f32 = std::fma(a.value.f32, b.value.f32, sub ? -c.value.f32 : c.value.f32);
      } else if (dest->type == VEC128_TYPE) {
        // MUL_ADD_V128: Xenia keeps vmulps + vaddps (unfused) so tests pass.
        for (int i = 0; i < 4; ++i) {
          const float m = va.f32[i] * vb.f32[i];
          out.f32[i] = sub ? m - vc.f32[i] : m + vc.f32[i];
        }
      } else {
        ok = false;
      }
      break;
    }
    case OPCODE_SQRT:
      unary_float([](double x, bool f32) { return f32 ? double(std::sqrt(float(x))) : std::sqrt(x); });
      break;
    case OPCODE_RSQRT:
      unary_float([](double x, bool f32) { return f32 ? double(1.0f / std::sqrt(float(x))) : 1.0 / std::sqrt(x); });
      break;
    case OPCODE_RECIP:
      unary_float([](double x, bool f32) { return f32 ? double(1.0f / float(x)) : 1.0 / x; });
      break;
    case OPCODE_POW2:
      unary_float([](double x, bool f32) { return f32 ? double(std::exp2(float(x))) : std::exp2(x); });
      break;
    case OPCODE_LOG2:
      unary_float([](double x, bool f32) { return f32 ? double(std::log2(float(x))) : std::log2(x); });
      break;
    case OPCODE_MUL: case OPCODE_DIV: case OPCODE_ADD: case OPCODE_SUB:
      for (int i = 0; i < 4; ++i) {
        const float x = va.f32[i], y = vb.f32[i];
        out.f32[i] = opcode == OPCODE_MUL ? x * y : opcode == OPCODE_DIV ? x / y
                   : opcode == OPCODE_ADD ? x + y : x - y;
      }
      break;
    case OPCODE_MAX: out = vs::MaxPS(va, vb); break;
    case OPCODE_MIN: out = vs::MinPS(va, vb); break;
    case OPCODE_IS_TRUE: case OPCODE_IS_FALSE: {
      const bool any = (va.u64[0] | va.u64[1]) != 0;
      SetUnsigned(&result, dest->type, (opcode == OPCODE_IS_TRUE) == any ? 1u : 0u);
      break;
    }
    case OPCODE_NOT:
      out.u64[0] = ~va.u64[0]; out.u64[1] = ~va.u64[1];
      break;
    case OPCODE_NEG:  // vxorps with the sign mask.
      for (int i = 0; i < 4; ++i) out.u32[i] = va.u32[i] ^ 0x80000000u;
      break;
    case OPCODE_SHL: case OPCODE_SHR: {
      // EmulateShlV128 / EmulateShrV128: whole-register shift by 0..7 bits
      // in PPC byte order (vsl / vsr).
      const uint8_t sh = b.value.u8 & 0x7;
      out = va;
      if (sh) {
        if (opcode == OPCODE_SHL) {
          for (int j = 0; j < 15; ++j)
            out.u8[j ^ 3] = uint8_t((out.u8[j ^ 3] << sh) | (out.u8[(j + 1) ^ 3] >> (8 - sh)));
          out.u8[15 ^ 3] = uint8_t(out.u8[15 ^ 3] << sh);
        } else {
          for (int j = 15; j > 0; --j)
            out.u8[j ^ 3] = uint8_t((out.u8[j ^ 3] >> sh) | (out.u8[(j - 1) ^ 3] << (8 - sh)));
          out.u8[0 ^ 3] = uint8_t(out.u8[0 ^ 3] >> sh);
        }
      }
      break;
    }
    case OPCODE_ROUND:  // vroundps with the HIR rounding mode.
      for (int i = 0; i < 4; ++i) {
        const float x = va.f32[i];
        switch (instr->flags) {
          case ROUND_TO_ZERO: out.f32[i] = std::trunc(x); break;
          case ROUND_TO_NEAREST: out.f32[i] = std::nearbyint(x); break;
          case ROUND_TO_MINUS_INFINITY: out.f32[i] = std::floor(x); break;
          case ROUND_TO_POSITIVE_INFINITY: out.f32[i] = std::ceil(x); break;
          default: ok = false;
        }
      }
      break;
    case OPCODE_CONVERT: {
      double x = s1->type == FLOAT32_TYPE ? double(a.value.f32) : a.value.f64;
      const bool trunc = instr->flags == ROUND_TO_ZERO;
      auto cvt = [&](double v, double lo, double hi, int64_t indefinite) -> int64_t {
        // cvt(t)sd2si: NaN or out of range gives the "integer indefinite".
        if (std::isnan(v)) return indefinite;
        const double r = trunc ? std::trunc(v) : RoundWithPpcMode(v);
        if (r < lo || r > hi) return indefinite;
        return int64_t(r);
      };
      if (dest->type == INT64_TYPE) {
        int64_t r = cvt(x, -9223372036854775808.0, 9223372036854774784.0, INT64_MIN);
        // CONVERT_I64_F64: an indefinite result from a non-negative source
        // saturates to INT64_MAX.
        if (r == INT64_MIN && !std::signbit(x)) r = INT64_MAX;
        SetUnsigned(&result, dest->type, uint64_t(r));
      } else {
        // CONVERT_I32_F64 clamps with vminsd(src, INT_MAX) first (a NaN
        // source yields the INT_MAX operand); I32_F32 does not.
        if (s1->type == FLOAT64_TYPE) x = x < 2147483647.0 ? x : 2147483647.0;
        const int64_t r = cvt(x, -2147483648.0, 2147483647.0, INT32_MIN);
        SetUnsigned(&result, dest->type, uint64_t(r));
      }
      break;
    }
    case OPCODE_SELECT:
      // SELECT_V128_V128: (src1 & src3) | (~src1 & src2).
      for (int i = 0; i < 2; ++i) out.u64[i] = (va.u64[i] & vc.u64[i]) | (~va.u64[i] & vb.u64[i]);
      break;
    default:
      ok = false;
  }
  if (!ok) return true;
  values[dest] = result;
  *supported = true;
  return true;
}

// Integer HIR operations whose semantics depend on instr->flags or a third
// operand. Each case follows Xenia's x64 backend sequence for the same opcode
// (x64_sequences.cc) so a title computes exactly what it computes in Xenia.
// Returns false when the opcode is not one of these; *supported reports the
// outcome when it is.
bool ExecuteFlaggedOperation(const xe::cpu::hir::Instr* instr,
                             RuntimeValues& values, bool* supported) {
  using namespace xe::cpu::hir;
  if (ExecuteVectorOperation(instr, values, supported)) return true;
  const auto opcode = instr->opcode->num;
  Value* dest = instr->dest;
  switch (opcode) {
    case OPCODE_ADD_CARRY:
    case OPCODE_MUL_HI:
    case OPCODE_SELECT:
    case OPCODE_MIN:
    case OPCODE_MAX:
      break;
    case OPCODE_DIV:
      if (!dest || !IsIntegerType(dest->type)) return false;
      break;
    case OPCODE_COMMENT:
    case OPCODE_NOP:
      *supported = true;
      return true;
    case OPCODE_MEMSET: {
      // dcbz / dcbz128: MEMSET(address, i8 value, length) on guest memory.
      uint64_t address = 0, length = 0, byte = 0;
      *supported = ResolveUint64(instr->src1.value, values, &address) &&
                   ResolveUint64(instr->src2.value, values, &byte) &&
                   ResolveUint64(instr->src3.value, values, &length) &&
                   length <= 4096;
      if (*supported && length) {
        uint8_t fill[4096];
        std::memset(fill, int(byte & 0xFF), size_t(length));
        *supported = WriteSparseGuestMemory(static_cast<uint32_t>(address), fill,
                                            static_cast<uint32_t>(length));
      }
      return true;
    }
    case OPCODE_ATOMIC_EXCHANGE:
    case OPCODE_ATOMIC_COMPARE_EXCHANGE: {
      // stwcx./stdcx. (and kernel interlocked helpers): the HIR values are
      // already byte-swapped, so like Xenia's x64 lock cmpxchg/xchg this
      // compares and stores the raw guest bytes. Single host thread: atomic.
      *supported = false;
      const bool cas = opcode == OPCODE_ATOMIC_COMPARE_EXCHANGE;
      const Value* value_operand = cas ? instr->src3.value : instr->src2.value;
      uint64_t address = 0;
      RuntimeValue compare{}, store{};
      if (!value_operand || !ResolveUint64(instr->src1.value, values, &address) ||
          !ResolveRuntimeValue(value_operand, values, &store) ||
          (cas && !ResolveRuntimeValue(instr->src2.value, values, &compare))) {
        return true;
      }
      const uint32_t size = uint32_t(xe::cpu::hir::GetTypeSize(value_operand->type));
      if (size != 1 && size != 2 && size != 4 && size != 8) return true;
      uint64_t current = 0;
      const uint32_t guest = static_cast<uint32_t>(address);
      if (!ReadSparseGuestMemory(guest, &current, size)) return true;
      uint64_t expected = 0, desired = 0;
      std::memcpy(&desired, &store.value, size);
      if (cas) std::memcpy(&expected, &compare.value, size);
      const bool swap = !cas || current == expected;
      if (swap && !WriteSparseGuestMemory(guest, &desired, size)) return true;
      if (dest) {
        RuntimeValue out;
        if (cas) {
          SetUnsigned(&out, dest->type, swap ? 1u : 0u);
        } else {
          out.type = dest->type;
          out.value = {};
          std::memcpy(&out.value, &current, size);
        }
        values[dest] = out;
      }
      *supported = true;
      return true;
    }
    case OPCODE_SET_ROUNDING_MODE: {
      uint64_t mode = 0;
      *supported = ResolveUint64(instr->src1.value, values, &mode);
      if (*supported) g_ppc_rounding_mode = uint32_t(mode) & 7u;
      return true;
    }
    case OPCODE_CALL_EXTERN: {
      // Xenia builtins (PPCFrontend::Initialize): the mfmsr/mtmsr global lock
      // helpers and the sc syscall handler. Call the same host handler the
      // x64 backend calls, on the live guest context.
      auto* symbol = instr->src1.symbol;
      *supported = false;
      if (symbol && symbol->behavior() == xe::cpu::Function::Behavior::kBuiltin &&
          g_active_context) {
        auto* builtin = static_cast<xe::cpu::BuiltinFunction*>(symbol);
        if (builtin->handler()) {
          builtin->handler()(g_active_context, builtin->arg0(), builtin->arg1());
          *supported = true;
        }
      }
      return true;
    }
    case OPCODE_LOAD_LOCAL:
    case OPCODE_STORE_LOCAL: {
      // HIR locals (HIRBuilder::AllocLocal) are ordinary Values used as
      // slots; Xenia's backends give each one a stack slot.
      RuntimeValue v;
      Value* slot = instr->src1.value;
      const Value* source =
          opcode == OPCODE_LOAD_LOCAL ? slot : instr->src2.value;
      Value* target = opcode == OPCODE_LOAD_LOCAL ? dest : slot;
      *supported = slot && target && ResolveRuntimeValue(source, values, &v);
      if (*supported) {
        v.type = target->type;
        values[target] = v;
      }
      return true;
    }
    case OPCODE_LOAD_CLOCK: {
      // mftb: Xenia's guest timebase runs at 50 MHz (Clock::guest_tick_frequency,
      // and KeQueryPerformanceFrequency here).
      const uint64_t ns = GuestClockNanoseconds();
      RuntimeValue v;
      SetUnsigned(&v, xe::cpu::hir::INT64_TYPE, ns / 20u);
      *supported = dest != nullptr;
      if (dest) values[dest] = v;
      return true;
    }
    case OPCODE_DEBUG_BREAK:
    case OPCODE_DEBUG_BREAK_TRUE: {
      // Xenia's x64 backend only breaks into an attached host debugger.
      bool taken = true;
      *supported = opcode == OPCODE_DEBUG_BREAK ||
                   ResolveCondition(instr->src1.value, values, &taken);
      return true;
    }
    case OPCODE_TRAP:
    case OPCODE_TRAP_TRUE: {
      bool taken = true;
      if (opcode == OPCODE_TRAP_TRUE &&
          !ResolveCondition(instr->src1.value, values, &taken)) {
        *supported = false;
        return true;
      }
      if (taken) {
        // X64Emitter::Trap: 20/26 are DbgPrint (r3 = text), 0/22 are debug
        // breaks Xenia logs and continues past, 25 is ignored.
        std::fprintf(stderr, "R360_TRAP type=%u\n", unsigned(instr->flags));
      }
      *supported = true;
      return true;
    }
    default:
      return false;
  }
  *supported = false;
  if (!dest) return true;
  RuntimeValue a, b;
  if (!ResolveRuntimeValue(instr->src1.value, values, &a) ||
      !ResolveRuntimeValue(instr->src2.value, values, &b)) {
    return true;
  }
  RuntimeValue result;
  if (opcode == OPCODE_SELECT) {
    // SELECT(i8 cond, T if_true, T if_false), any T including floats/vectors.
    RuntimeValue c;
    uint64_t cond = 0;
    if (!ResolveRuntimeValue(instr->src3.value, values, &c) ||
        !GetUnsigned(a, &cond)) {
      return true;
    }
    result = cond ? b : c;
    result.type = dest->type;
    values[dest] = result;
    *supported = true;
    return true;
  }
  if ((opcode == OPCODE_MIN || opcode == OPCODE_MAX) && IsFloatType(dest->type)) {
    // vminss/vmaxss: src1 when it compares less/greater, otherwise src2.
    result.type = dest->type;
    result.value = {};
    if (dest->type == FLOAT32_TYPE) {
      const float x = a.value.f32, y = b.value.f32;
      result.value.f32 = opcode == OPCODE_MIN ? (x < y ? x : y) : (x > y ? x : y);
    } else {
      const double x = a.value.f64, y = b.value.f64;
      result.value.f64 = opcode == OPCODE_MIN ? (x < y ? x : y) : (x > y ? x : y);
    }
    values[dest] = result;
    *supported = true;
    return true;
  }
  if (!IsIntegerType(dest->type)) return true;
  const uint32_t width = IntegerBitWidth(dest->type);
  const bool is_unsigned = (instr->flags & ARITHMETIC_UNSIGNED) != 0;
  uint64_t au = 0, bu = 0;
  int64_t as = 0, bs = 0;
  if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu) || !GetSigned(a, &as) ||
      !GetSigned(b, &bs)) {
    return true;
  }
  uint64_t out = 0;
  switch (opcode) {
    case OPCODE_ADD_CARRY: {
      // sahf loads bit 0 of the carry operand into CF, then adc.
      RuntimeValue c;
      uint64_t carry = 0;
      if (!ResolveRuntimeValue(instr->src3.value, values, &c) ||
          !GetUnsigned(c, &carry)) {
        return true;
      }
      out = au + bu + (carry & 1u);
      break;
    }
    case OPCODE_MUL_HI:
      if (width == 64) {
        out = is_unsigned
                  ? uint64_t((unsigned __int128)au * (unsigned __int128)bu >> 64)
                  : uint64_t(((__int128)as * (__int128)bs) >> 64);
      } else {
        out = is_unsigned ? (au * bu) >> width
                          : uint64_t((as * bs) >> width);
      }
      break;
    case OPCODE_DIV:
      // Xenia's PPC emitter does not guard the divisor; the x64 sequence skips
      // a zero divide (PPC leaves RT undefined) and the tests expect 0.
      if (!bu) {
        out = 0;
      } else if (is_unsigned) {
        out = au / bu;
      } else if (bs == -1) {
        out = uint64_t(0) - au;  // INT_MIN / -1 wraps instead of faulting.
      } else {
        out = uint64_t(as / bs);
      }
      break;
    case OPCODE_MIN:  // cmp + cmovg: signed.
      out = bs < as ? bu : au;
      break;
    case OPCODE_MAX:  // cmp + cmovl: signed.
      out = bs > as ? bu : au;
      break;
    default:
      return true;
  }
  SetUnsigned(&result, dest->type, out);
  values[dest] = result;
  *supported = true;
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

      if (++g_total_instructions > g_total_instruction_budget &&
          g_total_instruction_budget) {
        result.blocker_kind = kHIRBlockerInstructionLimit;
        result.blocker_address = current_source_address;
        supported = false;
        break;
      }
      ++g_opcode_histogram[instr->opcode->num & 0xFFu];
      if (ExecuteFlaggedOperation(instr, values, &supported)) {
        if (!supported) {
          result.blocker_kind = kHIRBlockerUnsupportedOpcode;
          result.blocker_opcode = instr->opcode->num;
          result.blocker_address = current_source_address;
        }
        continue;
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
        case xe::cpu::hir::OPCODE_CNTLZ:
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
        auto describe = [&](const Value* v) -> std::string {
          if (!v) return "-";
          char text[64];
          const bool known = v->IsConstant() || values.find(v) != values.end();
          std::snprintf(text, sizeof(text), "v%u:t%u:%s", v->ordinal,
                        unsigned(v->type), v->IsConstant() ? "const" : known ? "set" : "UNDEFINED");
          return text;
        };
        using xe::cpu::hir::OpcodeSignatureType;
        const auto* info = instr->opcode;
        const bool src1_value = info && (GET_OPCODE_SIG_TYPE_SRC1(info->signature) == xe::cpu::hir::OPCODE_SIG_TYPE_V);
        const bool src2_value = info && (GET_OPCODE_SIG_TYPE_SRC2(info->signature) == xe::cpu::hir::OPCODE_SIG_TYPE_V);
        const bool src3_value = info && (GET_OPCODE_SIG_TYPE_SRC3(info->signature) == xe::cpu::hir::OPCODE_SIG_TYPE_V);
        std::fprintf(stderr,
                     "R360_HIR_BLOCK_DETAIL ppc=0x%08X opcode=%s flags=0x%X dest=%s src1=%s src2=%s src3=%s\n",
                     current_source_address, info && info->name ? info->name : "?",
                     unsigned(instr->flags), describe(instr->dest).c_str(),
                     src1_value ? describe(instr->src1.value).c_str() : "n/a",
                     src2_value ? describe(instr->src2.value).c_str() : "n/a",
                     src3_value ? describe(instr->src3.value).c_str() : "n/a");
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

// Xenia PPC test-runner register annotations (#_ REGISTER_IN f1 1.5, v3 [..],
// cr 0x...) applied to the outermost context through Xenia's own
// PPCContext::SetRegFromString, and the final context kept for
// CompareRegWithString. Integer registers keep using g_initial_gprs.
std::vector<std::pair<std::string, std::string>> g_initial_register_strings;
xe::cpu::ppc::PPCContext g_last_context{};

void ApplyInitialRegisterStrings(xe::cpu::ppc::PPCContext& context) {
  for (const auto& entry : g_initial_register_strings) {
    context.SetRegFromString(entry.first.c_str(), entry.second.c_str());
  }
}

// A wasm trap unwinds straight out of the executor: the outermost frame's
// context pointer is left pointing at a dead stack frame and the depth counter
// stays raised, so the next title would run as a "nested" call. Every title
// handoff starts a fresh outermost run.
void AbandonHIRCorrectnessExecution() {
  g_total_instructions = 0;
  g_ppc_rounding_mode = 0;
  g_initial_register_strings.clear();
  g_last_context = {};
  g_active_context = nullptr;
  g_execution_depth = 0;
  ClearPendingNestedFailure();
}

void ClearHIRCorrectnessInitialRegisterStrings() {
  g_initial_register_strings.clear();
}

bool AddHIRCorrectnessInitialRegister(const char* name, const char* value) {
  if (!name || !value || !*name) return false;
  g_initial_register_strings.emplace_back(name, value);
  return true;
}

int CompareHIRCorrectnessLastRegister(const char* name, const char* value,
                                      std::string* actual) {
  if (!name || !value || !actual) return -1;
  return g_last_context.CompareRegWithString(name, value, *actual) ? 1 : 0;
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

  if (outermost) ApplyInitialRegisterStrings(*g_active_context);
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
  if (outermost && g_active_context) g_last_context = *g_active_context;
  --g_execution_depth;

  if (!outermost && !result.supported &&
      result.blocker_kind != kHIRBlockerNone) {
    RecordPendingNestedFailure(result);
  }
  if (outermost) g_active_context = nullptr;
  return result;
}

uint64_t HIRTotalInstructions() { return g_total_instructions; }

// Guest clock. Normally host monotonic time; with a deterministic clock
// (r360_set_deterministic_clock) it advances with executed HIR instructions,
// so headless runs replay identically (timers, vblank, mftb, system time).
uint64_t g_clock_ps_per_instruction = 0;
uint64_t GuestClockNanoseconds() {
  if (g_clock_ps_per_instruction) {
    return g_total_instructions * g_clock_ps_per_instruction / 1000ull;
  }
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000000000ull + uint64_t(ts.tv_nsec);
}
uint32_t HIRLastSourceAddress() { return g_last_source_address; }

}  // namespace render360::xenia_web

// V73 adaptive HIR metadata. These exports are generated from the exact Xenia
// opcode table compiled into this runtime, so diagnostics don't carry a second
// hand-maintained opcode-number map that can drift when Xenia changes.
extern "C" {
const char* r360_hir_opcode_name(uint32_t opcode) {
  switch (opcode) {
#define DEFINE_OPCODE(num, name, sig, flags) \
    case xe::cpu::hir::num: return name;
#include "xenia/cpu/hir/opcodes.inl"
#undef DEFINE_OPCODE
    default:
      return "unknown";
  }
}

uint32_t r360_hir_opcode_count() {
  return static_cast<uint32_t>(xe::cpu::hir::__OPCODE_MAX_VALUE);
}

uint32_t r360_hir_correctness_supports_opcode(uint32_t opcode) {
  switch (opcode) {
    case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
    case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
    case xe::cpu::hir::OPCODE_MEMORY_BARRIER:
    case xe::cpu::hir::OPCODE_CACHE_CONTROL:
    case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:
    case xe::cpu::hir::OPCODE_STORE_CONTEXT:
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET:
    case xe::cpu::hir::OPCODE_STORE:
    case xe::cpu::hir::OPCODE_STORE_OFFSET:
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
    case xe::cpu::hir::OPCODE_CNTLZ:
    case xe::cpu::hir::OPCODE_IS_TRUE:
    case xe::cpu::hir::OPCODE_IS_FALSE:
    case xe::cpu::hir::OPCODE_IS_NAN:
    case xe::cpu::hir::OPCODE_VECTOR_ADD:
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
    case xe::cpu::hir::OPCODE_BRANCH:
    case xe::cpu::hir::OPCODE_BRANCH_TRUE:
    case xe::cpu::hir::OPCODE_BRANCH_FALSE:
    case xe::cpu::hir::OPCODE_CALL:
    case xe::cpu::hir::OPCODE_CALL_TRUE:
    case xe::cpu::hir::OPCODE_CALL_INDIRECT:
    case xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE:
    case xe::cpu::hir::OPCODE_RETURN:
    case xe::cpu::hir::OPCODE_RETURN_TRUE:
      return 1;
    default:
      return 0;
  }
}

uint32_t r360_hir_correctness_supported_opcode_count() {
  uint32_t count = 0;
  for (uint32_t opcode = 0; opcode < r360_hir_opcode_count(); ++opcode) {
    count += r360_hir_correctness_supports_opcode(opcode) ? 1u : 0u;
  }
  return count;
}
}

extern "C" {
uint32_t r360_trace_set_verbose(uint32_t enabled) {
  render360::xenia_web::g_r360_verbose_trace = enabled != 0;
  return enabled != 0 ? 1u : 0u;
}
uint32_t r360_trace_verbose() {
  return render360::xenia_web::g_r360_verbose_trace ? 1u : 0u;
}
}

extern "C" __attribute__((used, export_name("r360_hir_set_total_instruction_budget")))
uint32_t r360_hir_set_total_instruction_budget(uint32_t millions) {
  render360::xenia_web::g_total_instruction_budget = uint64_t(millions) * 1000000ull;
  return millions;
}
extern "C" __attribute__((used, export_name("r360_hir_total_instructions_millions")))
uint32_t r360_hir_total_instructions_millions() {
  return uint32_t(render360::xenia_web::g_total_instructions / 1000000ull);
}

extern "C" __attribute__((used, export_name("r360_debug_watch")))
uint32_t r360_debug_watch(uint32_t address) {
  render360::xenia_web::g_debug_watch_address = address;
  return address;
}
extern "C" uint64_t r360_guest_clock_ns() {
  return render360::xenia_web::GuestClockNanoseconds();
}
extern "C" uint32_t r360_guest_clock_deterministic() {
  return render360::xenia_web::g_clock_ps_per_instruction ? 1u : 0u;
}
// 0 = host time; otherwise picoseconds of guest time per HIR instruction.
extern "C" uint32_t r360_set_deterministic_clock(uint32_t ps_per_instruction) {
  render360::xenia_web::g_clock_ps_per_instruction = ps_per_instruction;
  return ps_per_instruction;
}
extern "C" uint32_t r360_debug_watch_address() {
  return render360::xenia_web::g_debug_watch_address;
}

extern "C" __attribute__((used, export_name("r360_hir_opcode_histogram_k")))
uint32_t r360_hir_opcode_histogram_k(uint32_t op) { return uint32_t(render360::xenia_web::g_opcode_histogram[op & 0xFF] / 1000u); }
