#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if old not in text:
        if new in text:
            return
        raise SystemExit(f'hir call/return stack overlay: {label} anchor changed')
    text = text.replace(old, new, 1)


# The title-runtime memory overlay intentionally keeps xe::Memory only as a
# decoder-window fallback. Make that rule real: title stack/data addresses must
# never be satisfied from the movable probe window.
replace_once(
    'extern "C" uint32_t r360_ppc_probe_guest_base();\n',
    'extern "C" uint32_t r360_ppc_probe_guest_base();\n'
    'extern "C" uint32_t r360_ppc_probe_loaded_size();\n',
    'probe loaded-size declaration',
)

fallback_old = '''    uint8_t* host = nullptr;\n    if (!TranslateGuestRange(memory, guest_address, size, &host)) {'''
fallback_new = '''    const uint32_t probe_base = r360_ppc_probe_guest_base();\n    const uint32_t probe_size = r360_ppc_probe_loaded_size();\n    const uint64_t probe_end = uint64_t(probe_base) + probe_size;\n    const uint64_t access_end = uint64_t(guest_address) + size;\n    const bool in_probe_window =\n        probe_size != 0 && guest_address >= probe_base &&\n        access_end <= probe_end;\n    uint8_t* host = nullptr;\n    if (!in_probe_window ||\n        !TranslateGuestRange(memory, guest_address, size, &host)) {'''
count = text.count(fallback_old)
if count == 2:
    text = text.replace(fallback_old, fallback_new, 2)
elif text.count(fallback_new) != 2:
    raise SystemExit('hir call/return stack overlay: decoder fallback anchors changed')

# Desktop Xenia tracks the guest call return address. CALL_POSSIBLE_RETURN is
# NOT an unconditional return: a bclr-style branch is a return only when its
# target matches the expected guest return address. Render360 previously threw
# away SET_RETURN_ADDRESS and treated every CALL_POSSIBLE_RETURN as RETURN,
# which can enter the wrong epilogue/tail path and corrupt live PPC state.
#
# A direct non-linking `b` is different: Xenia lowers it to CALL_TAIL and no
# SET_RETURN_ADDRESS is emitted. If that tail call originated at the top-level
# compatibility entry there is intentionally no guest return address to inherit;
# the tail callee's final `blr` must still complete the host-side title slice.
# Track that state explicitly instead of weakening nested-return validation.
globals_anchor = '''thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;\nthread_local uint32_t g_execution_depth = 0;\n'''
globals_replacement = '''thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;\nthread_local uint32_t g_execution_depth = 0;\n\nconstexpr uint32_t kR360MaxGuestCallDepth = 64;\nconstexpr size_t kR360PpcR1ContextOffset =\n    offsetof(xe::cpu::ppc::PPCContext, r) + sizeof(uint64_t);\nthread_local std::array<uint64_t, kR360MaxGuestCallDepth>\n    g_expected_guest_returns{};\nthread_local std::array<bool, kR360MaxGuestCallDepth>\n    g_expected_guest_return_valid{};\nthread_local std::array<bool, kR360MaxGuestCallDepth>\n    g_guest_tail_terminal{};\nthread_local uint64_t g_next_guest_return_address = 0;\nthread_local bool g_next_guest_return_valid = false;\nthread_local uint32_t g_current_source_address = 0;\n\nstruct R360StackTraceState {\n  uint64_t initial_r1 = 0;\n  uint64_t last_old_r1 = 0;\n  uint64_t last_new_r1 = 0;\n  uint64_t last_call_r1 = 0;\n  uint32_t last_write_address = 0;\n  uint32_t last_write_depth = 0;\n  uint32_t last_call_source = 0;\n  uint32_t last_call_target = 0;\n  uint32_t last_call_depth = 0;\n};\nthread_local R360StackTraceState g_r360_stack_trace{};\n\nbool CurrentExpectedGuestReturn(uint64_t* out) {\n  if (!out || g_execution_depth == 0 ||\n      g_execution_depth > kR360MaxGuestCallDepth) {\n    return false;\n  }\n  const size_t index = size_t(g_execution_depth - 1);\n  if (!g_expected_guest_return_valid[index]) return false;\n  *out = g_expected_guest_returns[index];\n  return true;\n}\n\nbool CurrentGuestTailTerminal() {\n  if (g_execution_depth == 0 ||\n      g_execution_depth > kR360MaxGuestCallDepth) {\n    return false;\n  }\n  return g_guest_tail_terminal[size_t(g_execution_depth - 1)];\n}\n\nvoid PrepareNestedGuestReturn(uint32_t flags) {\n  if (g_execution_depth >= kR360MaxGuestCallDepth) {\n    g_next_guest_return_valid = false;\n    return;\n  }\n  uint64_t expected = 0;\n  bool valid = false;\n  if (g_next_guest_return_valid) {\n    expected = g_next_guest_return_address;\n    valid = true;\n  } else {\n    // Tail calls have no fresh SET_RETURN_ADDRESS and inherit the caller's.\n    valid = CurrentExpectedGuestReturn(&expected);\n  }\n  g_expected_guest_returns[g_execution_depth] = expected;\n  g_expected_guest_return_valid[g_execution_depth] = valid;\n  g_guest_tail_terminal[g_execution_depth] =\n      !valid && (flags & xe::cpu::hir::CALL_TAIL) != 0;\n  g_next_guest_return_valid = false;\n}\n\nvoid ClearNestedGuestReturn() {\n  if (g_execution_depth < kR360MaxGuestCallDepth) {\n    g_expected_guest_return_valid[g_execution_depth] = false;\n    g_guest_tail_terminal[g_execution_depth] = false;\n  }\n}\n\nvoid RecordGuestCall(uint32_t target) {\n  if (!g_active_context) return;\n  g_r360_stack_trace.last_call_r1 = g_active_context->r[1];\n  g_r360_stack_trace.last_call_source = g_current_source_address;\n  g_r360_stack_trace.last_call_target = target;\n  g_r360_stack_trace.last_call_depth = g_execution_depth;\n  std::fprintf(stderr,\n               "R360_STACK_CALL source=0x%08X target=0x%08X depth=%u r1=0x%08X\\n",\n               g_current_source_address, target, g_execution_depth,\n               static_cast<uint32_t>(g_active_context->r[1]));\n}\n'''
replace_once(globals_anchor, globals_replacement, 'guest return/stack globals')

