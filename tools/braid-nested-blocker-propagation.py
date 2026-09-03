from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


cpp_path = Path("src/xenia_web_bootstrap/hir_correctness_executor.cpp")
cpp = cpp_path.read_text()
state_anchor = "thread_local xe::cpu::ppc::PPCContext* g_active_context = nullptr;\nthread_local uint32_t g_execution_depth = 0;\n"
state_patch = state_anchor + """
// Resolver callbacks are boolean, but real title calls may recursively execute
// another HIR builder. Preserve the exact nested blocker across that boundary.
thread_local bool g_pending_nested_failure_valid = false;
thread_local HIRCorrectnessResult g_pending_nested_failure{};

void ClearPendingNestedFailure() {
  g_pending_nested_failure_valid = false;
  g_pending_nested_failure = {};
}
void RecordPendingNestedFailure(const HIRCorrectnessResult& failure) {
  if (failure.supported || failure.blocker_kind == kHIRBlockerNone) return;
  g_pending_nested_failure = failure;
  g_pending_nested_failure_valid = true;
}
bool ConsumePendingNestedFailure(HIRCorrectnessResult* failure) {
  if (!failure || !g_pending_nested_failure_valid) return false;
  *failure = g_pending_nested_failure;
  ClearPendingNestedFailure();
  return true;
}
bool ResolveFunctionCallWithNestedFailure(xe::cpu::Function* function) {
  ClearPendingNestedFailure();
  if (!g_call_resolver || !g_call_resolver(function)) return false;
  ClearPendingNestedFailure();
  return true;
}
bool ResolveAddressCallWithNestedFailure(uint32_t target) {
  ClearPendingNestedFailure();
  if (!g_address_resolver || !g_address_resolver(target)) return false;
  ClearPendingNestedFailure();
  return true;
}
"""
cpp = replace_once(cpp, state_anchor, state_patch, "nested failure state")
cpp = replace_once(
    cpp,
    "  if (target > std::numeric_limits<uint32_t>::max() || !g_address_resolver) {\n    return false;\n  }\n  if (!g_address_resolver(static_cast<uint32_t>(target))) return false;\n",
    "  if (target > std::numeric_limits<uint32_t>::max()) return false;\n  if (!ResolveAddressCallWithNestedFailure(static_cast<uint32_t>(target))) {\n    return false;\n  }\n",
    "indirect resolver")
cpp = replace_once(
    cpp,
    "            call_resolved =\n                g_call_resolver && g_call_resolver(instr->src1.symbol);\n",
    "            call_resolved =\n                ResolveFunctionCallWithNestedFailure(instr->src1.symbol);\n",
    "direct symbol resolver")
cpp = replace_once(
    cpp,
    "              call_resolved =\n                  g_call_resolver && g_call_resolver(instr->src2.symbol);\n",
    "              call_resolved =\n                  ResolveFunctionCallWithNestedFailure(instr->src2.symbol);\n",
    "conditional symbol resolver")
if "call_resolved = ResolveAddressCallWithNestedFailure(target);" not in cpp:
    if cpp.count("call_resolved = g_address_resolver(target);") != 2:
        raise SystemExit("expected two direct-address resolver anchors")
    cpp = cpp.replace("call_resolved = g_address_resolver(target);",
                      "call_resolved = ResolveAddressCallWithNestedFailure(target);")
classification_anchor = "      if (!supported && result.blocker_kind == kHIRBlockerNone) {\n        const uint32_t opcode = instr->opcode ? instr->opcode->num : 0;\n"
classification_patch = """      if (!supported && result.blocker_kind == kHIRBlockerNone) {
        HIRCorrectnessResult nested_failure;
        if (ConsumePendingNestedFailure(&nested_failure)) {
          result.blocker_kind = nested_failure.blocker_kind;
          result.blocker_opcode = nested_failure.blocker_opcode;
          result.blocker_address = nested_failure.blocker_address;
          std::fprintf(stderr,
                       "R360_NESTED_BLOCKER propagated kind=%u opcode=%u address=0x%08X outer=0x%08X\n",
                       result.blocker_kind, result.blocker_opcode,
                       result.blocker_address, current_source_address);
        }
      }
      if (!supported && result.blocker_kind == kHIRBlockerNone) {
        const uint32_t opcode = instr->opcode ? instr->opcode->num : 0;
"""
cpp = replace_once(cpp, classification_anchor, classification_patch,
                   "nested blocker classification")
cpp = replace_once(
    cpp,
    "  const bool outermost = g_active_context == nullptr;\n  xe::cpu::ppc::PPCContext local_context{};\n",
    "  const bool outermost = g_active_context == nullptr;\n  if (outermost) ClearPendingNestedFailure();\n  xe::cpu::ppc::PPCContext local_context{};\n",
    "outer execution reset")
cpp = replace_once(
    cpp,
    "  result = ExecuteBuilder(builder, memory, *g_active_context);\n  --g_execution_depth;\n\n  if (outermost) g_active_context = nullptr;\n",
    "  result = ExecuteBuilder(builder, memory, *g_active_context);\n  --g_execution_depth;\n\n  if (!outermost && !result.supported &&\n      result.blocker_kind != kHIRBlockerNone) {\n    RecordPendingNestedFailure(result);\n  }\n  if (outermost) g_active_context = nullptr;\n",
    "nested failure record")
