#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
src = root / 'src/xenia_web_bootstrap/hir_correctness_executor.cpp'
out = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = src.read_text()

old_vector_add = r'''bool StoreVectorAdd(Value* destination, const Value* lhs, const Value* rhs,
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
'''

new_vector_ops = r'''bool StoreVectorArithmetic(Value* destination, const Value* lhs,
                           const Value* rhs, const RuntimeValues& values,
                           RuntimeValues& out_values, uint32_t flags,
                           bool subtract) {
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
  if (arithmetic_flags != xe::cpu::hir::ARITHMETIC_UNSIGNED) return false;

  RuntimeValue result;
  result.type = xe::cpu::hir::VEC128_TYPE;
  result.value = {};
  if (part_type == xe::cpu::hir::INT8_TYPE) {
    for (size_t i = 0; i < 16; ++i) {
      result.value.v128.u8[i] = subtract
          ? static_cast<uint8_t>(a.value.v128.u8[i] - b.value.v128.u8[i])
          : static_cast<uint8_t>(a.value.v128.u8[i] + b.value.v128.u8[i]);
    }
  } else if (part_type == xe::cpu::hir::INT16_TYPE) {
    for (size_t i = 0; i < 8; ++i) {
      result.value.v128.u16[i] = subtract
          ? static_cast<uint16_t>(a.value.v128.u16[i] - b.value.v128.u16[i])
          : static_cast<uint16_t>(a.value.v128.u16[i] + b.value.v128.u16[i]);
    }
  } else if (part_type == xe::cpu::hir::INT32_TYPE) {
    for (size_t i = 0; i < 4; ++i) {
      result.value.v128.u32[i] = subtract
          ? static_cast<uint32_t>(a.value.v128.u32[i] - b.value.v128.u32[i])
          : static_cast<uint32_t>(a.value.v128.u32[i] + b.value.v128.u32[i]);
    }
  } else {
    return false;
  }
  out_values[destination] = result;
  return true;
}

bool StoreVectorShift(Value* destination, const Value* lhs, const Value* rhs,
                      const RuntimeValues& values, RuntimeValues& out_values,
                      uint32_t flags, uint32_t opcode) {
  if (!destination || !lhs || !rhs ||
      destination->type != xe::cpu::hir::VEC128_TYPE ||
      lhs->type != xe::cpu::hir::VEC128_TYPE ||
      rhs->type != xe::cpu::hir::VEC128_TYPE) return false;
  RuntimeValue a, b;
  if (!ResolveRuntimeValue(lhs, values, &a) ||
      !ResolveRuntimeValue(rhs, values, &b)) return false;
  const auto part_type = static_cast<TypeName>(flags & 0xFFu);
  RuntimeValue result;
  result.type = xe::cpu::hir::VEC128_TYPE;
  result.value = {};
#define R360_SHIFT_LANE(field, stype, count, mask) do { \
  for (size_t i = 0; i < (count); ++i) { \
    const uint32_t sh = static_cast<uint32_t>(b.value.v128.field[i]) & (mask); \
    if (opcode == xe::cpu::hir::OPCODE_VECTOR_SHL) \
      result.value.v128.field[i] = static_cast<decltype(result.value.v128.field[i])>(a.value.v128.field[i] << sh); \
    else if (opcode == xe::cpu::hir::OPCODE_VECTOR_SHR) \
      result.value.v128.field[i] = static_cast<decltype(result.value.v128.field[i])>(a.value.v128.field[i] >> sh); \
    else \
      result.value.v128.field[i] = static_cast<decltype(result.value.v128.field[i])>(static_cast<stype>(a.value.v128.field[i]) >> sh); \
  } \
} while (0)
  if (part_type == xe::cpu::hir::INT8_TYPE) {
    R360_SHIFT_LANE(u8, int8_t, 16, 7u);
  } else if (part_type == xe::cpu::hir::INT16_TYPE) {
    R360_SHIFT_LANE(u16, int16_t, 8, 15u);
  } else if (part_type == xe::cpu::hir::INT32_TYPE) {
    R360_SHIFT_LANE(u32, int32_t, 4, 31u);
  } else {
    return false;
  }
#undef R360_SHIFT_LANE
  out_values[destination] = result;
  return true;
}

bool StoreVectorCompare(Value* destination, const Value* lhs, const Value* rhs,
                        const RuntimeValues& values, RuntimeValues& out_values,
                        uint32_t flags, uint32_t opcode) {
  if (!destination || !lhs || !rhs ||
      destination->type != xe::cpu::hir::VEC128_TYPE ||
      lhs->type != xe::cpu::hir::VEC128_TYPE ||
      rhs->type != xe::cpu::hir::VEC128_TYPE) return false;
  RuntimeValue a, b;
  if (!ResolveRuntimeValue(lhs, values, &a) ||
      !ResolveRuntimeValue(rhs, values, &b)) return false;
  const auto part_type = static_cast<TypeName>(flags & 0xFFu);
  RuntimeValue result;
  result.type = xe::cpu::hir::VEC128_TYPE;
  result.value = {};
#define R360_CMP_LANE(ufield, sfield, count, allones) do { \
  for (size_t i = 0; i < (count); ++i) { \
    bool yes = false; \
    if (opcode == xe::cpu::hir::OPCODE_VECTOR_COMPARE_EQ) yes = a.value.v128.ufield[i] == b.value.v128.ufield[i]; \
    else if (opcode == xe::cpu::hir::OPCODE_VECTOR_COMPARE_UGT) yes = a.value.v128.ufield[i] > b.value.v128.ufield[i]; \
    else if (opcode == xe::cpu::hir::OPCODE_VECTOR_COMPARE_UGE) yes = a.value.v128.ufield[i] >= b.value.v128.ufield[i]; \
    else if (opcode == xe::cpu::hir::OPCODE_VECTOR_COMPARE_SGT) yes = a.value.v128.sfield[i] > b.value.v128.sfield[i]; \
    else if (opcode == xe::cpu::hir::OPCODE_VECTOR_COMPARE_SGE) yes = a.value.v128.sfield[i] >= b.value.v128.sfield[i]; \
    else return false; \
    result.value.v128.ufield[i] = yes ? (allones) : 0; \
  } \
} while (0)
  if (part_type == xe::cpu::hir::INT8_TYPE) {
    R360_CMP_LANE(u8, i8, 16, UINT8_MAX);
  } else if (part_type == xe::cpu::hir::INT16_TYPE) {
    R360_CMP_LANE(u16, i16, 8, UINT16_MAX);
  } else if (part_type == xe::cpu::hir::INT32_TYPE) {
    R360_CMP_LANE(u32, i32, 4, UINT32_MAX);
  } else {
    return false;
  }
#undef R360_CMP_LANE
  out_values[destination] = result;
  return true;
}
'''