function_resolver_old = '''bool ResolveFunctionCallWithNestedFailure(xe::cpu::Function* function) {\n  ClearPendingNestedFailure();\n  if (!g_call_resolver || !g_call_resolver(function)) return false;\n  ClearPendingNestedFailure();\n  return true;\n}\n'''
function_resolver_new = '''bool ResolveFunctionCallWithNestedFailure(xe::cpu::Function* function,\n                                              uint32_t flags) {\n  ClearPendingNestedFailure();\n  PrepareNestedGuestReturn(flags);\n  if (function) RecordGuestCall(static_cast<uint32_t>(function->address()));\n  const bool ok = g_call_resolver && g_call_resolver(function);\n  ClearNestedGuestReturn();\n  if (!ok) return false;\n  ClearPendingNestedFailure();\n  return true;\n}\n'''
replace_once(function_resolver_old, function_resolver_new, 'function call resolver')

address_resolver_old = '''bool ResolveAddressCallWithNestedFailure(uint32_t target) {\n  ClearPendingNestedFailure();\n  if (!g_address_resolver || !g_address_resolver(target)) return false;\n  ClearPendingNestedFailure();\n  return true;\n}\n'''
address_resolver_new = '''bool ResolveAddressCallWithNestedFailure(uint32_t target, uint32_t flags) {\n  ClearPendingNestedFailure();\n  PrepareNestedGuestReturn(flags);\n  RecordGuestCall(target);\n  const bool ok = g_address_resolver && g_address_resolver(target);\n  ClearNestedGuestReturn();\n  if (!ok) return false;\n  ClearPendingNestedFailure();\n  return true;\n}\n'''
replace_once(address_resolver_old, address_resolver_new, 'address call resolver')

