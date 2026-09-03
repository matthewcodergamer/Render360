# Braid nested HIR blocker propagation

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

The first CI compile exposed only an escaped-newline typo in the new diagnostic
`fprintf`; source commit `68b6313f` repairs that token before this verification
rerun. The behavior gate remains the nested blocker kind/address assertion, not
the diagnostic string itself.
