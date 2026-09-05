#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 60


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


# ---------------------------------------------------------------------------
# V60 build compatibility: STORE_CONTEXT stack tracing.
# ---------------------------------------------------------------------------
overlay_path = ROOT / 'prepare-hir-call-return-stack-overlay.py'
overlay = overlay_path.read_text()
compat_marker = '# R360_V60_STORE_CONTEXT_STACK_COMPAT'
if compat_marker not in overlay:
    section_start = overlay.find("store_context_old = '''")
    end_marker = "replace_once(store_context_old, store_context_new, 'r1 STORE_CONTEXT tracing')\n"
    section_end = overlay.find(end_marker, section_start)
    require(section_start >= 0 and section_end >= 0,
            'V60 build fix: legacy STORE_CONTEXT overlay section not found')
    section_end += len(end_marker)

    replacement = r"""# R360_V60_STORE_CONTEXT_STACK_COMPAT
# Patch the STORE_CONTEXT case structurally rather than matching its complete
# body. V60 may recover a missing HIR source from live PPC context before the
# final break; stack tracing belongs after that recovery so it observes the
# actual committed r1 value without deleting or bypassing V60 behavior.
store_case_anchor = '        case xe::cpu::hir::OPCODE_STORE_CONTEXT: {'
load_case_anchor = '        case xe::cpu::hir::OPCODE_LOAD_CONTEXT:'
store_case_start = text.find(store_case_anchor)
store_case_end = text.find(load_case_anchor, store_case_start)
if store_case_start < 0 or store_case_end < 0:
    raise SystemExit('hir call/return stack overlay: STORE_CONTEXT case boundary changed')
store_case = text[store_case_start:store_case_end]
if 'R360_STACK_WRITE ppc=' not in store_case:
    first_store = '          supported = StoreResolvedValue(\n'
    if 'const uint64_t old_r1 = context.r[1];' not in store_case:
        if first_store not in store_case:
            raise SystemExit('hir call/return stack overlay: STORE_CONTEXT write anchor changed')
        store_case = store_case.replace(
            first_store,
            '          const uint64_t old_r1 = context.r[1];\n' + first_store,
            1,
        )

    trace = '''          if (supported && offset == kR360PpcR1ContextOffset &&\n              size == sizeof(uint64_t)) {\n            const int64_t delta = static_cast<int64_t>(context.r[1]) -\n                                  static_cast<int64_t>(old_r1);\n            g_r360_stack_trace.last_old_r1 = old_r1;\n            g_r360_stack_trace.last_new_r1 = context.r[1];\n            g_r360_stack_trace.last_write_address = current_source_address;\n            g_r360_stack_trace.last_write_depth = g_execution_depth;\n            std::fprintf(stderr,\n                         "R360_STACK_WRITE ppc=0x%08X depth=%u old=0x%08X new=0x%08X delta=%lld\\n",\n                         current_source_address, g_execution_depth,\n                         static_cast<uint32_t>(old_r1),\n                         static_cast<uint32_t>(context.r[1]),\n                         static_cast<long long>(delta));\n          }\n'''
    break_anchor = '          break;\n'
    break_at = store_case.rfind(break_anchor)
    if break_at < 0:
        raise SystemExit('hir call/return stack overlay: STORE_CONTEXT final break changed')
    store_case = store_case[:break_at] + trace + store_case[break_at:]
    text = text[:store_case_start] + store_case + text[store_case_end:]
"""
    overlay = overlay[:section_start] + replacement + overlay[section_end:]
    overlay_path.write_text(overlay)
    print('V60 structural STORE_CONTEXT stack overlay: applied')
else:
    print('V60 structural STORE_CONTEXT stack overlay: already applied')


