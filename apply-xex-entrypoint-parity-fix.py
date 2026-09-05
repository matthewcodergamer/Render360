#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f'{label}: anchor changed in {path}')
    path.write_text(text.replace(old, new, 1))


# 1) PE guest loader: preserve the PE/COFF entry for diagnostics but allow the
# caller to select the XEX optional-header entry point before mapper finalization.
header = ROOT / 'src/xenia_web_bootstrap/xex_pe_guest_loader.h'
replace_once(
    header,
    '''void ResetPreparedPeGuestLoad();\nbool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length);\nuint32_t PreparedPeGuestLoadStatus();\nuint32_t PreparedPeGuestEntryAddress();\nuint32_t PreparedPeGuestSectionCount();\n''',
    '''void ResetPreparedPeGuestLoad();\nbool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length);\nbool LoadPreparedPeImageToGuestAtEntry(const uint8_t* image, uint32_t length,\n                                       uint32_t entry_address);\nuint32_t PreparedPeGuestLoadStatus();\nuint32_t PreparedPeGuestEntryAddress();\nuint32_t PreparedPeGuestPeEntryAddress();\nuint32_t PreparedPeGuestSectionCount();\n''',
    'PE loader C++ API',
)
replace_once(
    header,
    '''uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length);\nuint32_t r360_pe_guest_status();\nuint32_t r360_pe_guest_entry_address();\nuint32_t r360_pe_guest_section_count();\n''',
    '''uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length);\nuint32_t r360_pe_guest_load_at_entry(uint32_t source_ptr, uint32_t length,\n                                      uint32_t entry_address);\nuint32_t r360_pe_guest_status();\nuint32_t r360_pe_guest_entry_address();\nuint32_t r360_pe_guest_pe_entry_address();\nuint32_t r360_pe_guest_section_count();\n''',
    'PE loader C ABI',
)

cpp = ROOT / 'src/xenia_web_bootstrap/xex_pe_guest_loader.cpp'
replace_once(
    cpp,
    '''uint32_t g_status = kPeGuestIdle;\nuint32_t g_entry = 0;\nuint32_t g_sections = 0;\n''',
    '''uint32_t g_status = kPeGuestIdle;\nuint32_t g_entry = 0;\nuint32_t g_pe_entry = 0;\nuint32_t g_sections = 0;\n''',
    'PE loader telemetry globals',
)
replace_once(
    cpp,
    '''  g_status = kPeGuestIdle;\n  g_entry = 0;\n  g_sections = 0;\n''',
    '''  g_status = kPeGuestIdle;\n  g_entry = 0;\n  g_pe_entry = 0;\n  g_sections = 0;\n''',
    'PE loader reset telemetry',
)
replace_once(
    cpp,
    '''bool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length) {\n''',
    '''bool LoadPreparedPeImageToGuestAtEntry(const uint8_t* image, uint32_t length,\n                                       uint32_t entry_override) {\n''',
    'PE loader entry-aware implementation',
)
replace_once(
    cpp,
    '''  uint32_t entry = 0;\n  if (!Add32(metadata.image_base, metadata.entry_rva, &entry)) {\n    return Fail(kPeGuestAddressOverflow);\n  }\n  if (!SetXexGuestEntry(entry)) return Fail(kPeGuestEntryFailed);\n  if (!FinalizeXexGuestMapping()) return Fail(kPeGuestFinalizeFailed);\n\n  g_entry = entry;\n  g_status = kPeGuestPass;\n  return true;\n}\n\nuint32_t PreparedPeGuestLoadStatus() { return g_status; }\nuint32_t PreparedPeGuestEntryAddress() { return g_entry; }\n''',
    '''  uint32_t pe_entry = 0;\n  if (!Add32(metadata.image_base, metadata.entry_rva, &pe_entry)) {\n    return Fail(kPeGuestAddressOverflow);\n  }\n  g_pe_entry = pe_entry;\n  const uint32_t entry = entry_override ? entry_override : pe_entry;\n  if (!SetXexGuestEntry(entry)) return Fail(kPeGuestEntryFailed);\n  if (!FinalizeXexGuestMapping()) return Fail(kPeGuestFinalizeFailed);\n\n  g_entry = entry;\n  g_status = kPeGuestPass;\n  return true;\n}\n\nbool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length) {\n  return LoadPreparedPeImageToGuestAtEntry(image, length, 0);\n}\n\nuint32_t PreparedPeGuestLoadStatus() { return g_status; }\nuint32_t PreparedPeGuestEntryAddress() { return g_entry; }\nuint32_t PreparedPeGuestPeEntryAddress() { return g_pe_entry; }\n''',
    'PE loader entry selection',
)
replace_once(
    cpp,
    '''uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length) {\n  const auto* source =\n      reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(source_ptr));\n  return render360::xenia_web::LoadPreparedPeImageToGuest(source, length) ? 1u\n                                                                         : 0u;\n}\nuint32_t r360_pe_guest_status() {\n''',
    '''uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length) {\n  const auto* source =\n      reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(source_ptr));\n  return render360::xenia_web::LoadPreparedPeImageToGuest(source, length) ? 1u\n                                                                         : 0u;\n}\nuint32_t r360_pe_guest_load_at_entry(uint32_t source_ptr, uint32_t length,\n                                      uint32_t entry_address) {\n  const auto* source =\n      reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(source_ptr));\n  return render360::xenia_web::LoadPreparedPeImageToGuestAtEntry(\n             source, length, entry_address)\n             ? 1u\n             : 0u;\n}\nuint32_t r360_pe_guest_status() {\n''',
    'PE loader entry-aware export',
)
replace_once(
    cpp,
    '''uint32_t r360_pe_guest_entry_address() {\n  return render360::xenia_web::PreparedPeGuestEntryAddress();\n}\nuint32_t r360_pe_guest_section_count() {\n''',
    '''uint32_t r360_pe_guest_entry_address() {\n  return render360::xenia_web::PreparedPeGuestEntryAddress();\n}\nuint32_t r360_pe_guest_pe_entry_address() {\n  return render360::xenia_web::PreparedPeGuestPeEntryAddress();\n}\nuint32_t r360_pe_guest_section_count() {\n''',
    'PE loader PE-entry telemetry export',
)

