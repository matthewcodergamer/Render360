#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 74


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


def sub_once(path: Path, pattern: str, replacement: str, label: str) -> None:
    text = path.read_text()
    new_text, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 regex anchor, got {count} in {path}")
    path.write_text(new_text)
    print(f"{label}: applied")


# Braid V73 proves the value at 0x82000610 is 0x00010059. This is not a
# pointer and not stack corruption: it is the still-unrelocated XEX variable
# import descriptor for xboxkrnl ordinal 0x59, KeDebugMonitorData. Upstream
# Xenia allocates a 4-byte guest variable for KeDebugMonitorData, initializes it
# from the debug-monitor option (zero for normal retail execution), and patches
# the XEX variable slot to the guest address. KeCertMonitorData (0x266) is the
# same zero-backed variable pattern, so install both exact Xenia exports while
# continuing to fail closed for every other unknown kernel variable.
controller = ROOT / 'render360-title-controller.mjs'
replace_once(
    controller,
    """const XENIA_KERNEL_DATA_BASE=0x50010000;\nconst XENIA_EXECUTABLE_MODULE_VAR=XENIA_KERNEL_DATA_BASE;\nconst XENIA_EXECUTABLE_HMODULE=XENIA_KERNEL_DATA_BASE+0x100;\nconst XENIA_XEX_HEADER_BASE=XENIA_KERNEL_DATA_BASE+0x1000;\nconst XENIA_BUILTIN_VARIABLE_EXPORTS={'xboxkrnl.exe:403':{kind:'kernel-variable',name:'XexExecutableModuleHandle'}};\n""",
    """const XENIA_KERNEL_DATA_BASE=0x50010000;\nconst XENIA_EXECUTABLE_MODULE_VAR=XENIA_KERNEL_DATA_BASE;\nconst XENIA_KE_DEBUG_MONITOR_DATA=XENIA_KERNEL_DATA_BASE+0x004;\nconst XENIA_KE_CERT_MONITOR_DATA=XENIA_KERNEL_DATA_BASE+0x008;\nconst XENIA_EXECUTABLE_HMODULE=XENIA_KERNEL_DATA_BASE+0x100;\nconst XENIA_XEX_HEADER_BASE=XENIA_KERNEL_DATA_BASE+0x1000;\nconst XENIA_KERNEL_VARIABLE_LAYOUT=new Map([\n  [0x59,{name:'KeDebugMonitorData',address:XENIA_KE_DEBUG_MONITOR_DATA,value:0}],\n  [0x193,{name:'XexExecutableModuleHandle',address:XENIA_EXECUTABLE_MODULE_VAR}],\n  [0x266,{name:'KeCertMonitorData',address:XENIA_KE_CERT_MONITOR_DATA,value:0}],\n]);\nconst XENIA_BUILTIN_VARIABLE_EXPORTS={\n  'xboxkrnl.exe:89':{kind:'kernel-variable',name:'KeDebugMonitorData'},\n  'xboxkrnl.exe:403':{kind:'kernel-variable',name:'XexExecutableModuleHandle'},\n  'xboxkrnl.exe:614':{kind:'kernel-variable',name:'KeCertMonitorData'},\n};\n""",
    'V74 Xenia variable export layout',
)
replace_once(
    controller,
    """  const supported=kernelImports.plan.filter(item=>item.isKernelModule&&item.kind==='variable'&&item.module.toLowerCase()==='xboxkrnl.exe'&&item.ordinal===0x193);\n""",
    """  const supported=kernelImports.plan.filter(item=>item.isKernelModule&&item.kind==='variable'&&item.module.toLowerCase()==='xboxkrnl.exe'&&XENIA_KERNEL_VARIABLE_LAYOUT.has(item.ordinal));\n""",
    'V74 variable import admission',
)
replace_once(
    controller,
    """  // xboxkrnl!XexExecutableModuleHandle is itself a pointer-sized exported\n  // variable whose value is the executable module's HMODULE.\n  put32(XENIA_EXECUTABLE_MODULE_VAR,XENIA_EXECUTABLE_HMODULE);\n\n  let patched=0;\n  for(const item of supported){\n    if((patch32(item.valueAddress>>>0,XENIA_EXECUTABLE_MODULE_VAR)>>>0)!==1){\n      const status=maybe(bootstrap,'r360_xex_guest_mapper_status')?.()>>>0||0;\n      throw new Error(`failed to relocate ${item.module}!XexExecutableModuleHandle at 0x${(item.valueAddress>>>0).toString(16)} (mapper 0x${status.toString(16)})`);\n    }\n    patched++;\n  }\n  return {available:true,patched,supported:supported.length,variableAddress:XENIA_EXECUTABLE_MODULE_VAR,hmoduleAddress:XENIA_EXECUTABLE_HMODULE,xexHeaderAddress:XENIA_XEX_HEADER_BASE,headerBytes:headerSize,imageBase:kernelImports.imageBase>>>0,imageSize,entry:entry>>>0};\n""",
    """  // Xenia's xboxkrnl module exports these as actual guest variables. Keep\n  // distinct backing cells and relocate only the exact variable ordinals that\n  // have faithful state here; unknown variables remain fail-closed.\n  put32(XENIA_EXECUTABLE_MODULE_VAR,XENIA_EXECUTABLE_HMODULE);\n  put32(XENIA_KE_DEBUG_MONITOR_DATA,0);\n  put32(XENIA_KE_CERT_MONITOR_DATA,0);\n\n  let patched=0;\n  const relocated=[];\n  for(const item of supported){\n    const spec=XENIA_KERNEL_VARIABLE_LAYOUT.get(item.ordinal);\n    const targetAddress=spec.address>>>0;\n    if((patch32(item.valueAddress>>>0,targetAddress)>>>0)!==1){\n      const status=maybe(bootstrap,'r360_xex_guest_mapper_status')?.()>>>0||0;\n      throw new Error(`failed to relocate ${item.module}!${spec.name} at 0x${(item.valueAddress>>>0).toString(16)} (mapper 0x${status.toString(16)})`);\n    }\n    relocated.push({module:item.module,ordinal:item.ordinal,name:spec.name,slotAddress:item.valueAddress>>>0,targetAddress});\n    patched++;\n  }\n  return {available:true,patched,supported:supported.length,variableAddress:XENIA_EXECUTABLE_MODULE_VAR,variableAddresses:{XexExecutableModuleHandle:XENIA_EXECUTABLE_MODULE_VAR,KeDebugMonitorData:XENIA_KE_DEBUG_MONITOR_DATA,KeCertMonitorData:XENIA_KE_CERT_MONITOR_DATA},relocated,hmoduleAddress:XENIA_EXECUTABLE_HMODULE,xexHeaderAddress:XENIA_XEX_HEADER_BASE,headerBytes:headerSize,imageBase:kernelImports.imageBase>>>0,imageSize,entry:entry>>>0};\n""",
    'V74 faithful xboxkrnl variable relocation',
)

