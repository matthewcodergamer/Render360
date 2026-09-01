#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'src/xenia_web_bootstrap/wasm_backend_call_probe.cpp'
text = PATH.read_text()

marker = 'case xe::cpu::hir::OPCODE_BYTE_SWAP: {'
if marker not in text:
    old = '''    case xe::cpu::hir::OPCODE_ADD:\n    case xe::cpu::hir::OPCODE_SUB:\n'''
    new = '''    case xe::cpu::hir::OPCODE_BYTE_SWAP: {\n      const uint32_t size = ScalarTypeSize(value->type);\n      if (!size || !instr->src1.value) break;\n      // Xenia materializes PPC big-endian scalar loads as LOAD_OFFSET followed\n      // by BYTE_SWAP. Keep this in the same callable generated-WASM tier so a\n      // loaded function pointer can flow directly into mtctr / CALL_INDIRECT.\n      // This is fail-closed to integer scalar values admitted by ScalarTypeSize.\n      for (uint32_t byte = 0; byte < size; ++byte) {\n        if (!EmitI64Value(instr->src1.value, producers, visiting, body, lowered)) {\n          ok = false;\n          break;\n        }\n        if (byte) {\n          body.push_back(0x42);\n          EmitI64Leb(body, static_cast<int64_t>(byte * 8u));\n          body.push_back(0x88);  // i64.shr_u\n        }\n        body.push_back(0x42);\n        EmitI64Leb(body, 0xFF);\n        body.push_back(0x83);  // i64.and\n        const uint32_t target_byte = size - 1u - byte;\n        if (target_byte) {\n          body.push_back(0x42);\n          EmitI64Leb(body, static_cast<int64_t>(target_byte * 8u));\n          body.push_back(0x86);  // i64.shl\n        }\n        if (byte) body.push_back(0x84);  // i64.or\n        ok = true;\n      }\n      if (ok) EmitI64Mask(body, value->type);\n      break;\n    }\n    case xe::cpu::hir::OPCODE_ADD:\n    case xe::cpu::hir::OPCODE_SUB:\n'''
    if text.count(old) != 1:
        raise SystemExit(f'BYTE_SWAP insertion anchor changed: {text.count(old)} matches')
    text = text.replace(old, new, 1)

skip_old = '''               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ADD ||'''
skip_new = '''               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_BYTE_SWAP ||\n               instr->opcode->num == xe::cpu::hir::OPCODE_ADD ||'''
if skip_new not in text:
    if text.count(skip_old) != 1:
        raise SystemExit(f'BYTE_SWAP producer-admission anchor changed: {text.count(skip_old)} matches')
    text = text.replace(skip_old, skip_new, 1)

PATH.write_text(text)

required = [
    marker,
    'body.push_back(0x88);  // i64.shr_u',
    'body.push_back(0x86);  // i64.shl',
    'body.push_back(0x84);  // i64.or',
    'instr->opcode->num == xe::cpu::hir::OPCODE_BYTE_SWAP',
]
final = PATH.read_text()
for needle in required:
    if needle not in final:
        raise SystemExit(f'BYTE_SWAP critic missing marker: {needle}')

print('BRAID_CALLABLE_BYTE_SWAP_SURGERY=PASS')