if old_vector_add not in text:
    raise SystemExit('VMX overlay: StoreVectorAdd source contract changed')
text = text.replace(old_vector_add, new_vector_ops)

integer_guard = r'''  if (!IsIntegerType(destination->type) || !IsIntegerType(lhs->type) ||
      !IsIntegerType(rhs->type)) {
    return false;
  }
'''
vector_logic = r'''  if (destination->type == xe::cpu::hir::VEC128_TYPE &&
      lhs->type == xe::cpu::hir::VEC128_TYPE &&
      rhs->type == xe::cpu::hir::VEC128_TYPE &&
      (opcode == xe::cpu::hir::OPCODE_AND ||
       opcode == xe::cpu::hir::OPCODE_AND_NOT ||
       opcode == xe::cpu::hir::OPCODE_OR ||
       opcode == xe::cpu::hir::OPCODE_XOR)) {
    RuntimeValue result;
    result.type = xe::cpu::hir::VEC128_TYPE;
    result.value = {};
    for (size_t i = 0; i < 4; ++i) {
      uint32_t v = a.value.v128.u32[i];
      if (opcode == xe::cpu::hir::OPCODE_AND) v &= b.value.v128.u32[i];
      if (opcode == xe::cpu::hir::OPCODE_AND_NOT) v &= ~b.value.v128.u32[i];
      if (opcode == xe::cpu::hir::OPCODE_OR) v |= b.value.v128.u32[i];
      if (opcode == xe::cpu::hir::OPCODE_XOR) v ^= b.value.v128.u32[i];
      result.value.v128.u32[i] = v;
    }
    out_values[destination] = result;
    return true;
  }

''' + integer_guard
if integer_guard not in text:
    raise SystemExit('VMX overlay: binary integer guard changed')
text = text.replace(integer_guard, vector_logic, 1)

old_dispatch = r'''        case xe::cpu::hir::OPCODE_VECTOR_ADD:
          supported = StoreVectorAdd(instr->dest, instr->src1.value,
                                     instr->src2.value, values, values,
                                     instr->flags);
          break;
'''
new_dispatch = r'''        case xe::cpu::hir::OPCODE_VECTOR_ADD:
        case xe::cpu::hir::OPCODE_VECTOR_SUB:
          supported = StoreVectorArithmetic(
              instr->dest, instr->src1.value, instr->src2.value, values, values,
              instr->flags, instr->opcode->num == xe::cpu::hir::OPCODE_VECTOR_SUB);
          break;
        case xe::cpu::hir::OPCODE_VECTOR_SHL:
        case xe::cpu::hir::OPCODE_VECTOR_SHR:
        case xe::cpu::hir::OPCODE_VECTOR_SHA:
          supported = StoreVectorShift(instr->dest, instr->src1.value,
                                       instr->src2.value, values, values,
                                       instr->flags, instr->opcode->num);
          break;
        case xe::cpu::hir::OPCODE_VECTOR_COMPARE_EQ:
        case xe::cpu::hir::OPCODE_VECTOR_COMPARE_SGT:
        case xe::cpu::hir::OPCODE_VECTOR_COMPARE_SGE:
        case xe::cpu::hir::OPCODE_VECTOR_COMPARE_UGT:
        case xe::cpu::hir::OPCODE_VECTOR_COMPARE_UGE:
          supported = StoreVectorCompare(instr->dest, instr->src1.value,
                                         instr->src2.value, values, values,
                                         instr->flags, instr->opcode->num);
          break;
'''
if old_dispatch not in text:
    raise SystemExit('VMX overlay: vector dispatch source contract changed')
text = text.replace(old_dispatch, new_dispatch)

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print(f'VMX executor overlay: {src.relative_to(root)} -> {out.relative_to(root)}')
