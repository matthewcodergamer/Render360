#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 68


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if new in text:
        print(f"{label}: already applied")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count} in {path}")
    path.write_text(text.replace(old, new, 1))
    print(f"{label}: applied")


kernel = ROOT / "src/xenia_web_bootstrap/kernel_runtime_foundation.cpp"
helper_anchor = """uint32_t ServiceCall(uint32_t module, uint32_t ordinal,\n"""
helper = r'''bool ReadGuestBe32(uint32_t address, uint32_t* out) {
  if (!out) return false;
  uint8_t bytes[4] = {};
  if (!ReadSparseGuestMemory(address, bytes, sizeof(bytes))) return false;
  *out = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
         (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
  return true;
}

// Match UserModule::GetOptHeader used by upstream xboxkrnl!
// RtlImageXexHeaderField. XEX optional-header keys encode how their value is
// represented in the low byte: 0 returns the inline dword, 1 returns the guest
// address of the optional-header value cell, and every other value treats the
// stored dword as an offset from the guest XEX header base.
bool ReadXexOptionalHeaderField(uint32_t xex_header, uint32_t field,
                                uint32_t* out) {
  if (!out || !xex_header) return false;
  *out = 0;

  uint32_t magic = 0, header_size = 0, header_count = 0;
  if (!ReadGuestBe32(xex_header + 0x00u, &magic) ||
      !ReadGuestBe32(xex_header + 0x08u, &header_size) ||
      !ReadGuestBe32(xex_header + 0x14u, &header_count)) {
    return false;
  }
  if (magic != 0x58455832u || header_size < 0x18u ||
      header_count > (header_size - 0x18u) / 8u || header_count > 4096u) {
    return false;
  }

  for (uint32_t i = 0; i < header_count; ++i) {
    const uint64_t entry64 = uint64_t(xex_header) + 0x18u + uint64_t(i) * 8u;
    if (entry64 + 7u > UINT32_MAX) return false;
    const uint32_t entry = static_cast<uint32_t>(entry64);
    uint32_t key = 0, value = 0;
    if (!ReadGuestBe32(entry, &key) || !ReadGuestBe32(entry + 4u, &value)) {
      return false;
    }
    if (key != field) continue;

    switch (key & 0xFFu) {
      case 0x00u:
        *out = value;
        return true;
      case 0x01u:
        *out = entry + 4u;
        return true;
      default: {
        const uint64_t result64 = uint64_t(xex_header) + value;
        if (result64 > UINT32_MAX) return false;
        *out = static_cast<uint32_t>(result64);
        return true;
      }
    }
  }

  // Xenia returns a null guest pointer when the optional header is absent.
  return true;
}

uint32_t ServiceCall(uint32_t module, uint32_t ordinal,
'''
replace_once(kernel, helper_anchor, helper, "V68 XEX optional-header service helper")

switch_anchor = """      case 0x0083:  // KeQueryPerformanceFrequency\n        return kGuestTickFrequency;\n      case 0x0132: {  // RtlLowerChar\n"""
switch_replacement = """      case 0x0083:  // KeQueryPerformanceFrequency\n        return kGuestTickFrequency;\n      case 0x012B: {  // RtlImageXexHeaderField\n        uint32_t value = 0;\n        if (!ReadXexOptionalHeaderField(r3, r4, &value)) {\n          g_service_status = kStatusInvalid;\n          return 0;\n        }\n        return value;\n      }\n      case 0x0132: {  // RtlLowerChar\n"""
replace_once(kernel, switch_anchor, switch_replacement, "V68 RtlImageXexHeaderField dispatch")

fastlane = ROOT / ".github/workflows/xenia-browser-bootstrap-fastlane.yml"
replace_once(
    fastlane,
    """      - 'test-xenia-entry-lr-abi.mjs'\n      - 'test-xex-guest-mapper.mjs'\n""",
    """      - 'test-xenia-entry-lr-abi.mjs'\n      - 'test-kernel-rtl-image-xex-header-field.mjs'\n      - 'test-xex-guest-mapper.mjs'\n""",
    "V68 fastlane trigger",
)
replace_once(
    fastlane,
    """      - name: Verify Xenia title-entry LR ABI\n        run: timeout 90s node ./test-xenia-entry-lr-abi.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify browser bootstrap runtime contract\n""",
    """      - name: Verify Xenia title-entry LR ABI\n        run: timeout 90s node ./test-xenia-entry-lr-abi.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify RtlImageXexHeaderField kernel service\n        run: timeout 90s node ./test-kernel-rtl-image-xex-header-field.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify browser bootstrap runtime contract\n""",
    "V68 kernel-service publication gate",
)

(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=67;", "const RENDER360_RELEASE=68;", "V68 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:67,", "const CONTENT_BRIDGE={release:68,", "V68 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 67", "Render360 68")
old = '<span>UI Release</span><span class="value">67</span>'
new = '<span>UI Release</span><span class="value">68</span>'
if new not in text:
    if old not in text:
        raise SystemExit("V68 UI Release anchor missing")
    text = text.replace(old, new, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='68';", text, count=1)
if count != 1:
    raise SystemExit("V68 service worker version anchor missing")
sw.write_text(text)

print("R360_V68_RTL_IMAGE_XEX_HEADER_FIELD_PATCH=PASS")
