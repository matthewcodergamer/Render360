#!/usr/bin/env python3
"""Generate the Xenia PPCTranslator overlay.

Xenia translates each guest function once and then calls its machine code.
Render360's HIR executor runs the finalized HIR builder directly, and nested
guest calls used to re-scan and re-translate the callee on every call (over
80% of Banjo-Tooie's startup time). After a successful Assemble, hand the
finalized builder to Render360's translation cache when the caller asked for
it (probe_backend.cpp) and give this pooled translator a fresh builder.
Everything else is unchanged.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream" / "xenia" / "src/xenia/cpu/ppc/ppc_translator.cc"
DEST = ROOT / "build" / "xenia-web-overlay" / "xenia/cpu/ppc/ppc_translator.cc"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream ppc_translator.cc is missing")
text = SOURCE.read_text(errors="strict")

anchor = """  if (!assembler_->Assemble(function, builder_.get(), debug_info_flags,
                            std::move(debug_info))) {
    return false;
  }
"""
replacement = anchor + """
  if (render360::xenia_web::WantsTranslatedBuilder()) {
    std::unique_ptr<hir::HIRBuilder> finalized(builder_.release());
    builder_.reset(new PPCHIRBuilder(frontend_));
    render360::xenia_web::RetainTranslatedBuilder(std::move(finalized));
  }
"""
if text.count(anchor) != 1:
    raise SystemExit("PPC translator overlay: Assemble anchor changed")
text = text.replace(anchor, replacement)
namespace_anchor = "namespace xe {\nnamespace cpu {\nnamespace ppc {\n"
if text.count(namespace_anchor) != 1:
    raise SystemExit("PPC translator overlay: namespace anchor changed")
text = text.replace(namespace_anchor,
                    "namespace render360::xenia_web {\n"
                    "bool WantsTranslatedBuilder();\n"
                    "void RetainTranslatedBuilder(std::unique_ptr<xe::cpu::hir::HIRBuilder> builder);\n"
                    "}  // namespace render360::xenia_web\n\n" + namespace_anchor)
DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated PPC translator overlay: {DEST}")
print("Translator rule: finalized nested-call HIR is retained for re-execution")
