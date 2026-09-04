#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if old not in text:
        if new in text:
            return
        raise SystemExit(f'hir return metadata v3 overlay: {label} anchor changed')
    text = text.replace(old, new, 1)


# Xenia emits SET_RETURN_ADDRESS for every linked PPC branch before it decides
# whether the target is an internal HIR label or an external function call.
# Render360's nested-call helper uses that value as one-shot host-side metadata.
# It must therefore be discarded when control flow stays inside the same HIR
# function, or when a conditional linked call is not taken. Otherwise a later,
# unrelated call may consume a stale return address and misclassify a bclr path.
helper_anchor = '''void ClearNestedGuestReturn() {
  if (g_execution_depth < kR360MaxGuestCallDepth) {
    g_expected_guest_return_valid[g_execution_depth] = false;
    g_guest_tail_terminal[g_execution_depth] = false;
  }
}

void RecordGuestCall(uint32_t target) {'''
helper_replacement = '''void ClearNestedGuestReturn() {
  if (g_execution_depth < kR360MaxGuestCallDepth) {
    g_expected_guest_return_valid[g_execution_depth] = false;
    g_guest_tail_terminal[g_execution_depth] = false;
  }
}

void DiscardPendingGuestReturnMetadata(const char* reason) {
  if (!g_next_guest_return_valid) return;
  std::fprintf(stderr,
               "R360_GUEST_RETURN_DISCARD source=0x%08X depth=%u return=0x%08X reason=%s\\n",
               g_current_source_address, g_execution_depth,
               static_cast<uint32_t>(g_next_guest_return_address),
               reason ? reason : "control-flow");
  g_next_guest_return_address = 0;
  g_next_guest_return_valid = false;
}

void RecordGuestCall(uint32_t target) {'''
replace_once(helper_anchor, helper_replacement, 'discard helper')

branch_old = '''        case xe::cpu::hir::OPCODE_BRANCH:
          supported = instr->src1.label && instr->src1.label->block;
          if (supported) next_block = instr->src1.label->block;
          block_terminated = true;
          break;'''
branch_new = '''        case xe::cpu::hir::OPCODE_BRANCH:
          supported = instr->src1.label && instr->src1.label->block;
          if (supported) next_block = instr->src1.label->block;
          // A linked PPC branch may have emitted SET_RETURN_ADDRESS even when
          // Xenia resolved the destination to an internal HIR label. The LR
          // update remains in PPCContext, but there is no nested host call that
          // may consume our one-shot expected-return metadata.
          DiscardPendingGuestReturnMetadata("internal-branch");
          block_terminated = true;
          break;'''
replace_once(branch_old, branch_new, 'unconditional internal branch')

conditional_branch_old = '''          if (supported && take) {
            supported = instr->src2.label && instr->src2.label->block;
            if (supported) next_block = instr->src2.label->block;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL: {'''
conditional_branch_new = '''          if (supported && take) {
            supported = instr->src2.label && instr->src2.label->block;
            if (supported) next_block = instr->src2.label->block;
            block_terminated = true;
          }
          // BRANCH_TRUE/FALSE is still intra-function control flow whether the
          // condition is taken or not, so any pending linked-branch token is
          // stale after this instruction.
          DiscardPendingGuestReturnMetadata(take ? "internal-conditional-branch-taken"
                                                   : "internal-conditional-branch-not-taken");
          break;
        }

        case xe::cpu::hir::OPCODE_CALL: {'''
replace_once(conditional_branch_old, conditional_branch_new, 'conditional internal branch')

call_true_old = '''            if (supported && (instr->flags & xe::cpu::hir::CALL_TAIL)) {
              reached_return = true;
              block_terminated = true;
            }
          }
          break;
        }

        case xe::cpu::hir::OPCODE_RETURN:'''
call_true_new = '''            if (supported && (instr->flags & xe::cpu::hir::CALL_TAIL)) {
              reached_return = true;
              block_terminated = true;
            }
          } else if (supported) {
            // A conditional linked PPC call updates LR even when its branch is
            // not taken. That architectural LR write stays in context, but no
            // callee exists to inherit the host-side expected-return token.
            DiscardPendingGuestReturnMetadata("conditional-call-not-taken");
          }
          break;
        }

        case xe::cpu::hir::OPCODE_RETURN:'''
replace_once(call_true_old, call_true_new, 'untaken direct conditional call')

indirect_true_old = '''        case xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (!supported || !condition) break;
          uint64_t target = 0;
          supported = ResolveUint64(instr->src2.value, values, &target);
          if (supported) {
            supported = ExecuteIndirect(target, instr->flags, &reached_return,
                                        &block_terminated);
          }
          break;
        }'''
indirect_true_new = '''        case xe::cpu::hir::OPCODE_CALL_INDIRECT_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (!supported) break;
          if (!condition) {
            DiscardPendingGuestReturnMetadata("conditional-indirect-call-not-taken");
            break;
          }
          uint64_t target = 0;
          supported = ResolveUint64(instr->src2.value, values, &target);
          if (supported) {
            supported = ExecuteIndirect(target, instr->flags, &reached_return,
                                        &block_terminated);
          }
          break;
        }'''
replace_once(indirect_true_old, indirect_true_new, 'untaken indirect conditional call')

# If execution returns or aborts with a pending token, never let it bleed into a
# later top-level compatibility execution. The outermost reset already clears it;
# these paths make the lifetime explicit and keep diagnostics deterministic.
return_old = '''        case xe::cpu::hir::OPCODE_RETURN:
          reached_return = true;
          block_terminated = true;
          break;'''
return_new = '''        case xe::cpu::hir::OPCODE_RETURN:
          DiscardPendingGuestReturnMetadata("return");
          reached_return = true;
          block_terminated = true;
          break;'''
replace_once(return_old, return_new, 'return cleanup')

return_true_old = '''          if (supported && condition) {
            reached_return = true;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL_INDIRECT: {'''
return_true_new = '''          if (supported && condition) {
            DiscardPendingGuestReturnMetadata("conditional-return");
            reached_return = true;
            block_terminated = true;
          }
          break;
        }

        case xe::cpu::hir::OPCODE_CALL_INDIRECT: {'''
replace_once(return_true_old, return_true_new, 'conditional return cleanup')

required = [
    'R360_GUEST_RETURN_DISCARD',
    'internal-branch',
    'internal-conditional-branch-taken',
    'conditional-call-not-taken',
    'conditional-indirect-call-not-taken',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f'hir return metadata v3 overlay missing marker: {marker}')

path.write_text(text)
print('HIR_RETURN_METADATA_V3_OVERLAY=PASS')