# 2) Browser title controller: desktop Xenia launches UserModule::entry_point(),
# which comes from XEX_HEADER_ENTRY_POINT, not PE AddressOfEntryPoint. Render360
# was selecting the PE/COFF entry and could therefore enter a shared epilogue in
# the middle of Braid startup, exactly matching the +0x100 stack teardown trace.
controller = ROOT / 'render360-title-controller.mjs'
replace_once(
    controller,
    '''const moduleId=name=>name.toLowerCase()==='xboxkrnl.exe'?1:name.toLowerCase()==='xam.xex'?2:0;\n\nfunction hasNativeTitleGpuRuntime(bootstrap){\n''',
    '''const moduleId=name=>name.toLowerCase()==='xboxkrnl.exe'?1:name.toLowerCase()==='xam.xex'?2:0;\nconst XEX_HEADER_ENTRY_POINT=0x00010100;\n\nfunction readXexEntryPoint(xex,headerSize){\n  const count=be32(xex,0x14);\n  if(headerSize<0x18||count>((headerSize-0x18)>>>3))throw new Error('XEX optional-header table out of bounds');\n  for(let i=0,p=0x18;i<count;i++,p+=8){\n    if(be32(xex,p)!==XEX_HEADER_ENTRY_POINT)continue;\n    const entry=be32(xex,p+4);\n    if(!entry)throw new Error('XEX entry point is zero');\n    return entry>>>0;\n  }\n  throw new Error('XEX entry point optional header missing');\n}\n\nfunction hasNativeTitleGpuRuntime(bootstrap){\n''',
    'controller XEX entry reader',
)
replace_once(
    controller,
    '''function stagePreparedPeImage(bootstrap,prepared){\n''',
    '''function stagePreparedPeImage(bootstrap,prepared,xexEntry){\n''',
    'controller stage signature',
)
replace_once(
    controller,
    '''  new Uint8Array(bootstrap.exports.memory.buffer,input,prepared.length).set(prepared);\n  if((pick(bootstrap,'r360_pe_guest_load')(input,prepared.length)>>>0)!==1)throw new Error(`prepared PE guest load failed 0x${(pick(bootstrap,'r360_pe_guest_status')()>>>0).toString(16)}`);\n  return {input,capacity:cap,stagingGrew};\n''',
    '''  new Uint8Array(bootstrap.exports.memory.buffer,input,prepared.length).set(prepared);\n  if((pick(bootstrap,'r360_pe_guest_load_at_entry')(input,prepared.length,xexEntry>>>0)>>>0)!==1)throw new Error(`prepared PE guest load failed 0x${(pick(bootstrap,'r360_pe_guest_status')()>>>0).toString(16)}`);\n  return {input,capacity:cap,stagingGrew};\n''',
    'controller entry-aware PE load',
)
replace_once(
    controller,
    '''  const headerSize=be32(xex,8);\n  if(headerSize<0x18||headerSize>xex.length)throw new Error('default.xex header size out of bounds');\n  const importedLibraries=decodeXexImportLibraries(xex);\n''',
    '''  const headerSize=be32(xex,8);\n  if(headerSize<0x18||headerSize>xex.length)throw new Error('default.xex header size out of bounds');\n  const xexEntry=readXexEntryPoint(xex,headerSize);\n  const importedLibraries=decodeXexImportLibraries(xex);\n''',
    'controller XEX entry capture',
)
replace_once(
    controller,
    '''  for(const n of ['r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_status','r360_pe_guest_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_title_handoff_hir_instructions'])if(typeof pick(bootstrap,n)!=='function')throw new Error(`missing title-controller export ${n}`);\n  const peStage=stagePreparedPeImage(bootstrap,prepared);\n  const entry=pick(bootstrap,'r360_pe_guest_entry_address')()>>>0;\n''',
    '''  for(const n of ['r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_load_at_entry','r360_pe_guest_status','r360_pe_guest_entry_address','r360_pe_guest_pe_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_title_handoff_hir_instructions'])if(typeof pick(bootstrap,n)!=='function')throw new Error(`missing title-controller export ${n}`);\n  const peStage=stagePreparedPeImage(bootstrap,prepared,xexEntry);\n  const entry=pick(bootstrap,'r360_pe_guest_entry_address')()>>>0;\n  const peEntry=pick(bootstrap,'r360_pe_guest_pe_entry_address')()>>>0;\n  if(entry!==xexEntry)throw new Error(`XEX entry selection mismatch 0x${entry.toString(16)}/0x${xexEntry.toString(16)}`);\n  if(peEntry!==entry)console.info(`[Render360] Xenia entry parity: XEX optional entry 0x${entry.toString(16).toUpperCase()} overrides PE entry 0x${peEntry.toString(16).toUpperCase()}`);\n''',
    'controller XEX-vs-PE entry selection',
)
replace_once(
    controller,
    '''  return {headerSize,preparedBytes:prepared.length,peStagingCapacity:peStage.capacity,peStagingGrew:peStage.stagingGrew,entry,hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0,entryExecutionMode,startupGprCount,mainThreadContext,executionStatus,executionInstructions,executionR3Hex,executionBlockerKind,executionBlockerOpcode,executionBlockerAddress,memoryFaultAddress,memoryFaultCode,stackTrace,translatedFunctionCount,firstTranslatedFunction,runtimeBoundary,importedLibraries,kernelImports,kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelCalls,kernelLastStatus,reachedKernelBlocker,firstKernelBlocker,titleGpuTelemetry,browserHle:browserHleSummary,browserHleTelemetry};\n''',
    '''  return {headerSize,preparedBytes:prepared.length,peStagingCapacity:peStage.capacity,peStagingGrew:peStage.stagingGrew,entry,xexEntry,peEntry,entrySource:'xex-optional-header',hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0,entryExecutionMode,startupGprCount,mainThreadContext,executionStatus,executionInstructions,executionR3Hex,executionBlockerKind,executionBlockerOpcode,executionBlockerAddress,memoryFaultAddress,memoryFaultCode,stackTrace,translatedFunctionCount,firstTranslatedFunction,runtimeBoundary,importedLibraries,kernelImports,kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelCalls,kernelLastStatus,reachedKernelBlocker,firstKernelBlocker,titleGpuTelemetry,browserHle:browserHleSummary,browserHleTelemetry};\n''',
    'controller entry telemetry return',
)

