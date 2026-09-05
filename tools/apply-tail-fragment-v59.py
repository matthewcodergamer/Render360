#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "src/xenia_web_bootstrap/probe_backend.cpp"
HEADER = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.h"
TAIL_OVERLAY = ROOT / "prepare-hir-tail-frame-overlay.py"
CONSOLE = ROOT / "developer-console.js"


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
# HIR executor contract: expose only the exact interior-entry-missing signal.
# This lets ProbeBackend distinguish a missing SOURCE_OFFSET marker from a real
# nested memory/opcode/call failure before attempting the target-rooted fallback.
# ---------------------------------------------------------------------------
h = HEADER.read_text()
h = replace_once(
    h,
    "uint32_t GetHIRCorrectnessCurrentCallFlags();\nbool IsHIRCorrectnessExecutionActive();",
    "uint32_t GetHIRCorrectnessCurrentCallFlags();\nuint32_t ConsumeHIRCorrectnessInteriorEntryMissing();\nbool IsHIRCorrectnessExecutionActive();",
    "HIR interior-missing API",
)
HEADER.write_text(h)


o = TAIL_OVERLAY.read_text()
o = replace_once(
    o,
    "thread_local uint32_t g_current_call_flags=0;\nuint32_t CurrentLogicalGuestDepth();",
    "thread_local uint32_t g_current_call_flags=0;\nthread_local uint32_t g_last_interior_entry_missing=0;\nuint32_t CurrentLogicalGuestDepth();",
    "HIR interior-missing state",
)
o = replace_once(
    o,
    "if(!found){result.blocker_kind=kHIRBlockerUnresolvedCall;result.blocker_address=execution_entry;std::fprintf(stderr,\"R360_HIR_INTERIOR_ENTRY_MISSING address=0x%08X\\\\n\",execution_entry);return result;}",
    "if(!found){g_last_interior_entry_missing=execution_entry;result.blocker_kind=kHIRBlockerUnresolvedCall;result.blocker_address=execution_entry;std::fprintf(stderr,\"R360_HIR_INTERIOR_ENTRY_MISSING address=0x%08X\\\\n\",execution_entry);return result;}",
    "record exact missing HIR entry",
)
o = replace_once(
    o,
    "void SetHIRCorrectnessExecutionEntry(uint32_t guest_address){g_requested_execution_entry=guest_address;}\nuint32_t GetHIRCorrectnessCurrentCallFlags(){return g_current_call_flags;}",
    "void SetHIRCorrectnessExecutionEntry(uint32_t guest_address){g_requested_execution_entry=guest_address;if(guest_address)g_last_interior_entry_missing=0;}\nuint32_t GetHIRCorrectnessCurrentCallFlags(){return g_current_call_flags;}\nuint32_t ConsumeHIRCorrectnessInteriorEntryMissing(){const uint32_t address=g_last_interior_entry_missing;g_last_interior_entry_missing=0;return address;}",
    "consume exact missing HIR entry",
)
TAIL_OVERLAY.write_text(o)


# ---------------------------------------------------------------------------
# CPU resolver: preserve V58 shared-epilog handling and the normal owner/interior
# path. Only when that exact interior marker is missing do we rescan from the
# branch target itself, bounded by the already trusted owning .pdata end.
# ---------------------------------------------------------------------------
s = BACKEND.read_text()
if "ExecuteSharedEpilogReturn" not in s or "MatchSharedEpilogReturnSignature" not in s:
    raise SystemExit("V59 refuses to run without the working V58 shared-epilog bridge")

old_tail = '''  const uint32_t interior_entry =
      use_owner && address != fn_begin ? address : 0u;
  SetHIRCorrectnessExecutionEntry(interior_entry);
  const bool translated = frontend->DefineFunction(&nested_function, 0);
  SetHIRCorrectnessExecutionEntry(0u);
  std::fprintf(stderr,
               "R360_CALL_RESOLVE translated target=0x%08X function=0x%08X "
               "end=0x%08X flags=0x%X owner=%u interior=0x%08X result=%u\\n",
               address, fn_begin, nested_function.end_address(), call_flags,
               use_owner ? 1u : 0u, interior_entry, translated ? 1u : 0u);
  return translated;
}'''

