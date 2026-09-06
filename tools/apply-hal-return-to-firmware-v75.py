#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 75


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


def regex_once(path: Path, pattern: str, repl: str, label: str, flags: int = 0) -> None:
    text = path.read_text()
    updated, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 regex anchor, got {count} in {path}")
    path.write_text(updated)
    print(f"{label}: applied")


# V74 proved the 0x00010059 memory failure was an unrelocated variable import.
# The next real Braid boundary is a function import: xboxkrnl ordinal 0x28.
# Upstream Xenia identifies this as HalReturnToFirmware and treats routine 1 as
# HalRebootRoutine, terminating the emulated title. Do not fake a successful
# return. Model it as an explicit terminal kernel boundary and retain the calls
# immediately before it so the next report can expose why Braid chose reboot.

runtime = ROOT / 'src/xenia_web_bootstrap/kernel_runtime_foundation.cpp'
replace_once(
    runtime,
    '''constexpr uint32_t kStatusUnsupported = 2;\nconstexpr uint32_t kStatusInvalid = 3;\n''',
    '''constexpr uint32_t kStatusUnsupported = 2;\nconstexpr uint32_t kStatusInvalid = 3;\nconstexpr uint32_t kStatusTerminal = 4;\n''',
    'V75 terminal kernel status',
)
replace_once(
    runtime,
    '''uint32_t g_last_module = 0;\nuint32_t g_last_ordinal = 0;\nuint32_t g_next_notify_handle = 0x37000001u;\n''',
    '''uint32_t g_last_module = 0;\nuint32_t g_last_ordinal = 0;\nuint32_t g_firmware_requested = 0;\nuint32_t g_firmware_routine = 0;\nuint32_t g_next_notify_handle = 0x37000001u;\n''',
    'V75 firmware request state',
)
replace_once(
    runtime,
    '''  if (module == kModuleXboxkrnl) {\n    switch (ordinal) {\n      case 0x0083:  // KeQueryPerformanceFrequency\n''',
    '''  if (module == kModuleXboxkrnl) {\n    switch (ordinal) {\n      case 0x0028:  // HalReturnToFirmware\n        // Upstream Xenia treats routine 1 as HalRebootRoutine and terminates\n        // the emulated process. A browser runtime cannot exit the host page,\n        // so expose the request as a terminal kernel boundary instead of\n        // pretending this call returned successfully to guest code.\n        g_firmware_requested = 1u;\n        g_firmware_routine = r3;\n        g_service_status = kStatusTerminal;\n        return 0;\n      case 0x0083:  // KeQueryPerformanceFrequency\n''',
    'V75 HalReturnToFirmware service',
)
replace_once(
    runtime,
    '''  render360::xenia_web::g_last_module = 0;\n  render360::xenia_web::g_last_ordinal = 0;\n}\nuint32_t r360_kernel_service_call''',
    '''  render360::xenia_web::g_last_module = 0;\n  render360::xenia_web::g_last_ordinal = 0;\n  render360::xenia_web::g_firmware_requested = 0;\n  render360::xenia_web::g_firmware_routine = 0;\n}\nuint32_t r360_kernel_service_call''',
    'V75 firmware service reset',
)
replace_once(
    runtime,
    '''uint32_t r360_kernel_service_last_ordinal() {\n  return render360::xenia_web::g_last_ordinal;\n}\n\n}  // extern "C"''',
    '''uint32_t r360_kernel_service_last_ordinal() {\n  return render360::xenia_web::g_last_ordinal;\n}\nuint32_t r360_kernel_service_firmware_requested() {\n  return render360::xenia_web::g_firmware_requested;\n}\nuint32_t r360_kernel_service_firmware_routine() {\n  return render360::xenia_web::g_firmware_routine;\n}\n\n}  // extern "C"''',
    'V75 firmware service telemetry exports',
)

