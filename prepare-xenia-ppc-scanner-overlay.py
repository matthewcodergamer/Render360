#!/usr/bin/env python3
"""Generate the Xenia PPCScanner overlay.

PPCScanner::IsRestGprLr ends a function at `b __restgprlr_N` when
Processor::QueryFunction knows that address as a kEpilogReturn function. In
Xenia the helpers are declared by XexModule::FindSaveRest and land in the
processor entry table on first resolution. Render360's executor inlines
those epilogues and never resolves them through the entry table, so the
overlay also accepts the addresses Render360's FindSaveRest port registered
(r360_ppc_probe_register_save_rest). Everything else is unchanged.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream" / "xenia" / "src/xenia/cpu/ppc/ppc_scanner.cc"
DEST = ROOT / "build" / "xenia-web-overlay" / "xenia/cpu/ppc/ppc_scanner.cc"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream ppc_scanner.cc is missing")
text = SOURCE.read_text(errors="strict")

anchor = """bool PPCScanner::IsRestGprLr(uint32_t address) {
  auto function = frontend_->processor()->QueryFunction(address);
  return function && function->behavior() == Function::Behavior::kEpilogReturn;
}"""
replacement = """bool PPCScanner::IsRestGprLr(uint32_t address) {
  auto function = frontend_->processor()->QueryFunction(address);
  return (function &&
          function->behavior() == Function::Behavior::kEpilogReturn) ||
         render360::xenia_web::IsRegisteredRestGprLr(address);
}"""
if text.count(anchor) != 1:
    raise SystemExit("PPC scanner overlay: IsRestGprLr anchor changed")
text = text.replace(anchor, replacement)
namespace_anchor = "namespace xe {\nnamespace cpu {\nnamespace ppc {\n"
if text.count(namespace_anchor) != 1:
    raise SystemExit("PPC scanner overlay: namespace anchor changed")
text = text.replace(namespace_anchor,
                    "namespace render360::xenia_web {\n"
                    "bool IsRegisteredRestGprLr(uint32_t address);\n"
                    "}  // namespace render360::xenia_web\n\n" + namespace_anchor)
DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated PPC scanner overlay: {DEST}")
print("Scanner rule: Render360-registered __restgprlr_N count as kEpilogReturn")
