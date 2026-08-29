#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
src = root / 'src/xenia_web_bootstrap/wasm_backend_cfg_probe.cpp'
out = root / 'build/xenia-web-overlay/render360/wasm_backend_cfg_probe.cpp'
text = src.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if text.count(old) != 1:
        raise SystemExit(f'WasmBackend CFG resumable overlay: {label} source contract changed ({text.count(old)} matches)')
    text = text.replace(old, new, 1)


replace_once(
    '#include <cstddef>\n#include <cstdint>\n',
    '#include <array>\n#include <cstddef>\n#include <cstdint>\n',
    'array include',
)

replace_once(
    '''uint32_t g_status = 0;\nuint32_t g_lowered = 0;\nstd::vector<uint8_t> g_module;\nalignas(64) uint8_t g_context[sizeof(PPCContext)] = {};\n''',
    '''uint32_t g_status = 0;\nuint32_t g_lowered = 0;\nstd::vector<uint8_t> g_module;\nalignas(64) uint8_t g_context[sizeof(PPCContext)] = {};\n\n// Browser-safe resumable CFG state. The generated module still executes against\n// Xenia's real PPCContext, while this side buffer contains only temporary HIR\n// values and the explicit CFG dispatcher PC needed to resume at a block\n// boundary after the browser fuel quantum expires. Keep multiple independent\n// slots so Xbox guest threads never share continuation state.\nconstexpr uint32_t kCfgContinuationSlotCount = 32u;\nconstexpr uint32_t kCfgContinuationFresh = 0u;\nconstexpr uint32_t kCfgContinuationYielded = 1u;\nconstexpr uint32_t kCfgContinuationCompleted = 2u;\nconstexpr uint32_t kCfgDispatchFuel = 4096u;\nconstexpr uint32_t kLocalContext = 0u;\nconstexpr uint32_t kLocalContinuation = 1u;\nconstexpr uint32_t kLocalPc = 2u;\nconstexpr uint32_t kLocalFuel = 3u;\nconstexpr uint32_t kValueLocalBase = 4u;\nuint32_t g_continuation_state_size = 0;\nstd::array<std::vector<uint64_t>, kCfgContinuationSlotCount>\n    g_continuation_slots;\n''',
    'continuation globals',
)

replace_once(
    '''void EmitI64Const(std::vector<uint8_t>& out, int64_t value) {\n  out.push_back(0x42);\n  EmitI64Leb(out, value);\n}\n''',
    '''void EmitI64Const(std::vector<uint8_t>& out, int64_t value) {\n  out.push_back(0x42);\n  EmitI64Leb(out, value);\n}\n\nvoid EmitLocalGet(std::vector<uint8_t>& out, uint32_t index) {\n  out.push_back(0x20);\n  EmitU32Leb(out, index);\n}\n\nvoid EmitLocalSet(std::vector<uint8_t>& out, uint32_t index) {\n  out.push_back(0x21);\n  EmitU32Leb(out, index);\n}\n\nvoid EmitI32Load(std::vector<uint8_t>& out, uint32_t offset) {\n  out.push_back(0x28);\n  EmitU32Leb(out, 2);\n  EmitU32Leb(out, offset);\n}\n\nvoid EmitI64Load(std::vector<uint8_t>& out, uint32_t offset) {\n  out.push_back(0x29);\n  EmitU32Leb(out, 3);\n  EmitU32Leb(out, offset);\n}\n\nvoid EmitI32Store(std::vector<uint8_t>& out, uint32_t offset) {\n  out.push_back(0x36);\n  EmitU32Leb(out, 2);\n  EmitU32Leb(out, offset);\n}\n\nvoid EmitI64Store(std::vector<uint8_t>& out, uint32_t offset) {\n  out.push_back(0x37);\n  EmitU32Leb(out, 3);\n  EmitU32Leb(out, offset);\n}\n\nvoid EmitContinuationStatus(std::vector<uint8_t>& out, uint32_t status) {\n  EmitLocalGet(out, kLocalContinuation);\n  EmitI32Const(out, static_cast<int32_t>(status));\n  EmitI32Store(out, 0);\n}\n\nvoid EmitLoadR3AndReturn(std::vector<uint8_t>& out) {\n  EmitLocalGet(out, kLocalContext);\n  EmitI64Load(out,\n              static_cast<uint32_t>(offsetof(PPCContext, r) +\n                                    3 * sizeof(uint64_t)));\n  out.push_back(0x0F);\n}\n\nvoid EmitSaveContinuation(const ValueLocals& locals,\n                          std::vector<uint8_t>& out, uint32_t status) {\n  EmitLocalGet(out, kLocalContinuation);\n  EmitLocalGet(out, kLocalPc);\n  EmitI32Store(out, 4);\n  for (const auto& [value, info] : locals) {\n    (void)value;\n    const uint32_t slot = info.index - kValueLocalBase;\n    const uint32_t offset = 8u + slot * 8u;\n    EmitLocalGet(out, kLocalContinuation);\n    EmitLocalGet(out, info.index);\n    if (IsI64(info.type))\n      EmitI64Store(out, offset);\n    else\n      EmitI32Store(out, offset);\n  }\n  EmitContinuationStatus(out, status);\n}\n\nvoid EmitRestoreContinuation(const ValueLocals& locals,\n                             std::vector<uint8_t>& out) {\n  EmitLocalGet(out, kLocalContinuation);\n  EmitI32Load(out, 4);\n  EmitLocalSet(out, kLocalPc);\n  for (const auto& [value, info] : locals) {\n    (void)value;\n    const uint32_t slot = info.index - kValueLocalBase;\n    const uint32_t offset = 8u + slot * 8u;\n    EmitLocalGet(out, kLocalContinuation);\n    if (IsI64(info.type))\n      EmitI64Load(out, offset);\n    else\n      EmitI32Load(out, offset);\n    EmitLocalSet(out, info.index);\n  }\n}\n''',
    'continuation emit helpers',
)

