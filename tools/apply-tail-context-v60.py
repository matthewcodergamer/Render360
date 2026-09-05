#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
HEADER = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.h"
BACKEND = ROOT / "src/xenia_web_bootstrap/probe_backend.cpp"
CONSOLE = ROOT / "developer-console.js"
FASTLANE = ROOT / ".github/workflows/xenia-browser-bootstrap-fastlane.yml"


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
# Contract: V60 may recover a missing HIR value only while executing the V59
# target-rooted tail fragment. It is never enabled for ordinary owner HIR.
# ---------------------------------------------------------------------------
h = HEADER.read_text()
h = replace_once(
    h,
    "uint32_t ConsumeHIRCorrectnessInteriorEntryMissing();\nbool IsHIRCorrectnessExecutionActive();",
    "uint32_t ConsumeHIRCorrectnessInteriorEntryMissing();\nvoid SetHIRCorrectnessContextProvenanceRecovery(bool enabled);\nbool IsHIRCorrectnessExecutionActive();",
    "V60 recovery API",
)
HEADER.write_text(h)


s = EXECUTOR.read_text()
s = replace_once(
    s,
    "thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;\nthread_local uint32_t g_execution_depth = 0;",
    "thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;\nthread_local uint32_t g_execution_depth = 0;\nthread_local bool g_context_provenance_recovery_enabled = false;",
    "V60 recovery state",
)

helper_anchor = '''bool ResolveCondition(const Value* value, const RuntimeValues& values,
                      bool* out) {'''
helper = '''// Recover a value only when HIR itself proves that the value originated from
// PPCContext. This is intentionally narrow: V59 exact tail fragments can begin
// at a valid PPC instruction whose finalized HIR retains a STORE_CONTEXT using
// a context-derived SSA value whose defining LOAD_CONTEXT is no longer visited
// by the compatibility walk. Reading that proven context source from the live
// PPCContext is equivalent to entering the fragment with the guest registers it
// actually had at the tail boundary. Do not synthesize arbitrary missing SSA.
bool ResolveContextProvenance(const Value* value,
                              const xe::cpu::ppc::PPCContext& context,
                              RuntimeValue* out, uint64_t* context_offset,
                              uint32_t depth = 0) {
  if (!value || !out || depth > 8 || value->IsConstant()) return false;
  auto* def = value->def;
  if (!def || !def->opcode) return false;

  if (def->opcode->num == xe::cpu::hir::OPCODE_LOAD_CONTEXT) {
    const size_t size = xe::cpu::hir::GetTypeSize(value->type);
    const uint64_t offset = def->src1.offset;
    if (offset > sizeof(context) || size > sizeof(context) - size_t(offset)) {
      return false;
    }
    RuntimeValue recovered;
    recovered.type = value->type;
    recovered.value = {};
    std::memcpy(&recovered.value,
                reinterpret_cast<const uint8_t*>(&context) + offset, size);
    *out = recovered;
    if (context_offset) *context_offset = offset;
    return true;
  }

  // Context promotion can rewrite a repeated LOAD_CONTEXT as ASSIGN. Follow
  // only that identity chain; conversions/arithmetic are not safe to invent.
  if (def->opcode->num == xe::cpu::hir::OPCODE_ASSIGN && def->src1.value) {
    RuntimeValue recovered;
    uint64_t recovered_offset = 0;
    if (!ResolveContextProvenance(def->src1.value, context, &recovered,
                                  &recovered_offset, depth + 1) ||
        recovered.type != value->type) {
      return false;
    }
    *out = recovered;
    if (context_offset) *context_offset = recovered_offset;
    return true;
  }
  return false;
}

bool ResolveCondition(const Value* value, const RuntimeValues& values,
                      bool* out) {'''
s = replace_once(s, helper_anchor, helper, "context provenance helper")

old_store = '''          supported = StoreResolvedValue(
              source, values, reinterpret_cast<uint8_t*>(&context) + offset,
              size);
          break;'''
