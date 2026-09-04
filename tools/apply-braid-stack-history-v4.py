#!/usr/bin/env python3
from pathlib import Path

root=Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str):
    text=path.read_text()
    if old not in text:
        if new in text:
            return
        raise SystemExit(f'{path}: {label} anchor changed')
    path.write_text(text.replace(old,new,1))

# Run the bounded stack-history instrumentation after the established V3
# return-metadata surgery so the history observes the final executor semantics.
prepare=root/'prepare-title-runtime-memory-overlay.py'
old="""subprocess.run(\n    [sys.executable, str(root / 'prepare-hir-return-metadata-v3-overlay.py')],\n    check=True,\n)\n"""
new=old+"""\n# Finally capture the bounded r1/call history used to diagnose real-title\n# prologue/epilogue balance without weakening the Xbox stack guards.\nsubprocess.run(\n    [sys.executable, str(root / 'prepare-hir-stack-history-v4-overlay.py')],\n    check=True,\n)\n"""
replace_once(prepare,old,new,'V4 overlay chaining')

controller=root/'render360-title-controller.mjs'
anchor="""  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;\n"""
insertion="""  const stackHistoryCountFn=maybe(bootstrap,'r360_ppc_probe_stack_history_count');\n  const stackHistoryRead=(name,index)=>{const f=maybe(bootstrap,name);return f?(f(index)>>>0):undefined;};\n  const stackHistory=[];\n  if(stackHistoryCountFn){\n    const count=Math.min(stackHistoryCountFn()>>>0,24);\n    for(let i=0;i<count;i++){\n      const kind=stackHistoryRead('r360_ppc_probe_stack_history_kind',i);\n      stackHistory.push({\n        index:i,\n        kind,\n        kindName:kind===1?'stack-write':kind===2?'guest-call':`event-${kind}`,\n        source:stackHistoryRead('r360_ppc_probe_stack_history_source',i),\n        sourceInstruction:stackHistoryRead('r360_ppc_probe_stack_history_instruction',i),\n        target:stackHistoryRead('r360_ppc_probe_stack_history_target',i),\n        flags:stackHistoryRead('r360_ppc_probe_stack_history_flags',i),\n        depth:stackHistoryRead('r360_ppc_probe_stack_history_depth',i),\n        oldR1:stackHistoryRead('r360_ppc_probe_stack_history_old_r1',i),\n        newR1:stackHistoryRead('r360_ppc_probe_stack_history_new_r1',i),\n      });\n    }\n  }\n  if(stackHistory.length)stackTrace.history=stackHistory;\n  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;\n"""
replace_once(controller,anchor,insertion,'title stack history snapshot')

dev=root/'developer-console.js'
compact_anchor="""function compact(value){return Object.fromEntries(Object.entries(value).filter(([,item])=>present(item)));}\n"""
compact_insert=compact_anchor+"""function knownPpcHelper(word){\n  const value=number(word);if(value===undefined)return undefined;const p=value>>>0;\n  if((p>>>26)!==58)return undefined;\n  const rt=(p>>>21)&31,ra=(p>>>16)&31;if(rt<14||rt>31||ra!==1)return undefined;\n  let ds=(p>>>2)&0x3FFF;if(ds&0x2000)ds-=0x4000;const disp=(ds<<2)|0;\n  return disp===-8*(33-rt)?`__restgprlr_${rt}`:undefined;\n}\n"""
replace_once(dev,compact_anchor,compact_insert,'known PPC rest helper decoder')

trace_anchor="""  });\n  const capturedFaultAddress=number(result?.memoryFaultAddress);\n"""
trace_insert="""  });\n  const rawHistory=Array.isArray(resultStack.history)?resultStack.history:[];\n  const stackHistory=rawHistory.map(event=>compact({\n    index:number(event.index),kind:event.kindName||number(event.kind),\n    source:address(event.source),instruction:address(event.sourceInstruction),\n    target:number(event.target)?address(event.target):undefined,flags:number(event.flags),depth:number(event.depth),\n    oldR1:address(event.oldR1),newR1:address(event.newR1),\n  }));\n  if(stackHistory.length)stackTrace.history=stackHistory;\n  const capturedFaultAddress=number(result?.memoryFaultAddress);\n"""
replace_once(dev,trace_anchor,trace_insert,'developer stack history formatting')

fault_anchor="""  const faultNames={0:'none',1:'unmapped',2:'read-protection',3:'write-protection',4:'invalid-argument',5:'already-mapped'};\n"""
fault_insert="""  const knownHelper=knownPpcHelper(instructionWord);\n  const faultNames={0:'none',1:'unmapped',2:'read-protection',3:'write-protection',4:'invalid-argument',5:'already-mapped'};\n"""
replace_once(dev,fault_anchor,fault_insert,'known helper capture')

return_anchor="""    instructionKind,ppcPrimaryOpcode:primaryOpcode,rt,ra,displacement,\n"""
return_insert="""    instructionKind,knownHelper,ppcPrimaryOpcode:primaryOpcode,rt,ra,displacement,\n"""
replace_once(dev,return_anchor,return_insert,'known helper report field')

summary_anchor="""  if((memory.instructionKind==='d-form-memory'||memory.instructionKind==='ds-form-memory')&&present(memory.ra))return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}`;\n"""
summary_insert="""  if((memory.instructionKind==='d-form-memory'||memory.instructionKind==='ds-form-memory')&&present(memory.ra))return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}${memory.knownHelper?` · ${memory.knownHelper}`:''}`;\n"""
replace_once(dev,summary_anchor,summary_insert,'helper summary')

print('BRAID_STACK_HISTORY_V4_INTEGRATION=PASS')