replace_once(
    '''void EmitSetPc(std::vector<uint8_t>& out, uint32_t pc) {\n  EmitI32Const(out, static_cast<int32_t>(pc));\n  out.push_back(0x21); out.push_back(0x01);\n}\n''',
    '''void EmitSetPc(std::vector<uint8_t>& out, uint32_t pc) {\n  EmitI32Const(out, static_cast<int32_t>(pc));\n  EmitLocalSet(out, kLocalPc);\n}\n''',
    'pc local',
)

replace_once(
    '  uint32_t next = 3;  // ctx=0, pc=1, dispatch budget=2\n',
    '  uint32_t next = kValueLocalBase;  // ctx=0, continuation=1, pc=2, fuel=3\n',
    'value local base',
)

replace_once(
    '''  EmitSetPc(body, 0);\n  EmitI32Const(body, 100000);\n  body.push_back(0x21); body.push_back(0x02);\n  body.push_back(0x02); body.push_back(0x40);\n  body.push_back(0x03); body.push_back(0x40);\n  body.push_back(0x20); body.push_back(0x02);\n  body.push_back(0x45);\n  body.push_back(0x04); body.push_back(0x40);\n  body.push_back(0x00);\n  body.push_back(0x0B);\n  body.push_back(0x20); body.push_back(0x02);\n  EmitI32Const(body, 1); body.push_back(0x6B);\n  body.push_back(0x21); body.push_back(0x02);\n''',
    '''  // Completed continuations are idempotent: never restart a guest function\n  // whose real return boundary has already been observed.\n  EmitLocalGet(body, kLocalContinuation);\n  EmitI32Load(body, 0);\n  EmitI32Const(body, static_cast<int32_t>(kCfgContinuationCompleted));\n  body.push_back(0x46);\n  body.push_back(0x04); body.push_back(0x40);\n  EmitLoadR3AndReturn(body);\n  body.push_back(0x0B);\n\n  // Resume only a continuation explicitly marked yielded. Fresh slots start at\n  // block zero with WebAssembly's zero-initialized value locals.\n  EmitLocalGet(body, kLocalContinuation);\n  EmitI32Load(body, 0);\n  EmitI32Const(body, static_cast<int32_t>(kCfgContinuationYielded));\n  body.push_back(0x46);\n  body.push_back(0x04); body.push_back(0x40);\n  EmitRestoreContinuation(locals, body);\n  body.push_back(0x05);\n  EmitSetPc(body, 0);\n  body.push_back(0x0B);\n  EmitContinuationStatus(body, kCfgContinuationFresh);\n\n  EmitI32Const(body, static_cast<int32_t>(kCfgDispatchFuel));\n  EmitLocalSet(body, kLocalFuel);\n  body.push_back(0x02); body.push_back(0x40);\n  body.push_back(0x03); body.push_back(0x40);\n  EmitLocalGet(body, kLocalFuel);\n  body.push_back(0x45);\n  body.push_back(0x04); body.push_back(0x40);\n  EmitSaveContinuation(locals, body, kCfgContinuationYielded);\n  EmitLoadR3AndReturn(body);\n  body.push_back(0x0B);\n  EmitLocalGet(body, kLocalFuel);\n  EmitI32Const(body, 1); body.push_back(0x6B);\n  EmitLocalSet(body, kLocalFuel);\n''',
    'fuel yield prologue',
)