new_store = '''          supported = StoreResolvedValue(
              source, values, reinterpret_cast<uint8_t*>(&context) + offset,
              size);
          if (!supported && g_context_provenance_recovery_enabled) {
            RuntimeValue recovered;
            uint64_t recovered_offset = 0;
            if (ResolveContextProvenance(source, context, &recovered,
                                         &recovered_offset)) {
              values[source] = recovered;
              supported = StoreResolvedValue(
                  source, values,
                  reinterpret_cast<uint8_t*>(&context) + offset, size);
              if (supported) {
                const uint32_t def_opcode =
                    source->def && source->def->opcode
                        ? source->def->opcode->num
                        : 0u;
                std::fprintf(
                    stderr,
                    "R360_CONTEXT_VALUE_RECOVERY ppc=0x%08X store=0x%llX "
                    "load=0x%llX def=%u type=%u\\n",
                    current_source_address,
                    static_cast<unsigned long long>(offset),
                    static_cast<unsigned long long>(recovered_offset),
                    def_opcode, static_cast<unsigned>(source->type));
              }
            }
          }
          break;'''
s = replace_once(s, old_store, new_store, "STORE_CONTEXT provenance recovery")

s = replace_once(
    s,
    "bool IsHIRCorrectnessExecutionActive() { return g_execution_depth != 0; }",
    "void SetHIRCorrectnessContextProvenanceRecovery(bool enabled) {\n  g_context_provenance_recovery_enabled = enabled;\n}\n\nbool IsHIRCorrectnessExecutionActive() { return g_execution_depth != 0; }",
    "V60 recovery setter",
)
EXECUTOR.write_text(s)


# ---------------------------------------------------------------------------
# Scope recovery to V59's exact target-rooted fragment. The existing owner HIR,
# V58 epilog bridge and all normal linked/indirect calls remain unchanged.
# ---------------------------------------------------------------------------
b = BACKEND.read_text()
if "R360_TAIL_FRAGMENT_FALLBACK" not in b or "ExecuteSharedEpilogReturn" not in b:
    raise SystemExit("V60 requires the working V58/V59 control-flow path")
b = replace_once(
    b,
    '''  SetHIRCorrectnessExecutionEntry(0u);
  const bool fragment_translated = frontend->DefineFunction(&fragment, 0);
  SetHIRCorrectnessExecutionEntry(0u);''',
    '''  SetHIRCorrectnessExecutionEntry(0u);
  SetHIRCorrectnessContextProvenanceRecovery(true);
  const bool fragment_translated = frontend->DefineFunction(&fragment, 0);
  SetHIRCorrectnessContextProvenanceRecovery(false);
  SetHIRCorrectnessExecutionEntry(0u);''',
    "scope recovery to exact tail fragment",
)
BACKEND.write_text(b)