cpp_path.write_text(cpp)


test_path = Path("test-kernel-abi-critic.mjs")
test = test_path.read_text()
test = replace_once(
    test,
    "  'r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3',\n",
    "  'r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3',\n  'r360_ppc_probe_correctness_blocker_kind','r360_ppc_probe_correctness_blocker_opcode',\n  'r360_ppc_probe_correctness_blocker_address',\n",
    "critic blocker exports")
test = replace_once(
    test,
    "    status: pick('r360_ppc_probe_correctness_status')() >>> 0,\n    r3: Number(pick('r360_ppc_probe_correctness_r3')()),\n",
    "    status: pick('r360_ppc_probe_correctness_status')() >>> 0,\n    r3: Number(pick('r360_ppc_probe_correctness_r3')()),\n    blockerKind: pick('r360_ppc_probe_correctness_blocker_kind')() >>> 0,\n    blockerOpcode: pick('r360_ppc_probe_correctness_blocker_opcode')() >>> 0,\n    blockerAddress: pick('r360_ppc_probe_correctness_blocker_address')() >>> 0,\n",
    "critic blocker telemetry")
test = replace_once(
    test,
    "if (boundary.status !== 1 || boundary.lastStatus !== 3 || boundary.calls !== 1) throw new Error(`critic boundary failure ${JSON.stringify(boundary)}`);\nconsole.log('KERNEL_ABI_CRITIC_RANGE_FAIL_CLOSED=PASS');\n",
    "if (boundary.status !== 1 || boundary.lastStatus !== 3 || boundary.calls !== 1 ||\n    boundary.blockerKind !== 5 || boundary.blockerAddress !== service) {\n  throw new Error(`critic boundary failure ${JSON.stringify(boundary)}`);\n}\nconsole.log('KERNEL_ABI_CRITIC_RANGE_FAIL_CLOSED=PASS');\nconsole.log('KERNEL_ABI_CRITIC_NESTED_BLOCKER_PROPAGATION=PASS');\n",
    "boundary propagation assertion")
test = replace_once(
    test,
    "if (wrap.status !== 1 || wrap.lastStatus !== 3 || wrap.calls !== 1) throw new Error(`critic wraparound failure ${JSON.stringify(wrap)}`);\n",
    "if (wrap.status !== 1 || wrap.lastStatus !== 3 || wrap.calls !== 1 ||\n    wrap.blockerKind !== 5 || wrap.blockerAddress !== service) {\n  throw new Error(`critic wraparound failure ${JSON.stringify(wrap)}`);\n}\n",
    "wrap propagation assertion")
test = replace_once(
    test,
    "if (unsupported.status !== 1 || unsupported.lastStatus !== 2 || unsupported.calls !== 1 ||\n    unsupported.thunk !== thunk || unsupported.module !== moduleId || unsupported.ordinal !== ordinal || unchanged !== 0x0BADF00D) {\n",
    "if (unsupported.status !== 1 || unsupported.lastStatus !== 2 || unsupported.calls !== 1 ||\n    unsupported.blockerKind !== 2 || unsupported.thunk !== thunk || unsupported.module !== moduleId ||\n    unsupported.ordinal !== ordinal || unchanged !== 0x0BADF00D) {\n",
    "unsupported remains unresolved")
test_path.write_text(test)


workflow_path = Path(".github/workflows/braid-portal-runtime-followup-gate.yml")
workflow = workflow_path.read_text()
workflow = replace_once(
    workflow,
    "          node ./test-hir-sparse-fail-closed.mjs \"$WASM\"\n",
    "          node ./test-hir-sparse-fail-closed.mjs \"$WASM\"\n      - name: Verify nested HIR blocker propagation\n        run: |\n          set -euo pipefail\n          WASM=\"$(find .runtime-followup-artifact -type f -name xenia_ppc_bootstrap.wasm | head -n 1)\"\n          test -n \"$WASM\"\n          node ./test-kernel-abi-critic.mjs \"$WASM\"\n",
    "runtime followup nested critic")
workflow_path.write_text(workflow)

Path("src/xenia_web_bootstrap/BRAID_NESTED_BLOCKER_PROPAGATION.md").write_text("""# Braid nested HIR blocker propagation

The 2026-09-03 iPhone run used verified runtime source `5358cec1` and still
reported outer HIR CALL blocker kind 2 at `0x8236EF7C` while sparse memory
retained an unmapped fault at `0x70081020`.

The direct sparse-memory fail-closed critic already passes, so this run rules
out the decoder-window fallback as the immediate title-level explanation.
ProbeBackend can recursively execute nested HIR while its resolver ABI returns
only a boolean. Before this patch, a nested guest-memory blocker was discarded
and the caller reclassified the resolver failure as `kHIRBlockerUnresolvedCall`.
The executor now propagates the exact nested blocker kind/opcode/address across
that boolean boundary. Unsupported imports with no nested execution remain
ordinary unresolved-call blockers.

The regression reuses the kernel ABI critic: a nested service performs a guest
STORE to an invalid pointer and must report blocker kind 5 at the nested service
instruction, not blocker kind 2 at the caller's `bctrl`. This is diagnostic and
control-flow correctness, not a claim that Braid has reached a frame.
""")
print("BRAID_NESTED_BLOCKER_PROPAGATION_PATCH=PASS")