new_tail = '''  const uint32_t interior_entry =
      use_owner && address != fn_begin ? address : 0u;
  if (interior_entry) {
    // Clear any stale marker before this one exact owner/interior attempt.
    (void)ConsumeHIRCorrectnessInteriorEntryMissing();
  }
  SetHIRCorrectnessExecutionEntry(interior_entry);
  const bool translated = frontend->DefineFunction(&nested_function, 0);
  SetHIRCorrectnessExecutionEntry(0u);
  const uint32_t missing_entry =
      interior_entry ? ConsumeHIRCorrectnessInteriorEntryMissing() : 0u;
  std::fprintf(stderr,
               "R360_CALL_RESOLVE translated target=0x%08X function=0x%08X "
               "end=0x%08X flags=0x%X owner=%u interior=0x%08X result=%u\\n",
               address, fn_begin, nested_function.end_address(), call_flags,
               use_owner ? 1u : 0u, interior_entry, translated ? 1u : 0u);

  // A compiler tail target may be a valid PPC instruction without surviving as
  // an exact SOURCE_OFFSET in finalized owner HIR. Do not guess a nearby marker:
  // replaying earlier HIR can duplicate side effects and starting later can skip
  // the target instruction. Re-translate only this exact PPC target as a
  // synthetic fragment, while keeping the owning .pdata end as the hard scan
  // boundary and the existing live PPCContext as execution state.
  const bool exact_interior_marker_missing =
      !translated && is_tail && use_owner && interior_entry &&
      missing_entry == interior_entry;
  if (!exact_interior_marker_missing) return translated;

  std::fprintf(stderr,
               "R360_TAIL_INTERIOR target=0x%08X owner=0x%08X end=0x%08X marker=0\\n",
               address, fn_begin, fn_end);

  ProbeGuestFunction fragment(module, address);
  fragment.set_end_address(scan_end);
  xe::cpu::ppc::PPCScanner fragment_scanner(frontend);
  const bool fragment_scanned = fragment_scanner.Scan(&fragment, nullptr);
  if (!fragment_scanned) {
    std::fprintf(stderr,
                 "R360_TAIL_FRAGMENT_FALLBACK target=0x%08X owner=0x%08X "
                 "end=0x%08X scan=0 define=0\\n",
                 address, fn_begin, fn_end);
    return false;
  }

  // address is now the fragment's real beginning, so requesting an interior HIR
  // entry would recreate the bug this fallback is intended to avoid.
  SetHIRCorrectnessExecutionEntry(0u);
  const bool fragment_translated = frontend->DefineFunction(&fragment, 0);
  SetHIRCorrectnessExecutionEntry(0u);
  std::fprintf(stderr,
               "R360_TAIL_FRAGMENT_FALLBACK target=0x%08X owner=0x%08X "
               "end=0x%08X scan=1 define=%u\\n",
               address, fn_begin, fn_end, fragment_translated ? 1u : 0u);
  if (fragment_translated) {
    auto* context = GetHIRCorrectnessActiveContext();
    std::fprintf(stderr,
                 "R360_TAIL_FRAGMENT_EXECUTED target=0x%08X r1=0x%08X\\n",
                 address,
                 context ? static_cast<uint32_t>(context->r[1]) : 0u);
  }
  return fragment_translated;
}'''

s = replace_once(s, old_tail, new_tail, "target-rooted tail fragment fallback")
BACKEND.write_text(s)


# ---------------------------------------------------------------------------
# Developer diagnostics: faultCode==0 is explicitly not a memory fault. For the
# exact unresolved tail signature, show target/source/reason/healthy stack instead
# of fault @ 0x00000000 and a stale frame-teardown headline.
# ---------------------------------------------------------------------------
d = CONSOLE.read_text()
d = replace_once(
    d,
    "faultCapturedAtExecution:capturedFaultCode!==undefined,",
    "faultCapturedAtExecution:capturedFaultCode!==undefined&&capturedFaultCode!==0,",
    "no-fault capture semantics",
)

