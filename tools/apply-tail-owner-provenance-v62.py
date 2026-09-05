#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
LOADER_H = ROOT / "src/xenia_web_bootstrap/xex_pe_guest_loader.h"
LOADER_CPP = ROOT / "src/xenia_web_bootstrap/xex_pe_guest_loader.cpp"
CONSOLE = ROOT / "developer-console.js"
LINK = ROOT / "link-xenia-ppc-bootstrap.sh"
VERSION = ROOT / "VERSION"
RUNTIME = ROOT / "runtime/render360-runtime.js"
INDEX = ROOT / "index.html"
SW = ROOT / "render360-sw.js"
RELEASE = 62


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
# Expose the already-parsed PE .pdata owner table to browser diagnostics.
# Returning zero means the address is not covered by a runtime-function record.
# This does not change translation or execution semantics.
# ---------------------------------------------------------------------------
h = LOADER_H.read_text()
h = replace_once(
    h,
    "uint32_t r360_pe_guest_raw_bytes();\n}",
    "uint32_t r360_pe_guest_raw_bytes();\n"
    "uint32_t r360_pe_guest_runtime_function_begin(uint32_t address);\n"
    "uint32_t r360_pe_guest_runtime_function_end(uint32_t address);\n"
    "uint32_t r360_pe_guest_runtime_function_prolog_bytes(uint32_t address);\n}",
    "V62 runtime-function ABI declarations",
)
LOADER_H.write_text(h)

cpp = LOADER_CPP.read_text()
cpp = replace_once(
    cpp,
    '''uint32_t r360_pe_guest_raw_bytes() {
  return render360::xenia_web::PreparedPeGuestRawBytes();
}
}''',
    '''uint32_t r360_pe_guest_raw_bytes() {
  return render360::xenia_web::PreparedPeGuestRawBytes();
}
uint32_t r360_pe_guest_runtime_function_begin(uint32_t address) {
  uint32_t begin = 0;
  return render360::xenia_web::PreparedPeGuestFindRuntimeFunction(
             address, &begin, nullptr, nullptr)
             ? begin
             : 0u;
}
uint32_t r360_pe_guest_runtime_function_end(uint32_t address) {
  uint32_t end = 0;
  return render360::xenia_web::PreparedPeGuestFindRuntimeFunction(
             address, nullptr, &end, nullptr)
             ? end
             : 0u;
}
uint32_t r360_pe_guest_runtime_function_prolog_bytes(uint32_t address) {
  uint32_t prolog = 0;
  return render360::xenia_web::PreparedPeGuestFindRuntimeFunction(
             address, nullptr, nullptr, &prolog)
             ? prolog
             : 0u;
}
}''',
    "V62 runtime-function ABI implementations",
)
LOADER_CPP.write_text(cpp)


# ---------------------------------------------------------------------------
# Make the owner-query ABI critical. The linker already roots every r360_*
# symbol automatically; putting these in CRITICAL_EXPORTS additionally proves
# the final Wasm contains each public export exactly once before publication.
# ---------------------------------------------------------------------------
link = LINK.read_text()
link = replace_once(
    link,
    "  r360_xex_guest_mapper_input_max_capacity\n",
    "  r360_xex_guest_mapper_input_max_capacity\n"
    "  r360_pe_guest_runtime_function_begin\n"
    "  r360_pe_guest_runtime_function_end\n"
    "  r360_pe_guest_runtime_function_prolog_bytes\n",
    "V62 critical owner exports",
)
LINK.write_text(link)


# ---------------------------------------------------------------------------
# Developer report: annotate every recorded guest-call edge with .pdata owner
# begin/end/prologue length and include the owner prologue bytes as PPC windows.
# This will distinguish a real cross-function tail from V59's synthetic fragment
# changing an internal backward branch into CALL_TAIL because the synthetic
# function start moved forward.
# ---------------------------------------------------------------------------
d = CONSOLE.read_text()

