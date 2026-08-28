#include "wasm_backend_cfg_probe.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/label.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"

namespace render360::xenia_web {
namespace {

using xe::cpu::hir::Block;
using xe::cpu::hir::HIRBuilder;
using xe::cpu::hir::Instr;
using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
using xe::cpu::ppc::PPCContext;

uint32_t g_status = 0;
uint32_t g_lowered = 0;
std::vector<uint8_t> g_module;
alignas(64) uint8_t g_context[sizeof(PPCContext)] = {};

struct LocalInfo {
  uint32_t index = 0;
  TypeName type = xe::cpu::hir::INT32_TYPE;
};

using ValueLocals = std::unordered_map<const Value*, LocalInfo>;
using BlockIndices = std::unordered_map<const Block*, uint32_t>;

bool IsIntegerType(TypeName type) {
  return type == xe::cpu::hir::INT8_TYPE ||
         type == xe::cpu::hir::INT16_TYPE ||
         type == xe::cpu::hir::INT32_TYPE ||
         type == xe::cpu::hir::INT64_TYPE;
}

bool IsI64(TypeName type) { return type == xe::cpu::hir::INT64_TYPE; }

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
  const uint32_t length = static_cast<uint32_t>(std::strlen(name));
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

void EmitMask(std::vector<uint8_t>& out, TypeName type) {
  if (type == xe::cpu::hir::INT8_TYPE) {
    EmitI32Const(out, 0xFF);
    out.push_back(0x71);
  } else if (type == xe::cpu::hir::INT16_TYPE) {
    EmitI32Const(out, 0xFFFF);
    out.push_back(0x71);
  }
}

void EmitSignNormalize(std::vector<uint8_t>& out, TypeName type) {
  if (type == xe::cpu::hir::INT8_TYPE) {
    out.push_back(0xC0);
  } else if (type == xe::cpu::hir::INT16_TYPE) {
    out.push_back(0xC1);
  }
}

bool EmitValue(const Value* value, const ValueLocals& locals,
               std::vector<uint8_t>& out) {
  if (!value || !IsIntegerType(value->type)) return false;
  if (value->IsConstant()) {
    if (IsI64(value->type)) {
      EmitI64Const(out, value->constant.i64);
    } else {
      EmitI32Const(out, value->constant.i32);
      EmitMask(out, value->type);
    }
    return true;
  }
  const auto it = locals.find(value);
  if (it == locals.end()) return false;
  out.push_back(0x20);
  EmitU32Leb(out, it->second.index);
  return true;
}

bool EmitAdaptedValue(const Value* value, bool want_i64, bool sign_extend,
                      const ValueLocals& locals, std::vector<uint8_t>& out) {
  if (!EmitValue(value, locals, out)) return false;
  const bool source_i64 = IsI64(value->type);
  if (source_i64 == want_i64) {
    if (!want_i64 && sign_extend) EmitSignNormalize(out, value->type);
    return true;
  }
  if (want_i64) {
    if (sign_extend) {
      EmitSignNormalize(out, value->type);
      out.push_back(0xAC);
    } else {
      out.push_back(0xAD);
    }
  } else {
    out.push_back(0xA7);
    if (sign_extend) EmitSignNormalize(out, value->type);
  }
  return true;
}

bool EmitCompare(const Instr* instr, const ValueLocals& locals,
                 std::vector<uint8_t>& out) {
  if (!instr->src1.value || !instr->src2.value ||
      !IsIntegerType(instr->src1.value->type) ||
      !IsIntegerType(instr->src2.value->type)) {
    return false;
  }
  const auto op = instr->opcode->num;
  const bool i64 = IsI64(instr->src1.value->type) ||
                   IsI64(instr->src2.value->type);
  const bool signed_compare =
      op == xe::cpu::hir::OPCODE_COMPARE_SLT ||
      op == xe::cpu::hir::OPCODE_COMPARE_SLE ||
      op == xe::cpu::hir::OPCODE_COMPARE_SGT ||
      op == xe::cpu::hir::OPCODE_COMPARE_SGE;
  if (!EmitAdaptedValue(instr->src1.value, i64, signed_compare, locals, out) ||
      !EmitAdaptedValue(instr->src2.value, i64, signed_compare, locals, out)) {
    return false;
  }
  if (!i64) {
    switch (op) {
      case xe::cpu::hir::OPCODE_COMPARE_EQ: out.push_back(0x46); break;
      case xe::cpu::hir::OPCODE_COMPARE_NE: out.push_back(0x47); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLT: out.push_back(0x48); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULT: out.push_back(0x49); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGT: out.push_back(0x4A); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGT: out.push_back(0x4B); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLE: out.push_back(0x4C); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULE: out.push_back(0x4D); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGE: out.push_back(0x4E); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGE: out.push_back(0x4F); break;
      default: return false;
    }
  } else {
    switch (op) {
      case xe::cpu::hir::OPCODE_COMPARE_EQ: out.push_back(0x51); break;
      case xe::cpu::hir::OPCODE_COMPARE_NE: out.push_back(0x52); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLT: out.push_back(0x53); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULT: out.push_back(0x54); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGT: out.push_back(0x55); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGT: out.push_back(0x56); break;
      case xe::cpu::hir::OPCODE_COMPARE_SLE: out.push_back(0x57); break;
      case xe::cpu::hir::OPCODE_COMPARE_ULE: out.push_back(0x58); break;
      case xe::cpu::hir::OPCODE_COMPARE_SGE: out.push_back(0x59); break;
      case xe::cpu::hir::OPCODE_COMPARE_UGE: out.push_back(0x5A); break;
      default: return false;
    }
  }
  return true;
}

bool EmitProducer(const Instr* instr, const ValueLocals& locals,
                  std::vector<uint8_t>& out) {
  if (!instr || !instr->opcode || !instr->dest ||
      !IsIntegerType(instr->dest->type)) {
    return false;
  }
  const TypeName dest_type = instr->dest->type;
  const bool dest_i64 = IsI64(dest_type);
  bool ok = false;
  switch (instr->opcode->num) {
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      out.push_back(0x20); out.push_back(0x00);
      if (dest_type == xe::cpu::hir::INT8_TYPE) {
        out.push_back(0x2D); out.push_back(0x00);
      } else if (dest_type == xe::cpu::hir::INT16_TYPE) {
        out.push_back(0x2F); out.push_back(0x01);
      } else if (dest_type == xe::cpu::hir::INT32_TYPE) {
        out.push_back(0x28); out.push_back(0x02);
      } else {
        out.push_back(0x29); out.push_back(0x03);
      }
      EmitU32Leb(out, static_cast<uint32_t>(instr->src1.offset));
      ok = true;
      break;
    case xe::cpu::hir::OPCODE_ASSIGN:
      ok = EmitAdaptedValue(instr->src1.value, dest_i64, false, locals, out);
      if (ok) EmitMask(out, dest_type);
      break;
    case xe::cpu::hir::OPCODE_TRUNCATE:
      if (!instr->src1.value || !IsIntegerType(instr->src1.value->type)) break;
      ok = EmitValue(instr->src1.value, locals, out);
      if (ok && IsI64(instr->src1.value->type) && !dest_i64) out.push_back(0xA7);
      if (ok) EmitMask(out, dest_type);
      break;
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
      ok = EmitAdaptedValue(instr->src1.value, dest_i64, false, locals, out);
      if (ok) EmitMask(out, dest_type);
      break;
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
      ok = EmitAdaptedValue(instr->src1.value, dest_i64, true, locals, out);
      break;
    case xe::cpu::hir::OPCODE_IS_TRUE:
    case xe::cpu::hir::OPCODE_IS_FALSE:
      if (!instr->src1.value || !EmitValue(instr->src1.value, locals, out)) break;
      out.push_back(IsI64(instr->src1.value->type) ? 0x50 : 0x45);
      if (instr->opcode->num == xe::cpu::hir::OPCODE_IS_TRUE) out.push_back(0x45);
      ok = true;
      break;
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
      ok = EmitCompare(instr, locals, out);
      break;
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
    case xe::cpu::hir::OPCODE_SHA:
    case xe::cpu::hir::OPCODE_ROTATE_LEFT:
      if (!EmitAdaptedValue(instr->src1.value, dest_i64, false, locals, out) ||
          !EmitAdaptedValue(instr->src2.value, dest_i64, false, locals, out)) break;
      if (!dest_i64) {
        switch (instr->opcode->num) {
          case xe::cpu::hir::OPCODE_ADD: out.push_back(0x6A); break;
          case xe::cpu::hir::OPCODE_SUB: out.push_back(0x6B); break;
          case xe::cpu::hir::OPCODE_AND: out.push_back(0x71); break;
          case xe::cpu::hir::OPCODE_OR: out.push_back(0x72); break;
          case xe::cpu::hir::OPCODE_XOR: out.push_back(0x73); break;
          case xe::cpu::hir::OPCODE_SHL: out.push_back(0x74); break;
          case xe::cpu::hir::OPCODE_SHA: out.push_back(0x75); break;
          case xe::cpu::hir::OPCODE_SHR: out.push_back(0x76); break;
          case xe::cpu::hir::OPCODE_ROTATE_LEFT: out.push_back(0x77); break;
          default: return false;
        }
      } else {
        switch (instr->opcode->num) {
          case xe::cpu::hir::OPCODE_ADD: out.push_back(0x7C); break;
          case xe::cpu::hir::OPCODE_SUB: out.push_back(0x7D); break;
          case xe::cpu::hir::OPCODE_AND: out.push_back(0x83); break;
          case xe::cpu::hir::OPCODE_OR: out.push_back(0x84); break;
          case xe::cpu::hir::OPCODE_XOR: out.push_back(0x85); break;
          case xe::cpu::hir::OPCODE_SHL: out.push_back(0x86); break;
          case xe::cpu::hir::OPCODE_SHA: out.push_back(0x87); break;
          case xe::cpu::hir::OPCODE_SHR: out.push_back(0x88); break;
          case xe::cpu::hir::OPCODE_ROTATE_LEFT: out.push_back(0x89); break;
          default: return false;
        }
      }
      EmitMask(out, dest_type);
      ok = true;
      break;
    case xe::cpu::hir::OPCODE_NOT:
      if (!EmitAdaptedValue(instr->src1.value, dest_i64, false, locals, out)) break;
      if (dest_i64) {
        EmitI64Const(out, -1); out.push_back(0x85);
      } else {
        EmitI32Const(out, -1); out.push_back(0x73); EmitMask(out, dest_type);
      }
      ok = true;
      break;
    case xe::cpu::hir::OPCODE_NEG:
      if (dest_i64) {
        EmitI64Const(out, 0);
        if (!EmitAdaptedValue(instr->src1.value, true, false, locals, out)) break;
        out.push_back(0x7D);
      } else {
        EmitI32Const(out, 0);
        if (!EmitAdaptedValue(instr->src1.value, false, false, locals, out)) break;
        out.push_back(0x6B); EmitMask(out, dest_type);
      }
      ok = true;
      break;
    default:
      return false;
  }
  if (!ok) return false;
  const auto local_it = locals.find(instr->dest);
  if (local_it == locals.end()) return false;
  out.push_back(0x21);
  EmitU32Leb(out, local_it->second.index);
  return true;
}

bool EmitStoreContext(const Instr* instr, const ValueLocals& locals,
                      std::vector<uint8_t>& out) {
  if (!instr->src2.value || !IsIntegerType(instr->src2.value->type)) return false;
  out.push_back(0x20); out.push_back(0x00);
  if (!EmitValue(instr->src2.value, locals, out)) return false;
  switch (instr->src2.value->type) {
    case xe::cpu::hir::INT8_TYPE: out.push_back(0x3A); out.push_back(0x00); break;
    case xe::cpu::hir::INT16_TYPE: out.push_back(0x3B); out.push_back(0x01); break;
    case xe::cpu::hir::INT32_TYPE: out.push_back(0x36); out.push_back(0x02); break;
    case xe::cpu::hir::INT64_TYPE: out.push_back(0x37); out.push_back(0x03); break;
    default: return false;
  }
  EmitU32Leb(out, static_cast<uint32_t>(instr->src1.offset));
  return true;
}

bool EmitTruthy(const Value* value, bool invert, const ValueLocals& locals,
                std::vector<uint8_t>& out) {
  if (!value || !EmitValue(value, locals, out)) return false;
  out.push_back(IsI64(value->type) ? 0x50 : 0x45);
  if (!invert) out.push_back(0x45);
  return true;
}

void EmitSetPc(std::vector<uint8_t>& out, uint32_t pc) {
  EmitI32Const(out, static_cast<int32_t>(pc));
  out.push_back(0x21); out.push_back(0x01);
}

bool IsPureIntegerProducer(const Instr* instr) {
  if (!instr || !instr->opcode || !instr->dest || !IsIntegerType(instr->dest->type)) return false;
  switch (instr->opcode->num) {
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
    case xe::cpu::hir::OPCODE_NOT:
    case xe::cpu::hir::OPCODE_NEG:
      return true;
    default:
      return false;
  }
}

bool BuildValueLocals(HIRBuilder* builder, ValueLocals* locals,
                      uint32_t* i32_count, uint32_t* i64_count) {
  std::vector<const Value*> i32_values;
  std::vector<const Value*> i64_values;
  std::unordered_set<const Value*> seen;
  for (auto* block = builder->first_block(); block; block = block->next) {
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      if (!instr->dest || !IsIntegerType(instr->dest->type) || !seen.insert(instr->dest).second) continue;
      if (IsI64(instr->dest->type)) i64_values.push_back(instr->dest);
      else i32_values.push_back(instr->dest);
    }
  }
  uint32_t next = 3;  // ctx=0, pc=1, dispatch budget=2
  for (const Value* value : i32_values) (*locals)[value] = LocalInfo{next++, value->type};
  *i32_count = static_cast<uint32_t>(i32_values.size());
  for (const Value* value : i64_values) (*locals)[value] = LocalInfo{next++, value->type};
  *i64_count = static_cast<uint32_t>(i64_values.size());
  return true;
}

bool BuildCfgModule(HIRBuilder* builder, const ValueLocals& locals,
                    const BlockIndices& indices, uint32_t i32_count,
                    uint32_t i64_count) {
  std::vector<uint8_t> body;
  uint32_t lowered = 0;
  uint32_t block_count = 0;
  for (auto* block = builder->first_block(); block; block = block->next) ++block_count;

  EmitSetPc(body, 0);
  EmitI32Const(body, 100000);
  body.push_back(0x21); body.push_back(0x02);
  body.push_back(0x02); body.push_back(0x40);
  body.push_back(0x03); body.push_back(0x40);
  body.push_back(0x20); body.push_back(0x02);
  body.push_back(0x45);
  body.push_back(0x04); body.push_back(0x40);
  body.push_back(0x00);
  body.push_back(0x0B);
  body.push_back(0x20); body.push_back(0x02);
  EmitI32Const(body, 1); body.push_back(0x6B);
  body.push_back(0x21); body.push_back(0x02);

  for (auto* block = builder->first_block(); block; block = block->next) {
    const auto block_it = indices.find(block);
    if (block_it == indices.end()) return false;
    body.push_back(0x20); body.push_back(0x01);
    EmitI32Const(body, static_cast<int32_t>(block_it->second));
    body.push_back(0x46);
    body.push_back(0x04); body.push_back(0x40);

    bool terminated = false;
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      if (!instr->opcode) return false;
      if (IsPureIntegerProducer(instr)) {
        if (!EmitProducer(instr, locals, body)) return false;
        ++lowered;
        continue;
      }
      switch (instr->opcode->num) {
        case xe::cpu::hir::OPCODE_NOP:
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
          break;
        case xe::cpu::hir::OPCODE_STORE_CONTEXT:
          if (!EmitStoreContext(instr, locals, body)) return false;
          ++lowered;
          break;
        case xe::cpu::hir::OPCODE_BRANCH: {
          if (!instr->src1.label || !instr->src1.label->block) return false;
          const auto target = indices.find(instr->src1.label->block);
          if (target == indices.end()) return false;
          EmitSetPc(body, target->second);
          body.push_back(0x0C); EmitU32Leb(body, 1);
          ++lowered; terminated = true; break;
        }
        case xe::cpu::hir::OPCODE_BRANCH_TRUE:
        case xe::cpu::hir::OPCODE_BRANCH_FALSE: {
          if (!instr->src1.value || !instr->src2.label || !instr->src2.label->block) return false;
          const auto target = indices.find(instr->src2.label->block);
          if (target == indices.end()) return false;
          const bool invert = instr->opcode->num == xe::cpu::hir::OPCODE_BRANCH_FALSE;
          if (!EmitTruthy(instr->src1.value, invert, locals, body)) return false;
          body.push_back(0x04); body.push_back(0x40);
          EmitSetPc(body, target->second);
          body.push_back(0x05);
          if (block->next) {
            const auto fallthrough = indices.find(block->next);
            if (fallthrough == indices.end()) return false;
            EmitSetPc(body, fallthrough->second);
          } else {
            EmitSetPc(body, block_count);
          }
          body.push_back(0x0B);
          body.push_back(0x0C); EmitU32Leb(body, 1);
          ++lowered; terminated = true; break;
        }
        case xe::cpu::hir::OPCODE_RETURN:
          body.push_back(0x0C); EmitU32Leb(body, 2);
          ++lowered; terminated = true; break;
        case xe::cpu::hir::OPCODE_CALL_INDIRECT:
          if ((instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) == 0) return false;
          body.push_back(0x0C); EmitU32Leb(body, 2);
          ++lowered; terminated = true; break;
        default:
          return false;
      }
      if (terminated) break;
    }

    if (!terminated) {
      if (block->next) {
        const auto next = indices.find(block->next);
        if (next == indices.end()) return false;
        EmitSetPc(body, next->second);
        body.push_back(0x0C); EmitU32Leb(body, 1);
      } else {
        body.push_back(0x0C); EmitU32Leb(body, 2);
      }
    }
    body.push_back(0x0B);
  }

