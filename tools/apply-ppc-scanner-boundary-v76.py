#!/usr/bin/env python3
"""Apply Render360 V76: keep Xenia PPCScanner inside authoritative .pdata bounds."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


# Generate a browser-only overlay for upstream PPCScanner. XEX .pdata end
# addresses are exclusive, while Xenia GuestFunction::end_address is inclusive.
# The scanner increments its cursor after the last bounded instruction before
# storing it back into the function. On wasm32 that widened 0x8236EF38's Braid
# entry from 0x8236F0F8 to 0x8236F0FC, and the second scan inside DefineFunction
# could then translate one instruction beyond the authoritative runtime record.
overlay_path = "prepare-xenia-web-overlay.py"
overlay = read(overlay_path)
overlay = replace_once(
    overlay,
    'PROCESSOR_SOURCE = XENIA / "src/xenia/cpu/processor.cc"\nPROCESSOR_DEST = OVERLAY / "xenia/cpu/processor.cc"\n',
    'PROCESSOR_SOURCE = XENIA / "src/xenia/cpu/processor.cc"\nPROCESSOR_DEST = OVERLAY / "xenia/cpu/processor.cc"\nPPC_SCANNER_SOURCE = XENIA / "src/xenia/cpu/ppc/ppc_scanner.cc"\nPPC_SCANNER_DEST = OVERLAY / "xenia/cpu/ppc/ppc_scanner.cc"\n',
    "PPCScanner source constants",
)
overlay = replace_once(
    overlay,
    '    (PROCESSOR_SOURCE, "processor.cc"),\n):',
    '    (PROCESSOR_SOURCE, "processor.cc"),\n    (PPC_SCANNER_SOURCE, "ppc_scanner.cc"),\n):',
    "PPCScanner prerequisite",
)
scanner_block = '''\n# ppc_scanner.cc: Xenia treats GuestFunction::end_address as an inclusive last\n# instruction address. The loop advances `address` by four before checking an\n# expected bound, so a scan that consumes the final bounded instruction can\n# otherwise publish end+4. Retail XEX .pdata is authoritative and exclusive;\n# Render360 converts it to end-4 before scanning. Never let the scanner widen\n# that inclusive boundary again. Early natural returns remain untouched.\nscanner_text = PPC_SCANNER_SOURCE.read_text(errors="strict")\nscanner_anchor = "  function->set_end_address(address);\\n"\nif scanner_text.count(scanner_anchor) != 1:\n    raise SystemExit("Upstream ppc_scanner.cc end-address anchor drifted")\nscanner_text = scanner_text.replace(\n    scanner_anchor,\n    "  // Render360 wasm32: preserve the caller's authoritative inclusive\\n"\n    "  // function bound (for XEX .pdata this is end_exclusive - 4).\\n"\n    "  if (end_address && address > end_address) {\\n"\n    "    address = end_address;\\n"\n    "  }\\n"\n    "  function->set_end_address(address);\\n",\n    1,\n)\nPPC_SCANNER_DEST.parent.mkdir(parents=True, exist_ok=True)\nPPC_SCANNER_DEST.write_text(scanner_text)\n\n'''
if "PPC_SCANNER_DEST.write_text(scanner_text)" not in overlay:
    anchor = '# processor.cc: the debugger exception-resume path knows how to restore a\n'
    if anchor not in overlay:
        raise SystemExit("PPCScanner overlay insertion anchor drifted")
    overlay = overlay.replace(anchor, scanner_block + anchor, 1)
if 'Generated web PPCScanner overlay:' not in overlay:
    overlay += '\nprint(f"Generated web PPCScanner overlay: {PPC_SCANNER_DEST}")\nprint("PPC scanner rule: bounded functions never widen beyond their inclusive expected end")\n'
write(overlay_path, overlay)

# Compile the patched scanner source rather than the pristine upstream source.
build_path = "build-xenia-ppc-bootstrap.sh"
build = read(build_path)
build = replace_once(
    build,
    '    "src/xenia/cpu/processor.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/processor.cc" ;;\n',
    '    "src/xenia/cpu/processor.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/processor.cc" ;;\n    "src/xenia/cpu/ppc/ppc_scanner.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/ppc/ppc_scanner.cc" ;;\n',
    "PPCScanner compile route",
)
write(build_path, build)

# Release-wide version contract. Package-core and browser-bootstrap binaries are
# rebuilt by the release workflow after this source commit lands.
version = read("VERSION").strip()
if version not in {"75", "76"}:
    raise SystemExit(f"V76 updater expected VERSION 75 or 76, found {version}")
write("VERSION", "76\n")

runtime_path = "runtime/render360-runtime.js"
runtime = read(runtime_path)
runtime = replace_once(runtime, "const RENDER360_RELEASE=75;", "const RENDER360_RELEASE=76;", "runtime release")
runtime = replace_once(runtime, "const REQUIRED_CORE_BUILD=75;", "const REQUIRED_CORE_BUILD=76;", "runtime core requirement")
runtime = replace_once(runtime, "const CONTENT_BRIDGE={release:75,", "const CONTENT_BRIDGE={release:76,", "runtime bridge release")
write(runtime_path, runtime)

title_runtime_path = "render360-browser-title-runtime.mjs"
title_runtime = read(title_runtime_path)
title_runtime = replace_once(title_runtime, "const RENDER360_RELEASE=75;", "const RENDER360_RELEASE=76;", "title runtime release")
write(title_runtime_path, title_runtime)

modern_bridge_path = "render360-browser-modern-content-bridge.mjs"
modern_bridge = read(modern_bridge_path)
modern_bridge = replace_once(modern_bridge, "return {release:75,inputs:", "return {release:76,inputs:", "modern bridge contract")
write(modern_bridge_path, modern_bridge)

sw_path = "render360-sw.js"
sw = read(sw_path)
sw = replace_once(sw, "const VERSION='75';", "const VERSION='76';", "service worker release")
write(sw_path, sw)

index_path = "index.html"
index = read(index_path)
if "Render360 75" in index:
    index = index.replace("Render360 75", "Render360 76")
if '<span>UI Release</span><span class="value">75</span>' in index:
    index = index.replace('<span>UI Release</span><span class="value">75</span>', '<span>UI Release</span><span class="value">76</span>')
if "Render360 76" not in index:
    raise SystemExit("index.html V76 release label was not found/applied")
write(index_path, index)

print("R360_V76_PPC_SCANNER_BOUNDARY_APPLIED=1")
