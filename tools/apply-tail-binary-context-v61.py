#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
CONSOLE = ROOT / "developer-console.js"
VERSION = ROOT / "VERSION"
RUNTIME = ROOT / "runtime/render360-runtime.js"
INDEX = ROOT / "index.html"
SW = ROOT / "render360-sw.js"
RELEASE = 61


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        print(f"{label}: already applied")
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count}")
    print(f"{label}: applied")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# V61: V60 proved that exact target-rooted tail HIR can retain SSA values whose
# defining LOAD_CONTEXT is before the fragment execution point. V60 recovered
# that provenance at STORE_CONTEXT. The next measured Braid boundary is ADD at
# 0x8236EB78 (addi r1,r1,256): ADD semantics already exist, but its lhs is the
# same missing context-derived SSA class. Recover only operands that the HIR
# proves originate from LOAD_CONTEXT (optionally through identity ASSIGN), and
# only while V60's exact-tail recovery gate is enabled.
# ---------------------------------------------------------------------------
s = EXECUTOR.read_text()
old_binary = """  RuntimeValue a, b;
  if (!ResolveRuntimeValue(lhs, values, &a) ||
      !ResolveRuntimeValue(rhs, values, &b)) {
    return false;
  }
"""
new_binary = """  RuntimeValue a, b;
  // R360_V61_BINARY_CONTEXT_RECOVERY
  // Exact target-rooted tail fragments may begin after a context LOAD that
  // still defines an operand used by the first arithmetic instruction. Keep
  // normal execution strict; only V60's explicitly-scoped recovery mode may
  // materialize that proven PPCContext source.
  auto resolve_binary_operand = [&](const Value* operand, RuntimeValue* out,
                                    const char* side) -> bool {
    if (ResolveRuntimeValue(operand, values, out)) return true;
    if (!g_context_provenance_recovery_enabled || !g_active_context) {
      return false;
    }
    uint64_t context_offset = 0;
    if (!ResolveContextProvenance(operand, *g_active_context, out,
                                  &context_offset)) {
      return false;
    }
    std::fprintf(
        stderr,
        "R360_CONTEXT_VALUE_RECOVERY stage=binary side=%s load=0x%llX type=%u\\n",
        side, static_cast<unsigned long long>(context_offset),
        static_cast<unsigned>(operand->type));
    return true;
  };
  if (!resolve_binary_operand(lhs, &a, "lhs") ||
      !resolve_binary_operand(rhs, &b, "rhs")) {
    return false;
  }
"""
s = replace_once(s, old_binary, new_binary,
                 "V61 binary context provenance recovery")
EXECUTOR.write_text(s)


# ---------------------------------------------------------------------------
# Diagnostics: the V60 unsupported-tail classifier looked for a tail CALL whose
# target exactly equaled the failing PPC. Once the first instruction at the tail
# succeeds, the blocker naturally moves to +4 and that test becomes false. Use
# the actual most-recent call edge instead. If it is CALL_TAIL, the current HIR
# boundary is still executing that tail fragment.
# ---------------------------------------------------------------------------
d = CONSOLE.read_text()
old_tail = "  const tailCall=[...calls].reverse().find(event=>event.target===cpu?.executionBlockerAddress&&((number(event.flags)||0)&2)!==0);"
new_tail = "  const lastCall=calls.length?calls[calls.length-1]:undefined;\n  const tailCall=lastCall&&(((number(lastCall.flags)||0)&2)!==0)?lastCall:undefined;"
d = replace_once(d, old_tail, new_tail,
                 "V61 active-tail diagnostic classification")
# Tail target is the call target; the failing PPC remains primarySuspect.
d = d.replace("tailTarget:cpu.executionBlockerAddress,", "tailTarget:tailCall.target,", 2)
CONSOLE.write_text(d)


# ---------------------------------------------------------------------------
# Release contract: every website/runtime update moves all visible version
# surfaces together. VERSION also drives the package-core metadata/build.
# ---------------------------------------------------------------------------
VERSION.write_text(f"{RELEASE}\n")

runtime = RUNTIME.read_text()
runtime = replace_once(runtime,
                       "const RENDER360_RELEASE=60;",
                       "const RENDER360_RELEASE=61;",
                       "V61 runtime release")
runtime = replace_once(runtime,
                       "const CONTENT_BRIDGE={release:60,",
                       "const CONTENT_BRIDGE={release:61,",
                       "V61 content bridge release")
RUNTIME.write_text(runtime)

index = INDEX.read_text()
index = index.replace("Render360 60", "Render360 61")
index = replace_once(index,
                     '<span>UI Release</span><span class="value">60</span>',
                     '<span>UI Release</span><span class="value">61</span>',
                     "V61 UI Release label")
INDEX.write_text(index)

sw = SW.read_text()
sw, count = re.subn(r"const VERSION='\d+';", "const VERSION='61';", sw, count=1)
if count != 1:
    raise SystemExit("V61 service-worker version anchor missing")
SW.write_text(sw)

print("R360_V61_TAIL_BINARY_CONTEXT_PATCH=PASS")