  body.push_back(0x0C); EmitU32Leb(body, 1);
  body.push_back(0x0B);
  body.push_back(0x0B);
  body.push_back(0x20); body.push_back(0x00);
  body.push_back(0x29); body.push_back(0x03);
  EmitU32Leb(body, static_cast<uint32_t>(offsetof(PPCContext, r) + 3 * sizeof(uint64_t)));
  body.push_back(0x0B);

  std::vector<uint8_t> module = {0x00,0x61,0x73,0x6D,0x01,0x00,0x00,0x00};
  std::vector<uint8_t> type;
  EmitU32Leb(type,1); type.push_back(0x60); EmitU32Leb(type,1); type.push_back(0x7F); EmitU32Leb(type,1); type.push_back(0x7E);
  EmitSection(module,1,type);
  std::vector<uint8_t> imports;
  EmitU32Leb(imports,1); EmitName(imports,"env"); EmitName(imports,"memory"); imports.push_back(0x02); imports.push_back(0x00); EmitU32Leb(imports,0);
  EmitSection(module,2,imports);
  std::vector<uint8_t> functions;
  EmitU32Leb(functions,1); EmitU32Leb(functions,0); EmitSection(module,3,functions);
  std::vector<uint8_t> exports;
  EmitU32Leb(exports,1); EmitName(exports,"run"); exports.push_back(0x00); EmitU32Leb(exports,0); EmitSection(module,7,exports);