# Make the release gate usable during an intentional N -> N+1 rollout without
# weakening the final invariant. Package-core is allowed to publish while the
# checked-in bootstrap is exactly one release behind; the bootstrap fastlane
# still runs the strict gate before publishing and final state must be equal.
consistency = ROOT / 'test-render360-version-consistency.mjs'
replace_once(
    consistency,
    """const runtime = read('runtime/render360-runtime.js');\nconst serviceWorker = read('render360-sw.js');\n\nassert.match(runtime, new RegExp(`const RENDER360_RELEASE=${version};`), 'runtime release drifted from VERSION');\n""",
    """const runtime = read('runtime/render360-runtime.js');\nconst titleRuntime = read('render360-browser-title-runtime.mjs');\nconst serviceWorker = read('render360-sw.js');\n\nassert.match(runtime, new RegExp(`const RENDER360_RELEASE=${version};`), 'runtime release drifted from VERSION');\nassert.match(titleRuntime, new RegExp(`const RENDER360_RELEASE=${version};`), 'title runtime release drifted from VERSION');\n""",
    'V74 title-runtime version gate',
)
replace_once(
    consistency,
    """const bootstrapMeta = JSON.parse(read('xenia_ppc_bootstrap.meta.json'));\nif (bootstrapMeta.release == null && allowBootstrapPending) {\n  console.warn(`BOOTSTRAP_RELEASE_PENDING current metadata has no release; fastlane must republish V${version}`);\n} else {\n  assert.equal(Number(bootstrapMeta.release), version, 'browser bootstrap metadata release drifted from VERSION');\n}\n""",
    """const bootstrapMeta = JSON.parse(read('xenia_ppc_bootstrap.meta.json'));\nconst bootstrapRelease = bootstrapMeta.release == null ? null : Number(bootstrapMeta.release);\nconst bootstrapIsPreviousRelease = Number.isInteger(bootstrapRelease) && bootstrapRelease === version - 1;\nif (allowBootstrapPending && (bootstrapRelease == null || bootstrapIsPreviousRelease)) {\n  console.warn(`BOOTSTRAP_RELEASE_PENDING current=${bootstrapRelease == null ? 'unset' : `V${bootstrapRelease}`} target=V${version}; fastlane must republish target release`);\n} else {\n  assert.equal(bootstrapRelease, version, 'browser bootstrap metadata release drifted from VERSION');\n}\n""",
    'V74 one-release transition gate',
)

# Single release source of truth and every user-visible/runtime cache stamp.
(ROOT / 'VERSION').write_text(f'{RELEASE}\n')

runtime = ROOT / 'runtime/render360-runtime.js'
sub_once(runtime, r'const RENDER360_RELEASE=\d+;', f'const RENDER360_RELEASE={RELEASE};', 'V74 runtime release')
sub_once(runtime, r'const REQUIRED_CORE_BUILD=\d+;', f'const REQUIRED_CORE_BUILD={RELEASE};', 'V74 required core release')
sub_once(runtime, r'const CONTENT_BRIDGE=\{release:\d+,', f'const CONTENT_BRIDGE={{release:{RELEASE},', 'V74 content bridge release')

title_runtime = ROOT / 'render360-browser-title-runtime.mjs'
sub_once(title_runtime, r'const RENDER360_RELEASE=\d+;', f'const RENDER360_RELEASE={RELEASE};', 'V74 title runtime release')

sw = ROOT / 'render360-sw.js'
sub_once(sw, r"const VERSION=['\"]\d+['\"];", f"const VERSION='{RELEASE}';", 'V74 service-worker cache release')

index = ROOT / 'index.html'
text = index.read_text()
text, count = re.subn(r'Render360 \d+', f'Render360 {RELEASE}', text)
if count < 1:
    raise SystemExit('V74 index release label anchor missing')
text, ui_count = re.subn(r'<span>UI Release</span><span class="value">\d+</span>', f'<span>UI Release</span><span class="value">{RELEASE}</span>', text, count=1)
if ui_count != 1:
    raise SystemExit('V74 UI Release anchor missing')
index.write_text(text)

print('R360_V74_KERNEL_DEBUG_MONITOR_VARIABLE_PATCH=PASS')
