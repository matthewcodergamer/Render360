#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 66


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


# V65 proved that XEX optional-header entry, PE AddressOfEntryPoint and the
# selected guest entry are all 0x8236EF38, while Xenia's normal main-thread
# register state intentionally leaves r11/r29 zero. The remaining mismatch is
# image layout: Xenia decrypts/decompresses the XEX directly into the image-base
# memory layout. PE PointerToRawData is metadata at that point and must not be
# used to re-copy section bytes into VirtualAddress a second time.
loader = ROOT / "src/xenia_web_bootstrap/xex_pe_guest_loader.cpp"
replace_once(
    loader,
    '''  for(uint32_t i=0;i<m.section_count;++i){const auto& q=m.sections[i];if(std::strncmp(q.name,".pdata",8)!=0)continue;if(uint64_t(q.raw_address)+q.raw_size>length)break;\n    for(uint32_t o=0;o+8<=q.raw_size;o+=8){const uint8_t* p=image+q.raw_address+o;uint32_t begin=ReadBe32(p),data=ReadBe32(p+4);const uint32_t prolog=data&0xFFu,count=(data>>8)&0x003FFFFFu,insn=4u;if(!begin||!count)continue;\n''',
    '''  for(uint32_t i=0;i<m.section_count;++i){const auto& q=m.sections[i];if(std::strncmp(q.name,".pdata",8)!=0)continue;const uint32_t virtual_span=q.virtual_size>q.raw_size?q.virtual_size:q.raw_size;const bool virtual_ready=virtual_span&&uint64_t(q.virtual_address)+virtual_span<=length;const bool raw_ready=q.raw_size&&uint64_t(q.raw_address)+q.raw_size<=length;if(!virtual_ready&&!raw_ready)break;const uint32_t source_offset=virtual_ready?q.virtual_address:q.raw_address;const uint32_t source_span=virtual_ready?virtual_span:q.raw_size;\n    for(uint32_t o=0;o+8<=source_span;o+=8){const uint8_t* p=image+source_offset+o;uint32_t begin=ReadBe32(p),data=ReadBe32(p+4);const uint32_t prolog=data&0xFFu,count=(data>>8)&0x003FFFFFu,insn=4u;if(!begin||!count)continue;\n''',
    "V66 virtual .pdata source",
)

replace_once(
    loader,
    '''  // Copy the original section bytes only after all required pages are mapped.\n  // LoadXexGuestSectionData accepts spans covered by multiple adjacent mapping\n  // ranges, so a single PE section may cross page-protection boundaries safely.\n''',
    '''  // Xenia's XEX image readers write the decrypted/decompressed payload directly\n  // into image-base memory. Therefore a prepared XEX image is already a memory\n  // image: section bytes live at image + VirtualAddress. PointerToRawData is PE\n  // metadata only and re-copying from it corrupts title code (the V65 Braid entry\n  // blocker was exactly this). Keep a raw-offset fallback solely for standalone\n  // file-layout PE fixtures where the virtual span is not present in the buffer.\n  // LoadXexGuestSectionData accepts spans covered by adjacent mapping ranges.\n''',
    "V66 memory-image loader contract comment",
)

replace_once(
    loader,
    '''    if (section.raw_size) {\n      if (!LoadXexGuestSectionData(guest_address, image + section.raw_address,\n                                   section.raw_size)) {\n        return Fail(kPeGuestLoadFailed);\n      }\n      const uint64_t total = uint64_t(g_raw_bytes) + section.raw_size;\n      g_raw_bytes = total > UINT32_MAX ? UINT32_MAX\n                                      : static_cast<uint32_t>(total);\n    }\n''',
    '''    const bool virtual_ready =\n        uint64_t(section.virtual_address) + virtual_span <= length;\n    const bool raw_ready = section.raw_size &&\n        uint64_t(section.raw_address) + section.raw_size <= length;\n    if (!virtual_ready && !raw_ready) return Fail(kPeGuestLoadFailed);\n\n    const uint32_t source_offset =\n        virtual_ready ? section.virtual_address : section.raw_address;\n    const uint32_t source_bytes =\n        virtual_ready ? virtual_span : section.raw_size;\n    if (source_bytes &&\n        !LoadXexGuestSectionData(guest_address, image + source_offset,\n                                 source_bytes)) {\n      return Fail(kPeGuestLoadFailed);\n    }\n    const uint64_t total = uint64_t(g_raw_bytes) + source_bytes;\n    g_raw_bytes = total > UINT32_MAX ? UINT32_MAX\n                                    : static_cast<uint32_t>(total);\n''',
    "V66 prepared virtual section source",
)

# Make the new semantic regression part of the bootstrap publication gate.
fastlane = ROOT / ".github/workflows/xenia-browser-bootstrap-fastlane.yml"
replace_once(
    fastlane,
    '''      - name: Verify commercial-title PE staging growth\n        run: timeout 90s node ./test-xex-guest-mapper.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n''',
    '''      - name: Verify commercial-title PE staging growth\n        run: timeout 90s node ./test-xex-guest-mapper.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify XEX prepared memory-image section sourcing\n        run: timeout 90s node ./test-xex-prepared-memory-image-loader.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n''',
    "V66 prepared memory-image publication gate",
)

# Release synchronization.
(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=65;", "const RENDER360_RELEASE=66;", "V66 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:65,", "const CONTENT_BRIDGE={release:66,", "V66 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 65", "Render360 66")
old = '<span>UI Release</span><span class="value">65</span>'
new = '<span>UI Release</span><span class="value">66</span>'
if new not in text:
    if old not in text:
        raise SystemExit("V66 UI Release anchor missing")
    text = text.replace(old, new, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='66';", text, count=1)
if count != 1:
    raise SystemExit("V66 service worker version anchor missing")
sw.write_text(text)

print("R360_V66_XEX_MEMORY_IMAGE_PATCH=PASS")
