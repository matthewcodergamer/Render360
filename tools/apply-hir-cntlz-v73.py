#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 73


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


# ---------------------------------------------------------------------------
# Lane A: correctness oracle — implement Xenia HIR CNTLZ exactly.
# ---------------------------------------------------------------------------
executor = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"

old_unary = """    case xe::cpu::hir::OPCODE_IS_FALSE:\n      if (!GetUnsigned(src, &u)) return false;\n      SetUnsigned(&result, destination->type, u == 0);\n      break;\n    default:\n      return false;\n"""
new_unary = """    case xe::cpu::hir::OPCODE_IS_FALSE:\n      if (!GetUnsigned(src, &u)) return false;\n      SetUnsigned(&result, destination->type, u == 0);\n      break;\n    case xe::cpu::hir::OPCODE_CNTLZ: {\n      // Xenia's HIR CNTLZ always returns the count in an INT8 value while\n      // preserving the source width (8/16/32/64) for the leading-zero count.\n      // The all-zero input therefore returns the exact source width.\n      if (destination->type != xe::cpu::hir::INT8_TYPE ||\n          !GetUnsigned(src, &u)) {\n        return false;\n      }\n      const uint32_t width = IntegerBitWidth(source->type);\n      if (!width || width > 64u) return false;\n      uint32_t leading = 0;\n      for (uint32_t bit = width; bit > 0; --bit) {\n        if ((u >> (bit - 1u)) & uint64_t{1}) break;\n        ++leading;\n      }\n      SetUnsigned(&result, destination->type, leading);\n      break;\n    }\n    default:\n      return false;\n"""
replace_once(executor, old_unary, new_unary, "V73 correctness HIR CNTLZ semantics")

old_dispatch = """        case xe::cpu::hir::OPCODE_NOT:\n        case xe::cpu::hir::OPCODE_BYTE_SWAP:\n        case xe::cpu::hir::OPCODE_IS_TRUE:\n"""
new_dispatch = """        case xe::cpu::hir::OPCODE_NOT:\n        case xe::cpu::hir::OPCODE_BYTE_SWAP:\n        case xe::cpu::hir::OPCODE_CNTLZ:\n        case xe::cpu::hir::OPCODE_IS_TRUE:\n"""
replace_once(executor, old_dispatch, new_dispatch, "V73 correctness CNTLZ dispatch")

