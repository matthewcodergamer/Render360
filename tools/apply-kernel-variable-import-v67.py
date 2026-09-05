#!/usr/bin/env python3
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
RELEASE=67


def replace_once(path:Path,old:str,new:str,label:str)->None:
    text=path.read_text()
    if new in text:
        print(f"{label}: already applied")
        return
    count=text.count(old)
    if count!=1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count} in {path}")
    path.write_text(text.replace(old,new,1))
    print(f"{label}: applied")

# V66 fixed the prepared XEX memory-image layout. The next real Braid blocker
# proves import relocation is now the first missing Xenia loader stage:
#   *(0x8200080C) == 0x00010193
# where 0x193 is xboxkrnl!XexExecutableModuleHandle and record type 0 is a
# variable import. Xenia replaces this descriptor with the address of the
# exported variable before applying final PE protections. Render360 previously
# registered only function thunks, leaving variable descriptors live in title
# memory. Add a protected loader-relocation write primitive and install the
# executable-module variable/HMODULE state before title execution.

mapper_h=ROOT/'src/xenia_web_bootstrap/xex_guest_mapper.h'
replace_once(
    mapper_h,
    '''bool FinalizeXexGuestMapping();\nbool ReserveXexGuestInput(uint32_t required_capacity);\n''',
    '''bool FinalizeXexGuestMapping();\nbool PatchFinalizedXexGuestU32BE(uint32_t address, uint32_t value);\nbool ReserveXexGuestInput(uint32_t required_capacity);\n''',
    'V67 mapper relocation declaration',
)
replace_once(
    mapper_h,
    '''uint32_t r360_xex_guest_mapper_finalize();\nuint32_t r360_xex_guest_mapper_reserve_input(uint32_t required_capacity);\n''',
    '''uint32_t r360_xex_guest_mapper_finalize();\nuint32_t r360_xex_guest_mapper_patch_u32_be(uint32_t address, uint32_t value);\nuint32_t r360_xex_guest_mapper_reserve_input(uint32_t required_capacity);\n''',
    'V67 mapper relocation C ABI declaration',
)

mapper=ROOT/'src/xenia_web_bootstrap/xex_guest_mapper.cpp'
replace_once(
    mapper,
    '''uint32_t XexGuestMapperStatusValue() { return g_status; }\n''',
    '''bool PatchFinalizedXexGuestU32BE(uint32_t address, uint32_t value) {\n  // Xenia performs kernel import relocation after loading the image but before\n  // installing final section protection. Render360's PE loader finalizes the\n  // sparse mapping in one call, so expose one deliberately narrow relocation\n  // operation that temporarily widens exactly the containing page, writes one\n  // aligned big-endian import slot, then restores the original protection.\n  if (g_status != kXexMapperFinalized || (address & 3u) ||\n      uint64_t(address) + 4u > (uint64_t{1} << 32)) {\n    return Fail(kXexMapperInvalidArgument);\n  }\n\n  const XexMappedSection* owner = nullptr;\n  for (const auto& section : g_sections) {\n    const uint64_t begin = section.address;\n    const uint64_t end = begin + uint64_t(section.virtual_size);\n    if (uint64_t(address) >= begin && uint64_t(address) + 4u <= end) {\n      owner = &section;\n      break;\n    }\n  }\n  if (!owner) return Fail(kXexMapperInvalidArgument);\n\n  const uint32_t page = address & ~kPageMask;\n  const uint32_t original = owner->final_protection;\n  const bool widen = (original & kGuestWrite) == 0;\n  if (widen &&\n      !ProtectSparseGuestMemory(page, 1u, original | kGuestWrite)) {\n    return Fail(kXexMapperFinalizationFailed);\n  }\n\n  const uint8_t bytes[4] = {static_cast<uint8_t>(value >> 24),\n                            static_cast<uint8_t>(value >> 16),\n                            static_cast<uint8_t>(value >> 8),\n                            static_cast<uint8_t>(value)};\n  const bool wrote = WriteSparseGuestMemory(address, bytes, sizeof(bytes));\n  const bool restored =\n      !widen || ProtectSparseGuestMemory(page, 1u, original);\n  if (!wrote) return Fail(kXexMapperLoadFailed);\n  if (!restored) return Fail(kXexMapperFinalizationFailed);\n  g_status = kXexMapperFinalized;\n  return true;\n}\n\nuint32_t XexGuestMapperStatusValue() { return g_status; }\n''',
    'V67 protected finalized import relocation',
)
replace_once(
    mapper,
    '''uint32_t r360_xex_guest_mapper_finalize() {\n  return render360::xenia_web::FinalizeXexGuestMapping() ? 1u : 0u;\n}\nuint32_t r360_xex_guest_mapper_reserve_input(uint32_t required_capacity) {\n''',
    '''uint32_t r360_xex_guest_mapper_finalize() {\n  return render360::xenia_web::FinalizeXexGuestMapping() ? 1u : 0u;\n}\nuint32_t r360_xex_guest_mapper_patch_u32_be(uint32_t address, uint32_t value) {\n  return render360::xenia_web::PatchFinalizedXexGuestU32BE(address, value)\n             ? 1u\n             : 0u;\n}\nuint32_t r360_xex_guest_mapper_reserve_input(uint32_t required_capacity) {\n''',
    'V67 protected relocation export',
)

