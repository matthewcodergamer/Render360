#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CONSOLE = ROOT / "developer-console.js"
VERSION = ROOT / "VERSION"
RUNTIME = ROOT / "runtime/render360-runtime.js"
INDEX = ROOT / "index.html"
SW = ROOT / "render360-sw.js"
RELEASE = 63


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        print(f"{label}: already applied")
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count}")
    print(f"{label}: applied")
    return text.replace(old, new, 1)


d = CONSOLE.read_text()

calls_anchor = '''  const callHistory=(Array.isArray(resultStack.callHistory)?resultStack.callHistory:[]).map(event=>compact({
    sequence:number(event.sequence),source:address(event.source),target:address(event.target),r1:address(event.r1),depth:number(event.depth),flags:number(event.flags),
    sourceOwner:runtimeOwner(event.source),targetOwner:runtimeOwner(event.target),
  }));
'''
calls_new = calls_anchor + '''  const tailCallDiagnostics=callHistory
    .filter(event=>(((number(event.flags)||0)&2)!==0))
    .map(event=>compact({
      sequence:event.sequence,source:event.source,target:event.target,r1:event.r1,depth:event.depth,flags:event.flags,
      sourceOwner:event.sourceOwner,targetOwner:event.targetOwner,
      sourceWindow:readPpcWindow(read8,event.source,10),
      targetWindow:readPpcWindow(read8,event.target,5),
      sourceOwnerPrologue:runtimeOwnerWindow(event.sourceOwner),
      targetOwnerPrologue:runtimeOwnerWindow(event.targetOwner),
    }));
'''
d = replace_once(d, calls_anchor, calls_new, "V63 tail call PPC diagnostics")

memory_anchor = '''    runtimeFunctions:Object.keys(runtimeFunctions).length?runtimeFunctions:undefined,
    codeWindows:compact({'''
memory_new = '''    runtimeFunctions:Object.keys(runtimeFunctions).length?runtimeFunctions:undefined,
    tailCallDiagnostics:tailCallDiagnostics.length?tailCallDiagnostics:undefined,
    codeWindows:compact({'''
d = replace_once(d, memory_anchor, memory_new, "V63 structured tail diagnostics")

reason_anchor = '''  const immediateTailSameOwner=!!immediateCall&&(((number(immediateCall.flags)||0)&2)!==0)&&sameOwner(immediateCall.sourceOwner,immediateCall.targetOwner);
  const frameWrites=writes.filter(event=>{'''
reason_new = '''  const immediateTailSameOwner=!!immediateCall&&(((number(immediateCall.flags)||0)&2)!==0)&&sameOwner(immediateCall.sourceOwner,immediateCall.targetOwner);
  const frameEntryCrossPdataInterior=!!enteringCall&&(((number(enteringCall.flags)||0)&2)!==0)&&!!enteringCall.sourceOwner?.begin&&!!enteringCall.targetOwner?.begin&&!frameEntrySameOwner&&Number(enteringCall.targetOwner.offset||0)>0;
  const immediateCrossPdataInterior=!!immediateCall&&(((number(immediateCall.flags)||0)&2)!==0)&&!!immediateCall.sourceOwner?.begin&&!!immediateCall.targetOwner?.begin&&!immediateTailSameOwner&&Number(immediateCall.targetOwner.offset||0)>0;
  const frameWrites=writes.filter(event=>{'''
d = replace_once(d, reason_anchor, reason_new, "V63 cross-pdata tail reasoning")

class_old = '''  const classification=missingAllocation&&(frameEntrySameOwner||immediateTailSameOwner)
    ?'SAME_PDATA_TAIL_FRAME_SPLIT'
    :crossedGuard&&isR1Fault?(missingAllocation?'FRAME_ENTRY_MISSING_PROLOGUE':historyReady?'STACK_BALANCE_OR_EPILOGUE_MISMATCH':'STACK_FRAME_TEARDOWN_MISMATCH'):memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';'''
class_new = '''  const classification=missingAllocation&&(frameEntrySameOwner||immediateTailSameOwner)
    ?'SAME_PDATA_TAIL_FRAME_SPLIT'
    :missingAllocation&&(frameEntryCrossPdataInterior||immediateCrossPdataInterior)
      ?'CROSS_PDATA_INTERIOR_TAIL_STACK_MISMATCH'
      :crossedGuard&&isR1Fault?(missingAllocation?'FRAME_ENTRY_MISSING_PROLOGUE':historyReady?'STACK_BALANCE_OR_EPILOGUE_MISMATCH':'STACK_FRAME_TEARDOWN_MISMATCH'):memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';'''