# ---------------------------------------------------------------------------
# Diagnostics: unsupported HIR at a tail target is not a guest-memory fault.
# Keep the V59 unresolved-tail card and add the next-stage equivalent.
# ---------------------------------------------------------------------------
d = CONSOLE.read_text()
d = replace_once(
    d,
    "  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;",
    "  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;\n  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;",
    "unsupported-tail classification",
)
unsupported_card = '''  if(unsupportedTail){
    const stackHealthy=present(trace.lastNewR1)&&present(memory?.stackTop)&&trace.lastNewR1===memory.stackTop;
    const timeline=[...writes.map(event=>({kind:'r1',...event})),...calls.map(event=>({kind:'call',...event}))].sort((a,b)=>(number(a.sequence)||0)-(number(b.sequence)||0)).map(event=>event.kind==='call'
      ?`#${event.sequence} CALL d${event.depth} ${event.source} → ${event.target} r1=${event.r1} flags=0x${(number(event.flags)||0).toString(16).toUpperCase()}`
      :`#${event.sequence} r1 d${event.depth} ${event.address} ${event.oldR1} → ${event.newR1} (${hexDelta((number(event.newR1)||0)-(number(event.oldR1)||0))})`);
    return compact({
      classification:'CPU_RUNTIME_BLOCKER',
      headline:'CPU execution stopped on unsupported HIR in a tail fragment',
      tailTarget:cpu.executionBlockerAddress,
      tailSource:tailCall.source,
      reason:`HIR opcode ${cpu.executionBlockerOpcode??'—'} failed in the compatibility executor`,
      stackState:stackHealthy?`Healthy · restored to ${memory.stackTop}`:`r1=${trace.lastNewR1||trace.lastCallR1||'—'}`,
      primarySuspect:cpu.executionBlockerAddress,
      initialAbiCorrect,
      callEdge:`${tailCall.source} -> ${tailCall.target}`,
      historyReady:writes.length>0&&calls.length>0,
      timeline,
      evidence:[
        `Tail fragment reached ${tailCall.target} from ${tailCall.source}.`,
        `Compatibility HIR stopped on opcode ${cpu.executionBlockerOpcode??'—'} at ${cpu.executionBlockerAddress}; this is not a sparse-memory fault.`,
        `No sparse-memory fault was captured (faultCode ${memory?.faultCode??'—'}).`,
        stackHealthy?`Stack is balanced at the boundary: ${trace.lastNewR1} == stackTop ${memory.stackTop}.`:undefined,
      ].filter(Boolean),
      ruledOut:[
        initialAbiCorrect?'Initial stack reservation / stackTop mismatch':undefined,
        stackHealthy?'The completed r1 teardown as the current cause':undefined,
        'A guest-memory fault at the displayed PPC instruction',
        number(kernel?.calls)===0?'XAM/xboxkrnl HLE as the current cause (kernel calls = 0)':undefined,
        gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU stops first)':undefined,
      ].filter(Boolean),
      next:[
        `Resolve HIR opcode ${cpu.executionBlockerOpcode??'—'} using proven live-context provenance at ${cpu.executionBlockerAddress}.`,
        'Do not alter the balanced stack restore or map address 0 writable.',
      ],
      runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,
      cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),
    });
  }
'''
d = replace_once(
    d,
    "  const suspectWrite=[...writes].reverse().find(event=>event.address===trace.lastWriteAddress&&event.newR1===trace.lastNewR1)||writes.at(-1);",
    unsupported_card + "  const suspectWrite=[...writes].reverse().find(event=>event.address===trace.lastWriteAddress&&event.newR1===trace.lastNewR1)||writes.at(-1);",
    "unsupported-tail diagnostic card",
)
CONSOLE.write_text(d)


# ---------------------------------------------------------------------------
# Fastlane must refuse to publish a build that silently drops V60.
# ---------------------------------------------------------------------------
f = FASTLANE.read_text()
verify_step = '''      - name: Verify V60 exact-tail context provenance contract
        shell: bash
        run: |
          set -euo pipefail
          grep -q 'SetHIRCorrectnessContextProvenanceRecovery' src/xenia_web_bootstrap/hir_correctness_executor.h
          grep -q 'ResolveContextProvenance' src/xenia_web_bootstrap/hir_correctness_executor.cpp
          grep -q 'g_context_provenance_recovery_enabled' src/xenia_web_bootstrap/hir_correctness_executor.cpp
          grep -q 'R360_CONTEXT_VALUE_RECOVERY' src/xenia_web_bootstrap/hir_correctness_executor.cpp
          grep -q 'SetHIRCorrectnessContextProvenanceRecovery(true)' src/xenia_web_bootstrap/probe_backend.cpp
          grep -q 'CPU execution stopped on unsupported HIR in a tail fragment' developer-console.js

'''
f = replace_once(
    f,
    "      - name: Restore pinned Xenia source cache\n",
    verify_step + "      - name: Restore pinned Xenia source cache\n",
    "V60 fastlane gate",
)
FASTLANE.write_text(f)

print("R360_V60_TAIL_CONTEXT_PATCH=PASS")