# ---------------------------------------------------------------------------
# V60 build compatibility: V59 interior-tail execution entry setter.
#
# V60 added SetHIRCorrectnessContextProvenanceRecovery between the address
# resolver and IsHIRCorrectnessExecutionActive. The older tail-frame overlay
# assumed those two declarations were adjacent and aborted with
# "tail frame entry setter: 0 anchors". Insert the V59 execution-entry API after
# the address-resolver function itself, independent of whatever newer setters
# follow it.
# ---------------------------------------------------------------------------
tail_path = ROOT / 'prepare-hir-tail-frame-overlay.py'
tail = tail_path.read_text()
tail_marker = '# R360_V60_TAIL_ENTRY_SETTER_COMPAT'
if tail_marker not in tail:
    section_start = tail.find("one('''void SetHIRCorrectnessAddressResolver")
    section_end_marker = "''','entry setter')\n"
    section_end = tail.find(section_end_marker, section_start)
    require(section_start >= 0 and section_end >= 0,
            'V60 build fix: legacy tail-frame entry-setter section not found')
    section_end += len(section_end_marker)

    replacement = r"""# R360_V60_TAIL_ENTRY_SETTER_COMPAT
# V60 may place additional correctness-executor setters after the address
# resolver. Anchor only on the resolver function and append the V59 interior
# entry API without assuming the next function name.
entry_setter_anchor = '''void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver) {
  g_address_resolver = resolver;
}
'''
entry_setter_api = '''void SetHIRCorrectnessExecutionEntry(uint32_t guest_address){g_requested_execution_entry=guest_address;if(guest_address)g_last_interior_entry_missing=0;}
uint32_t GetHIRCorrectnessCurrentCallFlags(){return g_current_call_flags;}
uint32_t ConsumeHIRCorrectnessInteriorEntryMissing(){const uint32_t address=g_last_interior_entry_missing;g_last_interior_entry_missing=0;return address;}
'''
if 'void SetHIRCorrectnessExecutionEntry(uint32_t guest_address)' not in s:
    if s.count(entry_setter_anchor) != 1:
        raise SystemExit(f'tail frame entry setter resolver anchor: {s.count(entry_setter_anchor)} anchors')
    s = s.replace(entry_setter_anchor, entry_setter_anchor + entry_setter_api, 1)
"""
    tail = tail[:section_start] + replacement + tail[section_end:]
    tail_path.write_text(tail)
    print('V60 structural tail-frame entry setter: applied')
else:
    print('V60 structural tail-frame entry setter: already applied')


# ---------------------------------------------------------------------------
# Release/version contract.
# Keep every user-visible website release marker on the current emulator release.
# The package-core workflow is explicitly dispatched by the apply workflow after
# this commit so Core Build is rebuilt from the same VERSION value.
# ---------------------------------------------------------------------------
(ROOT / 'VERSION').write_text(f'{RELEASE}\n')

runtime_path = ROOT / 'runtime/render360-runtime.js'
runtime = runtime_path.read_text()
for old in range(44, RELEASE):
    runtime = runtime.replace(f'const RENDER360_RELEASE={old};',
                              f'const RENDER360_RELEASE={RELEASE};', 1)
    runtime = runtime.replace(f'const CONTENT_BRIDGE={{release:{old},',
                              f'const CONTENT_BRIDGE={{release:{RELEASE},', 1)
require(f'const RENDER360_RELEASE={RELEASE};' in runtime,
        'V60 release fix: RENDER360_RELEASE anchor missing')
require(f'const CONTENT_BRIDGE={{release:{RELEASE},' in runtime,
        'V60 release fix: CONTENT_BRIDGE release anchor missing')
runtime_path.write_text(runtime)

index_path = ROOT / 'index.html'
index = index_path.read_text()
for old in range(44, RELEASE):
    index = index.replace(f'Render360 {old}', f'Render360 {RELEASE}')
    index = index.replace(
        f'<span>UI Release</span><span class="value">{old}</span>',
        f'<span>UI Release</span><span class="value">{RELEASE}</span>',
    )
require(f'Render360 {RELEASE}' in index,
        'V60 release fix: document release title anchor missing')
require(f'<span>UI Release</span><span class="value">{RELEASE}</span>' in index,
        'V60 release fix: UI Release settings anchor missing')
index_path.write_text(index)

sw_path = ROOT / 'render360-sw.js'
sw = sw_path.read_text()
sw, count = re.subn(r"const VERSION='\d+';",
                    f"const VERSION='{RELEASE}';", sw, count=1)
require(count == 1, 'V60 release fix: service-worker cache version anchor missing')
sw_path.write_text(sw)

print(f'R360_V{RELEASE}_BUILD_VERSION_FIX=PASS')