old_executor_end = """}  // namespace render360::xenia_web\n"""
new_executor_end = """}  // namespace render360::xenia_web\n\n// V73 adaptive HIR metadata. These exports are generated from the exact Xenia\n// opcode table compiled into this runtime, so diagnostics don't carry a second\n// hand-maintained opcode-number map that can drift when Xenia changes.\nextern \"C\" {\nconst char* r360_hir_opcode_name(uint32_t opcode) {\n  switch (opcode) {\n#define DEFINE_OPCODE(num, name, sig, flags) \\\n    case xe::cpu::hir::num: return name;\n#include \"xenia/cpu/hir/opcodes.inl\"\n#undef DEFINE_OPCODE\n    default:\n      return \"unknown\";\n  }\n}\n\nuint32_t r360_hir_opcode_count() {\n  return static_cast<uint32_t>(xe::cpu::hir::__OPCODE_MAX_VALUE);\n}\n\nuint32_t r360_hir_correctness_supports_opcode(uint32_t opcode) {\n  switch (opcode) {\n    case xe::cpu::hir::OPCODE_SOURCE_OFFSET:\n    case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:\n    case xe::cpu::hir::OPCODE_MEMORY_BARRIER:\n    case xe::cpu::hir::OPCODE_CACHE_CONTROL:\n    case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:\n    case xe::cpu::hir::OPCODE_STORE_CONTEXT:\n    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:\n    case xe::cpu::hir::OPCODE_LOAD:\n    case xe::cpu::hir::OPCODE_LOAD_OFFSET:\n    case xe::cpu::hir::OPCODE_STORE:\n    case xe::cpu::hir::OPCODE_STORE_OFFSET:\n    case xe::cpu::hir::OPCODE_ASSIGN:\n    case xe::cpu::hir::OPCODE_CAST:\n    case xe::cpu::hir::OPCODE_ZERO_EXTEND:\n    case xe::cpu::hir::OPCODE_SIGN_EXTEND:\n    case xe::cpu::hir::OPCODE_TRUNCATE:\n    case xe::cpu::hir::OPCODE_CONVERT:\n    case xe::cpu::hir::OPCODE_ROUND:\n    case xe::cpu::hir::OPCODE_NEG:\n    case xe::cpu::hir::OPCODE_ABS:\n    case xe::cpu::hir::OPCODE_NOT:\n    case xe::cpu::hir::OPCODE_BYTE_SWAP:\n    case xe::cpu::hir::OPCODE_CNTLZ:\n    case xe::cpu::hir::OPCODE_IS_TRUE:\n    case xe::cpu::hir::OPCODE_IS_FALSE:\n    case xe::cpu::hir::OPCODE_IS_NAN:\n    case xe::cpu::hir::OPCODE_VECTOR_ADD:\n    case xe::cpu::hir::OPCODE_ADD:\n    case xe::cpu::hir::OPCODE_SUB:\n    case xe::cpu::hir::OPCODE_MUL:\n    case xe::cpu::hir::OPCODE_DIV:\n    case xe::cpu::hir::OPCODE_AND:\n    case xe::cpu::hir::OPCODE_AND_NOT:\n    case xe::cpu::hir::OPCODE_OR:\n    case xe::cpu::hir::OPCODE_XOR:\n    case xe::cpu::hir::OPCODE_SHL:\n    case xe::cpu::hir::OPCODE_SHR:\n    case xe::cpu::hir::OPCODE_SHA:\n    case xe::cpu::hir::OPCODE_ROTATE_LEFT:\n    case xe::cpu::hir::OPCODE_COMPARE_EQ:\n    case xe::cpu::hir::OPCODE_COMPARE_NE:\n    case xe::cpu::hir::OPCODE_COMPARE_SLT:\n    case xe::cpu::hir::OPCODE_COMPARE_SLE:\n    case xe::cpu::hir::OPCODE_COMPARE_SGT:\n    case xe::cpu::hir::OPCODE_COMPARE_SGE:\n    case xe::cpu::hir::OPCODE_COMPARE_ULT:\n    case xe::cpu::hir::OPCODE_COMPARE_ULE:\n    case xe::cpu::hir::OPCODE_COMPARE_UGT:\n    case xe::cpu::hir::OPCODE_COMPARE_UGE:\n    case xe::cpu::hir::OPCODE_BRANCH:\n    case xe::cpu::hir::OPCODE_BRANCH_TRUE:\n    case xe::cpu::hir::OPCODE_BRANCH_FALSE:\n    case xe::cpu::hir::OPCODE_CALL:\n    case xe::cpu::hir::OPCODE_CALL_TRUE:\n    case xe::cpu::hir::OPCODE_CALL_INDIRECT:\n    case xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE:\n    case xe::cpu::hir::OPCODE_RETURN:\n    case xe::cpu::hir::OPCODE_RETURN_TRUE:\n      return 1;\n    default:\n      return 0;\n  }\n}\n\nuint32_t r360_hir_correctness_supported_opcode_count() {\n  uint32_t count = 0;\n  for (uint32_t opcode = 0; opcode < r360_hir_opcode_count(); ++opcode) {\n    count += r360_hir_correctness_supports_opcode(opcode) ? 1u : 0u;\n  }\n  return count;\n}\n}\n"""
replace_once(executor, old_executor_end, new_executor_end, "V73 adaptive HIR metadata exports")


# ---------------------------------------------------------------------------
# Lane B: generated-Wasm backend — lower CNTLZ to native Wasm clz.
# ---------------------------------------------------------------------------
wasm_backend = ROOT / "src/xenia_web_bootstrap/wasm_backend_probe.cpp"

