#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 70


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

# Execute Xenia's scalar integer ROTATE_LEFT with the destination width. The
# shift operand is intentionally allowed to be INT8 (Xenia's HIR builder
# truncates variable shift counts to INT8), while the data operand and result
# must retain the same integer type.
old_binary = """    case xe::cpu::hir::OPCODE_SHL:\n    case xe::cpu::hir::OPCODE_SHR:\n      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;\n      SetUnsigned(&result, destination->type,\n                  opcode == xe::cpu::hir::OPCODE_SHL\n                      ? au << (uint32_t(bu) & shift_mask)\n                      : au >> (uint32_t(bu) & shift_mask));\n      break;\n    case xe::cpu::hir::OPCODE_SHA:\n"""
new_binary = """    case xe::cpu::hir::OPCODE_SHL:\n    case xe::cpu::hir::OPCODE_SHR:\n      if (!GetUnsigned(a, &au) || !GetUnsigned(b, &bu)) return false;\n      SetUnsigned(&result, destination->type,\n                  opcode == xe::cpu::hir::OPCODE_SHL\n                      ? au << (uint32_t(bu) & shift_mask)\n                      : au >> (uint32_t(bu) & shift_mask));\n      break;\n    case xe::cpu::hir::OPCODE_ROTATE_LEFT: {\n      if (destination->type != lhs->type || !GetUnsigned(a, &au) ||\n          !GetUnsigned(b, &bu)) {\n        return false;\n      }\n      const uint32_t width = IntegerBitWidth(destination->type);\n      const uint32_t shift = uint32_t(bu) & shift_mask;\n      const uint64_t width_mask =\n          width == 64u ? ~uint64_t{0} : ((uint64_t{1} << width) - 1u);\n      const uint64_t value = au & width_mask;\n      const uint64_t rotated =\n          shift == 0u\n              ? value\n              : ((value << shift) | (value >> (width - shift))) & width_mask;\n      SetUnsigned(&result, destination->type, rotated);\n      break;\n    }\n    case xe::cpu::hir::OPCODE_SHA:\n"""
replace_once(executor, old_binary, new_binary, "V70 scalar HIR ROTATE_LEFT semantics")

old_dispatch = """        case xe::cpu::hir::OPCODE_SHL:\n        case xe::cpu::hir::OPCODE_SHR:\n        case xe::cpu::hir::OPCODE_SHA:\n        case xe::cpu::hir::OPCODE_COMPARE_EQ:\n"""
new_dispatch = """        case xe::cpu::hir::OPCODE_SHL:\n        case xe::cpu::hir::OPCODE_SHR:\n        case xe::cpu::hir::OPCODE_SHA:\n        case xe::cpu::hir::OPCODE_ROTATE_LEFT:\n        case xe::cpu::hir::OPCODE_COMPARE_EQ:\n"""
replace_once(executor, old_dispatch, new_dispatch, "V70 ROTATE_LEFT executor dispatch")

fastlane = ROOT / ".github/workflows/xenia-browser-bootstrap-fastlane.yml"
replace_once(
    fastlane,
    """      - 'test-hir-cache-control.mjs'\n      - 'test-xenia-entry-lr-abi.mjs'\n""",
    """      - 'test-hir-cache-control.mjs'\n      - 'test-hir-rotate-left.mjs'\n      - 'test-xenia-entry-lr-abi.mjs'\n""",
    "V70 fastlane trigger",
)
replace_once(
    fastlane,
    """      - name: Verify Braid dcbt HIR cache-control semantics\n        run: timeout 90s node ./test-hir-cache-control.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify Xenia title-entry LR ABI\n""",
    """      - name: Verify Braid dcbt HIR cache-control semantics\n        run: timeout 90s node ./test-hir-cache-control.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify Braid rlwinm HIR rotate-left semantics\n        run: timeout 90s node ./test-hir-rotate-left.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify Xenia title-entry LR ABI\n""",
    "V70 rotate-left publication gate",
)

(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=69;", "const RENDER360_RELEASE=70;", "V70 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:69,", "const CONTENT_BRIDGE={release:70,", "V70 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 69", "Render360 70")
old_ui = '<span>UI Release</span><span class="value">69</span>'
new_ui = '<span>UI Release</span><span class="value">70</span>'
if new_ui not in text:
    if old_ui not in text:
        raise SystemExit("V70 UI Release anchor missing")
    text = text.replace(old_ui, new_ui, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='70';", text, count=1)
if count != 1:
    raise SystemExit("V70 service worker version anchor missing")
sw.write_text(text)

print("R360_V70_HIR_ROTATE_LEFT_PATCH=PASS")