probe = ROOT / 'src/xenia_web_bootstrap/kernel_import_probe.cpp'
replace_once(
    probe,
    '''constexpr uint32_t kServiceStatusSuccess = 1;\nconstexpr uint32_t kServiceStatusInvalid = 3;\nstd::array<KernelImportEntry, kMaxKernelImports> g_entries{};\nuint32_t g_count = 0, g_calls = 0, g_last_thunk = 0, g_last_module = 0,\n         g_last_ordinal = 0, g_last_status = 0, g_last_abi_target = 0;\n''',
    '''constexpr uint32_t kServiceStatusSuccess = 1;\nconstexpr uint32_t kServiceStatusInvalid = 3;\nconstexpr uint32_t kServiceStatusTerminal = 4;\nconstexpr uint32_t kMaxKernelImportHistory = 32;\nstruct KernelImportHistoryEntry {\n  uint32_t thunk_address = 0;\n  uint32_t module_id = 0;\n  uint32_t ordinal = 0;\n};\nstd::array<KernelImportEntry, kMaxKernelImports> g_entries{};\nstd::array<KernelImportHistoryEntry, kMaxKernelImportHistory> g_history{};\nuint32_t g_history_count = 0;\nuint32_t g_count = 0, g_calls = 0, g_last_thunk = 0, g_last_module = 0,\n         g_last_ordinal = 0, g_last_status = 0, g_last_abi_target = 0;\n''',
    'V75 kernel call history storage',
)
replace_once(
    probe,
    '''    if (service_status == kServiceStatusInvalid) g_last_status = kServiceStatusInvalid;\n    return false;\n''',
    '''    if (service_status == kServiceStatusInvalid) g_last_status = kServiceStatusInvalid;\n    else if (service_status == kServiceStatusTerminal) g_last_status = kServiceStatusTerminal;\n    return false;\n''',
    'V75 terminal service propagation',
)
replace_once(
    probe,
    '''void RecordKernelImportCall(const KernelImportEntry& entry) {\n  ++g_calls;\n  g_last_thunk = entry.thunk_address;\n  g_last_module = entry.module_id;\n  g_last_ordinal = entry.ordinal;\n  g_last_abi_target = entry.abi_target;\n}\n''',
    '''void RecordKernelImportCall(const KernelImportEntry& entry) {\n  ++g_calls;\n  g_last_thunk = entry.thunk_address;\n  g_last_module = entry.module_id;\n  g_last_ordinal = entry.ordinal;\n  g_last_abi_target = entry.abi_target;\n  KernelImportHistoryEntry event{entry.thunk_address, entry.module_id, entry.ordinal};\n  if (g_history_count < kMaxKernelImportHistory) {\n    g_history[g_history_count++] = event;\n  } else {\n    for (uint32_t i = 1; i < kMaxKernelImportHistory; ++i) {\n      g_history[i - 1] = g_history[i];\n    }\n    g_history[kMaxKernelImportHistory - 1] = event;\n  }\n}\n''',
    'V75 kernel call history recorder',
)
replace_once(
    probe,
    '''void ResetKernelImportProbe() {\n  g_entries = {}; g_count = g_calls = g_last_thunk = g_last_module =\n      g_last_ordinal = g_last_status = g_last_abi_target = 0;\n  ResetTitleGpuRuntime();\n}\n''',
    '''void ResetKernelImportProbe() {\n  g_entries = {};\n  g_history = {};\n  g_history_count = 0;\n  g_count = g_calls = g_last_thunk = g_last_module =\n      g_last_ordinal = g_last_status = g_last_abi_target = 0;\n  ResetTitleGpuRuntime();\n}\n''',
    'V75 kernel call history reset',
)
replace_once(
    probe,
    '''uint32_t KernelImportProbeLastAbiTarget() { return g_last_abi_target; }\nvoid MarkKernelImportProbeAbiFailure() { g_last_status = 3; }\n''',
    '''uint32_t KernelImportProbeLastAbiTarget() { return g_last_abi_target; }\nuint32_t KernelImportProbeHistoryCount() { return g_history_count; }\nuint32_t KernelImportProbeHistoryThunk(uint32_t index) {\n  return index < g_history_count ? g_history[index].thunk_address : 0u;\n}\nuint32_t KernelImportProbeHistoryModule(uint32_t index) {\n  return index < g_history_count ? g_history[index].module_id : 0u;\n}\nuint32_t KernelImportProbeHistoryOrdinal(uint32_t index) {\n  return index < g_history_count ? g_history[index].ordinal : 0u;\n}\nvoid MarkKernelImportProbeAbiFailure() { g_last_status = 3; }\n''',
    'V75 kernel history C++ accessors',
)
replace_once(
    probe,
    '''uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}\n}\n''',
    '''uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}\nuint32_t r360_kernel_import_history_count(){return render360::xenia_web::KernelImportProbeHistoryCount();}\nuint32_t r360_kernel_import_history_thunk(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryThunk(i);}\nuint32_t r360_kernel_import_history_module(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryModule(i);}\nuint32_t r360_kernel_import_history_ordinal(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryOrdinal(i);}\n}\n''',
    'V75 kernel history C exports',
)

