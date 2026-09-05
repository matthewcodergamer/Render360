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
ui_release_old = '<span>UI Release</span><span class="value">44</span>'
ui_release_new = '<span>UI Release</span><span class="value">58</span>'
if ui_release_old in s:
    s = s.replace(ui_release_old, ui_release_new, 1)
elif ui_release_new not in s:
    raise SystemExit('UI Release label anchor not found')
index.write_text(s)

readme = ROOT / 'README.md'
s = readme.read_text()
s = s.replace('## Current status — September 4, 2026', '## Current status — September 5, 2026', 1)

start = s.index('## Current Braid real-device blocker')
end = s.index('## Browser execution architecture')
replacement = '''## Current Braid real-device blocker — V57 measurement / V58 fix\n\nThe September 5 iPhone run is still using the verified pre-V58 generated PPC bootstrap even though the JavaScript/UI release reports V58:\n\n```text\nsourceCommit: 525a1ac43370ca9b8d357ec3d7c8a3dfd3f7dda0\nsourceRun:    33958433624\nwasm sha256:  0bd12e1d545514ef6e258e38f0efc72bde21990772d5bebf6afab255cc9745d9\n\nentry:        0x8236EF38\nHIR:          340\nexecuted:     17 instructions\nblocker:      HIR guest-memory dependency (opcode 37)\nPPC:          0x8234F5AC / 0xEBA1FFE0\noperation:    ld r29,-32(r1)\ncaller r1:    0x70080EF0\ncall:         0x8236C7CC -> 0x8234F5AC\ncall flags:   0x2 (CALL_TAIL)\nkernel calls: 0\nGPU:          ring-not-initialized\n```\n\nThe frame evidence is now strong: `0x8236C6E8` allocates `-0x70`, `0x8236C7C8` restores `+0x70`, and the next instruction is the tail branch into the shared restore sequence at `0x8234F5AC`. The zero-address diagnostic is not a real sparse-memory fault; the compatibility executor is translating the interior restore label as an isolated HIR entry and reaches `ld r29,-32(r1)` without the HIR value materialization that would exist in the owning translation.\n\n### V58: execute shared epilog helpers on the live PPC context\n\nV58 keeps ordinary linked calls on their exact ABI targets and keeps `.pdata` owner/interior routing for genuine compiler-generated tail fragments. For `CALL_TAIL` targets, Render360 now accepts either Xenia `Function::Behavior::kEpilogReturn` metadata or a strict canonical `__restgprlr_N` PPC signature. This matters for Braid's interior label `0x8234F5AC`, which may not be registered as a standalone function even though its instruction stream is the canonical shared restore helper.\n\nThe helper bridge:\n\n```text\nCALL_TAIL -> kEpilogReturn metadata OR strict __restgprlr_N signature\n        ↓\nvalidate ld rN..r31 offsets from the live r1\n        ↓\nrestore rN..r31 from authoritative sparse guest memory\n        ↓\nrestore 32-bit LR from lwz r12,-8(r1)\n        ↓\ncomplete the existing tail-call return boundary\n```\n\nThe implementation remains fail-closed. It validates the complete helper signature when metadata is unavailable, reads only through `SparseGuestMemory`, and returns a real failure if code or stack data is unmapped. It does not map the upper guard, clamp `r1`, fabricate register values, or bypass unrelated memory faults.\n\n### What remains ruled out\n\n- The initial Xbox stack reservation is correct (`r1 = 0x70080F50`).\n- The upper stack guard remains protected.\n- The current blocker has a matching `-0x70` allocation and `+0x70` teardown, so it is not the earlier missing-prologue case.\n- No XAM/xboxkrnl HLE call has executed yet.\n- The Xenos ring is still downstream of the CPU blocker.\n\nThe next real-device Copy Report must show a newly published `xenia_ppc_bootstrap.wasm` provenance (`sourceCommit` / `sourceRun`) before it counts as a V58 helper test. The success criterion is that execution advances beyond `0x8234F5AC` / 17 instructions and reports the next measured boundary.\n\n'''
s = s[:start] + replacement + s[end:]

near = s.index('## Near-term engineering order')
important = s.index('## Important files')
near_replacement = '''## Near-term engineering order\n\n```text\n1. build and publish the hardened V58 shared-epilog bootstrap\n2. verify xenia_ppc_bootstrap.meta.json has new sourceCommit/sourceRun provenance\n3. run Braid on the real iPhone and capture a new Copy Report\n4. verify execution advances beyond 0x8234F5AC / 17 instructions\n5. confirm later ordinary tail fragments still use .pdata owner/interior routing\n6. implement only the next measured PPC/HIR blocker\n7. reach the first real xboxkrnl/XAM HLE call\n8. bring the guest scheduler online\n9. reach Xenos ring initialization, PM4 traffic, VdSwap, and the first genuine frame\n10. only then move from first-frame bring-up to sustained gameplay\n```\n\n'''
s = s[:near] + near_replacement + s[important:]
s = s.replace('current V52 depth-1 return seeding', 'V52 depth-1 return seeding plus V55-V58 tail/epilog routing')

readme.write_text(s)
print('R360_RELEASE_V58_TEXT=PASS')
