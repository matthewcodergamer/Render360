#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
OUT = ROOT / "build/render360-fpu-overlay/hir_correctness_executor.cpp"

text = SOURCE.read_text(encoding="utf-8")

text = text.replace(
    '#include <cstring>\n#include <limits>',
    '#include <cstring>\n#include <cmath>\n#include <limits>',
    1,
)

float_mul32 = '''      } else if (opcode == xe::cpu::hir::OPCODE_MUL) {
        result.value.f32 = a.value.f32 * b.value.f32;
      } else {
        return false;
      }'''
float_mul32_new = '''      } else if (opcode == xe::cpu::hir::OPCODE_MUL) {
        result.value.f32 = a.value.f32 * b.value.f32;
      } else if (opcode == xe::cpu::hir::OPCODE_DIV) {
        result.value.f32 = a.value.f32 / b.value.f32;
      } else {
        return false;
      }'''
if float_mul32 not in text:
    raise SystemExit("FLOAT32 arithmetic anchor not found")
text = text.replace(float_mul32, float_mul32_new, 1)

float_mul64 = '''      } else if (opcode == xe::cpu::hir::OPCODE_MUL) {
        result.value.f64 = a.value.f64 * b.value.f64;
      } else {
        return false;
      }'''
float_mul64_new = '''      } else if (opcode == xe::cpu::hir::OPCODE_MUL) {
        result.value.f64 = a.value.f64 * b.value.f64;
      } else if (opcode == xe::cpu::hir::OPCODE_DIV) {
        result.value.f64 = a.value.f64 / b.value.f64;
      } else {
        return false;
      }'''
if float_mul64 not in text:
    raise SystemExit("FLOAT64 arithmetic anchor not found")
text = text.replace(float_mul64, float_mul64_new, 1)

binary_anchor = '''  if (IsFloatType(destination->type) && destination->type == lhs->type &&
      destination->type == rhs->type) {'''
float_compare = '''  if (IsFloatType(lhs->type) && lhs->type == rhs->type &&
      IsIntegerType(destination->type) &&
      (opcode == xe::cpu::hir::OPCODE_COMPARE_EQ ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_NE ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SLT ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SLE ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SGT ||
       opcode == xe::cpu::hir::OPCODE_COMPARE_SGE)) {
    bool comparison = false;
    if (lhs->type == xe::cpu::hir::FLOAT32_TYPE) {
      const float av = a.value.f32;
      const float bv = b.value.f32;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_EQ) comparison = av == bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_NE) comparison = av != bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLT) comparison = av < bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLE) comparison = av <= bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGT) comparison = av > bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGE) comparison = av >= bv;
    } else {
      const double av = a.value.f64;
      const double bv = b.value.f64;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_EQ) comparison = av == bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_NE) comparison = av != bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLT) comparison = av < bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SLE) comparison = av <= bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGT) comparison = av > bv;
      if (opcode == xe::cpu::hir::OPCODE_COMPARE_SGE) comparison = av >= bv;
    }
    RuntimeValue result;
    SetUnsigned(&result, destination->type, comparison ? 1u : 0u);
    out_values[destination] = result;
    return true;
  }

'''
if binary_anchor not in text:
    raise SystemExit("binary float anchor not found")
text = text.replace(binary_anchor, float_compare + binary_anchor, 1)

