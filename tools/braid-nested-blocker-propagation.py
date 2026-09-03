from pathlib import Path

cpp_path = Path("src/xenia_web_bootstrap/hir_correctness_executor.cpp")
cpp = cpp_path.read_text()

# The first generated patch accidentally let Python interpret the C++ "\\n"
# escape as a literal newline inside the string token. Repair that exact source
# form and then fail closed if the nested-blocker implementation is incomplete.
bad_log = '"R360_NESTED_BLOCKER propagated kind=%u opcode=%u address=0x%08X outer=0x%08X\n",'
good_log = '"R360_NESTED_BLOCKER propagated kind=%u opcode=%u address=0x%08X outer=0x%08X\\n",'
if bad_log in cpp:
    cpp = cpp.replace(bad_log, good_log, 1)
elif good_log not in cpp:
    raise SystemExit("missing nested blocker propagation log")

required_cpp = [
    "g_pending_nested_failure_valid",
    "RecordPendingNestedFailure",
    "ConsumePendingNestedFailure",
    "ResolveFunctionCallWithNestedFailure",
    "ResolveAddressCallWithNestedFailure",
    "R360_NESTED_BLOCKER propagated",
]
for token in required_cpp:
    if token not in cpp:
        raise SystemExit(f"missing nested blocker source contract: {token}")
cpp_path.write_text(cpp)

critic = Path("test-kernel-abi-critic.mjs").read_text()
for token in [
    "r360_ppc_probe_correctness_blocker_kind",
    "boundary.blockerKind !== 5",
    "wrap.blockerKind !== 5",
    "unsupported.blockerKind !== 2",
    "KERNEL_ABI_CRITIC_NESTED_BLOCKER_PROPAGATION=PASS",
]:
    if token not in critic:
        raise SystemExit(f"missing nested blocker critic contract: {token}")

followup = Path(".github/workflows/braid-portal-runtime-followup-gate.yml").read_text()
if "Verify nested HIR blocker propagation" not in followup:
    raise SystemExit("missing published-runtime nested blocker gate")

if not Path("src/xenia_web_bootstrap/BRAID_NESTED_BLOCKER_PROPAGATION.md").exists():
    raise SystemExit("missing nested blocker investigation note")

print("BRAID_NESTED_BLOCKER_PROPAGATION_PATCH=PASS")