# 3) Stale runtime gate: the page must not silently run a bootstrap that lacks
# the entry-aware loader after the JS starts requiring Xenia entry parity.
runtime = ROOT / 'render360-browser-title-runtime.mjs'
replace_once(
    runtime,
    '''  'r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_xex_guest_mapper_reserve_input','r360_xex_guest_mapper_input_max_capacity',\n  'r360_pe_guest_load','r360_pe_guest_entry_address','r360_title_handoff_translate_entry','r360_title_handoff_translate_scanned_entry',\n''',
    '''  'r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_xex_guest_mapper_reserve_input','r360_xex_guest_mapper_input_max_capacity',\n  'r360_pe_guest_load','r360_pe_guest_load_at_entry','r360_pe_guest_entry_address','r360_pe_guest_pe_entry_address','r360_title_handoff_translate_entry','r360_title_handoff_translate_scanned_entry',\n''',
    'browser bootstrap entry-aware export gate',
)

# 4) Extend the existing fastlane mapper test with a real minimal Xbox PE. The
# PE says entry 0x82001000 while the XEX override selects 0x82001020. The final
# mapper must use the XEX entry and still expose the PE entry for diagnostics.
test = ROOT / 'test-xex-guest-mapper.mjs'
replace_once(
    test,
    '''  'r360_xex_guest_mapper_input_max_capacity','r360_sparse_guest_memory_read_u8',\n''',
    '''  'r360_xex_guest_mapper_input_max_capacity','r360_pe_guest_load_at_entry',\n  'r360_pe_guest_status','r360_pe_guest_entry_address','r360_pe_guest_pe_entry_address',\n  'r360_sparse_guest_memory_read_u8',\n''',
    'mapper test required entry-aware exports',
)
replace_once(
    test,
    '''console.log(`XEX_PE_STAGING_GROWTH=PASS initial=${initialCapacity} grown=${capacity} memory=${initialMemoryBytes}->${instance.exports.memory.buffer.byteLength}`);\n\n// Realistic Xbox 360 user image addresses: separate RX, R, and RW regions.\n''',
    '''console.log(`XEX_PE_STAGING_GROWTH=PASS initial=${initialCapacity} grown=${capacity} memory=${initialMemoryBytes}->${instance.exports.memory.buffer.byteLength}`);\n\n// Xenia UserModule launches XEX_HEADER_ENTRY_POINT, not PE AddressOfEntryPoint.\n// Build a minimal valid Xbox PE whose COFF entry is 0x82001000, then select\n// 0x82001020 as the XEX entry before mapper finalization.\nconst makeXboxPe=()=>{\n  const b=Buffer.alloc(0x400);\n  const w16=(o,v)=>b.writeUInt16LE(v>>>0,o);\n  const w32=(o,v)=>b.writeUInt32LE(v>>>0,o);\n  w16(0,0x5A4D); w32(0x3C,0x80); w32(0x80,0x00004550);\n  const file=0x84; w16(file+0,0x01F2); w16(file+2,1); w16(file+16,224); w16(file+18,0x0100);\n  const opt=0x98; w16(opt+0,0x010B); w32(opt+16,0x1000); w32(opt+28,0x82000000);\n  w32(opt+32,0x1000); w32(opt+36,0x200); w32(opt+56,0x2000); w32(opt+60,0x200); w16(opt+68,14);\n  const sh=opt+224; b.write('.text',sh,'ascii'); w32(sh+8,0x1000); w32(sh+12,0x1000);\n  w32(sh+16,0x200); w32(sh+20,0x200); w32(sh+36,0x60000020);\n  b.writeUInt32BE(0x4E800020,0x200);\n  return b;\n};\nconst entryPe=makeXboxPe();\ninput=pick('r360_xex_guest_mapper_input_buffer')()>>>0;\nnew Uint8Array(instance.exports.memory.buffer,input,entryPe.length).set(entryPe);\nok(pick('r360_pe_guest_load_at_entry')(input,entryPe.length,0x82001020),'PE load with XEX entry override');\neq(pick('r360_pe_guest_pe_entry_address')(),0x82001000,'PE/COFF entry telemetry');\neq(pick('r360_pe_guest_entry_address')(),0x82001020,'XEX entry selection');\neq(pick('r360_pe_guest_status')(),1,'entry-aware PE load status');\nconsole.log('XEX_OPTIONAL_ENTRY_OVERRIDES_PE_ENTRY=PASS');\n\n// Realistic Xbox 360 user image addresses: separate RX, R, and RW regions.\n''',
    'mapper entrypoint parity test',
)

# 5) Make future controller-only entrypoint changes enter the same verification
# lane even when no C++ source changed.
workflow = ROOT / '.github/workflows/xenia-browser-bootstrap-fastlane.yml'
replace_once(
    workflow,
    '''      - 'render360-browser-title-runtime.mjs'\n      - 'test-wasm-backend-cfg.mjs'\n''',
    '''      - 'render360-browser-title-runtime.mjs'\n      - 'render360-title-controller.mjs'\n      - 'test-wasm-backend-cfg.mjs'\n''',
    'fastlane title-controller trigger',
)

print('XEX_ENTRYPOINT_PARITY_FIX=PASS')