probe_h = ROOT / 'src/xenia_web_bootstrap/kernel_import_probe.h'
replace_once(
    probe_h,
    '''uint32_t KernelImportProbeLastAbiTarget();\nvoid MarkKernelImportProbeAbiFailure();\n''',
    '''uint32_t KernelImportProbeLastAbiTarget();\nuint32_t KernelImportProbeHistoryCount();\nuint32_t KernelImportProbeHistoryThunk(uint32_t index);\nuint32_t KernelImportProbeHistoryModule(uint32_t index);\nuint32_t KernelImportProbeHistoryOrdinal(uint32_t index);\nvoid MarkKernelImportProbeAbiFailure();\n''',
    'V75 kernel history header declarations',
)
replace_once(
    probe_h,
    '''uint32_t r360_kernel_import_last_status();\n}\n''',
    '''uint32_t r360_kernel_import_last_status();\nuint32_t r360_kernel_import_history_count();\nuint32_t r360_kernel_import_history_thunk(uint32_t index);\nuint32_t r360_kernel_import_history_module(uint32_t index);\nuint32_t r360_kernel_import_history_ordinal(uint32_t index);\n}\n''',
    'V75 kernel history C header declarations',
)

controller = ROOT / 'render360-title-controller.mjs'
replace_once(
    controller,
    '''  const kernelLastStatusFn=maybe(bootstrap,'r360_kernel_import_last_status');\n  const executionStatus=execStatusFn?(execStatusFn()>>>0):0;\n''',
    '''  const kernelLastStatusFn=maybe(bootstrap,'r360_kernel_import_last_status');\n  const kernelHistoryCountFn=maybe(bootstrap,'r360_kernel_import_history_count');\n  const kernelHistoryThunkFn=maybe(bootstrap,'r360_kernel_import_history_thunk');\n  const kernelHistoryModuleFn=maybe(bootstrap,'r360_kernel_import_history_module');\n  const kernelHistoryOrdinalFn=maybe(bootstrap,'r360_kernel_import_history_ordinal');\n  const firmwareRequestedFn=maybe(bootstrap,'r360_kernel_service_firmware_requested');\n  const firmwareRoutineFn=maybe(bootstrap,'r360_kernel_service_firmware_routine');\n  const executionStatus=execStatusFn?(execStatusFn()>>>0):0;\n''',
    'V75 title kernel history readers',
)
replace_once(
    controller,
    '''  const kernelLastStatus=kernelLastStatusFn?(kernelLastStatusFn()>>>0):0;\n  const reachedKernelModule=kernelLastModuleId===1?'xboxkrnl.exe':kernelLastModuleId===2?'xam.xex':null;\n  const runtimeBoundary=executionStatus===3?'guest-return':kernelLastStatus===2?'kernel-import-unimplemented':kernelLastStatus===3?'kernel-import-abi-failed':executionStatus===2?'no-return-boundary':executionStatus===1?(executionBlockerKind===2?'unresolved-guest-call':executionBlockerKind===3?'instruction-limit':executionBlockerKind===5?'guest-memory-dependency':'unsupported-hir'):'execution-not-observed';\n  const firstKernelBlocker=kernelImports.firstKernelBlocker?{module:kernelImports.firstKernelBlocker.module,ordinal:kernelImports.firstKernelBlocker.ordinal,kind:kernelImports.firstKernelBlocker.kind,valueAddress:kernelImports.firstKernelBlocker.valueAddress,thunkAddress:kernelImports.firstKernelBlocker.thunkAddress}:null;\n  const reachedKernelBlocker=kernelLastStatus===2?{module:reachedKernelModule,ordinal:kernelLastOrdinal,thunkAddress:kernelLastThunk}:null;\n''',
    '''  const kernelLastStatus=kernelLastStatusFn?(kernelLastStatusFn()>>>0):0;\n  const kernelHistoryCount=Math.min(kernelHistoryCountFn?(kernelHistoryCountFn()>>>0):0,32);\n  const kernelCallHistory=Array.from({length:kernelHistoryCount},(_,index)=>{\n    const moduleId=kernelHistoryModuleFn?(kernelHistoryModuleFn(index)>>>0):0;\n    return {\n      sequence:index+1,\n      thunkAddress:kernelHistoryThunkFn?(kernelHistoryThunkFn(index)>>>0):0,\n      moduleId,\n      module:moduleId===1?'xboxkrnl.exe':moduleId===2?'xam.xex':null,\n      ordinal:kernelHistoryOrdinalFn?(kernelHistoryOrdinalFn(index)>>>0):0,\n    };\n  });\n  const firmwareRequested=firmwareRequestedFn?!!(firmwareRequestedFn()>>>0):false;\n  const firmwareRoutine=firmwareRoutineFn?(firmwareRoutineFn()>>>0):0;\n  const reachedKernelModule=kernelLastModuleId===1?'xboxkrnl.exe':kernelLastModuleId===2?'xam.xex':null;\n  const runtimeBoundary=executionStatus===3?'guest-return':kernelLastStatus===4?'firmware-reentry-request':kernelLastStatus===2?'kernel-import-unimplemented':kernelLastStatus===3?'kernel-import-abi-failed':executionStatus===2?'no-return-boundary':executionStatus===1?(executionBlockerKind===2?'unresolved-guest-call':executionBlockerKind===3?'instruction-limit':executionBlockerKind===5?'guest-memory-dependency':'unsupported-hir'):'execution-not-observed';\n  const firstKernelBlocker=kernelImports.firstKernelBlocker?{module:kernelImports.firstKernelBlocker.module,ordinal:kernelImports.firstKernelBlocker.ordinal,kind:kernelImports.firstKernelBlocker.kind,valueAddress:kernelImports.firstKernelBlocker.valueAddress,thunkAddress:kernelImports.firstKernelBlocker.thunkAddress}:null;\n  const reachedKernelBlocker=kernelLastStatus===4?{kind:'firmware-reentry-request',module:reachedKernelModule,ordinal:kernelLastOrdinal,name:kernelLastOrdinal===0x28?'HalReturnToFirmware':undefined,routine:firmwareRoutine,thunkAddress:kernelLastThunk,message:kernelLastOrdinal===0x28?`xboxkrnl!HalReturnToFirmware requested ${firmwareRoutine===1?'HalRebootRoutine':'firmware routine '+firmwareRoutine}`:`Kernel requested firmware re-entry (routine ${firmwareRoutine})`}:kernelLastStatus===2?{kind:'kernel-import-unimplemented',module:reachedKernelModule,ordinal:kernelLastOrdinal,thunkAddress:kernelLastThunk,message:`Unimplemented kernel import ${reachedKernelModule||'module'} ordinal 0x${kernelLastOrdinal.toString(16).toUpperCase()}`}:null;\n''',
    'V75 title terminal boundary classification',
)
replace_once(
    controller,
    '''kernelVariableRegistration,kernelCalls,kernelLastStatus,reachedKernelBlocker,firstKernelBlocker,titleGpuTelemetry''',
    '''kernelVariableRegistration,kernelCalls,kernelLastStatus,kernelCallHistory,firmwareRequested,firmwareRoutine,reachedKernelBlocker,firstKernelBlocker,titleGpuTelemetry''',
    'V75 title kernel telemetry return',
)

