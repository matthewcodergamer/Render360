#!/usr/bin/env python3
# Every executor overlay declares its per-call-chain state thread_local (Xenia
# runs each XThread on its own host thread). The browser core runs guest
# threads as fibers on one host thread, so move all of that state into the
# R360_FIBER_LOCAL section that guest_fibers.cpp saves and restores per guest
# thread. Runs after every other executor overlay.
from pathlib import Path
p=Path(__file__).resolve().parent/'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
s=p.read_text()
count=s.count('thread_local ')
if count<20: raise SystemExit(f'fiber locals: expected the executor thread_local state, found {count}')
s=s.replace('thread_local ','R360_FIBER_LOCAL ')
p.write_text(s)
print(f'fiber locals: {count} executor variables')