old_wasm_anchor = """    case xe::cpu::hir::OPCODE_COMPARE_UGE:\n      supported = EmitCompare(instr, producers, visiting, body, lowered);\n      break;\n\n    case xe::cpu::hir::OPCODE_ADD:\n"""
new_wasm_anchor = """    case xe::cpu::hir::OPCODE_COMPARE_UGE:\n      supported = EmitCompare(instr, producers, visiting, body, lowered);\n      break;\n\n    case xe::cpu::hir::OPCODE_CNTLZ: {\n      // WebAssembly has native i32.clz / i64.clz. Xenia's CNTLZ result is INT8,\n      // so narrow 8/16-bit sources subtract the host i32 width bias while a\n      // 64-bit count is wrapped back to the backend's i32 representation.\n      const Value* source = instr->src1.value;\n      if (!source || !IsIntegerType(source->type) ||\n          value->type != xe::cpu::hir::INT8_TYPE ||\n          !EmitIntegerValue(source, producers, visiting, body, lowered)) {\n        break;\n      }\n      if (source->type == xe::cpu::hir::INT64_TYPE) {\n        body.push_back(0x79);  // i64.clz\n        body.push_back(0xA7);  // i32.wrap_i64\n      } else {\n        body.push_back(0x67);  // i32.clz\n        const uint32_t bias = 32u - TypeBits(source->type);\n        if (bias) {\n          EmitI32Const(body, static_cast<int32_t>(bias));\n          body.push_back(0x6B);  // i32.sub\n        }\n      }\n      EmitMaskForType(body, value->type);\n      supported = true;\n      break;\n    }\n\n    case xe::cpu::hir::OPCODE_ADD:\n"""
replace_once(wasm_backend, old_wasm_anchor, new_wasm_anchor, "V73 generated-Wasm CNTLZ lowering")

old_wasm_exports = """uint32_t r360_wasm_backend_context_ptr() {\n  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(\n      render360::xenia_web::GetWasmBackendProbeContextData()));\n}\n}\n"""
new_wasm_exports = """uint32_t r360_wasm_backend_context_ptr() {\n  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(\n      render360::xenia_web::GetWasmBackendProbeContextData()));\n}\n\nuint32_t r360_wasm_backend_supports_hir_opcode(uint32_t opcode) {\n  switch (opcode) {\n    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:\n    case xe::cpu::hir::OPCODE_ASSIGN:\n    case xe::cpu::hir::OPCODE_TRUNCATE:\n    case xe::cpu::hir::OPCODE_ZERO_EXTEND:\n    case xe::cpu::hir::OPCODE_SIGN_EXTEND:\n    case xe::cpu::hir::OPCODE_IS_TRUE:\n    case xe::cpu::hir::OPCODE_IS_FALSE:\n    case xe::cpu::hir::OPCODE_COMPARE_EQ:\n    case xe::cpu::hir::OPCODE_COMPARE_NE:\n    case xe::cpu::hir::OPCODE_COMPARE_SLT:\n    case xe::cpu::hir::OPCODE_COMPARE_SLE:\n    case xe::cpu::hir::OPCODE_COMPARE_SGT:\n    case xe::cpu::hir::OPCODE_COMPARE_SGE:\n    case xe::cpu::hir::OPCODE_COMPARE_ULT:\n    case xe::cpu::hir::OPCODE_COMPARE_ULE:\n    case xe::cpu::hir::OPCODE_COMPARE_UGT:\n    case xe::cpu::hir::OPCODE_COMPARE_UGE:\n    case xe::cpu::hir::OPCODE_ADD:\n    case xe::cpu::hir::OPCODE_SUB:\n    case xe::cpu::hir::OPCODE_AND:\n    case xe::cpu::hir::OPCODE_OR:\n    case xe::cpu::hir::OPCODE_XOR:\n    case xe::cpu::hir::OPCODE_SHL:\n    case xe::cpu::hir::OPCODE_SHR:\n    case xe::cpu::hir::OPCODE_SHA:\n    case xe::cpu::hir::OPCODE_ROTATE_LEFT:\n    case xe::cpu::hir::OPCODE_CNTLZ:\n    case xe::cpu::hir::OPCODE_NOT:\n    case xe::cpu::hir::OPCODE_NEG:\n      return 1;\n    default:\n      return 0;\n  }\n}\n\nuint32_t r360_wasm_backend_supported_opcode_count() {\n  uint32_t count = 0;\n  const uint32_t total = static_cast<uint32_t>(xe::cpu::hir::__OPCODE_MAX_VALUE);\n  for (uint32_t opcode = 0; opcode < total; ++opcode) {\n    count += r360_wasm_backend_supports_hir_opcode(opcode) ? 1u : 0u;\n  }\n  return count;\n}\n}\n"""
replace_once(wasm_backend, old_wasm_exports, new_wasm_exports, "V73 generated-Wasm HIR support metadata")