  std::vector<uint8_t> function_body;
  EmitU32Leb(function_body, 1 + (i64_count ? 1u : 0u));
  EmitU32Leb(function_body, 2 + i32_count); function_body.push_back(0x7F);
  if (i64_count) { EmitU32Leb(function_body, i64_count); function_body.push_back(0x7E); }
  function_body.insert(function_body.end(), body.begin(), body.end());
  std::vector<uint8_t> code;
  EmitU32Leb(code,1); EmitU32Leb(code,static_cast<uint32_t>(function_body.size())); code.insert(code.end(),function_body.begin(),function_body.end());
  EmitSection(module,10,code);
  g_module = std::move(module);
  g_lowered = lowered;
  return true;
}

}  // namespace

void ResetWasmBackendCfgProbe() {
  g_status = 0; g_lowered = 0; g_module.clear(); std::memset(g_context, 0, sizeof(g_context));
}

bool BuildWasmBackendCfgProbe(HIRBuilder* builder) {
  ResetWasmBackendCfgProbe();
  if (!builder || !builder->first_block() || !builder->first_block()->next) { g_status = 1; return false; }
  BlockIndices indices;
  uint32_t block_index = 0;
  for (auto* block = builder->first_block(); block; block = block->next) indices[block] = block_index++;
  ValueLocals locals;
  uint32_t i32_count = 0, i64_count = 0;
  if (!BuildValueLocals(builder, &locals, &i32_count, &i64_count) ||
      !BuildCfgModule(builder, locals, indices, i32_count, i64_count)) {
    g_status = 1; g_lowered = 0; g_module.clear(); return false;
  }
  g_status = 2;
  return true;
}

uint32_t GetWasmBackendCfgProbeStatus() { return g_status; }
uint32_t GetWasmBackendCfgProbeModuleSize() { return static_cast<uint32_t>(g_module.size()); }
uint32_t GetWasmBackendCfgProbeLoweredInstructions() { return g_lowered; }
uint8_t* GetWasmBackendCfgProbeModuleData() { return g_module.empty() ? nullptr : g_module.data(); }
uint8_t* GetWasmBackendCfgProbeContextData() { return g_context; }

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_cfg_status() { return render360::xenia_web::GetWasmBackendCfgProbeStatus(); }
uint32_t r360_wasm_backend_cfg_module_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgProbeModuleData())); }
uint32_t r360_wasm_backend_cfg_module_size() { return render360::xenia_web::GetWasmBackendCfgProbeModuleSize(); }
uint32_t r360_wasm_backend_cfg_lowered_instructions() { return render360::xenia_web::GetWasmBackendCfgProbeLoweredInstructions(); }
uint32_t r360_wasm_backend_cfg_context_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgProbeContextData())); }
}
