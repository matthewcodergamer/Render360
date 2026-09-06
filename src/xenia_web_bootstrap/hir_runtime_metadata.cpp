#include <cstdint>
#include <cstddef>

#include "xenia/cpu/hir/opcodes.h"

namespace render360::xenia_web {
namespace {

constexpr const char* kOpcodeNames[] = {
#define DEFINE_OPCODE(num, name, sig, flags) name,
#include "xenia/cpu/hir/opcodes.inl"
#undef DEFINE_OPCODE
};

static_assert(sizeof(kOpcodeNames) / sizeof(kOpcodeNames[0]) ==
              xe::cpu::hir::__OPCODE_MAX_VALUE);

bool ExecutorSupports(uint32_t opcode) {
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
      return true;
    default:
      return false;
  }
}

bool CallableWasmSupports(uint32_t opcode) {
  switch (opcode) {
    case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
    case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
    case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
    case xe::cpu::hir::OPCODE_STORE_CONTEXT:
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_CAST:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET:
    case xe::cpu::hir::OPCODE_BYTE_SWAP:
    case xe::cpu::hir::OPCODE_CNTLZ:
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
    case xe::cpu::hir::OPCODE_CALL:
    case xe::cpu::hir::OPCODE_CALL_INDIRECT:
    case xe::cpu::hir::OPCODE_RETURN:
      return true;
    default:
      return false;
  }
}

bool CfgWasmSupports(uint32_t opcode) {
  switch (opcode) {
    case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
    case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
    case xe::cpu::hir::OPCODE_STORE_CONTEXT:
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_TRUNCATE:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
    case xe::cpu::hir::OPCODE_CNTLZ:
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
    case xe::cpu::hir::OPCODE_BRANCH:
    case xe::cpu::hir::OPCODE_BRANCH_TRUE:
    case xe::cpu::hir::OPCODE_BRANCH_FALSE:
    case xe::cpu::hir::OPCODE_RETURN:
    case xe::cpu::hir::OPCODE_RETURN_TRUE:
      return true;
    default:
      return false;
  }
}

}  // namespace

extern "C" uint32_t r360_hir_opcode_count() {
  return static_cast<uint32_t>(xe::cpu::hir::__OPCODE_MAX_VALUE);
}

extern "C" uint32_t r360_hir_opcode_name_ptr(uint32_t opcode) {
  if (opcode >= r360_hir_opcode_count()) return 0;
  return static_cast<uint32_t>(
      reinterpret_cast<uintptr_t>(kOpcodeNames[opcode]));
}

extern "C" uint32_t r360_hir_opcode_executor_supported(uint32_t opcode) {
  return ExecutorSupports(opcode) ? 1u : 0u;
}

extern "C" uint32_t r360_hir_opcode_callable_wasm_supported(uint32_t opcode) {
  return CallableWasmSupports(opcode) ? 1u : 0u;
}

extern "C" uint32_t r360_hir_opcode_cfg_wasm_supported(uint32_t opcode) {
  return CfgWasmSupports(opcode) ? 1u : 0u;
}

extern "C" uint32_t r360_hir_opcode_reference_available(uint32_t opcode) {
  return opcode < r360_hir_opcode_count() ? 1u : 0u;
}

}  // namespace render360::xenia_web