# ---------------------------------------------------------------------------
# Adaptive developer diagnostics — resolve HIR names from the compiled runtime,
# decode the actual cntlzw/cntlzd PPC instruction, and surface both lanes.
# ---------------------------------------------------------------------------
dev = ROOT / "developer-console.js"
replace_once(
    dev,
    "// V54: Braid frame-history console — prove prologue vs duplicate teardown.",
    "// V73: adaptive Xenia HIR diagnostics + dual-lane correctness/Wasm coverage.",
    "V73 developer-console release note",
)

old_hex_helper = """function hexDelta(value){\n  const n=number(value);if(n===undefined)return '—';\n  const sign=n<0?'-':'+';\n  return `${sign}0x${Math.abs(n).toString(16).toUpperCase()}`;\n}\nfunction compactBlocker(detail){\n"""
new_hex_helper = """function hexDelta(value){\n  const n=number(value);if(n===undefined)return '—';\n  const sign=n<0?'-':'+';\n  return `${sign}0x${Math.abs(n).toString(16).toUpperCase()}`;\n}\nfunction readWasmCString(memory,ptr,max=128){\n  const start=number(ptr);if(!(memory instanceof WebAssembly.Memory)||!start)return undefined;\n  const bytes=new Uint8Array(memory.buffer);let end=start>>>0;const limit=Math.min(bytes.length,end+Math.max(1,max|0));\n  while(end<limit&&bytes[end])end++;\n  if(end===(start>>>0))return '';\n  try{return new TextDecoder().decode(bytes.subarray(start>>>0,end));}catch{return undefined;}\n}\nfunction compactBlocker(detail){\n"""
replace_once(dev, old_hex_helper, new_hex_helper, "V73 Wasm C-string helper")

old_xform = """  if(primary===31){\n    const rb=(word>>>11)&31,xo=(word>>>1)&0x3FF;\n    const xMemoryNames={\n"""
new_xform = """  if(primary===31){\n    const rb=(word>>>11)&31,xo=(word>>>1)&0x3FF;\n    if(xo===26)return {kind:'cntlz',text:`cntlzw r${ra},r${rt}`,rs:rt,ra,xo,mnemonic:'cntlzw'};\n    if(xo===58)return {kind:'cntlz',text:`cntlzd r${ra},r${rt}`,rs:rt,ra,xo,mnemonic:'cntlzd'};\n    const xMemoryNames={\n"""
replace_once(dev, old_xform, new_xform, "V73 PPC cntlzw/cntlzd decoder")

replace_once(
    dev,
    "    rt:decoded?.rt,ra:decoded?.ra,rb:decoded?.rb,displacement:decoded?.displacement,",
    "    rt:decoded?.rt,rs:decoded?.rs,ra:decoded?.ra,rb:decoded?.rb,displacement:decoded?.displacement,",
    "V73 PPC source-register report",
)

