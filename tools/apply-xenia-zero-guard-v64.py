#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TITLE = ROOT / "render360-title-controller.mjs"
CONSOLE = ROOT / "developer-console.js"
VERSION = ROOT / "VERSION"
RUNTIME = ROOT / "runtime/render360-runtime.js"
INDEX = ROOT / "index.html"
SW = ROOT / "render360-sw.js"
RELEASE = 64


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
# Real Xenia reserves/protects the first 64 KiB by default. Render360's earlier
# Braid workaround mapped that entire aperture RW and zero-filled, allowing an
# invalid r31==0 startup path to read 0x46C0 and continue into unrelated cleanup
# code. Stop masking that dependency. Sparse memory leaves it unmapped, which is
# the browser runtime's fail-closed equivalent of Xenia's protected zero region.
# ---------------------------------------------------------------------------
t = TITLE.read_text()
low_old = '''  // Compatibility fallback for the native-HIR title path. Braid's current
  // startup load is `lwz r11,0x46C0(r31)` while r31 is still zero, so its
  // effective address is 0x000046C0. The previous workaround mapped only one
  // 4 KiB page (0x0000-0x0FFF), leaving that exact address unmapped. Keep this
  // workaround bounded to Xenia's first 64 KiB low-memory region rather than
  // turning sparse memory into an unrestricted low-address alias.
  const lowMemoryPages=0x10000/pageSize;
  const lowMemoryBacking=alloc(lowMemoryPages)>>>0;
  if(!lowMemoryBacking||(map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map title low-memory compatibility aperture');

'''
low_new = '''  // Xenia protects 0x00000000-0x0000FFFF by default. Do not map a synthetic
  // zero-filled title aperture here. If guest code reaches this region through
  // a zero base register, preserve the fault so the missing loader/register
  // state is diagnosed at the first incorrect dependency instead of being
  // hidden until a later stack teardown.

'''
t = replace_once(t, low_old, low_new, "V64 remove zero-filled low-memory aperture")
return_old = "return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,xeniaInitialLr,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};"
return_new = "return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,xeniaInitialLr,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:false,lowMemoryCompatBytes:0,lowMemoryPolicy:'xenia-protected'};"
t = replace_once(t, return_old, return_new, "V64 main-thread zero-aperture telemetry")
TITLE.write_text(t)


# ---------------------------------------------------------------------------
# Promote the newly exposed low-memory fault to the real problem in the report.
# memoryDiagnostics already derives the effective address and base-register value
# from the faulting PPC instruction, so V64 can prove rA==0 without inventing a
# new native telemetry ABI.
# ---------------------------------------------------------------------------
d = CONSOLE.read_text()
anchor = '''  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;
  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;
  if(unresolvedTail){
'''
insert = '''  const unresolvedTail=cpu?.runtimeBoundary==='unresolved-guest-call'&&number(cpu?.executionBlockerKind)===2&&number(cpu?.executionBlockerOpcode)===0&&!!tailCall;
  const unsupportedTail=cpu?.runtimeBoundary==='unsupported-hir'&&number(cpu?.executionBlockerKind)===1&&!!tailCall;
  const lowApertureFault=!!memory?.faultCode&&fault!==undefined&&fault<0x10000&&
    (memory?.instructionKind==='d-form-memory'||memory?.instructionKind==='ds-form-memory')&&number(memory?.baseRegisterValue)===0;
  if(lowApertureFault){
    const baseReg=number(memory?.ra);
    return compact({
      classification:'XENIA_ZERO_APERTURE_STATE_MISSING',
      headline:`guest memory reached Xenia-protected low memory through r${baseReg??'A'}=0`,
      primarySuspect:cpu?.executionBlockerAddress,
      initialAbiCorrect,
      faultDerivedFromBaseRegister:true,
      evidence:[
        `Failing PPC: ${memory?.blockerDecoded||'memory instruction'} at ${cpu?.executionBlockerAddress||'—'}.`,
        `Effective address ${memory?.effectiveAddress||memory?.faultAddress||'—'} came from r${baseReg??'A'}=${memory?.baseRegisterValue||'0x00000000'} plus displacement ${memory?.displacement??'—'}.`,
        `The access is inside 0x00000000-0x0000FFFF. V64 intentionally leaves that aperture inaccessible instead of returning synthetic zero data.`,
        initialAbiCorrect?`Entry r1 remains correct: ${trace.initialR1} == stackTop ${memory.stackTop}.`:undefined,
      ].filter(Boolean),
      ruledOut:[
        initialAbiCorrect?'Initial stack reservation / stackTop mismatch':undefined,
        'The later +0x100 teardown as the first cause; V63 proved it was downstream of this masked state path',
        'Making low memory writable as a compatibility fix',
        number(kernel?.calls)===0?'XAM/xboxkrnl HLE as the current cause (kernel calls = 0)':undefined,
        gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU stops first)':undefined,
      ].filter(Boolean),
      next:[
        `Trace why live r${baseReg??'A'} is zero at ${cpu?.executionBlockerAddress||'this instruction'} and restore the missing Xenia loader/title startup state.`,
        'Keep 0x00000000-0x0000FFFF inaccessible; do not reintroduce a zero-filled low-memory aperture.',
        'Do not change the verified r1/stackTop geometry while fixing this register/runtime-state dependency.',
      ],
      runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,
      cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),
    });
  }
  if(unresolvedTail){
'''
d = replace_once(d, anchor, insert, "V64 zero-aperture diagnostic classification")
CONSOLE.write_text(d)


VERSION.write_text(f"{RELEASE}\n")

runtime = RUNTIME.read_text()
runtime = replace_once(runtime, "const RENDER360_RELEASE=63;", "const RENDER360_RELEASE=64;", "V64 runtime release")
runtime = replace_once(runtime, "const CONTENT_BRIDGE={release:63,", "const CONTENT_BRIDGE={release:64,", "V64 content bridge release")
RUNTIME.write_text(runtime)

index = INDEX.read_text().replace("Render360 63", "Render360 64")
index = replace_once(index,
                     '<span>UI Release</span><span class="value">63</span>',
                     '<span>UI Release</span><span class="value">64</span>',
                     "V64 UI Release label")
INDEX.write_text(index)

sw = SW.read_text()
sw, count = re.subn(r"const VERSION='\d+';", "const VERSION='64';", sw, count=1)
if count != 1:
    raise SystemExit("V64 service-worker version anchor missing")
SW.write_text(sw)

print("R360_V64_XENIA_ZERO_GUARD_PATCH=PASS")