indirect_old = '''  if (!reached_return || !block_terminated) return false;\n  if (flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) {\n    *reached_return = true;\n    *block_terminated = true;\n    return true;\n  }\n  if (target > std::numeric_limits<uint32_t>::max()) return false;\n'''
indirect_new = '''  if (!reached_return || !block_terminated) return false;\n  if (target > std::numeric_limits<uint32_t>::max()) return false;\n  const uint32_t guest_target = static_cast<uint32_t>(target) & ~3u;\n  if (flags & xe::cpu::hir::CALL_POSSIBLE_RETURN) {\n    uint64_t expected_return = 0;\n    const bool have_expected = CurrentExpectedGuestReturn(&expected_return);\n    const uint32_t expected_target =\n        static_cast<uint32_t>(expected_return) & ~3u;\n    // The top-level compatibility probe has no host caller frame to compare\n    // against. A nested callee reached through a top-level CALL_TAIL is also a\n    // terminal host boundary and intentionally has no guest return address.\n    // All other nested bclr paths still require an exact SET_RETURN_ADDRESS\n    // match so an unrelated LR branch cannot be mistaken for a return.\n    if ((!have_expected && g_execution_depth <= 1) ||\n        (!have_expected && CurrentGuestTailTerminal()) ||\n        (have_expected && guest_target == expected_target)) {\n      *reached_return = true;\n      *block_terminated = true;\n      return true;\n    }\n  }\n'''
replace_once(indirect_old, indirect_new, 'CALL_POSSIBLE_RETURN semantics')

# Thread the CALL flags through nested resolution so the callee can distinguish
# a true top-level tail-call terminal from a malformed linked call that forgot
# to establish SET_RETURN_ADDRESS.
text = text.replace(
    'ResolveFunctionCallWithNestedFailure(instr->src1.symbol);',
    'ResolveFunctionCallWithNestedFailure(instr->src1.symbol, instr->flags);',
)
text = text.replace(
    'ResolveFunctionCallWithNestedFailure(instr->src2.symbol);',
    'ResolveFunctionCallWithNestedFailure(instr->src2.symbol, instr->flags);',
)
text = text.replace(
    'ResolveAddressCallWithNestedFailure(target);',
    'ResolveAddressCallWithNestedFailure(target, instr->flags);',
)
text = text.replace(
    'ResolveAddressCallWithNestedFailure(static_cast<uint32_t>(target))',
    'ResolveAddressCallWithNestedFailure(static_cast<uint32_t>(target), flags)',
)

set_return_old = '''        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS: {\n          uint64_t return_address = 0;\n          supported = ResolveUint64(instr->src1.value, values, &return_address);\n          break;\n        }\n'''
set_return_new = '''        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS: {\n          uint64_t return_address = 0;\n          supported = ResolveUint64(instr->src1.value, values, &return_address);\n          if (supported) {\n            g_next_guest_return_address = return_address;\n            g_next_guest_return_valid = true;\n            std::fprintf(stderr,\n                         "R360_GUEST_RETURN_SET source=0x%08X depth=%u return=0x%08X\\n",\n                         g_current_source_address, g_execution_depth,\n                         static_cast<uint32_t>(return_address));\n          }\n          break;\n        }\n'''
replace_once(set_return_old, set_return_new, 'SET_RETURN_ADDRESS persistence')

source_old = '''        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:\n          current_source_address = static_cast<uint32_t>(instr->src1.offset);\n          break;\n'''
source_new = '''        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:\n          current_source_address = static_cast<uint32_t>(instr->src1.offset);\n          g_current_source_address = current_source_address;\n          break;\n'''
replace_once(source_old, source_new, 'source address tracing')

store_context_old = '''          supported = StoreResolvedValue(\n              source, values, reinterpret_cast<uint8_t*>(&context) + offset,\n              size);\n          break;\n'''
store_context_new = '''          const uint64_t old_r1 = context.r[1];\n          supported = StoreResolvedValue(\n              source, values, reinterpret_cast<uint8_t*>(&context) + offset,\n              size);\n          if (supported && offset == kR360PpcR1ContextOffset &&\n              size == sizeof(uint64_t)) {\n            const int64_t delta = static_cast<int64_t>(context.r[1]) -\n                                  static_cast<int64_t>(old_r1);\n            g_r360_stack_trace.last_old_r1 = old_r1;\n            g_r360_stack_trace.last_new_r1 = context.r[1];\n            g_r360_stack_trace.last_write_address = current_source_address;\n            g_r360_stack_trace.last_write_depth = g_execution_depth;\n            std::fprintf(stderr,\n                         "R360_STACK_WRITE ppc=0x%08X depth=%u old=0x%08X new=0x%08X delta=%lld\\n",\n                         current_source_address, g_execution_depth,\n                         static_cast<uint32_t>(old_r1),\n                         static_cast<uint32_t>(context.r[1]),\n                         static_cast<long long>(delta));\n          }\n          break;\n'''
replace_once(store_context_old, store_context_new, 'r1 STORE_CONTEXT tracing')