browser_runtime = ROOT / 'render360-browser-title-runtime.mjs'
replace_once(browser_runtime, 'const RENDER360_RELEASE=74;', 'const RENDER360_RELEASE=75;', 'V75 browser title release')
replace_once(
    browser_runtime,
    '''  'r360_kernel_import_register','r360_kernel_service_call','r360_kernel_runtime_reset',\n''',
    '''  'r360_kernel_import_register','r360_kernel_service_call','r360_kernel_runtime_reset',\n  'r360_kernel_import_history_count','r360_kernel_import_history_thunk','r360_kernel_import_history_module','r360_kernel_import_history_ordinal',\n  'r360_kernel_service_firmware_requested','r360_kernel_service_firmware_routine',\n''',
    'V75 browser terminal/history ABI gate',
)

content_bridge = ROOT / 'render360-browser-modern-content-bridge.mjs'
replace_once(
    content_bridge,
    '''    const compatibilityBlocker=state.result.reachedKernelBlocker??(status===1?{kind:state.result.runtimeBoundary==='unresolved-guest-call'?'native-hir-unresolved-call':'native-hir-unsupported-boundary',entry:state.result.entry>>>0,hirBlockerKind:state.result.executionBlockerKind>>>0,hirOpcode:state.result.executionBlockerOpcode>>>0,guestAddress:state.result.executionBlockerAddress>>>0,message:`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`}:(status===2?{kind:'native-hir-no-return-boundary',entry:state.result.entry>>>0,message:`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`}:null));\n''',
    '''    const reachedKernel=state.result.reachedKernelBlocker?{...state.result.reachedKernelBlocker}:null;\n    if(reachedKernel&&!reachedKernel.message){\n      reachedKernel.message=reachedKernel.kind==='firmware-reentry-request'&&reachedKernel.ordinal===0x28\n        ?`xboxkrnl!HalReturnToFirmware requested ${reachedKernel.routine===1?'HalRebootRoutine':'firmware routine '+reachedKernel.routine}`\n        :`Kernel blocker ${reachedKernel.module||'module'} ordinal 0x${Number(reachedKernel.ordinal||0).toString(16).toUpperCase()}`;\n    }\n    const compatibilityBlocker=reachedKernel??(status===1?{kind:state.result.runtimeBoundary==='unresolved-guest-call'?'native-hir-unresolved-call':'native-hir-unsupported-boundary',entry:state.result.entry>>>0,hirBlockerKind:state.result.executionBlockerKind>>>0,hirOpcode:state.result.executionBlockerOpcode>>>0,guestAddress:state.result.executionBlockerAddress>>>0,message:`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`}:(status===2?{kind:'native-hir-no-return-boundary',entry:state.result.entry>>>0,message:`Native HIR compatibility execution reached ${state.result.runtimeBoundary}${exact}`}:null));\n''',
    'V75 readable compatibility blocker',
)
regex_once(
    content_bridge,
    r"export function modernContentBridgeContract\(\)\{return \{release:\d+,",
    "export function modernContentBridgeContract(){return {release:75,",
    'V75 modern content contract release',
)