window_anchor = '''function readPpcWindow(read8,center,radius=3){
  const c=number(center);if(!read8||c===undefined)return undefined;
  const rows=[];
  for(let i=-radius;i<=radius;i++){
    const at=(c+i*4)>>>0;
    const word=readInstructionWord(read8,at);
    if(word===undefined)continue;
    const decoded=decodePpcInstruction(word,at);
    rows.push(compact({
      address:address(at),
      word:`0x${word.toString(16).toUpperCase().padStart(8,'0')}`,
      decoded:decoded?.text,
      kind:decoded?.kind,
      current:i===0,
    }));
  }
  return rows.length?rows:undefined;
}
'''
window_new = window_anchor + '''function readPpcForward(read8,start,count=12){
  const s=number(start);if(!read8||s===undefined)return undefined;
  const rows=[];
  const n=Math.max(1,Math.min(32,Number(count)||12));
  for(let i=0;i<n;i++){
    const at=(s+i*4)>>>0;
    const word=readInstructionWord(read8,at);
    if(word===undefined)continue;
    const decoded=decodePpcInstruction(word,at);
    rows.push(compact({
      address:address(at),
      word:`0x${word.toString(16).toUpperCase().padStart(8,'0')}`,
      decoded:decoded?.text,
      kind:decoded?.kind,
      current:i===0,
    }));
  }
  return rows.length?rows:undefined;
}
'''
d = replace_once(d, window_anchor, window_new, "V62 forward PPC window")

fn_anchor = "  const read8=fn('r360_sparse_guest_memory_read_u8');\n"
fn_new = fn_anchor + '''  const runtimeBeginFn=fn('r360_pe_guest_runtime_function_begin');
  const runtimeEndFn=fn('r360_pe_guest_runtime_function_end');
  const runtimePrologFn=fn('r360_pe_guest_runtime_function_prolog_bytes');
  const runtimeOwner=value=>{
    const a=number(value);if(a===undefined||!runtimeBeginFn||!runtimeEndFn||!runtimePrologFn)return undefined;
    const begin=runtimeBeginFn(a>>>0)>>>0,end=runtimeEndFn(a>>>0)>>>0;
    if(!begin||!end||end<=begin)return undefined;
    return compact({begin:address(begin),end:address(end),prologBytes:runtimePrologFn(a>>>0)>>>0,offset:(a>>>0)-begin});
  };
  const runtimeOwnerWindow=owner=>{
    if(!owner?.begin)return undefined;
    const prolog=number(owner.prologBytes)||0;
    return readPpcForward(read8,owner.begin,Math.min(32,Math.max(8,Math.ceil(prolog/4)+4)));
  };
'''
d = replace_once(d, fn_anchor, fn_new, "V62 owner-query helpers")

calls_old = '''  const callHistory=(Array.isArray(resultStack.callHistory)?resultStack.callHistory:[]).map(event=>compact({
    sequence:number(event.sequence),source:address(event.source),target:address(event.target),r1:address(event.r1),depth:number(event.depth),flags:number(event.flags),
  }));'''
calls_new = '''  const callHistory=(Array.isArray(resultStack.callHistory)?resultStack.callHistory:[]).map(event=>compact({
    sequence:number(event.sequence),source:address(event.source),target:address(event.target),r1:address(event.r1),depth:number(event.depth),flags:number(event.flags),
    sourceOwner:runtimeOwner(event.source),targetOwner:runtimeOwner(event.target),
  }));'''
d = replace_once(d, calls_old, calls_new, "V62 call owner annotations")

context_anchor = "  const context=result?.mainThreadContext||{};\n"
context_new = context_anchor + '''  const runtimeFunctions=compact({
    entry:runtimeOwner(result?.entry),
    lastWrite:runtimeOwner(stackTrace.lastWriteAddress),
    lastCallSource:runtimeOwner(stackTrace.lastCallSource),
    lastCallTarget:runtimeOwner(stackTrace.lastCallTarget),
    blocker:runtimeOwner(blockerAddress),
  });
'''
d = replace_once(d, context_anchor, context_new, "V62 runtime owner summary")