replace_once(
    '''    body.push_back(0x20); body.push_back(0x01);\n    EmitI32Const(body, static_cast<int32_t>(block_it->second));\n''',
    '''    EmitLocalGet(body, kLocalPc);\n    EmitI32Const(body, static_cast<int32_t>(block_it->second));\n''',
    'dispatcher pc read',
)

replace_once(
    '''        case xe::cpu::hir::OPCODE_RETURN:\n          body.push_back(0x0C); EmitU32Leb(body, 2);\n          ++lowered; terminated = true; break;\n        case xe::cpu::hir::OPCODE_CALL_INDIRECT:\n          if ((instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) == 0) return false;\n          body.push_back(0x0C); EmitU32Leb(body, 2);\n          ++lowered; terminated = true; break;\n''',
    '''        case xe::cpu::hir::OPCODE_RETURN:\n          EmitContinuationStatus(body, kCfgContinuationCompleted);\n          body.push_back(0x0C); EmitU32Leb(body, 2);\n          ++lowered; terminated = true; break;\n        case xe::cpu::hir::OPCODE_CALL_INDIRECT:\n          if ((instr->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) == 0) return false;\n          EmitContinuationStatus(body, kCfgContinuationCompleted);\n          body.push_back(0x0C); EmitU32Leb(body, 2);\n          ++lowered; terminated = true; break;\n''',
    'completed return status',
)

replace_once(
    '''    if (!terminated) {\n      if (block->next) {\n        const auto next = indices.find(block->next);\n        if (next == indices.end()) return false;\n        EmitSetPc(body, next->second);\n        body.push_back(0x0C); EmitU32Leb(body, 1);\n      } else {\n        body.push_back(0x0C); EmitU32Leb(body, 2);\n      }\n    }\n''',
    '''    if (!terminated) {\n      if (block->next) {\n        const auto next = indices.find(block->next);\n        if (next == indices.end()) return false;\n        EmitSetPc(body, next->second);\n        body.push_back(0x0C); EmitU32Leb(body, 1);\n      } else {\n        EmitContinuationStatus(body, kCfgContinuationCompleted);\n        body.push_back(0x0C); EmitU32Leb(body, 2);\n      }\n    }\n''',
    'fallthrough completion status',
)

replace_once(
    '''  EmitU32Leb(type,1); type.push_back(0x60); EmitU32Leb(type,1); type.push_back(0x7F); EmitU32Leb(type,1); type.push_back(0x7E);\n''',
    '''  EmitU32Leb(type,1); type.push_back(0x60); EmitU32Leb(type,2); type.push_back(0x7F); type.push_back(0x7F); EmitU32Leb(type,1); type.push_back(0x7E);\n''',
    'run signature',
)

replace_once(
    '''  g_module = std::move(module);\n  g_lowered = lowered;\n  return true;\n}\n''',
    '''  g_module = std::move(module);\n  g_lowered = lowered;\n  g_continuation_state_size =\n      8u + (i32_count + i64_count) * static_cast<uint32_t>(sizeof(uint64_t));\n  const size_t continuation_words =\n      (size_t(g_continuation_state_size) + sizeof(uint64_t) - 1u) /\n      sizeof(uint64_t);\n  for (auto& slot : g_continuation_slots) slot.assign(continuation_words, 0u);\n  return true;\n}\n''',
    'continuation slot allocation',
)

replace_once(
    '''void ResetWasmBackendCfgProbe() {\n  g_status = 0; g_lowered = 0; g_module.clear(); std::memset(g_context, 0, sizeof(g_context));\n}\n''',
    '''void ResetWasmBackendCfgProbe() {\n  g_status = 0;\n  g_lowered = 0;\n  g_module.clear();\n  g_continuation_state_size = 0;\n  for (auto& slot : g_continuation_slots) slot.clear();\n  std::memset(g_context, 0, sizeof(g_context));\n}\n''',
    'continuation reset',
)

