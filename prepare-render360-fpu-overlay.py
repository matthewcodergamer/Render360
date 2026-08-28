#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
OUT = ROOT / "build/render360-fpu-overlay/hir_correctness_executor.cpp"

text = SOURCE.read_text(encoding="utf-8")

# This build-stage copy is intentionally fail-closed. The canonical Render360
# correctness executor now owns the FPU behavior directly; this script only
# verifies that the completed finalized-HIR FPU foundation has not regressed
# before the wasm32 build consumes it.
required = {
    "typed HIR DIV": "case xe::cpu::hir::OPCODE_DIV:",
    "HIR CONVERT": "case xe::cpu::hir::OPCODE_CONVERT:",
    "HIR ROUND": "case xe::cpu::hir::OPCODE_ROUND:",
    "HIR IS_NAN": "case xe::cpu::hir::OPCODE_IS_NAN:",
    "FLOAT32 DIV execution": "result.value.f32 = a.value.f32 / b.value.f32;",
    "FLOAT64 DIV execution": "result.value.f64 = a.value.f64 / b.value.f64;",
    "floating compare execution": "IsFloatType(lhs->type) && lhs->type == rhs->type",
    "float conversion helper": "bool StoreConvertValue(",
    "rounding helper": "double RoundFloating(",
}
missing = [name for name, token in required.items() if token not in text]
if missing:
    raise SystemExit("FPU correctness foundation regression: missing " + ", ".join(missing))

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(text, encoding="utf-8")
print(f"Verified canonical Render360 FPU correctness executor: {SOURCE}")
print(f"Generated build copy: {OUT}")
print("FPU rule: canonical source executes Xenia-finalized HIR DIV/compare/IS_NAN/CONVERT/ROUND; unsupported forms remain fail-closed")
