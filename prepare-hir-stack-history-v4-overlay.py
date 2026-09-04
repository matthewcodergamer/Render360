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
        raise SystemExit(f'hir stack history v4: {label} anchor changed')
    text = text.replace(old, new, 1)


# The one-value "last stack write" diagnostic proved the blocker is entered
# with r1 above the high stack boundary, but it cannot tell whether a matching
# prologue allocation occurred earlier. Keep a small bounded history inside the
# native executor so the real device report shows every recent r1 mutation and
# nested guest call without making the execution path unbounded.
history_anchor = 'thread_local R360StackTraceState g_r360_stack_trace{};\n'
history_block = r'''thread_local R360StackTraceState g_r360_stack_trace{};

enum R360StackHistoryKind : uint32_t {
  kR360StackHistoryWrite = 1,
  kR360StackHistoryCall = 2,
};

struct R360StackHistoryEvent {
  uint32_t kind = 0;
  uint32_t source = 0;
  uint32_t source_instruction = 0;
  uint32_t target = 0;
  uint32_t flags = 0;
  uint32_t depth = 0;
  uint64_t old_r1 = 0;
  uint64_t new_r1 = 0;
};

constexpr uint32_t kR360StackHistoryCapacity = 24;
thread_local std::array<R360StackHistoryEvent, kR360StackHistoryCapacity>
    g_r360_stack_history{};
thread_local uint32_t g_r360_stack_history_count = 0;

uint32_t ReadStackHistoryPpc(uint32_t address) {
  if (!address) return 0;
  uint8_t raw[4] = {};
  if (!ReadSparseGuestMemory(address, raw, sizeof(raw))) return 0;
  return (uint32_t(raw[0]) << 24) | (uint32_t(raw[1]) << 16) |
         (uint32_t(raw[2]) << 8) | uint32_t(raw[3]);
}

void PushStackHistory(uint32_t kind, uint32_t source, uint32_t target,
                      uint32_t flags, uint32_t depth, uint64_t old_r1,
                      uint64_t new_r1) {
  R360StackHistoryEvent event;
  event.kind = kind;
  event.source = source;
  event.source_instruction = ReadStackHistoryPpc(source);
  event.target = target;
  event.flags = flags;
  event.depth = depth;
  event.old_r1 = old_r1;
  event.new_r1 = new_r1;
  if (g_r360_stack_history_count < kR360StackHistoryCapacity) {
    g_r360_stack_history[g_r360_stack_history_count++] = event;
    return;
  }
  for (uint32_t i = 1; i < kR360StackHistoryCapacity; ++i) {
    g_r360_stack_history[i - 1] = g_r360_stack_history[i];
  }
  g_r360_stack_history[kR360StackHistoryCapacity - 1] = event;
}
'''
replace_once(history_anchor, history_block, 'history state')

call_anchor = '''  g_r360_stack_trace.last_call_target = target;\n  g_r360_stack_trace.last_call_depth = g_execution_depth;\n  std::fprintf(stderr,'''
call_replacement = '''  g_r360_stack_trace.last_call_target = target;\n  g_r360_stack_trace.last_call_depth = g_execution_depth;\n  PushStackHistory(kR360StackHistoryCall, g_current_source_address, target, 0,\n                   g_execution_depth, g_active_context->r[1],\n                   g_active_context->r[1]);\n  std::fprintf(stderr,'''
replace_once(call_anchor, call_replacement, 'call history')

write_anchor = '''            g_r360_stack_trace.last_write_address = current_source_address;\n            g_r360_stack_trace.last_write_depth = g_execution_depth;\n            std::fprintf(stderr,'''
write_replacement = '''            g_r360_stack_trace.last_write_address = current_source_address;\n            g_r360_stack_trace.last_write_depth = g_execution_depth;\n            PushStackHistory(kR360StackHistoryWrite, current_source_address, 0,\n                             0, g_execution_depth, old_r1, context.r[1]);\n            std::fprintf(stderr,'''
replace_once(write_anchor, write_replacement, 'r1 write history')

reset_anchor = '''    g_current_source_address = 0;\n    g_r360_stack_trace = {};\n  }'''
reset_replacement = '''    g_current_source_address = 0;\n    g_r360_stack_trace = {};\n    g_r360_stack_history = {};\n    g_r360_stack_history_count = 0;\n  }'''
replace_once(reset_anchor, reset_replacement, 'history reset')

# Export a stable index-based ABI. The browser snapshots this immediately after
# title execution just like the existing blocker r1 fields, so later UI work
# cannot destroy the evidence.
namespace_close = '\n}  // namespace render360::xenia_web\n'
insert_at = text.rfind(namespace_close)
if insert_at < 0:
    raise SystemExit('hir stack history v4: namespace close missing')
if 'r360_ppc_probe_stack_history_count' not in text:
    exports = r'''

extern "C" {
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_count() {
  return g_r360_stack_history_count;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_capacity() {
  return kR360StackHistoryCapacity;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_kind(uint32_t index) {
  return index < g_r360_stack_history_count ? g_r360_stack_history[index].kind : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_source(uint32_t index) {
  return index < g_r360_stack_history_count ? g_r360_stack_history[index].source : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_instruction(uint32_t index) {
  return index < g_r360_stack_history_count ? g_r360_stack_history[index].source_instruction : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_target(uint32_t index) {
  return index < g_r360_stack_history_count ? g_r360_stack_history[index].target : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_flags(uint32_t index) {
  return index < g_r360_stack_history_count ? g_r360_stack_history[index].flags : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_depth(uint32_t index) {
  return index < g_r360_stack_history_count ? g_r360_stack_history[index].depth : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_old_r1(uint32_t index) {
  return index < g_r360_stack_history_count
             ? static_cast<uint32_t>(g_r360_stack_history[index].old_r1)
             : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_history_new_r1(uint32_t index) {
  return index < g_r360_stack_history_count
             ? static_cast<uint32_t>(g_r360_stack_history[index].new_r1)
             : 0;
}
}  // extern "C"
'''
    text = text[:insert_at] + exports + text[insert_at:]

required = [
    'kR360StackHistoryCapacity = 24',
    'PushStackHistory(kR360StackHistoryWrite',
    'PushStackHistory(kR360StackHistoryCall',
    'r360_ppc_probe_stack_history_count',
    'r360_ppc_probe_stack_history_instruction',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f'hir stack history v4: missing generated marker {marker}')

path.write_text(text)
print('HIR_STACK_HISTORY_V4=PASS')