return_anchor = '''    stackTrace:Object.keys(stackTrace).length?stackTrace:undefined,
    codeWindows:compact({
      entry:readPpcWindow(read8,result?.entry,4),
      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
      callSite:readPpcWindow(read8,stackTrace.lastCallSource,2),
      blocker:readPpcWindow(read8,blockerAddress,2),
    }),'''
return_new = '''    stackTrace:Object.keys(stackTrace).length?stackTrace:undefined,
    runtimeFunctions:Object.keys(runtimeFunctions).length?runtimeFunctions:undefined,
    codeWindows:compact({
      entry:readPpcWindow(read8,result?.entry,4),
      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
      callSite:readPpcWindow(read8,stackTrace.lastCallSource,2),
      blocker:readPpcWindow(read8,blockerAddress,2),
      entryOwnerPrologue:runtimeOwnerWindow(runtimeFunctions.entry),
      lastWriteOwnerPrologue:runtimeOwnerWindow(runtimeFunctions.lastWrite),
      lastCallSourceOwnerPrologue:runtimeOwnerWindow(runtimeFunctions.lastCallSource),
      lastCallTargetOwnerPrologue:runtimeOwnerWindow(runtimeFunctions.lastCallTarget),
    }),'''
d = replace_once(d, return_anchor, return_new, "V62 owner prologue windows")

enter_anchor = '''  const enteringCall=suspectDepth===undefined?undefined:[...calls].reverse().find(event=>number(event.depth)===suspectDepth-1&&(suspectSequence===undefined||number(event.sequence)<suspectSequence));
  const frameWrites=writes.filter(event=>{'''
enter_new = '''  const enteringCall=suspectDepth===undefined?undefined:[...calls].reverse().find(event=>number(event.depth)===suspectDepth-1&&(suspectSequence===undefined||number(event.sequence)<suspectSequence));
  const sameOwner=(a,b)=>!!(a?.begin&&b?.begin&&a.begin===b.begin&&a.end===b.end);
  const frameEntrySameOwner=!!enteringCall&&sameOwner(enteringCall.sourceOwner,enteringCall.targetOwner);
  const immediateCall=calls.length?calls[calls.length-1]:undefined;
  const immediateTailSameOwner=!!immediateCall&&(((number(immediateCall.flags)||0)&2)!==0)&&sameOwner(immediateCall.sourceOwner,immediateCall.targetOwner);
  const frameWrites=writes.filter(event=>{'''
d = replace_once(d, enter_anchor, enter_new, "V62 same-owner reasoning")

class_old = '''  const classification=crossedGuard&&isR1Fault?(missingAllocation?'FRAME_ENTRY_MISSING_PROLOGUE':historyReady?'STACK_BALANCE_OR_EPILOGUE_MISMATCH':'STACK_FRAME_TEARDOWN_MISMATCH'):memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';'''
class_new = '''  const classification=missingAllocation&&(frameEntrySameOwner||immediateTailSameOwner)
    ?'SAME_PDATA_TAIL_FRAME_SPLIT'
    :crossedGuard&&isR1Fault?(missingAllocation?'FRAME_ENTRY_MISSING_PROLOGUE':historyReady?'STACK_BALANCE_OR_EPILOGUE_MISMATCH':'STACK_FRAME_TEARDOWN_MISMATCH'):memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';'''
d = replace_once(d, class_old, class_new, "V62 same-owner classification")

# Add owner topology to evidence immediately before the existing call-edge fact.
evidence_anchor = '''    isR1Fault?`Fault equation: ${memory.baseRegisterValue} + (${memory.displacement}) = ${memory.effectiveAddress}.`:undefined,
    trace.lastCallSource&&trace.lastCallTarget?`Immediate call edge: ${trace.lastCallSource} → ${trace.lastCallTarget}, depth ${trace.lastCallDepth??'—'}, r1=${trace.lastCallR1||'—'}.`:undefined,'''