d = replace_once(d, class_old, class_new, "V63 cross-pdata classification")

evidence_anchor = '''    frameEntrySameOwner?`Frame-entry tail ${enteringCall.source} → ${enteringCall.target} stays inside .pdata owner ${enteringCall.sourceOwner.begin}-${enteringCall.sourceOwner.end}; target offset +0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()}.`:undefined,
    immediateTailSameOwner?`Immediate tail ${immediateCall.source} → ${immediateCall.target} stays inside .pdata owner ${immediateCall.sourceOwner.begin}-${immediateCall.sourceOwner.end}; the synthetic fragment boundary can therefore change an internal branch into CALL_TAIL.`:undefined,
    enteringCall?.targetOwner?`Frame-entry target owner ${enteringCall.targetOwner.begin}-${enteringCall.targetOwner.end} prologue=${enteringCall.targetOwner.prologBytes??'—'} bytes offset=+0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()}.`:undefined,'''
evidence_new = '''    frameEntrySameOwner?`Frame-entry tail ${enteringCall.source} → ${enteringCall.target} stays inside .pdata owner ${enteringCall.sourceOwner.begin}-${enteringCall.sourceOwner.end}; target offset +0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()}.`:undefined,
    immediateTailSameOwner?`Immediate tail ${immediateCall.source} → ${immediateCall.target} stays inside .pdata owner ${immediateCall.sourceOwner.begin}-${immediateCall.sourceOwner.end}; the synthetic fragment boundary can therefore change an internal branch into CALL_TAIL.`:undefined,
    frameEntryCrossPdataInterior?`Frame-entry tail ${enteringCall.source} → ${enteringCall.target} crosses .pdata ${enteringCall.sourceOwner.begin}-${enteringCall.sourceOwner.end} → ${enteringCall.targetOwner.begin}-${enteringCall.targetOwner.end} and lands +0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()} inside the target record; the V59 same-owner split hypothesis is ruled out for this edge.`:undefined,
    immediateCrossPdataInterior?`Immediate tail ${immediateCall.source} → ${immediateCall.target} crosses .pdata ${immediateCall.sourceOwner.begin}-${immediateCall.sourceOwner.end} → ${immediateCall.targetOwner.begin}-${immediateCall.targetOwner.end} and lands +0x${Number(immediateCall.targetOwner.offset||0).toString(16).toUpperCase()} inside the target record.`:undefined,
    enteringCall?.targetOwner?`Frame-entry target owner ${enteringCall.targetOwner.begin}-${enteringCall.targetOwner.end} prologue=${enteringCall.targetOwner.prologBytes??'—'} bytes offset=+0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()}.`:undefined,'''
d = replace_once(d, evidence_anchor, evidence_new, "V63 cross-pdata evidence")

next_anchor = '''  const next=[
    missingAllocation&&enteringCall?`Inspect the translated function entered at ${enteringCall.target}; the runtime reached its +0x100 teardown without recording a -0x100 r1 allocation in that frame.`:trace.lastWriteAddress?`Inspect the frame teardown at ${trace.lastWriteAddress}; determine whether its positive r1 restore has a matching earlier allocation in the same guest frame.`:undefined,
    historyReady&&matchingAllocation?`A matching allocation exists, so inspect intervening r1 writes/branches for a duplicate restore or wrong shared epilogue.`:trace.lastCallSource?`Verify function/shared-epilogue classification around ${trace.lastCallSource} and the target ${trace.lastCallTarget||'—'}.`:undefined,
    `Do not patch ${memory?.faultAddress||'the fault address'} writable; preserve Xenia's stack guard and fix the control-flow/frame state that reached it.`,
  ].filter(Boolean);'''
