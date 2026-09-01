#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor changed in {path}: {old[:100]!r}")
    if text.count(old) != 1:
        raise SystemExit(f"anchor is not unique in {path}: {text.count(old)} matches")
    p.write_text(text.replace(old, new, 1))


def require(path, needle):
    text = (ROOT / path).read_text()
    if needle not in text:
        raise SystemExit(f"expected marker missing from {path}: {needle}")


# Make the 32-bit PPC effective-address rule authoritative in source, not only
# in a later generated overlay. D-form/X-form guest addresses are modulo 2^32.
replace_once('src/xenia_web_bootstrap/hir_correctness_executor.cpp',
"""  const uint64_t effective = base + displacement;\n  if (effective > std::numeric_limits<uint32_t>::max()) return false;\n  *guest_address = static_cast<uint32_t>(effective);\n  return true;\n""",
"""  const uint32_t effective = static_cast<uint32_t>(base) +\n                             static_cast<uint32_t>(displacement);\n  *guest_address = effective;\n  return true;\n""")

# Pinned Xenia opcode truth: CALL_INDIRECT is 9; opcode 37 is LOAD_OFFSET.
# The native executor already handles CALL_INDIRECT. Treat a failure at 37 as
# guest-memory / generated-WASM coverage, rather than adding a duplicate call case.
replace_once('src/xenia_web_bootstrap/hir_correctness_executor.h',
'''  kHIRBlockerNoReturnBoundary = 4,\n};''',
'''  kHIRBlockerNoReturnBoundary = 4,\n  kHIRBlockerGuestMemory = 5,\n};''')
replace_once('src/xenia_web_bootstrap/hir_correctness_executor.cpp',
'''        result.blocker_kind = call_boundary ? kHIRBlockerUnresolvedCall\n                                            : kHIRBlockerUnsupportedOpcode;\n        result.blocker_opcode = opcode;''',
'''        const bool memory_boundary =\n            opcode == xe::cpu::hir::OPCODE_LOAD ||\n            opcode == xe::cpu::hir::OPCODE_LOAD_OFFSET ||\n            opcode == xe::cpu::hir::OPCODE_STORE ||\n            opcode == xe::cpu::hir::OPCODE_STORE_OFFSET;\n        result.blocker_kind = call_boundary\n                                  ? kHIRBlockerUnresolvedCall\n                                  : memory_boundary ? kHIRBlockerGuestMemory\n                                                    : kHIRBlockerUnsupportedOpcode;\n        result.blocker_opcode = opcode;''')

# Narrow fail-closed scalar load bridge from generated child Wasm to the
# authoritative sparse Xbox virtual address space.
replace_once('src/xenia_web_bootstrap/sparse_guest_memory.h',
'''uint32_t r360_sparse_guest_memory_last_fault_code();\n}''',
'''uint32_t r360_sparse_guest_memory_last_fault_code();\nuint64_t r360_generated_guest_load_scalar(uint32_t virtual_address,\n                                           uint32_t size, uint32_t flags);\nuint32_t r360_generated_guest_load_status();\n}''')
replace_once('src/xenia_web_bootstrap/sparse_guest_memory.cpp',
'''}  // namespace render360::xenia_web\n\nextern "C" {''',
'''}  // namespace render360::xenia_web\n\nnamespace {\nuint32_t g_generated_guest_load_status = 0;\n\nuint64_t GeneratedGuestLoadScalar(uint32_t virtual_address, uint32_t size,\n                                  uint32_t flags) {\n  g_generated_guest_load_status = 0;\n  if ((flags & ~1u) != 0 ||\n      (size != 1u && size != 2u && size != 4u && size != 8u)) {\n    return 0;\n  }\n  uint64_t value = 0;\n  if (!render360::xenia_web::ReadSparseGuestMemory(virtual_address, &value,\n                                                    size)) {\n    return 0;\n  }\n  if ((flags & 1u) && size > 1u) {\n    uint64_t swapped = 0;\n    for (uint32_t i = 0; i < size; ++i) {\n      swapped |= ((value >> (i * 8u)) & 0xFFu)\n                 << ((size - 1u - i) * 8u);\n    }\n    value = swapped;\n  }\n  g_generated_guest_load_status = 1;\n  return value;\n}\n}  // namespace\n\nextern "C" {''')
replace_once('src/xenia_web_bootstrap/sparse_guest_memory.cpp',
'''uint32_t r360_sparse_guest_memory_last_fault_code() {\n  return render360::xenia_web::SparseGuestLastFaultCode();\n}\nuint32_t r360_wasm_backend_executable_content_generation(uint32_t address) {''',
'''uint32_t r360_sparse_guest_memory_last_fault_code() {\n  return render360::xenia_web::SparseGuestLastFaultCode();\n}\nuint64_t r360_generated_guest_load_scalar(uint32_t virtual_address,\n                                           uint32_t size, uint32_t flags) {\n  return GeneratedGuestLoadScalar(virtual_address, size, flags);\n}\nuint32_t r360_generated_guest_load_status() {\n  return g_generated_guest_load_status;\n}\nuint32_t r360_wasm_backend_executable_content_generation(uint32_t address) {''')

