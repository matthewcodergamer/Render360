#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if new in text:
        return
    if old not in text:
        raise SystemExit(f'HIR stack history overlay: {label} anchor changed')
    text = text.replace(old, new, 1)


state_anchor = '''thread_local R360StackTraceState g_r360_stack_trace{};
'''
state_replacement = state_anchor + '''
constexpr uint32_t kR360StackHistoryCapacity = 32;
struct R360StackWriteHistoryEvent {
  uint32_t sequence = 0;
  uint32_t source = 0;
  uint32_t depth = 0;
  uint64_t old_r1 = 0;
  uint64_t new_r1 = 0;
};
struct R360StackCallHistoryEvent {
  uint32_t sequence = 0;
  uint32_t source = 0;
  uint32_t target = 0;
  uint32_t depth = 0;
  uint32_t flags = 0;
  uint64_t r1 = 0;
};
thread_local std::array<R360StackWriteHistoryEvent, kR360StackHistoryCapacity>
    g_r360_stack_write_history{};
thread_local std::array<R360StackCallHistoryEvent, kR360StackHistoryCapacity>
    g_r360_stack_call_history{};
thread_local uint32_t g_r360_stack_write_history_count = 0;
thread_local uint32_t g_r360_stack_call_history_count = 0;
thread_local uint32_t g_r360_stack_event_sequence = 0;

template <typename T, size_t N>
void PushBoundedHistory(std::array<T, N>& history, uint32_t* count,
                        const T& event) {
  if (!count) return;
  if (*count < N) {
    history[*count] = event;
    ++(*count);
    return;
  }
  for (size_t i = 1; i < N; ++i) history[i - 1] = history[i];
  history[N - 1] = event;
}

void RecordStackWriteHistory(uint32_t source, uint64_t old_r1,
                             uint64_t new_r1, uint32_t depth) {
  R360StackWriteHistoryEvent event;
  event.sequence = ++g_r360_stack_event_sequence;
  event.source = source;
  event.depth = depth;
  event.old_r1 = old_r1;
  event.new_r1 = new_r1;
  PushBoundedHistory(g_r360_stack_write_history,
                     &g_r360_stack_write_history_count, event);
}

void RecordStackCallHistory(uint32_t target, uint32_t flags) {
  if (!g_active_context) return;
  R360StackCallHistoryEvent event;
  event.sequence = ++g_r360_stack_event_sequence;
  event.source = g_current_source_address;
  event.target = target;
  event.depth = g_execution_depth;
  event.flags = flags;
  event.r1 = g_active_context->r[1];
  PushBoundedHistory(g_r360_stack_call_history,
                     &g_r360_stack_call_history_count, event);
}
'''
replace_once(state_anchor, state_replacement, 'history state')

call_old = '''void RecordGuestCall(uint32_t target) {
  if (!g_active_context) return;
  g_r360_stack_trace.last_call_r1 = g_active_context->r[1];
  g_r360_stack_trace.last_call_source = g_current_source_address;
  g_r360_stack_trace.last_call_target = target;
  g_r360_stack_trace.last_call_depth = g_execution_depth;
  std::fprintf(stderr,
               "R360_STACK_CALL source=0x%08X target=0x%08X depth=%u r1=0x%08X\\n",
               g_current_source_address, target, g_execution_depth,
               static_cast<uint32_t>(g_active_context->r[1]));
}
'''
call_new = '''void RecordGuestCall(uint32_t target, uint32_t flags) {
  if (!g_active_context) return;
  g_r360_stack_trace.last_call_r1 = g_active_context->r[1];
  g_r360_stack_trace.last_call_source = g_current_source_address;
  g_r360_stack_trace.last_call_target = target;
  g_r360_stack_trace.last_call_depth = g_execution_depth;
  RecordStackCallHistory(target, flags);
  std::fprintf(stderr,
               "R360_STACK_CALL source=0x%08X target=0x%08X depth=%u r1=0x%08X flags=0x%X\\n",
               g_current_source_address, target, g_execution_depth,
               static_cast<uint32_t>(g_active_context->r[1]), flags);
}
'''
replace_once(call_old, call_new, 'guest call history')

replace_once(
    'if (function) RecordGuestCall(static_cast<uint32_t>(function->address()));',
    'if (function) RecordGuestCall(static_cast<uint32_t>(function->address()), flags);',
    'function call flags',
)
replace_once(
    '  RecordGuestCall(target);\n',
    '  RecordGuestCall(target, flags);\n',
    'address call flags',
)

write_anchor = '''            g_r360_stack_trace.last_write_address = current_source_address;
            g_r360_stack_trace.last_write_depth = g_execution_depth;
            std::fprintf(stderr,
'''
write_replacement = '''            g_r360_stack_trace.last_write_address = current_source_address;
            g_r360_stack_trace.last_write_depth = g_execution_depth;
            RecordStackWriteHistory(current_source_address, old_r1,
                                    context.r[1], g_execution_depth);
            std::fprintf(stderr,
'''
replace_once(write_anchor, write_replacement, 'r1 write history')

reset_anchor = '''    g_current_source_address = 0;
    g_r360_stack_trace = {};
'''
reset_replacement = '''    g_current_source_address = 0;
    g_r360_stack_trace = {};
    g_r360_stack_write_history = {};
    g_r360_stack_call_history = {};
    g_r360_stack_write_history_count = 0;
    g_r360_stack_call_history_count = 0;
    g_r360_stack_event_sequence = 0;
'''
replace_once(reset_anchor, reset_replacement, 'outer history reset')

export_anchor = '''__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_depth() {
  return g_r360_stack_trace.last_call_depth;
}
}  // extern "C"
'''
export_replacement = '''__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_depth() {
  return g_r360_stack_trace.last_call_depth;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_count() {
  return g_r360_stack_write_history_count;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_sequence(uint32_t index) {
  return index < g_r360_stack_write_history_count ? g_r360_stack_write_history[index].sequence : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_address(uint32_t index) {
  return index < g_r360_stack_write_history_count ? g_r360_stack_write_history[index].source : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_old_r1(uint32_t index) {
  return index < g_r360_stack_write_history_count ? static_cast<uint32_t>(g_r360_stack_write_history[index].old_r1) : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_new_r1(uint32_t index) {
  return index < g_r360_stack_write_history_count ? static_cast<uint32_t>(g_r360_stack_write_history[index].new_r1) : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_depth(uint32_t index) {
  return index < g_r360_stack_write_history_count ? g_r360_stack_write_history[index].depth : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_count() {
  return g_r360_stack_call_history_count;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_sequence(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].sequence : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_source(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].source : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_target(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].target : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_r1(uint32_t index) {
  return index < g_r360_stack_call_history_count ? static_cast<uint32_t>(g_r360_stack_call_history[index].r1) : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_depth(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].depth : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_flags(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].flags : 0;
}
}  // extern "C"
'''
replace_once(export_anchor, export_replacement, 'history ABI exports')

for marker in [
    'r360_ppc_probe_stack_write_count',
    'r360_ppc_probe_stack_call_count',
    'RecordStackWriteHistory',
    'RecordStackCallHistory',
    'g_r360_stack_event_sequence',
]:
    if marker not in text:
        raise SystemExit(f'HIR stack history overlay missing marker: {marker}')

path.write_text(text)
print('HIR_STACK_HISTORY_OVERLAY=PASS')