outer_old = '''  const bool outermost = g_active_context == nullptr;\n  if (outermost) ClearPendingNestedFailure();\n  xe::cpu::ppc::PPCContext local_context{};\n'''
outer_new = '''  const bool outermost = g_active_context == nullptr;\n  if (outermost) {\n    ClearPendingNestedFailure();\n    g_expected_guest_return_valid.fill(false);\n    g_guest_tail_terminal.fill(false);\n    g_next_guest_return_address = 0;\n    g_next_guest_return_valid = false;\n    g_current_source_address = 0;\n    g_r360_stack_trace = {};\n  }\n  xe::cpu::ppc::PPCContext local_context{};\n'''
replace_once(outer_old, outer_new, 'outer execution reset')

context_init_old = '''    for (size_t i = 0; i < g_initial_gprs.size(); ++i) {\n      local_context.r[i] = g_initial_gprs[i];\n    }\n    g_active_context = &local_context;\n'''
context_init_new = '''    for (size_t i = 0; i < g_initial_gprs.size(); ++i) {\n      local_context.r[i] = g_initial_gprs[i];\n    }\n    g_r360_stack_trace.initial_r1 = local_context.r[1];\n    std::fprintf(stderr, "R360_STACK_INITIAL r1=0x%08X\\n",\n                 static_cast<uint32_t>(local_context.r[1]));\n    g_active_context = &local_context;\n'''
replace_once(context_init_old, context_init_new, 'initial r1 trace')

# Make the next memory blocker self-contained: it now reports the live r1 and
# the last instruction that actually wrote r1, instead of inferring stack state
# from an unrelated boundary instruction.
memory_log_old = '''                   guest_address, sparse_fault, sparse_fault_address,\n                   static_cast<unsigned>(size));\n      return false;\n'''
memory_log_new = '''                   guest_address, sparse_fault, sparse_fault_address,\n                   static_cast<unsigned>(size));\n      if (g_active_context) {\n        std::fprintf(stderr,\n                     "R360_STACK_BLOCKER fault=0x%08X r1=0x%08X initial=0x%08X last_write=0x%08X old=0x%08X new=0x%08X write_depth=%u call_source=0x%08X call_target=0x%08X call_r1=0x%08X call_depth=%u\\n",\n                     guest_address,\n                     static_cast<uint32_t>(g_active_context->r[1]),\n                     static_cast<uint32_t>(g_r360_stack_trace.initial_r1),\n                     g_r360_stack_trace.last_write_address,\n                     static_cast<uint32_t>(g_r360_stack_trace.last_old_r1),\n                     static_cast<uint32_t>(g_r360_stack_trace.last_new_r1),\n                     g_r360_stack_trace.last_write_depth,\n                     g_r360_stack_trace.last_call_source,\n                     g_r360_stack_trace.last_call_target,\n                     static_cast<uint32_t>(g_r360_stack_trace.last_call_r1),\n                     g_r360_stack_trace.last_call_depth);\n      }\n      return false;\n'''
log_count = text.count(memory_log_old)
if log_count == 2:
    text = text.replace(memory_log_old, memory_log_new, 2)
elif text.count('R360_STACK_BLOCKER fault=') != 2:
    raise SystemExit('hir call/return stack overlay: memory blocker log anchors changed')

required = [
    'R360_STACK_INITIAL',
    'R360_STACK_WRITE',
    'R360_STACK_CALL',
    'R360_GUEST_RETURN_SET',
    'CurrentExpectedGuestReturn',
    'CurrentGuestTailTerminal',
    'g_guest_tail_terminal',
    'in_probe_window',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f'hir call/return stack overlay missing marker: {marker}')

path.write_text(text)
print('HIR_CALL_RETURN_STACK_ABI_OVERLAY=PASS')