anchor = "  const writes=trace.writeHistory||[],calls=trace.callHistory||[];\n"
early = '''  const writes=trace.writeHistory||[],calls=trace.callHistory||[];
  const tailCall=[...calls].reverse().find(event=>event.target===cpu?.executionBlockerAddress&&((number(event.flags)||0)&2)!==0);
  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;
  if(unresolvedTail){
    const stackHealthy=present(trace.lastNewR1)&&present(memory?.stackTop)&&trace.lastNewR1===memory.stackTop;
    const timeline=[...writes.map(event=>({kind:'r1',...event})),...calls.map(event=>({kind:'call',...event}))].sort((a,b)=>(number(a.sequence)||0)-(number(b.sequence)||0)).map(event=>event.kind==='call'
      ?`#${event.sequence} CALL d${event.depth} ${event.source} → ${event.target} r1=${event.r1} flags=0x${(number(event.flags)||0).toString(16).toUpperCase()}`
      :`#${event.sequence} r1 d${event.depth} ${event.address} ${event.oldR1} → ${event.newR1} (${hexDelta((number(event.newR1)||0)-(number(event.oldR1)||0))})`);
    return compact({
      classification:'CPU_RUNTIME_BLOCKER',
      headline:'CPU execution stopped at an unresolved tail target',
      tailTarget:cpu.executionBlockerAddress,
      tailSource:tailCall.source,
      reason:'HIR interior entry unavailable',
      stackState:stackHealthy?`Healthy · restored to ${memory.stackTop}`:`r1=${trace.lastNewR1||trace.lastCallR1||'—'}`,
      primarySuspect:cpu.executionBlockerAddress,
      initialAbiCorrect,
      callEdge:`${tailCall.source} -> ${tailCall.target}`,
      historyReady:writes.length>0&&calls.length>0,
      timeline,
      evidence:[
        `Tail branch reached ${tailCall.target} from ${tailCall.source} with flags=0x${(number(tailCall.flags)||0).toString(16).toUpperCase()}.`,
        `Runtime boundary is unresolved-guest-call with blocker opcode 0; the PPC instruction at ${cpu.executionBlockerAddress} has not been proven to execute.`,
        `No sparse-memory fault was captured (faultCode ${memory?.faultCode??'—'}).`,
        stackHealthy?`Stack is balanced at the boundary: ${trace.lastNewR1} == stackTop ${memory.stackTop}.`:undefined,
      ].filter(Boolean),
      ruledOut:[
        initialAbiCorrect?'Initial stack reservation / stackTop mismatch':undefined,
        stackHealthy?'The completed inner/outer r1 teardown as the current cause':undefined,
        'A guest-memory fault at the displayed target instruction',
        number(kernel?.calls)===0?'XAM/xboxkrnl HLE as the current cause (kernel calls = 0)':undefined,
        gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU stops first)':undefined,
      ].filter(Boolean),
      next:[
        `Retry ${tailCall.target} as an exact target-rooted PPC fragment bounded by its owning .pdata end.`,
        'Do not resume at the nearest earlier or later SOURCE_OFFSET; preserve exact PPC side effects.',
        'Do not modify the balanced stack restore and do not map address 0 writable.',
      ],
      runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,
      cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),
    });
  }
'''
d = replace_once(d, anchor, early, "unresolved-tail diagnostic classification")

old_grid = '''  grid.append(
    focusCell('First suspect',focus.primarySuspect||summary.memory?.stackTrace?.lastWriteAddress),
    focusCell('r1 change',focus.r1WriteDelta!==undefined?`${summary.memory?.stackTrace?.lastOldR1||'—'} → ${summary.memory?.stackTrace?.lastNewR1||'—'} (${hexDelta(focus.r1WriteDelta)})`:'—'),
    focusCell('Fault',`${summary.memory?.faultName||'—'} @ ${summary.memory?.faultAddress||'—'}`),
    focusCell('Failing PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),
    focusCell('Call edge',focus.callEdge||'—'),
    focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)
  );'''
new_grid = '''  if(focus.tailTarget){
    grid.append(
      focusCell('Tail target',focus.tailTarget),
      focusCell('Source',focus.tailSource||'—'),
      focusCell('Reason',focus.reason||'HIR interior entry unavailable'),
      focusCell('Stack',focus.stackState||'—'),
      focusCell('Target PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),
      focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)
    );
  }else{
    grid.append(
      focusCell('First suspect',focus.primarySuspect||summary.memory?.stackTrace?.lastWriteAddress),
      focusCell('r1 change',focus.r1WriteDelta!==undefined?`${summary.memory?.stackTrace?.lastOldR1||'—'} → ${summary.memory?.stackTrace?.lastNewR1||'—'} (${hexDelta(focus.r1WriteDelta)})`:'—'),
      focusCell('Fault',`${summary.memory?.faultName||'—'} @ ${summary.memory?.faultAddress||'—'}`),
      focusCell('Failing PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),
      focusCell('Call edge',focus.callEdge||'—'),
      focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)
    );
  }'''
d = replace_once(d, old_grid, new_grid, "unresolved-tail focus card")
d = replace_once(
    d,
    "  appendCodeWindow(root,'PPC around fault',summary.memory?.codeWindows?.blocker);",
    "  appendCodeWindow(root,focus.tailTarget?'PPC around unresolved tail target':'PPC around fault',summary.memory?.codeWindows?.blocker);",
    "tail-target code-window label",
)
CONSOLE.write_text(d)

print("R360_V59_TAIL_FRAGMENT_PATCH=PASS")