old_ppc_summary = """function ppcDiagnosticSummary(memory){\n"""
new_ppc_summary = """function hirDiagnostics(state,result){\n  const exp=state?.bootstrap?.exports||{};\n  const fn=name=>{const value=exp[name]??exp[`_${name}`];return typeof value==='function'?value:null;};\n  const opcode=number(result?.executionBlockerOpcode);\n  const countFn=fn('r360_hir_opcode_count'),nameFn=fn('r360_hir_opcode_name');\n  const executorFn=fn('r360_hir_correctness_supports_opcode'),wasmFn=fn('r360_wasm_backend_supports_hir_opcode');\n  const executorCountFn=fn('r360_hir_correctness_supported_opcode_count'),wasmCountFn=fn('r360_wasm_backend_supported_opcode_count');\n  const totalOpcodes=countFn?(countFn()>>>0):undefined;\n  const rawName=opcode!==undefined&&nameFn?readWasmCString(exp.memory,nameFn(opcode>>>0)):undefined;\n  const opcodeName=rawName&&rawName!=='unknown'?rawName.toUpperCase():rawName;\n  const executorSupportsCurrent=opcode!==undefined&&executorFn?!!(executorFn(opcode>>>0)>>>0):undefined;\n  const wasmSupportsCurrent=opcode!==undefined&&wasmFn?!!(wasmFn(opcode>>>0)>>>0):undefined;\n  const executorSupported=executorCountFn?(executorCountFn()>>>0):undefined;\n  const wasmSupported=wasmCountFn?(wasmCountFn()>>>0):undefined;\n  const percent=(part,total)=>part!==undefined&&total?Number((part*100/total).toFixed(1)):undefined;\n  let recommendedLane;\n  if(opcode!==undefined){\n    if(executorSupportsCurrent===false&&wasmSupportsCurrent===false)recommendedLane='correctness-oracle + generated-Wasm';\n    else if(executorSupportsCurrent===false)recommendedLane='correctness-oracle';\n    else if(wasmSupportsCurrent===false)recommendedLane='generated-Wasm';\n    else recommendedLane='runtime integration / callable function path';\n  }\n  return compact({\n    opcode,opcodeName,xeniaReferenceAvailable:!!(rawName&&rawName!=='unknown'),\n    executorSupportsCurrent,wasmSupportsCurrent,recommendedLane,totalOpcodes,executorSupported,wasmSupported,\n    executorCoveragePercent:percent(executorSupported,totalOpcodes),wasmCoveragePercent:percent(wasmSupported,totalOpcodes),\n  });\n}\n\nfunction ppcDiagnosticSummary(memory){\n"""
replace_once(dev, old_ppc_summary, new_ppc_summary, "V73 adaptive HIR diagnostics")

replace_once(
    dev,
    "function problemFocus(memory,cpu,kernel,gpu,runtimeAsset){",
    "function problemFocus(memory,cpu,kernel,gpu,runtimeAsset,hir){",
    "V73 problem focus HIR input",
)

replace_once(
    dev,
    "      headline:'CPU execution stopped on unsupported HIR in a tail fragment',",
    "      headline:`CPU execution stopped on unsupported HIR${hir?.opcodeName?`: ${hir.opcodeName}`:''} in a tail fragment`,",
    "V73 adaptive unsupported-HIR headline",
)
replace_once(
    dev,
    "      reason:`HIR opcode ${cpu.executionBlockerOpcode??'—'} failed in the compatibility executor`,",
    "      reason:`${hir?.opcodeName?`${hir.opcodeName} (opcode ${cpu.executionBlockerOpcode??'—'})`:`HIR opcode ${cpu.executionBlockerOpcode??'—'}`} failed in the compatibility executor`,",
    "V73 adaptive unsupported-HIR reason",
)
replace_once(
    dev,
    "        `Compatibility HIR stopped on opcode ${cpu.executionBlockerOpcode??'—'} at ${cpu.executionBlockerAddress}; this is not a sparse-memory fault.`,",
    "        `Compatibility HIR stopped on ${hir?.opcodeName?`${hir.opcodeName} (opcode ${cpu.executionBlockerOpcode??'—'})`:`opcode ${cpu.executionBlockerOpcode??'—'}`} at ${cpu.executionBlockerAddress}; this is not a sparse-memory fault.`,\n        hir?.recommendedLane?`Adaptive HIR lane: ${hir.recommendedLane}. Executor support=${hir.executorSupportsCurrent??'unknown'}; generated-Wasm support=${hir.wasmSupportsCurrent??'unknown'}.`:undefined,",
    "V73 adaptive unsupported-HIR evidence",
)
replace_once(
    dev,
    "        `Resolve HIR opcode ${cpu.executionBlockerOpcode??'—'} using proven live-context provenance at ${cpu.executionBlockerAddress}.`,\n        'Do not alter the balanced stack restore or map address 0 writable.',",
    "        `Resolve ${hir?.opcodeName?`${hir.opcodeName} (HIR ${cpu.executionBlockerOpcode??'—'})`:`HIR opcode ${cpu.executionBlockerOpcode??'—'}`} using Xenia semantics and proven live-context provenance at ${cpu.executionBlockerAddress}.`,\n        hir?.recommendedLane?`Implement the ${hir.recommendedLane} lane indicated by the runtime support matrix instead of waiting for another one-off blocker.`:undefined,\n        'Do not alter the balanced stack restore or map address 0 writable.',",
    "V73 adaptive unsupported-HIR next action",
)

