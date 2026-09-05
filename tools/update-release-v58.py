#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Keep the canonical release file and all user-visible app release labels aligned.
(ROOT / 'VERSION').write_text('58\n')

runtime = ROOT / 'runtime/render360-runtime.js'
s = runtime.read_text()
s = s.replace('const RENDER360_RELEASE=44;', 'const RENDER360_RELEASE=58;', 1)
s = s.replace('const CONTENT_BRIDGE={release:44,', 'const CONTENT_BRIDGE={release:58,', 1)
runtime.write_text(s)

index = ROOT / 'index.html'
s = index.read_text()
s = s.replace('Render360 44', 'Render360 58')
index.write_text(s)

readme = ROOT / 'README.md'
s = readme.read_text()
s = s.replace('## Current status — September 4, 2026', '## Current status — September 5, 2026', 1)

start = s.index('## Current Braid real-device blocker')
end = s.index('## Browser execution architecture')
replacement = '''## Current Braid real-device blocker — V57 measurement / V58 fix\n\nThe September 5 iPhone run is using the verified V57 bootstrap:\n\n```text\nsourceCommit: 525a1ac43370ca9b8d357ec3d7c8a3dfd3f7dda0\nsourceRun:    33958433624\nwasm sha256:  0bd12e1d545514ef6e258e38f0efc72bde21990772d5bebf6afab255cc9745d9\n\nentry:        0x8236EF38\nHIR:          340\nexecuted:     17 instructions\nblocker:      HIR guest-memory dependency (opcode 37)\nPPC:          0x8234F5AC / 0xEBA1FFE0\noperation:    ld r29,-32(r1)\ncaller r1:    0x70080EF0\ncall:         0x8236C7CC -> 0x8234F5AC\ncall flags:   0x2 (CALL_TAIL)\nhelper:       Xenia kEpilogReturn / __restgprlr_29-style entry\nkernel calls: 0\nGPU:          ring-not-initialized\n```\n\nThis run is different from the old `0x70081020` guard fault. The frame allocation and teardown around `0x8236C6E0` are balanced (`-0x70`, then `+0x70`). V57 correctly identifies the target as a Xenia epilog-return helper, but sending that helper back through an isolated nested HIR translation still loses the value materialization required by the helper's loads; the diagnostic therefore reports no concrete sparse-memory fault even though HIR opcode 37 stops execution.\n\n### V58: execute shared epilog helpers on the live PPC context\n\nV58 keeps ordinary linked calls on their exact ABI targets and keeps `.pdata` owner/interior routing for genuine compiler-generated tail fragments. For a tail target that Xenia has already classified as `Function::Behavior::kEpilogReturn`, Render360 now handles the Microsoft `__restgprlr_N` helper as the ABI helper it actually is rather than constructing a standalone nested HIR function.\n\nThe helper bridge:\n\n```text\nCALL_TAIL -> Xenia kEpilogReturn\n        ↓\nvalidate first instruction as ld rN,disp(r1)\n        ↓\nrestore rN..r31 from live sparse guest stack\n        ↓\nrestore LR from -8(r1)\n        ↓\nreturn through the caller's existing tail-call boundary\n```\n\nThe implementation remains fail-closed. It validates the helper's first instruction and expected register/stack offset pattern, reads only through authoritative `SparseGuestMemory`, and returns a real failure if any helper load is unmapped. It does not map the upper guard, clamp `r1`, fabricate register values, or bypass unrelated memory faults.\n\n### What remains ruled out\n\n- The initial Xbox stack reservation is correct (`r1 = 0x70080F50`).\n- The upper stack guard remains protected.\n- The current V57 blocker has a matching `-0x70` allocation and `+0x70` teardown, so it is not the earlier missing-prologue case.\n- No XAM/xboxkrnl HLE call has executed yet.\n- The Xenos ring is still downstream of the CPU blocker.\n\nThe next real-device Copy Report should use the V58 published bootstrap and show whether execution advances beyond the `0x8234F5AC` shared restore helper.\n\n'''
s = s[:start] + replacement + s[end:]

near = s.index('## Near-term engineering order')
important = s.index('## Important files')
near_replacement = '''## Near-term engineering order\n\n```text\n1. build and publish the V58 shared-epilog helper bootstrap\n2. run Braid on the real iPhone and capture a new Copy Report\n3. verify execution advances beyond 0x8234F5AC / 17 instructions\n4. confirm the later 0x8236EB74 tail fragment still uses .pdata owner/interior routing\n5. implement only the next measured PPC/HIR blocker\n6. reach the first real xboxkrnl/XAM HLE call\n7. bring the guest scheduler online\n8. reach Xenos ring initialization and PM4 traffic\n9. reach VdSwap and present the first genuine Braid frame\n10. only then move from first-frame bring-up to sustained gameplay\n```\n\n'''
s = s[:near] + near_replacement + s[important:]
s = s.replace('current V52 depth-1 return seeding', 'V52 depth-1 return seeding plus V55-V58 tail/epilog routing')

readme.write_text(s)
print('R360_RELEASE_V58_TEXT=PASS')
