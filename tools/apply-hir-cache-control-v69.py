#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 69


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if new in text:
        print(f"{label}: already applied")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count} in {path}")
    path.write_text(text.replace(old, new, 1))
    print(f"{label}: applied")


executor = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
old = """        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:\n        case xe::cpu::hir::OPCODE_MEMORY_BARRIER:\n          break;\n\n        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS: {\n"""
new = """        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:\n        case xe::cpu::hir::OPCODE_MEMORY_BARRIER:\n          break;\n\n        case xe::cpu::hir::OPCODE_CACHE_CONTROL:\n          // Xenia lowers PPC cache-management instructions (for example Braid's\n          // dcbt 0x7C00222C) to HIR CACHE_CONTROL. On x64, DATA_TOUCH is a host\n          // prefetch and DATA_STORE/FLUSH becomes a host cache-line flush. The\n          // browser runtime has one coherent sparse guest-memory backing and no\n          // emulated CPU data cache, so these operations have no architectural\n          // guest state to mutate. Treat the four Xenia-defined cache-control\n          // kinds as semantic no-ops instead of converting a cache hint into a\n          // false guest-memory dependency. Unknown flags remain fail-closed.\n          switch (static_cast<xe::cpu::hir::CacheControlType>(instr->flags)) {\n            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_TOUCH:\n            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_TOUCH_FOR_STORE:\n            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_STORE:\n            case xe::cpu::hir::CACHE_CONTROL_TYPE_DATA_STORE_AND_FLUSH:\n              break;\n            default:\n              supported = false;\n              break;\n          }\n          break;\n\n        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS: {\n"""
replace_once(executor, old, new, "V69 HIR CACHE_CONTROL compatibility semantics")

(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=68;", "const RENDER360_RELEASE=69;", "V69 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:68,", "const CONTENT_BRIDGE={release:69,", "V69 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 68", "Render360 69")
old_ui = '<span>UI Release</span><span class="value">68</span>'
new_ui = '<span>UI Release</span><span class="value">69</span>'
if new_ui not in text:
    if old_ui not in text:
        raise SystemExit("V69 UI Release anchor missing")
    text = text.replace(old_ui, new_ui, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='69';", text, count=1)
if count != 1:
    raise SystemExit("V69 service worker version anchor missing")
sw.write_text(text)

print("R360_V69_HIR_CACHE_CONTROL_PATCH=PASS")