# Production callable emitter: CALL_INDIRECT already exists; add the missing
# integer LOAD / LOAD_OFFSET producer path used to compute its runtime target.
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''using xe::cpu::hir::Instr;\nusing xe::cpu::hir::Value;''',
'''using xe::cpu::hir::Instr;\nusing xe::cpu::hir::TypeName;\nusing xe::cpu::hir::Value;''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''void EmitName(std::vector<uint8_t>& out, const char* name) {''',
'''void EmitI64Mask(std::vector<uint8_t>& out, TypeName type) {\n  uint64_t mask = 0;\n  switch (type) {\n    case xe::cpu::hir::INT8_TYPE: mask = 0xFFu; break;\n    case xe::cpu::hir::INT16_TYPE: mask = 0xFFFFu; break;\n    case xe::cpu::hir::INT32_TYPE: mask = 0xFFFFFFFFu; break;\n    case xe::cpu::hir::INT64_TYPE: return;\n    default: return;\n  }\n  out.push_back(0x42);\n  EmitI64Leb(out, static_cast<int64_t>(mask));\n  out.push_back(0x83);\n}\n\nuint32_t ScalarTypeSize(TypeName type) {\n  switch (type) {\n    case xe::cpu::hir::INT8_TYPE: return 1u;\n    case xe::cpu::hir::INT16_TYPE: return 2u;\n    case xe::cpu::hir::INT32_TYPE: return 4u;\n    case xe::cpu::hir::INT64_TYPE: return 8u;\n    default: return 0u;\n  }\n}\n\nvoid EmitName(std::vector<uint8_t>& out, const char* name) {''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:\n      if (value->type != xe::cpu::hir::INT64_TYPE) break;\n      body.push_back(0x20);\n      body.push_back(0x00);\n      body.push_back(0x29);\n      body.push_back(0x03);\n      EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));\n      ok = true;\n      break;\n    case xe::cpu::hir::OPCODE_ASSIGN:\n      ok = EmitI64Value(instr->src1.value, producers, visiting, body, lowered);\n      break;''',
'''    case xe::cpu::hir::OPCODE_LOAD_CONTEXT: {\n      body.push_back(0x20);\n      body.push_back(0x00);\n      switch (value->type) {\n        case xe::cpu::hir::INT8_TYPE:\n          body.push_back(0x2D); body.push_back(0x00);\n          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));\n          body.push_back(0xAD);\n          break;\n        case xe::cpu::hir::INT16_TYPE:\n          body.push_back(0x2F); body.push_back(0x01);\n          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));\n          body.push_back(0xAD);\n          break;\n        case xe::cpu::hir::INT32_TYPE:\n          body.push_back(0x28); body.push_back(0x02);\n          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));\n          body.push_back(0xAD);\n          break;\n        case xe::cpu::hir::INT64_TYPE:\n          body.push_back(0x29); body.push_back(0x03);\n          EmitU32Leb(body, static_cast<uint32_t>(instr->src1.offset));\n          break;\n        default:\n          break;\n      }\n      ok = ScalarTypeSize(value->type) != 0;\n      break;\n    }\n    case xe::cpu::hir::OPCODE_ASSIGN:\n    case xe::cpu::hir::OPCODE_CAST:\n    case xe::cpu::hir::OPCODE_ZERO_EXTEND:\n    case xe::cpu::hir::OPCODE_TRUNCATE:\n      ok = EmitI64Value(instr->src1.value, producers, visiting, body, lowered);\n      if (ok) EmitI64Mask(body, value->type);\n      break;\n    case xe::cpu::hir::OPCODE_SIGN_EXTEND:\n      ok = EmitI64Value(instr->src1.value, producers, visiting, body, lowered);\n      if (ok) {\n        switch (instr->src1.value->type) {\n          case xe::cpu::hir::INT8_TYPE: body.push_back(0xC2); break;\n          case xe::cpu::hir::INT16_TYPE: body.push_back(0xC3); break;\n          case xe::cpu::hir::INT32_TYPE: body.push_back(0xC4); break;\n          case xe::cpu::hir::INT64_TYPE: break;\n          default: ok = false; break;\n        }\n      }\n      break;\n    case xe::cpu::hir::OPCODE_LOAD:\n    case xe::cpu::hir::OPCODE_LOAD_OFFSET: {\n      const uint32_t size = ScalarTypeSize(value->type);\n      if (!size || (instr->flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP)) break;\n      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered))\n        break;\n      if (instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET) {\n        if (!EmitI64Value(instr->src2.value, producers, visiting, body, lowered))\n          break;\n        body.push_back(0x7C);\n      }\n      body.push_back(0xA7);\n      body.push_back(0x41); EmitI32Leb(body, static_cast<int32_t>(size));\n      body.push_back(0x41); EmitI32Leb(body, static_cast<int32_t>(instr->flags));\n      body.push_back(0x10); EmitU32Leb(body, 1);\n      EmitI64Mask(body, value->type);\n      ok = true;\n      break;\n    }''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''      if (value->type != xe::cpu::hir::INT64_TYPE) break;\n      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered) ||\n          !EmitI64Value(instr->src2.value, producers, visiting, body, lowered)) {''',
'''      if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered) ||\n          !EmitI64Value(instr->src2.value, producers, visiting, body, lowered)) {''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''      ok = true;\n      break;\n    default:\n      break;\n  }\n  if (ok && lowered) ++*lowered;''',
'''      ok = true;\n      if (ok) EmitI64Mask(body, value->type);\n      break;\n    default:\n      break;\n  }\n  if (ok && lowered) ++*lowered;''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''              (instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_CONTEXT ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ASSIGN ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ADD ||''',
'''              (instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_CONTEXT ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ASSIGN ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_CAST ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ZERO_EXTEND ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_SIGN_EXTEND ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_TRUNCATE ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ADD ||''')

# Child Wasm ABI: guest_call remains function import 0; guest_load is function
# import 1; therefore the module's own run function moves to function index 2.
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''  std::vector<uint8_t> types;\n  EmitU32Leb(types, 2);\n  types.push_back(0x60);''',
'''  std::vector<uint8_t> types;\n  EmitU32Leb(types, 3);\n  types.push_back(0x60);''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''  EmitU32Leb(types, 1);\n  types.push_back(0x7E);\n  EmitSection(module, 1, types);''',
'''  EmitU32Leb(types, 1);\n  types.push_back(0x7E);\n  types.push_back(0x60);\n  EmitU32Leb(types, 3);\n  types.push_back(0x7F); types.push_back(0x7F); types.push_back(0x7F);\n  EmitU32Leb(types, 1);\n  types.push_back(0x7E);\n  EmitSection(module, 1, types);''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''  EmitU32Leb(imports, 2);\n  EmitName(imports, "env");\n  EmitName(imports, "guest_call");\n  imports.push_back(0x00);\n  EmitU32Leb(imports, 0);\n  EmitName(imports, "env");\n  EmitName(imports, "memory");''',
'''  EmitU32Leb(imports, 3);\n  EmitName(imports, "env");\n  EmitName(imports, "guest_call");\n  imports.push_back(0x00);\n  EmitU32Leb(imports, 0);\n  EmitName(imports, "env");\n  EmitName(imports, "guest_load");\n  imports.push_back(0x00);\n  EmitU32Leb(imports, 2);\n  EmitName(imports, "env");\n  EmitName(imports, "memory");''')
replace_once('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp',
'''  EmitName(exports, "run");\n  exports.push_back(0x00);\n  EmitU32Leb(exports, 1);''',
'''  EmitName(exports, "run");\n  exports.push_back(0x00);\n  EmitU32Leb(exports, 2);''')

# Browser host for generated scalar loads.
replace_once('render360-browser-ppc-session.mjs',
'''  const kernelLastOrdinal=pick(bootstrap,'r360_kernel_import_last_ordinal');''',
'''  const kernelLastOrdinal=pick(bootstrap,'r360_kernel_import_last_ordinal');\n  const generatedGuestLoad=requiredFunction(bootstrap,'r360_generated_guest_load_scalar');\n  const generatedGuestLoadStatus=requiredFunction(bootstrap,'r360_generated_guest_load_status');\n  const sparseFaultAddress=pick(bootstrap,'r360_sparse_guest_memory_last_fault_address');\n  const sparseFaultCode=pick(bootstrap,'r360_sparse_guest_memory_last_fault_code');''')
replace_once('render360-browser-ppc-session.mjs',
'''    for(const record of next.values()){\n      record.instance=await WebAssembly.instantiate(record.module,{env:{memory,guest_call}});''',
'''    const guest_load=(address,size,flags)=>{\n      address>>>=0;size>>>=0;flags>>>=0;\n      const value=generatedGuestLoad(address,size,flags);\n      const status=generatedGuestLoadStatus()>>>0;\n      if(status!==1){\n        const faultAddress=typeof sparseFaultAddress==='function'?sparseFaultAddress()>>>0:address;\n        const faultCode=typeof sparseFaultCode==='function'?sparseFaultCode()>>>0:0;\n        throw new Error(`FAIL_CLOSED_GUEST_LOAD_0x${address.toString(16).toUpperCase()}_SIZE_${size}_FLAGS_${flags}_FAULT_${faultCode}_AT_0x${faultAddress.toString(16).toUpperCase()}`);\n      }\n      return BigInt.asUintN(64,value);\n    };\n    for(const record of next.values()){\n      record.instance=await WebAssembly.instantiate(record.module,{env:{memory,guest_call,guest_load}});''')
replace_once('render360-browser-title-runtime.mjs',
'''  'r360_kernel_import_register','r360_kernel_service_call','r360_kernel_runtime_reset',''',
'''  'r360_kernel_import_register','r360_kernel_service_call','r360_kernel_runtime_reset',\n  'r360_generated_guest_load_scalar','r360_generated_guest_load_status',\n  'r360_sparse_guest_memory_last_fault_address','r360_sparse_guest_memory_last_fault_code',''')
replace_once('render360-title-controller.mjs',
'''executionStatus===1?(executionBlockerKind===2?'unresolved-guest-call':executionBlockerKind===3?'instruction-limit':'unsupported-hir-or-runtime-dependency'):'execution-not-observed';''',
'''executionStatus===1?(executionBlockerKind===2?'unresolved-guest-call':executionBlockerKind===3?'instruction-limit':executionBlockerKind===5?'guest-memory-dependency':'unsupported-hir'):'execution-not-observed';''')

# Existing call critic now also verifies the exact Braid memory->CTR->XAM path.
replace_once('test-wasm-backend-calls.mjs',
'''  'r360_kernel_import_last_ordinal',\n];''',
'''  'r360_kernel_import_last_ordinal',\n  'r360_generated_guest_load_scalar','r360_generated_guest_load_status',\n  'r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc',\n  'r360_sparse_guest_memory_map','r360_sparse_guest_memory_write_u32_be',\n  'r360_sparse_guest_memory_last_fault_address','r360_sparse_guest_memory_last_fault_code',\n];''')
replace_once('test-wasm-backend-calls.mjs',
'''        !declared.some((x)=>x.module==='env'&&x.name==='guest_call'&&x.kind==='function')) {''',
'''        !declared.some((x)=>x.module==='env'&&x.name==='guest_call'&&x.kind==='function') ||\n        !declared.some((x)=>x.module==='env'&&x.name==='guest_load'&&x.kind==='function')) {''')
replace_once('test-wasm-backend-calls.mjs',
'''  for (const record of records) {\n    record.instance = await WebAssembly.instantiate(record.mod, { env: { memory: parent.exports.memory, guest_call } });\n  }''',
'''  const guest_load = (address,size,flags) => {\n    const value = pick('r360_generated_guest_load_scalar')(address>>>0,size>>>0,flags>>>0);\n    const status = pick('r360_generated_guest_load_status')()>>>0;\n    if (status !== 1) {\n      const fault = pick('r360_sparse_guest_memory_last_fault_code')()>>>0;\n      const faultAddress = pick('r360_sparse_guest_memory_last_fault_address')()>>>0;\n      throw new Error(`FAIL_CLOSED_TEST_GUEST_LOAD_${fault}_0x${faultAddress.toString(16)}`);\n    }\n    return BigInt.asUintN(64,value);\n  };\n  for (const record of records) {\n    record.instance = await WebAssembly.instantiate(record.mod, { env: { memory: parent.exports.memory, guest_call, guest_load } });\n  }''')
replace_once('test-wasm-backend-calls.mjs',
'''console.log('WASM_BACKEND_CALL_DIRECT=PASS');''',
'''// Braid regression: HIR opcode 37 is LOAD_OFFSET. Fetch an XAM thunk from\n// sparse guest memory, mtctr it, bctrl, and require generated-WASM continuation.\npick('r360_ppc_probe_reset')();\npick('r360_kernel_import_reset')();\npick('r360_sparse_guest_memory_reset')();\nconst braidDataBase = 0x30000000;\nconst braidBacking = pick('r360_sparse_guest_memory_alloc')(2)>>>0;\nif (!braidBacking || (pick('r360_sparse_guest_memory_map')(braidDataBase,2,braidBacking,0,3)>>>0)!==1) throw new Error('Could not map Braid LOAD_OFFSET data pages');\nconst braidXamThunk = (guestBase + 0x00200000)>>>0;\nif ((pick('r360_kernel_import_register')(braidXamThunk,2,0x028B,0,0)>>>0)!==1) throw new Error('Could not register Braid XNotifyGetNext thunk');\nif ((pick('r360_sparse_guest_memory_write_u32_be')(braidDataBase+4,braidXamThunk)>>>0)!==1) throw new Error('Could not seed Braid XAM thunk pointer');\nconst braidOutput = braidDataBase + 0x1000;\nfor (const [index,value] of [[5,BigInt(braidOutput)],[6,0n]]) {\n  if ((pick('r360_ppc_probe_set_initial_gpr')(index,value)>>>0)!==1) throw new Error(`Could not seed Braid r${index}`);\n}\nconst braidLoadOffset = wordBytes(\n  0x3C803000,  // lis r4,0x3000\n  0x80840004,  // lwz r4,4(r4) -> HIR LOAD_OFFSET\n  0x7C8903A6,  // mtctr r4\n  0x4E800421,  // bctrl -> HIR CALL_INDIRECT\n  0x38630002,  // addi r3,r3,2\n  0x4E800020,  // blr\n);\nconst braidInput = pick('r360_ppc_probe_input_buffer')()>>>0;\nnew Uint8Array(parent.exports.memory.buffer,braidInput,braidLoadOffset.length).set(braidLoadOffset);\nif ((pick('r360_ppc_probe_load')(braidInput,braidLoadOffset.length)>>>0)!==braidLoadOffset.length) throw new Error('Could not load Braid LOAD_OFFSET regression PPC');\npick('r360_ppc_probe_translate')();\nconst braidOracleStatus = pick('r360_ppc_probe_correctness_status')()>>>0;\nconst braidOracleR3 = BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')());\nif (braidOracleStatus!==3 || braidOracleR3!==2n) throw new Error(`Braid LOAD_OFFSET oracle failed status=${braidOracleStatus} r3=${braidOracleR3}`);\nif ((pick('r360_wasm_backend_call_function_count')()>>>0)!==1) throw new Error(`Braid LOAD_OFFSET still produced ${pick('r360_wasm_backend_call_function_count')()>>>0} callable functions`);\nconst braidSession = await createPersistentPpcSession({bootstrap:parent,initialGprs:{5:BigInt(braidOutput),6:0n}});\nconst braidResult = await braidSession.runFunctionSlice(guestBase);\nif (braidResult.r3!==2n || braidResult.kernelDispatches!==1) throw new Error(`Braid generated LOAD_OFFSET/XAM dispatch failed r3=${braidResult.r3} kernel=${braidResult.kernelDispatches}`);\nif ((pick('r360_kernel_import_last_module')()>>>0)!==2 || (pick('r360_kernel_import_last_ordinal')()>>>0)!==0x028B) throw new Error('Braid generated path did not reach xam.xex ordinal 0x28B');\nconsole.log('BRAID_LOAD_OFFSET_CALL_INDIRECT_XAM=PASS');\n\nconsole.log('WASM_BACKEND_CALL_DIRECT=PASS');''')

for path, marker in [
    ('src/xenia_web_bootstrap/wasm_backend_call_probe.cpp', 'guest_load'),
    ('src/xenia_web_bootstrap/hir_correctness_executor.cpp', 'kHIRBlockerGuestMemory'),
    ('src/xenia_web_bootstrap/hir_correctness_executor.cpp', 'const uint32_t effective = static_cast<uint32_t>(base) +'),
    ('render360-browser-ppc-session.mjs', 'FAIL_CLOSED_GUEST_LOAD'),
    ('test-wasm-backend-calls.mjs', 'BRAID_LOAD_OFFSET_CALL_INDIRECT_XAM=PASS'),
]:
    require(path, marker)

print('BRAID_LOAD_OFFSET_SURGERY=PASS')