replace_once(
    '''uint8_t* GetWasmBackendCfgProbeModuleData() { return g_module.empty() ? nullptr : g_module.data(); }\nuint8_t* GetWasmBackendCfgProbeContextData() { return g_context; }\n\n}  // namespace render360::xenia_web\n\nextern "C" {\nuint32_t r360_wasm_backend_cfg_status() { return render360::xenia_web::GetWasmBackendCfgProbeStatus(); }\nuint32_t r360_wasm_backend_cfg_module_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgProbeModuleData())); }\nuint32_t r360_wasm_backend_cfg_module_size() { return render360::xenia_web::GetWasmBackendCfgProbeModuleSize(); }\nuint32_t r360_wasm_backend_cfg_lowered_instructions() { return render360::xenia_web::GetWasmBackendCfgProbeLoweredInstructions(); }\nuint32_t r360_wasm_backend_cfg_context_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgProbeContextData())); }\n}\n''',
    '''uint8_t* GetWasmBackendCfgProbeModuleData() { return g_module.empty() ? nullptr : g_module.data(); }\nuint8_t* GetWasmBackendCfgProbeContextData() { return g_context; }\nuint32_t GetWasmBackendCfgContinuationSlotCount() {\n  return kCfgContinuationSlotCount;\n}\nuint32_t GetWasmBackendCfgContinuationStateSize() {\n  return g_continuation_state_size;\n}\nuint8_t* GetWasmBackendCfgContinuationData(uint32_t slot) {\n  if (slot >= kCfgContinuationSlotCount || g_continuation_slots[slot].empty())\n    return nullptr;\n  return reinterpret_cast<uint8_t*>(g_continuation_slots[slot].data());\n}\nuint32_t GetWasmBackendCfgContinuationStatus(uint32_t slot) {\n  auto* data = GetWasmBackendCfgContinuationData(slot);\n  if (!data || g_continuation_state_size < sizeof(uint32_t)) return 0u;\n  uint32_t status = 0;\n  std::memcpy(&status, data, sizeof(status));\n  return status;\n}\nvoid ResetWasmBackendCfgContinuation(uint32_t slot) {\n  if (slot >= kCfgContinuationSlotCount) return;\n  auto& state = g_continuation_slots[slot];\n  if (!state.empty()) std::memset(state.data(), 0, state.size() * sizeof(uint64_t));\n}\n\n}  // namespace render360::xenia_web\n\nextern "C" {\nuint32_t r360_wasm_backend_cfg_status() { return render360::xenia_web::GetWasmBackendCfgProbeStatus(); }\nuint32_t r360_wasm_backend_cfg_module_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgProbeModuleData())); }\nuint32_t r360_wasm_backend_cfg_module_size() { return render360::xenia_web::GetWasmBackendCfgProbeModuleSize(); }\nuint32_t r360_wasm_backend_cfg_lowered_instructions() { return render360::xenia_web::GetWasmBackendCfgProbeLoweredInstructions(); }\nuint32_t r360_wasm_backend_cfg_context_ptr() { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgProbeContextData())); }\nuint32_t r360_wasm_backend_cfg_continuation_slot_count() { return render360::xenia_web::GetWasmBackendCfgContinuationSlotCount(); }\nuint32_t r360_wasm_backend_cfg_continuation_state_size() { return render360::xenia_web::GetWasmBackendCfgContinuationStateSize(); }\nuint32_t r360_wasm_backend_cfg_continuation_ptr(uint32_t slot) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendCfgContinuationData(slot))); }\nuint32_t r360_wasm_backend_cfg_continuation_status(uint32_t slot) { return render360::xenia_web::GetWasmBackendCfgContinuationStatus(slot); }\nvoid r360_wasm_backend_cfg_continuation_reset(uint32_t slot) { render360::xenia_web::ResetWasmBackendCfgContinuation(slot); }\n}\n''',
    'continuation exports',
)

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print(
    f'WasmBackend CFG resumable overlay: {src.relative_to(root)} -> '
    f'{out.relative_to(root)} (32 per-thread continuation slots, 4096 block fuel)'
)