helper_anchor = '''bool StoreBinaryValue(Value* destination, const Value* lhs, const Value* rhs,'''
helpers = r'''bool StoreIsNanValue(Value* destination, const Value* source,
                     const RuntimeValues& values, RuntimeValues& out_values) {
  if (!destination || !source || !IsIntegerType(destination->type) ||
      !IsFloatType(source->type)) {
    return false;
  }
  RuntimeValue src;
  if (!ResolveRuntimeValue(source, values, &src)) return false;
  const bool is_nan = source->type == xe::cpu::hir::FLOAT32_TYPE
                          ? std::isnan(src.value.f32)
                          : std::isnan(src.value.f64);
  RuntimeValue result;
  SetUnsigned(&result, destination->type, is_nan ? 1u : 0u);
  out_values[destination] = result;
  return true;
}

bool StoreConvertValue(Value* destination, const Value* source,
                       const RuntimeValues& values, RuntimeValues& out_values,
                       uint32_t round_mode) {
  if (!destination || !source) return false;
  RuntimeValue src;
  if (!ResolveRuntimeValue(source, values, &src)) return false;

  RuntimeValue result;
  result.type = destination->type;
  result.value = {};

  if (source->type == xe::cpu::hir::FLOAT64_TYPE &&
      destination->type == xe::cpu::hir::FLOAT32_TYPE) {
    result.value.f32 = static_cast<float>(src.value.f64);
  } else if (source->type == xe::cpu::hir::FLOAT32_TYPE &&
             destination->type == xe::cpu::hir::FLOAT64_TYPE) {
    result.value.f64 = static_cast<double>(src.value.f32);
  } else if (IsIntegerType(source->type) && IsFloatType(destination->type)) {
    int64_t signed_value = 0;
    if (!GetSigned(src, &signed_value)) return false;
    if (destination->type == xe::cpu::hir::FLOAT32_TYPE) {
      result.value.f32 = static_cast<float>(signed_value);
    } else {
      result.value.f64 = static_cast<double>(signed_value);
    }
  } else if (IsFloatType(source->type) && IsIntegerType(destination->type)) {
    const double input = source->type == xe::cpu::hir::FLOAT32_TYPE
                             ? static_cast<double>(src.value.f32)
                             : src.value.f64;
    if (!std::isfinite(input)) return false;
    double rounded = input;
    switch (round_mode) {
      case xe::cpu::hir::ROUND_TO_ZERO:
        rounded = std::trunc(input);
        break;
      case xe::cpu::hir::ROUND_TO_MINUS_INFINITY:
        rounded = std::floor(input);
        break;
      case xe::cpu::hir::ROUND_TO_POSITIVE_INFINITY:
        rounded = std::ceil(input);
        break;
      case xe::cpu::hir::ROUND_TO_NEAREST:
      case xe::cpu::hir::ROUND_DYNAMIC:
        rounded = std::nearbyint(input);
        break;
      default:
        return false;
    }
    if (destination->type == xe::cpu::hir::INT32_TYPE) {
      if (rounded < static_cast<double>(std::numeric_limits<int32_t>::min()) ||
          rounded > static_cast<double>(std::numeric_limits<int32_t>::max())) {
        return false;
      }
      result.value.i32 = static_cast<int32_t>(rounded);
    } else if (destination->type == xe::cpu::hir::INT64_TYPE) {
      const long double wide = static_cast<long double>(rounded);
      if (wide < static_cast<long double>(std::numeric_limits<int64_t>::min()) ||
          wide > static_cast<long double>(std::numeric_limits<int64_t>::max())) {
        return false;
      }
      result.value.i64 = static_cast<int64_t>(rounded);
    } else {
      return false;
    }
  } else {
    return false;
  }

  out_values[destination] = result;
  return true;
}

'''
if helper_anchor not in text:
    raise SystemExit("binary helper anchor not found")
text = text.replace(helper_anchor, helpers + helper_anchor, 1)

switch_unary = '''        case xe::cpu::hir::OPCODE_ASSIGN:
        case xe::cpu::hir::OPCODE_CAST:
        case xe::cpu::hir::OPCODE_ZERO_EXTEND:'''
switch_unary_new = '''        case xe::cpu::hir::OPCODE_CONVERT:
          supported = StoreConvertValue(instr->dest, instr->src1.value, values,
                                        values, instr->flags);
          break;
        case xe::cpu::hir::OPCODE_IS_NAN:
          supported = StoreIsNanValue(instr->dest, instr->src1.value, values,
                                      values);
          break;

        case xe::cpu::hir::OPCODE_ASSIGN:
        case xe::cpu::hir::OPCODE_CAST:
        case xe::cpu::hir::OPCODE_ZERO_EXTEND:'''
if switch_unary not in text:
    raise SystemExit("executor unary switch anchor not found")
text = text.replace(switch_unary, switch_unary_new, 1)

switch_mul = '''        case xe::cpu::hir::OPCODE_MUL:
        case xe::cpu::hir::OPCODE_AND:'''
switch_mul_new = '''        case xe::cpu::hir::OPCODE_MUL:
        case xe::cpu::hir::OPCODE_DIV:
        case xe::cpu::hir::OPCODE_AND:'''
if switch_mul not in text:
    raise SystemExit("executor binary switch anchor not found")
text = text.replace(switch_mul, switch_mul_new, 1)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(text, encoding="utf-8")
print(f"Generated Render360 FPU correctness overlay: {OUT}")
print("FPU rule: execute only Xenia-finalized HIR DIV/compare/IS_NAN/CONVERT semantics; unsupported forms remain fail-closed")