old_tail_grid = """      focusCell('Reason',focus.reason||'HIR interior entry unavailable'),\n      focusCell('Stack',focus.stackState||'—'),\n      focusCell('Target PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),\n      focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)\n"""
new_tail_grid = """      focusCell('Reason',focus.reason||'HIR interior entry unavailable'),\n      focusCell('Stack',focus.stackState||'—'),\n      focusCell('HIR opcode',summary.hir?.opcodeName?`${summary.hir.opcodeName} (${summary.hir.opcode??'—'})`:`${summary.hir?.opcode??'—'}`),\n      focusCell('HIR support',`${summary.hir?.executorSupportsCurrent===true?'executor ✓':summary.hir?.executorSupportsCurrent===false?'executor ✗':'executor —'} · ${summary.hir?.wasmSupportsCurrent===true?'Wasm ✓':summary.hir?.wasmSupportsCurrent===false?'Wasm ✗':'Wasm —'}`),\n      focusCell('Target PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),\n      focusCell('Coverage',summary.hir?.totalOpcodes?`oracle ${summary.hir.executorSupported??'—'}/${summary.hir.totalOpcodes} · Wasm ${summary.hir.wasmSupported??'—'}/${summary.hir.totalOpcodes}`:'—'),\n      focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)\n"""
replace_once(dev, old_tail_grid, new_tail_grid, "V73 HIR focus-card cells")

old_focus_after = """  card.appendChild(grid);root.appendChild(card);\n  appendTextList(root,'Evidence',focus.evidence);\n"""
new_focus_after = """  card.appendChild(grid);root.appendChild(card);\n  if(summary.hir?.totalOpcodes){\n    appendTextList(root,'HIR coverage',[\n      `Current: ${summary.hir.opcodeName||'unknown'} · opcode ${summary.hir.opcode??'—'} · adaptive lane ${summary.hir.recommendedLane||'—'}.`,\n      `Compatibility oracle: ${summary.hir.executorSupported??'—'}/${summary.hir.totalOpcodes} opcodes (${summary.hir.executorCoveragePercent??'—'}%).`,\n      `Generated-Wasm scalar backend: ${summary.hir.wasmSupported??'—'}/${summary.hir.totalOpcodes} opcodes (${summary.hir.wasmCoveragePercent??'—'}%).`,\n      `Callable title functions: ${summary.cpu?.translatedFunctions??0} translated · first ${summary.cpu?.firstTranslatedFunction||'—'}.`,\n    ]);\n  }\n  appendTextList(root,'Evidence',focus.evidence);\n"""
replace_once(dev, old_focus_after, new_focus_after, "V73 HIR coverage dashboard")

old_report_memory = """  const memory=memoryDiagnostics(state,result);\n  const cpu=compact({\n"""
new_report_memory = """  const memory=memoryDiagnostics(state,result);\n  const hir=hirDiagnostics(state,result);\n  const cpu=compact({\n"""
replace_once(dev, old_report_memory, new_report_memory, "V73 report HIR diagnostics")

old_cpu_fields = """    executionBlockerKind:result.executionBlockerKind,executionBlockerOpcode:number(result.executionBlockerOpcode),\n    executionBlockerAddress:address(result.executionBlockerAddress),translatedFunctions:number(result.translatedFunctionCount),\n"""
new_cpu_fields = """    executionBlockerKind:result.executionBlockerKind,executionBlockerOpcode:number(result.executionBlockerOpcode),\n    executionBlockerAddress:address(result.executionBlockerAddress),hirOpcodeName:hir?.opcodeName,\n    hirExecutorSupport:hir?.executorSupportsCurrent,hirWasmSupport:hir?.wasmSupportsCurrent,\n    translatedFunctions:number(result.translatedFunctionCount),\n"""
replace_once(dev, old_cpu_fields, new_cpu_fields, "V73 CPU HIR metadata")

