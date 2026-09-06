#!/usr/bin/env python3
from pathlib import Path

path=Path('src/xenia_web_bootstrap/kernel_runtime_foundation.cpp')
text=path.read_text()

def replace_once(old,new,label):
    global text
    if old not in text:
        if new in text:
            print(f'{label}: already applied')
            return
        raise SystemExit(f'{label}: anchor not found')
    if text.count(old)!=1:
        raise SystemExit(f'{label}: expected one anchor, found {text.count(old)}')
    text=text.replace(old,new,1)
    print(f'{label}: applied')

replace_once(
"constexpr uint32_t kStatusInvalid = 3;\nconstexpr uint32_t kTlsOutOfIndexes = 0xFFFFFFFFu;",
"constexpr uint32_t kStatusInvalid = 3;\n// Match Xenia KernelState process types used by KeGet/SetCurrentProcessType.\nconstexpr uint32_t kXProcTypeIdle = 0;\nconstexpr uint32_t kXProcTypeUser = 1;\nconstexpr uint32_t kXProcTypeSystem = 2;\nconstexpr uint32_t kTlsOutOfIndexes = 0xFFFFFFFFu;",
'process-type constants')

replace_once(
"uint32_t g_next_notify_handle = 0x37000001u;",
"uint32_t g_next_notify_handle = 0x37000001u;\n// A normal retail title begins in the user process, matching Xenia KernelState.\nuint32_t g_process_type = kXProcTypeUser;",
'process-type state')

replace_once(
"  g_current_thread = 0;\n  g_scheduler_cursor = 0;\n  g_runtime_status = kStatusIdle;\n}",
"  g_current_thread = 0;\n  g_scheduler_cursor = 0;\n  g_process_type = kXProcTypeUser;\n  g_runtime_status = kStatusIdle;\n}",
'process-type reset')

replace_once(
"    switch (ordinal) {\n      case 0x0083:  // KeQueryPerformanceFrequency",
"    switch (ordinal) {\n      case 0x0066:  // KeGetCurrentProcessType\n        // Xenia returns KernelState::process_type(); normal titles start USER.\n        return g_process_type;\n      case 0x0083:  // KeQueryPerformanceFrequency",
'KeGetCurrentProcessType')

replace_once(
"      case 0x0083:  // KeQueryPerformanceFrequency\n        return kGuestTickFrequency;\n      case 0x00CC:  // NtAllocateVirtualMemory",
"      case 0x0083:  // KeQueryPerformanceFrequency\n        return kGuestTickFrequency;\n      case 0x009A:  // KeSetCurrentProcessType\n        // Xenia accepts X_PROCTYPE_IDLE/USER/SYSTEM (0..2). Keep malformed\n        // guest input fail-closed rather than manufacturing a valid state.\n        if (r3 > kXProcTypeSystem) {\n          g_service_status = kStatusInvalid;\n          return 0;\n        }\n        g_process_type = r3;\n        return 0;\n      case 0x00CC:  // NtAllocateVirtualMemory",
'KeSetCurrentProcessType')

path.write_text(text)
print('KE_CURRENT_PROCESS_TYPE_PATCH=PASS')
