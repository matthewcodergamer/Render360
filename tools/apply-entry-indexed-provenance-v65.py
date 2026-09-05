#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 65

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

# Native correctness executor: retain the architectural GPR state that existed
# when the outermost compatibility execution returned or faulted. V64 exposed an
# indexed load at entry+4; V65 must report its actual rA/rB values rather than
# infer them from the fault address.
header = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.h"
replace_once(
    header,
    "uint64_t GetHIRCorrectnessInitialLR();\n",
    "uint64_t GetHIRCorrectnessInitialLR();\nuint64_t GetHIRCorrectnessLastGPR(uint32_t index);\n",
    "V65 HIR last-GPR declaration",
)

cpp = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
replace_once(
    cpp,
    "std::array<uint64_t, 32> g_initial_gprs{};\n",
    "std::array<uint64_t, 32> g_initial_gprs{};\nstd::array<uint64_t, 32> g_last_gprs{};\n",
    "V65 HIR last-GPR storage",
)
replace_once(
    cpp,
    "void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }\n",
    """void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_last_gprs.fill(0);
}
""",
    "V65 HIR snapshot reset",
)
replace_once(
    cpp,
    """  ++g_execution_depth;
  result = ExecuteBuilder(builder, memory, *g_active_context);
  --g_execution_depth;
""",
    """  ++g_execution_depth;
  result = ExecuteBuilder(builder, memory, *g_active_context);
  // Snapshot after the builder returns, including failure. The context still
  // contains the exact architectural state at the blocker, and outermost
  // execution owns that state for the complete title call chain.
  if (outermost && g_active_context) {
    for (size_t i = 0; i < g_last_gprs.size(); ++i) {
      g_last_gprs[i] = g_active_context->r[i];
    }
  }
  --g_execution_depth;
""",
    "V65 HIR blocker GPR snapshot",
)
replace_once(
    cpp,
    """bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver) {
""",
    """bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

uint64_t GetHIRCorrectnessLastGPR(uint32_t index) {
  return index < g_last_gprs.size() ? g_last_gprs[index] : 0;
}

void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver) {
""",
    "V65 HIR last-GPR getter",
)

probe = ROOT / "src/xenia_web_bootstrap/ppc_translation_probe.cpp"
replace_once(
    probe,
    """uint64_t r360_ppc_probe_initial_lr() {
  return render360::xenia_web::GetHIRCorrectnessInitialLR();
}

uint32_t r360_ppc_probe_write_guest_u32_be""",
    """uint64_t r360_ppc_probe_initial_lr() {
  return render360::xenia_web::GetHIRCorrectnessInitialLR();
}

uint64_t r360_ppc_probe_correctness_gpr(uint32_t index) {
  return render360::xenia_web::GetHIRCorrectnessLastGPR(index);
}

uint32_t r360_ppc_probe_write_guest_u32_be""",
    "V65 exported blocker GPR getter",
)

linker = ROOT / "link-xenia-ppc-bootstrap.sh"
replace_once(
    linker,
    """CRITICAL_EXPORTS=(
  r360_ppc_probe_set_initial_lr
""",
    """CRITICAL_EXPORTS=(
  r360_ppc_probe_set_initial_lr
  r360_ppc_probe_correctness_gpr
""",
    "V65 critical GPR export",
)

browser = ROOT / "render360-browser-title-runtime.mjs"
replace_once(
    browser,
    """  'r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status',
""",
    """  'r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_gpr',
""",
    "V65 synchronized bootstrap GPR gate",
)