replace_once(
    dev,
    "  const focus=problemFocus(memory,cpu,kernel,gpu,runtimeAsset);",
    "  const focus=problemFocus(memory,cpu,kernel,gpu,runtimeAsset,hir);",
    "V73 problem-focus HIR wiring",
)
replace_once(
    dev,
    "    schema:'render360-blocker-report-v1',",
    "    schema:'render360-blocker-report-v2',",
    "V73 blocker report schema",
)
replace_once(
    dev,
    "    memory:Object.keys(memory).length?memory:null,\n    cpu,kernel,gpu,",
    "    memory:Object.keys(memory).length?memory:null,\n    hir:Object.keys(hir).length?hir:null,\n    cpu,kernel,gpu,",
    "V73 top-level HIR report",
)


# ---------------------------------------------------------------------------
# Publication/ABI gates: make adaptive metadata part of the deployed contract.
# ---------------------------------------------------------------------------
link = ROOT / "link-xenia-ppc-bootstrap.sh"
replace_once(
    link,
    """CRITICAL_EXPORTS=(\n  r360_ppc_probe_set_initial_lr\n""",
    """CRITICAL_EXPORTS=(\n  r360_hir_opcode_count\n  r360_hir_opcode_name\n  r360_hir_correctness_supports_opcode\n  r360_hir_correctness_supported_opcode_count\n  r360_wasm_backend_supports_hir_opcode\n  r360_wasm_backend_supported_opcode_count\n  r360_ppc_probe_set_initial_lr\n""",
    "V73 critical HIR ABI exports",
)

critic = ROOT / "test-deployed-browser-bootstrap-critic.mjs"
replace_once(
    critic,
    """const required=[\n  'memory','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status',\n""",
    """const required=[\n  'memory','r360_hir_opcode_count','r360_hir_opcode_name','r360_hir_correctness_supports_opcode','r360_hir_correctness_supported_opcode_count',\n  'r360_wasm_backend_supports_hir_opcode','r360_wasm_backend_supported_opcode_count',\n  'r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status',\n""",
    "V73 deployed adaptive HIR ABI critic",
)

fastlane = ROOT / ".github/workflows/xenia-browser-bootstrap-fastlane.yml"
replace_once(
    fastlane,
    """      - 'test-hir-cache-control.mjs'\n      - 'test-hir-rotate-left.mjs'\n      - 'test-xenia-entry-lr-abi.mjs'\n""",
    """      - 'test-hir-cache-control.mjs'\n      - 'test-hir-rotate-left.mjs'\n      - 'test-hir-cntlz.mjs'\n      - 'test-xenia-entry-lr-abi.mjs'\n""",
    "V73 fastlane CNTLZ trigger",
)
replace_once(
    fastlane,
    """      - name: Verify Braid rlwinm HIR rotate-left semantics\n        run: timeout 90s node ./test-hir-rotate-left.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify Xenia title-entry LR ABI\n""",
    """      - name: Verify Braid rlwinm HIR rotate-left semantics\n        run: timeout 90s node ./test-hir-rotate-left.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify Braid cntlzw/cntlzd HIR + generated-Wasm semantics\n        run: timeout 90s node ./test-hir-cntlz.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify Xenia title-entry LR ABI\n""",
    "V73 fastlane CNTLZ publication gate",
)


# ---------------------------------------------------------------------------
# Release 73 surface.
# ---------------------------------------------------------------------------
(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=72;", "const RENDER360_RELEASE=73;", "V73 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:72,", "const CONTENT_BRIDGE={release:73,", "V73 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 72", "Render360 73")
old_ui = '<span>UI Release</span><span class="value">72</span>'
new_ui = '<span>UI Release</span><span class="value">73</span>'
if new_ui not in text:
    if old_ui not in text:
        raise SystemExit("V73 UI Release anchor missing")
    text = text.replace(old_ui, new_ui, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='73';", text, count=1)
if count != 1:
    raise SystemExit("V73 service worker version anchor missing")
sw.write_text(text)

print("R360_V73_HIR_CNTLZ_ADAPTIVE_PATCH=PASS")