evidence_new = '''    isR1Fault?`Fault equation: ${memory.baseRegisterValue} + (${memory.displacement}) = ${memory.effectiveAddress}.`:undefined,
    frameEntrySameOwner?`Frame-entry tail ${enteringCall.source} → ${enteringCall.target} stays inside .pdata owner ${enteringCall.sourceOwner.begin}-${enteringCall.sourceOwner.end}; target offset +0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()}.`:undefined,
    immediateTailSameOwner?`Immediate tail ${immediateCall.source} → ${immediateCall.target} stays inside .pdata owner ${immediateCall.sourceOwner.begin}-${immediateCall.sourceOwner.end}; the synthetic fragment boundary can therefore change an internal branch into CALL_TAIL.`:undefined,
    enteringCall?.targetOwner?`Frame-entry target owner ${enteringCall.targetOwner.begin}-${enteringCall.targetOwner.end} prologue=${enteringCall.targetOwner.prologBytes??'—'} bytes offset=+0x${Number(enteringCall.targetOwner.offset||0).toString(16).toUpperCase()}.`:undefined,
    trace.lastCallSource&&trace.lastCallTarget?`Immediate call edge: ${trace.lastCallSource} → ${trace.lastCallTarget}, depth ${trace.lastCallDepth??'—'}, r1=${trace.lastCallR1||'—'}.`:undefined,'''
d = replace_once(d, evidence_anchor, evidence_new, "V62 owner evidence")

headline_old = '''    headline:missingAllocation?`depth ${suspectDepth} reached a ${hexDelta(r1WriteDelta)} epilogue without its matching allocation`:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary','''
headline_new = '''    headline:missingAllocation&&(frameEntrySameOwner||immediateTailSameOwner)?`same .pdata owner tail split reached a ${hexDelta(r1WriteDelta)} teardown without its frame allocation`:missingAllocation?`depth ${suspectDepth} reached a ${hexDelta(r1WriteDelta)} epilogue without its matching allocation`:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary','''
d = replace_once(d, headline_old, headline_new, "V62 owner-aware headline")

# Make the report explicitly carry the owner topology as structured data.
focus_anchor = '''    historyReady,
    missingAllocation,
    frameEntryCall:enteringCall,'''
focus_new = '''    historyReady,
    missingAllocation,
    ownerTopology:compact({frameEntrySameOwner,immediateTailSameOwner,frameEntrySource:enteringCall?.sourceOwner,frameEntryTarget:enteringCall?.targetOwner,immediateSource:immediateCall?.sourceOwner,immediateTarget:immediateCall?.targetOwner}),
    frameEntryCall:enteringCall,'''
d = replace_once(d, focus_anchor, focus_new, "V62 structured owner topology")

CONSOLE.write_text(d)


# ---------------------------------------------------------------------------
# Release contract: move every user-visible/runtime release surface together.
# ---------------------------------------------------------------------------
VERSION.write_text(f"{RELEASE}\n")

runtime = RUNTIME.read_text()
runtime = replace_once(runtime, "const RENDER360_RELEASE=61;", "const RENDER360_RELEASE=62;", "V62 runtime release")
runtime = replace_once(runtime, "const CONTENT_BRIDGE={release:61,", "const CONTENT_BRIDGE={release:62,", "V62 content bridge release")
RUNTIME.write_text(runtime)

index = INDEX.read_text().replace("Render360 61", "Render360 62")
index = replace_once(index,
                     '<span>UI Release</span><span class="value">61</span>',
                     '<span>UI Release</span><span class="value">62</span>',
                     "V62 UI Release label")
INDEX.write_text(index)

sw = SW.read_text()
sw, count = re.subn(r"const VERSION='\d+';", "const VERSION='62';", sw, count=1)
if count != 1:
    raise SystemExit("V62 service-worker version anchor missing")
SW.write_text(sw)

print("R360_V62_TAIL_OWNER_PROVENANCE_PATCH=PASS")
