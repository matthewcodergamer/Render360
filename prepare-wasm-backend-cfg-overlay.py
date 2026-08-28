#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
src = root / 'src/xenia_web_bootstrap/wasm_backend_cfg_probe.cpp'
out = root / 'build/xenia-web-overlay/render360/wasm_backend_cfg_probe.cpp'
text = src.read_text()

old = r'''        case xe::cpu::hir::OPCODE_BRANCH_TRUE:
        case xe::cpu::hir::OPCODE_BRANCH_FALSE: {
          if (!instr->src1.value || !instr->src2.label || !instr->src2.label->block) return false;
          const auto target = indices.find(instr->src2.label->block);
          if (target == indices.end()) return false;
          const bool invert = instr->opcode->num == xe::cpu::hir::OPCODE_BRANCH_FALSE;
          if (!EmitTruthy(instr->src1.value, invert, locals, body)) return false;
          body.push_back(0x04); body.push_back(0x40);
          EmitSetPc(body, target->second);
          body.push_back(0x05);
          if (block->next) {
            const auto fallthrough = indices.find(block->next);
            if (fallthrough == indices.end()) return false;
            EmitSetPc(body, fallthrough->second);
          } else {
            EmitSetPc(body, block_count);
          }
          body.push_back(0x0B);
          body.push_back(0x0C); EmitU32Leb(body, 1);
          ++lowered; terminated = true; break;
        }
'''

new = r'''        case xe::cpu::hir::OPCODE_BRANCH_TRUE:
        case xe::cpu::hir::OPCODE_BRANCH_FALSE: {
          if (!instr->src1.value || !instr->src2.label || !instr->src2.label->block) return false;
          const auto target = indices.find(instr->src2.label->block);
          if (target == indices.end()) return false;
          const bool invert = instr->opcode->num == xe::cpu::hir::OPCODE_BRANCH_FALSE;
          if (!EmitTruthy(instr->src1.value, invert, locals, body)) return false;
          // Finalized Xenia HIR may contain a conditional branch in the middle
          // of a block. The taken path transfers to the target block, while the
          // not-taken path must continue with the following HIR instruction in
          // this same block. Treating block->next as the false edge skips that
          // in-block fallthrough and is observably wrong for cmpwi/beq and CTR
          // loops after Xenia's control-flow simplification passes.
          body.push_back(0x04); body.push_back(0x40);
          EmitSetPc(body, target->second);
          // We are nested in: conditional if -> block-dispatch if -> loop.
          // br 2 therefore resumes the dispatcher loop only on the taken edge.
          body.push_back(0x0C); EmitU32Leb(body, 2);
          body.push_back(0x0B);
          ++lowered;
          break;
        }
'''

if old not in text:
    raise SystemExit('WasmBackend CFG overlay: conditional branch source contract changed')
text = text.replace(old, new, 1)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print(f'WasmBackend CFG overlay: {src.relative_to(root)} -> {out.relative_to(root)}')