dev = ROOT / 'developer-console.js'
replace_once(
    dev,
    '''function compactBlocker(detail){\n  const source=detail?.blocker||detail?.schedulerBlocker||detail||{};\n''',
    '''function blockerMessage(source,detail){\n  const raw=source?.message??source?.reason??detail?.message??detail?.reason;\n  if(typeof raw==='string')return raw;\n  if(raw&&typeof raw==='object')return raw.message||raw.reason||raw.kind||JSON.stringify(raw);\n  return present(raw)?String(raw):undefined;\n}\nfunction compactBlocker(detail){\n  const source=detail?.blocker||detail?.schedulerBlocker||detail||{};\n''',
    'V75 structured blocker message formatter',
)
replace_once(
    dev,
    '''    message:source.message||source.reason||detail?.message||detail?.reason,\n''',
    '''    message:blockerMessage(source,detail),\n''',
    'V75 no object-object blocker messages',
)
replace_once(
    dev,
    '''    module:source.module,\n    ordinal:present(source.ordinal)?`0x${Number(source.ordinal).toString(16).toUpperCase()}`:undefined,\n''',
    '''    module:source.module,\n    name:source.name,\n    routine:number(source.routine),\n    ordinal:present(source.ordinal)?`0x${Number(source.ordinal).toString(16).toUpperCase()}`:undefined,\n''',
    'V75 blocker terminal fields',
)
replace_once(
    dev,
    '''  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;\n  const entryAddress=number(cpu?.entry),blockerAddress=number(cpu?.executionBlockerAddress);\n''',
    '''  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;\n  const kernelOrdinal=number(kernel?.reachedBlocker?.ordinal);\n  const firmwareBoundary=number(kernel?.lastStatus)===4||kernel?.reachedBlocker?.kind==='firmware-reentry-request'||cpu?.runtimeBoundary==='firmware-reentry-request';\n  if(firmwareBoundary&&kernelOrdinal===0x28&&!memory?.faultCode){\n    const history=Array.isArray(kernel?.callHistory)?kernel.callHistory:[];\n    const historyText=history.map(event=>`#${event.sequence??'?'} ${event.module||'module'}!0x${Number(event.ordinal||0).toString(16).toUpperCase()}${event.thunkAddress?` @ ${event.thunkAddress}`:''}`);\n    const hasAllocation=writes.some(event=>number(event.newR1)!==undefined&&number(event.oldR1)!==undefined&&(number(event.newR1)-number(event.oldR1))===-160);\n    const hasRestore=writes.some(event=>number(event.newR1)!==undefined&&number(event.oldR1)!==undefined&&(number(event.newR1)-number(event.oldR1))===160);\n    return compact({\n      classification:'FIRMWARE_REENTRY_REQUEST',\n      headline:'CPU reached xboxkrnl!HalReturnToFirmware (HalRebootRoutine)',\n      primarySuspect:cpu?.executionBlockerAddress,\n      reason:'The title requested firmware reboot; this is a terminal kernel path, not a guest-memory fault.',\n      initialAbiCorrect,\n      callEdge:trace.lastCallSource&&trace.lastCallTarget?`${trace.lastCallSource} -> ${trace.lastCallTarget}`:undefined,\n      kernelCallHistory:historyText.length?historyText:undefined,\n      evidence:[\n        `Kernel status is terminal (4): xboxkrnl ordinal 0x28 = HalReturnToFirmware, routine ${kernel?.reachedBlocker?.routine??'—'}.`,\n        `No sparse guest-memory fault was captured (fault=${memory?.faultName||'none'} @ ${memory?.faultAddress||'0x00000000'}).`,\n        hasAllocation&&hasRestore?'The -0xA0 frame allocation and +0xA0 restore are both present; the earlier r1 teardown is balanced.':undefined,\n        historyText.length?`Kernel calls before reboot: ${historyText.join(' · ')}`:'Kernel call history was not available in this bootstrap.',\n        cpu?.executionBlockerAddress==='0x8237386C'?'Braid reached the reboot call at 0x8237386C after its preceding startup path returned failure.':undefined,\n      ].filter(Boolean),\n      ruledOut:[\n        '0x00010059 / KeDebugMonitorData relocation (V74 resolved it)',\n        'A current guest-memory boundary (fault code is zero)',\n        hasAllocation&&hasRestore?'The +0xA0 r1 restore as an unmatched frame teardown':undefined,\n        gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU requests reboot first)':undefined,\n      ].filter(Boolean),\n      next:[\n        'Use the captured kernel-call history to inspect the calls immediately before HalReturnToFirmware and identify which startup dependency made Braid choose its reboot path.',\n        'Do not stub HalReturnToFirmware as a successful return; preserve it as a terminal title boundary.',\n        'Keep the V74 variable relocation and strict low-memory guard unchanged.',\n      ],\n      runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,\n      cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),\n    });\n  }\n  const entryAddress=number(cpu?.entry),blockerAddress=number(cpu?.executionBlockerAddress);\n''',
    'V75 firmware-aware diagnostic focus',
)
replace_once(
    dev,
    '''  const kernel=compact({\n    imports:number(result.kernelImportCount??result.importCount),registered:number(result.registeredKernelImports),calls:number(result.kernelCalls),\n    lastStatus:number(result.lastKernelServiceStatus),reachedBlocker:kernelBlocker?compactBlocker(kernelBlocker):undefined,\n  });\n''',
    '''  const kernel=compact({\n    imports:number(result.kernelImportCount??result.importCount),registered:number(result.registeredKernelImports),calls:number(result.kernelCalls),\n    lastStatus:number(result.kernelLastStatus??result.lastKernelServiceStatus),\n    callHistory:Array.isArray(result.kernelCallHistory)?result.kernelCallHistory.map(event=>compact({sequence:number(event.sequence),module:event.module,moduleId:number(event.moduleId),ordinal:number(event.ordinal),thunkAddress:address(event.thunkAddress)})):undefined,\n    firmwareRequested:result.firmwareRequested,routine:number(result.firmwareRoutine),\n    reachedBlocker:kernelBlocker?compactBlocker(kernelBlocker):undefined,\n  });\n''',
    'V75 kernel report history/status',
)

runtime_js = ROOT / 'runtime/render360-runtime.js'
replace_once(runtime_js, 'const RENDER360_RELEASE=74;', 'const RENDER360_RELEASE=75;', 'V75 runtime release')
replace_once(runtime_js, 'const REQUIRED_CORE_BUILD=74;', 'const REQUIRED_CORE_BUILD=75;', 'V75 package requirement')
replace_once(runtime_js, 'const CONTENT_BRIDGE={release:74,', 'const CONTENT_BRIDGE={release:75,', 'V75 content bridge release')

sw = ROOT / 'render360-sw.js'
regex_once(sw, r"const VERSION='\d+';", "const VERSION='75';", 'V75 service worker release')

index = ROOT / 'index.html'
text = index.read_text()
text = text.replace('Render360 74', 'Render360 75')
text = text.replace('<span>UI Release</span><span class="value">74</span>', '<span>UI Release</span><span class="value">75</span>')
index.write_text(text)
print('V75 index labels: applied')

(ROOT / 'VERSION').write_text(f'{RELEASE}\n')
print('V75 VERSION: applied')
print('R360_V75_HAL_RETURN_TO_FIRMWARE_PATCH=PASS')
