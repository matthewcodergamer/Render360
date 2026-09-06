#!/usr/bin/env python3
from pathlib import Path

path=Path('developer-console.js')
text=path.read_text()

def replace_once(old,new,label,marker=None):
    global text
    if marker and marker in text:
        print(f'{label}: already applied')
        return
    if old not in text:
        if new in text:
            print(f'{label}: already applied')
            return
        raise SystemExit(f'{label}: anchor not found')
    if text.count(old)!=1:
        raise SystemExit(f'{label}: expected one anchor, got {text.count(old)}')
    text=text.replace(old,new,1)
    print(f'{label}: applied')

replace_once(
"  const suspectWrite=[...writes].reverse().find(event=>event.address===trace.lastWriteAddress&&event.newR1===trace.lastNewR1)||writes.at(-1);",
"  // A kernel import boundary is not a sparse-memory fault. Prefer the exact\n  // guest-visible HLE service over stale stack-history heuristics so the\n  // problem-first console names the service the title actually reached.\n  if(cpu?.runtimeBoundary==='kernel-import-unimplemented'&&kernel?.reachedBlocker){\n    const service=kernel.reachedBlocker;\n    const moduleName=service.module||'kernel';\n    const ordinal=service.ordinal||'unknown ordinal';\n    return compact({\n      classification:'KERNEL_IMPORT_BLOCKER',\n      headline:`Xbox kernel service ${moduleName} ${ordinal} is not implemented`,\n      primarySuspect:cpu?.executionBlockerAddress,\n      serviceModule:moduleName,\n      serviceOrdinal:ordinal,\n      serviceCalls:kernel?.calls,\n      initialAbiCorrect,\n      callEdge:trace.lastCallSource&&trace.lastCallTarget?`${trace.lastCallSource} -> ${trace.lastCallTarget}`:undefined,\n      evidence:[\n        `Runtime boundary is kernel-import-unimplemented at ${cpu?.executionBlockerAddress||'—'}.`,\n        `Guest reached ${moduleName} ordinal ${ordinal}; kernel calls=${kernel?.calls??'—'}.`,\n        memory?.faultCode===0?'No sparse guest-memory fault was captured for this boundary.':undefined,\n        memory?.faultCapturedAtExecution===false?'The displayed memory fault address is diagnostic history, not an execution-captured fault.':undefined,\n        initialAbiCorrect?`Entry r1 remains correct: ${trace.initialR1} == stackTop ${memory.stackTop}.`:undefined,\n      ].filter(Boolean),\n      ruledOut:[\n        memory?.faultCode===0?'Guest-memory boundary as the active stop reason':undefined,\n        initialAbiCorrect?'Initial stack reservation / stackTop mismatch':undefined,\n        gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU stops first)':undefined,\n      ].filter(Boolean),\n      next:[\n        `Resolve ${moduleName} ${ordinal} from Xenia's kernel export table and implement its guest-visible semantics.`,\n        'Keep sparse-memory guards and the verified stack ABI unchanged unless a later captured fault proves otherwise.',\n      ],\n      runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,\n      cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),\n    });\n  }\n  const suspectWrite=[...writes].reverse().find(event=>event.address===trace.lastWriteAddress&&event.newR1===trace.lastNewR1)||writes.at(-1);",
'kernel blocker classification',
"classification:'KERNEL_IMPORT_BLOCKER'")

replace_once(
"  if(focus.tailTarget){\n    grid.append(",
"  if(focus.classification==='KERNEL_IMPORT_BLOCKER'){\n    grid.append(\n      focusCell('Kernel service',`${focus.serviceModule||summary.kernel?.reachedBlocker?.module||'—'} · ${focus.serviceOrdinal||summary.kernel?.reachedBlocker?.ordinal||'—'}`),\n      focusCell('Runtime boundary',summary.cpu?.runtimeBoundary||'—'),\n      focusCell('Call site',focus.primarySuspect||summary.cpu?.executionBlockerAddress||'—'),\n      focusCell('Kernel calls',`${focus.serviceCalls??summary.kernel?.calls??'—'}`),\n      focusCell('Failing PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),\n      focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)\n    );\n  }else if(focus.tailTarget){\n    grid.append(",
'kernel blocker focus grid',
"focus.classification==='KERNEL_IMPORT_BLOCKER'")

path.write_text(text)
print('KERNEL_BLOCKER_DIAGNOSTIC_PATCH=PASS')