linker=ROOT/'link-xenia-ppc-bootstrap.sh'
replace_once(
    linker,
    '''  r360_xex_guest_mapper_reserve_input\n  r360_xex_guest_mapper_input_max_capacity\n''',
    '''  r360_xex_guest_mapper_reserve_input\n  r360_xex_guest_mapper_patch_u32_be\n  r360_xex_guest_mapper_input_max_capacity\n''',
    'V67 critical relocation export',
)

controller=ROOT/'render360-title-controller.mjs'
replace_once(
    controller,
    '''const XEX_HEADER_ENTRY_POINT=0x00010100;\n''',
    '''const XEX_HEADER_ENTRY_POINT=0x00010100;\nconst XENIA_KERNEL_DATA_BASE=0x50010000;\nconst XENIA_EXECUTABLE_MODULE_VAR=XENIA_KERNEL_DATA_BASE;\nconst XENIA_EXECUTABLE_HMODULE=XENIA_KERNEL_DATA_BASE+0x100;\nconst XENIA_XEX_HEADER_BASE=XENIA_KERNEL_DATA_BASE+0x1000;\nconst XENIA_BUILTIN_VARIABLE_EXPORTS={'xboxkrnl.exe:403':{kind:'kernel-variable',name:'XexExecutableModuleHandle'}};\n''',
    'V67 Xenia kernel variable constants',
)
replace_once(
    controller,
    '''function applyInitialGprs(bootstrap,initialGprs){\n''',
    '''function installKernelVariableImports(bootstrap,kernelImports,xex,{entry,headerSize}){\n  const supported=kernelImports.plan.filter(item=>item.isKernelModule&&item.kind==='variable'&&item.module.toLowerCase()==='xboxkrnl.exe'&&item.ordinal===0x193);\n  if(!supported.length)return {available:true,patched:0,supported:0};\n  const alloc=maybe(bootstrap,'r360_sparse_guest_memory_alloc');\n  const map=maybe(bootstrap,'r360_sparse_guest_memory_map');\n  const write8=maybe(bootstrap,'r360_sparse_guest_memory_write_u8');\n  const patch32=maybe(bootstrap,'r360_xex_guest_mapper_patch_u32_be');\n  if(!alloc||!map||!write8||!patch32)throw new Error('published browser bootstrap is missing Xenia kernel-variable relocation support; refresh to the synchronized runtime');\n\n  const pageSize=4096,readWrite=3;\n  const headerPages=Math.ceil(headerSize/pageSize);\n  const pages=1+headerPages;\n  const backing=alloc(pages)>>>0;\n  if(!backing||(map(XENIA_KERNEL_DATA_BASE,pages,backing,0,readWrite)>>>0)!==1)throw new Error('unable to map Xenia kernel variable/module state');\n\n  const put8=(address,value)=>{if((write8(address>>>0,value&0xff)>>>0)!==1)throw new Error(`unable to initialize Xenia kernel state @ 0x${(address>>>0).toString(16)}`)};\n  const put32=(address,value)=>{const v=Number(value)>>>0;for(let i=0;i<4;i++)put8(address+i,(v>>>(24-i*8))&0xff)};\n  for(let i=0;i<headerSize;i++)put8(XENIA_XEX_HEADER_BASE+i,xex[i]);\n\n  const securityOffset=be32(xex,0x10);\n  if(securityOffset>headerSize-8)throw new Error('XEX security header is outside copied guest header');\n  const imageSize=be32(xex,securityOffset+4);\n  // X_LDR_DATA_TABLE_ENTRY fields used by Xenia UserModule::LoadXexContinue.\n  put32(XENIA_EXECUTABLE_HMODULE+0x18,0);\n  put32(XENIA_EXECUTABLE_HMODULE+0x1c,kernelImports.imageBase);\n  put32(XENIA_EXECUTABLE_HMODULE+0x38,imageSize);\n  put32(XENIA_EXECUTABLE_HMODULE+0x3c,entry);\n  put32(XENIA_EXECUTABLE_HMODULE+0x58,XENIA_XEX_HEADER_BASE);\n  // xboxkrnl!XexExecutableModuleHandle is itself a pointer-sized exported\n  // variable whose value is the executable module's HMODULE.\n  put32(XENIA_EXECUTABLE_MODULE_VAR,XENIA_EXECUTABLE_HMODULE);\n\n  let patched=0;\n  for(const item of supported){\n    if((patch32(item.valueAddress>>>0,XENIA_EXECUTABLE_MODULE_VAR)>>>0)!==1){\n      const status=maybe(bootstrap,'r360_xex_guest_mapper_status')?.()>>>0||0;\n      throw new Error(`failed to relocate ${item.module}!XexExecutableModuleHandle at 0x${(item.valueAddress>>>0).toString(16)} (mapper 0x${status.toString(16)})`);\n    }\n    patched++;\n  }\n  return {available:true,patched,supported:supported.length,variableAddress:XENIA_EXECUTABLE_MODULE_VAR,hmoduleAddress:XENIA_EXECUTABLE_HMODULE,xexHeaderAddress:XENIA_XEX_HEADER_BASE,headerBytes:headerSize,imageBase:kernelImports.imageBase>>>0,imageSize,entry:entry>>>0};\n}\n\nfunction applyInitialGprs(bootstrap,initialGprs){\n''',
    'V67 kernel variable installer',
)
replace_once(
    controller,
    '''  const effectiveKernelExports=browserHle?{...browserHle.implementedKernelExports,...implementedKernelExports}:implementedKernelExports;\n  const kernelImports=buildKernelImportPlan(xex,prepared,{implementedExports:effectiveKernelExports});\n  const kernelRegistration=registerKernelImportPlan(bootstrap,kernelImports);\n''',
    '''  const effectiveKernelExports=browserHle?{...XENIA_BUILTIN_VARIABLE_EXPORTS,...browserHle.implementedKernelExports,...implementedKernelExports}:{...XENIA_BUILTIN_VARIABLE_EXPORTS,...implementedKernelExports};\n  const kernelImports=buildKernelImportPlan(xex,prepared,{implementedExports:effectiveKernelExports});\n  const kernelRegistration=registerKernelImportPlan(bootstrap,kernelImports);\n  const kernelVariableRegistration=installKernelVariableImports(bootstrap,kernelImports,xex,{entry,headerSize});\n''',
    'V67 automatic variable import relocation',
)
replace_once(
    controller,
    '''kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelCalls,kernelLastStatus''',
    '''kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelVariableRegistration,kernelCalls,kernelLastStatus''',
    'V67 variable relocation telemetry',
)

(ROOT/'VERSION').write_text(f'{RELEASE}\n')
runtime=ROOT/'runtime/render360-runtime.js'
replace_once(runtime,'const RENDER360_RELEASE=66;','const RENDER360_RELEASE=67;','V67 runtime release')
replace_once(runtime,'const CONTENT_BRIDGE={release:66,','const CONTENT_BRIDGE={release:67,','V67 content bridge release')

index=ROOT/'index.html'
text=index.read_text().replace('Render360 66','Render360 67')
old='<span>UI Release</span><span class="value">66</span>'
new='<span>UI Release</span><span class="value">67</span>'
if new not in text:
    if old not in text: raise SystemExit('V67 UI Release anchor missing')
    text=text.replace(old,new,1)
index.write_text(text)

sw=ROOT/'render360-sw.js'
text=sw.read_text();text,count=re.subn(r"const VERSION='\d+';","const VERSION='67';",text,count=1)
if count!=1: raise SystemExit('V67 service worker version anchor missing')
sw.write_text(text)

print('R360_V67_KERNEL_VARIABLE_IMPORT_PATCH=PASS')
