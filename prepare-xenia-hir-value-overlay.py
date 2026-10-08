#!/usr/bin/env python3
"""Generate the Xenia HIR Value overlay for non-MSVC hosts.

Value::MulHi (constant folding of mulhdu/mulhd) casts the *signed* int64
constant straight to unsigned __int128 on non-MSVC compilers, which
sign-extends a negative operand to 128 bits: mulhdu(-1, 1) folds to
0xFFFFFFFFFFFFFFFF instead of 0. Xenia's MSVC build uses __umulh and is
correct, and so is the runtime x64 sequence; only the constant-folding path
built with clang/gcc is wrong. Xenia's own instr_mulhdu.s tests
(test_mulhdu_*_constant) catch it. Route the unsigned case through uint64_t
first, matching __umulh, and leave everything else byte-identical.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
XENIA = ROOT / "upstream" / "xenia"
OVERLAY = ROOT / "build" / "xenia-web-overlay"
SOURCE = XENIA / "src/xenia/cpu/hir/value.cc"
DEST = OVERLAY / "xenia/cpu/hir/value.cc"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream hir/value.cc is missing")

text = SOURCE.read_text(errors="strict")
anchor = '''        constant.i64 = static_cast<uint64_t>(
            (static_cast<unsigned __int128>(constant.i64) *
             static_cast<unsigned __int128>(other->constant.i64)) >>
            64);'''
replacement = '''        constant.i64 = static_cast<uint64_t>(
            (static_cast<unsigned __int128>(static_cast<uint64_t>(constant.i64)) *
             static_cast<unsigned __int128>(
                 static_cast<uint64_t>(other->constant.i64))) >>
            64);'''
if text.count(anchor) != 1:
    raise SystemExit("HIR Value overlay: Value::MulHi unsigned INT64 anchor changed")
text = text.replace(anchor, replacement)
DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated HIR Value overlay: {DEST}")
print("Value rule: unsigned 64-bit MulHi constant folding zero-extends like __umulh")