dev = ROOT / "developer-console.js"
replace_once(
    dev,
    """  if(primary===58||primary===62){
""",
    """  if(primary===31){
    const rb=(word>>>11)&31,xo=(word>>>1)&0x3FF;
    const xMemoryNames={
      23:'lwzx',55:'lwzux',87:'lbzx',119:'lbzux',
      151:'stwx',183:'stwux',215:'stbx',247:'stbux',
      279:'lhzx',311:'lhzux',343:'lhax',375:'lhaux',
      407:'sthx',439:'sthux'
    };
    const mnemonic=xMemoryNames[xo];
    if(mnemonic)return {kind:'x-form-memory',text:`${mnemonic} r${rt},r${ra},r${rb}`,rt,ra,rb,mnemonic,indexed:true};
  }
  if(primary===58||primary===62){
""",
    "V65 indexed PPC decoder",
)
replace_once(
    dev,
    """  const read8=fn('r360_sparse_guest_memory_read_u8');
  const runtimeBeginFn=fn('r360_pe_guest_runtime_function_begin');
""",
    """  const read8=fn('r360_sparse_guest_memory_read_u8');
  const gprSnapshotFn=fn('r360_ppc_probe_correctness_gpr');
  const runtimeBeginFn=fn('r360_pe_guest_runtime_function_begin');
""",
    "V65 blocker GPR accessor",
)
replace_once(
    dev,
    """  let baseRegisterValue,effectiveAddress;
  if(decoded&&(decoded.kind==='d-form-memory'||decoded.kind==='ds-form-memory')&&faultAddress!==undefined&&faultCode){
    effectiveAddress=faultAddress>>>0;
    baseRegisterValue=decoded.ra===0?0:(effectiveAddress-(decoded.displacement|0))>>>0;
  }
""",
    """  let baseRegisterValue,indexRegisterValue,effectiveAddress;
  const readSnapshotGpr=index=>{
    if(!gprSnapshotFn||index===undefined)return undefined;
    try{
      const raw=gprSnapshotFn(index>>>0);
      return typeof raw==='bigint'?Number(BigInt.asUintN(32,raw))>>>0:Number(raw)>>>0;
    }catch{return undefined;}
  };
  if(decoded&&(decoded.kind==='d-form-memory'||decoded.kind==='ds-form-memory')&&faultAddress!==undefined&&faultCode){
    effectiveAddress=faultAddress>>>0;
    baseRegisterValue=readSnapshotGpr(decoded.ra);
    if(baseRegisterValue===undefined)baseRegisterValue=decoded.ra===0?0:(effectiveAddress-(decoded.displacement|0))>>>0;
  }
  if(decoded?.kind==='x-form-memory'&&faultAddress!==undefined&&faultCode){
    effectiveAddress=faultAddress>>>0;
    baseRegisterValue=readSnapshotGpr(decoded.ra);
    indexRegisterValue=readSnapshotGpr(decoded.rb);
  }
""",
    "V65 indexed fault operands",
)
replace_once(
    dev,
    """    rt:decoded?.rt,ra:decoded?.ra,displacement:decoded?.displacement,
    effectiveAddress:effectiveAddress===undefined?undefined:address(effectiveAddress),
    baseRegisterValue:baseRegisterValue===undefined?undefined:address(baseRegisterValue),
""",
    """    rt:decoded?.rt,ra:decoded?.ra,rb:decoded?.rb,displacement:decoded?.displacement,
    effectiveAddress:effectiveAddress===undefined?undefined:address(effectiveAddress),
    baseRegisterValue:baseRegisterValue===undefined?undefined:address(baseRegisterValue),
    indexRegisterValue:indexRegisterValue===undefined?undefined:address(indexRegisterValue),
""",
    "V65 indexed operand report fields",
)
replace_once(
    dev,
    """  const runtimeFunctions=compact({
    entry:runtimeOwner(result?.entry),
    lastWrite:runtimeOwner(stackTrace.lastWriteAddress),
""",
    """  const runtimeFunctions=compact({
    entry:runtimeOwner(result?.entry),
    xexEntry:runtimeOwner(result?.xexEntry),
    peEntry:runtimeOwner(result?.peEntry),
    lastWrite:runtimeOwner(stackTrace.lastWriteAddress),
""",
    "V65 entry provenance runtime owners",
)
replace_once(
    dev,
    """    codeWindows:compact({
      entry:readPpcWindow(read8,result?.entry,4),
      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
""",
    """    codeWindows:compact({
      entry:readPpcWindow(read8,result?.entry,4),
      xexEntry:readPpcWindow(read8,result?.xexEntry,4),
      peEntry:readPpcWindow(read8,result?.peEntry,4),
      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
""",
    "V65 entry provenance code windows",
)
replace_once(
    dev,
    """  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;
  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;
  const lowApertureFault=!!memory?.faultCode&&fault!==undefined&&fault<0x10000&&
""",
    """  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;
  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;
  const entryAddress=number(cpu?.entry),blockerAddress=number(cpu?.executionBlockerAddress);
  const indexedEntryZero=!!memory?.faultCode&&fault===0&&memory?.instructionKind==='x-form-memory'&&
    entryAddress!==undefined&&blockerAddress===((entryAddress+4)>>>0)&&
    number(memory?.baseRegisterValue)===0&&number(memory?.indexRegisterValue)===0;
  if(indexedEntryZero){
    const ra=number(memory?.ra),rb=number(memory?.rb);
    const selected=cpu?.entry,xex=cpu?.xexEntry,pe=cpu?.peEntry;
    const xexMatches=present(selected)&&present(xex)&&selected===xex;
    const peMatches=present(selected)&&present(pe)&&selected===pe;
    return compact({
      classification:'TITLE_ENTRY_INDEXED_ZERO_DEPENDENCY',
      headline:`XEX-selected entry immediately dereferenced r${ra??'A'}+r${rb??'B'}=0`,
      primarySuspect:cpu?.executionBlockerAddress,
      initialAbiCorrect,
      faultDerivedFromBaseRegister:true,
      entryProvenance:compact({selected,xex,pe,source:cpu?.entrySource,xexMatchesSelected:xexMatches,peMatchesSelected:peMatches}),
      evidence:[
        `Failing PPC: ${memory?.blockerDecoded||'indexed memory load'} at ${cpu?.executionBlockerAddress||'—'}, only +0x4 from selected entry ${cpu?.entry||'—'}.`,
        `Live blocker snapshot: r${ra??'A'}=${memory?.baseRegisterValue||'—'}, r${rb??'B'}=${memory?.indexRegisterValue||'—'} → effective address ${memory?.effectiveAddress||memory?.faultAddress||'—'}.`,
        `Entry provenance: selected=${selected||'—'} XEX=${xex||'—'} PE=${pe||'—'} source=${cpu?.entrySource||'—'}.`,
        'V64 strict zero-page behavior exposed this before the later call/epilogue chain; the V63 +0x100 stack failure is downstream evidence, not the first blocker.',
        initialAbiCorrect?`Entry r1 remains correct: ${trace.initialR1} == stackTop ${memory.stackTop}.`:undefined,
      ].filter(Boolean),
      ruledOut:[
        initialAbiCorrect?'Initial stack reservation / stackTop mismatch':undefined,
        'Synthesizing r11/r29 startup values without proof',
        'Making 0x00000000-0x0000FFFF writable or zero-filled',
        'The later +0x100 teardown as the first failure',
        number(kernel?.calls)===0?'XAM/xboxkrnl HLE as the current cause (kernel calls = 0)':undefined,
        gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU stops first)':undefined,
      ].filter(Boolean),
      next:[
        'Reconcile XEX optional-header entry, PE AddressOfEntryPoint, and the prepared executable bytes mapped at the selected entry.',
        'If XEX and PE entries differ, inspect why the selected XEX entry starts with an indexed load requiring pre-existing registers; if they match, audit prepared-image section placement/decompression at that address.',
        'Keep the strict zero guard and verified r1/LR ABI unchanged while proving image/entry parity.',
      ],
      runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,
      cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),
    });
  }
  const lowApertureFault=!!memory?.faultCode&&fault!==undefined&&fault<0x10000&&
""",
    "V65 entry indexed-zero classification",
)
replace_once(
    dev,
    """  const cpu=compact({
    entry:address(result.entry),hir:number(result.hir),runtimeBoundary:result.runtimeBoundary,
""",
    """  const cpu=compact({
    entry:address(result.entry),xexEntry:address(result.xexEntry),peEntry:address(result.peEntry),entrySource:result.entrySource,
    hir:number(result.hir),runtimeBoundary:result.runtimeBoundary,
""",
    "V65 CPU entry provenance",
)

# Release synchronization.
version = ROOT / "VERSION"
version.write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=64;", "const RENDER360_RELEASE=65;", "V65 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:64,", "const CONTENT_BRIDGE={release:65,", "V65 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 64", "Render360 65")
old = '<span>UI Release</span><span class="value">64</span>'
new = '<span>UI Release</span><span class="value">65</span>'
if new not in text:
    if old not in text:
        raise SystemExit("V65 UI Release anchor missing")
    text = text.replace(old, new, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='65';", text, count=1)
if count != 1:
    raise SystemExit("V65 service worker version anchor missing")
sw.write_text(text)

print("R360_V65_ENTRY_INDEXED_PROVENANCE_PATCH=PASS")