next_new = '''  const next=[
    missingAllocation&&(frameEntryCrossPdataInterior||immediateCrossPdataInterior)?`Inspect memory.tailCallDiagnostics for the cross-.pdata tail chain. Compare each source window with the source-owner prologue and each target window with the target-owner prologue; specifically look for an update-form stack allocation (stdu/stwu r1,-0x100) that the live path bypassed.`:missingAllocation&&enteringCall?`Inspect the translated function entered at ${enteringCall.target}; the runtime reached its +0x100 teardown without recording a -0x100 r1 allocation in that frame.`:trace.lastWriteAddress?`Inspect the frame teardown at ${trace.lastWriteAddress}; determine whether its positive r1 restore has a matching earlier allocation in the same guest frame.`:undefined,
    historyReady&&matchingAllocation?`A matching allocation exists, so inspect intervening r1 writes/branches for a duplicate restore or wrong shared epilogue.`:trace.lastCallSource?`Verify function/shared-epilogue classification around ${trace.lastCallSource} and the target ${trace.lastCallTarget||'—'}.`:undefined,
    `Do not synthesize a -0x100 frame and do not patch ${memory?.faultAddress||'the fault address'} writable; preserve Xenia's stack guard until the exact skipped/incorrect control-flow edge is proven.`,
  ].filter(Boolean);'''
d = replace_once(d, next_anchor, next_new, "V63 next-step guidance")

headline_old = '''    headline:missingAllocation&&(frameEntrySameOwner||immediateTailSameOwner)?`same .pdata owner tail split reached a ${hexDelta(r1WriteDelta)} teardown without its frame allocation`:missingAllocation?`depth ${suspectDepth} reached a ${hexDelta(r1WriteDelta)} epilogue without its matching allocation`:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary','''
headline_new = '''    headline:missingAllocation&&(frameEntrySameOwner||immediateTailSameOwner)?`same .pdata owner tail split reached a ${hexDelta(r1WriteDelta)} teardown without its frame allocation`:missingAllocation&&(frameEntryCrossPdataInterior||immediateCrossPdataInterior)?`cross-.pdata interior tail chain reached a ${hexDelta(r1WriteDelta)} teardown without a live matching allocation`:missingAllocation?`depth ${suspectDepth} reached a ${hexDelta(r1WriteDelta)} epilogue without its matching allocation`:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary','''
d = replace_once(d, headline_old, headline_new, "V63 owner-aware headline")

struct_anchor = '''    historyReady,missingAllocation,ownerTopology:compact({frameEntrySameOwner,immediateTailSameOwner,frameEntrySource:enteringCall?.sourceOwner,frameEntryTarget:enteringCall?.targetOwner,immediateSource:immediateCall?.sourceOwner,immediateTarget:immediateCall?.targetOwner}),frameEntryCall:enteringCall,matchingAllocation:matchingAllocation?.event,'''
struct_new = '''    historyReady,missingAllocation,ownerTopology:compact({frameEntrySameOwner,immediateTailSameOwner,frameEntryCrossPdataInterior,immediateCrossPdataInterior,frameEntrySource:enteringCall?.sourceOwner,frameEntryTarget:enteringCall?.targetOwner,immediateSource:immediateCall?.sourceOwner,immediateTarget:immediateCall?.targetOwner}),tailPath:memory?.tailCallDiagnostics,frameEntryCall:enteringCall,matchingAllocation:matchingAllocation?.event,'''
d = replace_once(d, struct_anchor, struct_new, "V63 structured tail path")

CONSOLE.write_text(d)

VERSION.write_text(f"{RELEASE}\n")

runtime = RUNTIME.read_text()
runtime = replace_once(runtime, "const RENDER360_RELEASE=62;", "const RENDER360_RELEASE=63;", "V63 runtime release")
runtime = replace_once(runtime, "const CONTENT_BRIDGE={release:62,", "const CONTENT_BRIDGE={release:63,", "V63 content bridge release")
RUNTIME.write_text(runtime)

index = INDEX.read_text().replace("Render360 62", "Render360 63")
index = replace_once(index,
                     '<span>UI Release</span><span class="value">62</span>',
                     '<span>UI Release</span><span class="value">63</span>',
                     "V63 UI Release label")
INDEX.write_text(index)

sw = SW.read_text()
sw, count = re.subn(r"const VERSION='\d+';", "const VERSION='63';", sw, count=1)
if count != 1:
    raise SystemExit("V63 service-worker version anchor missing")
SW.write_text(sw)

print("R360_V63_TAIL_PATH_DIAGNOSTIC_PATCH=PASS")
