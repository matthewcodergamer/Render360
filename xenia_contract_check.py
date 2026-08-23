#!/usr/bin/env python3
from pathlib import Path
import re, sys
root=Path(__file__).resolve().parents[1]
info=root/'upstream/xenia/src/xenia/kernel/util/xex2_info.h'
module=root/'upstream/xenia/src/xenia/cpu/xex_module.h'
if not info.exists() or not module.exists():
    raise SystemExit('Run scripts/fetch-xenia.sh first')
text=info.read_text(errors='replace')
module_text=module.read_text(errors='replace')
required={
 'XEX_HEADER_FILE_FORMAT_INFO':'0x000003FF',
 'XEX_HEADER_ENTRY_POINT':'0x00010100',
 'XEX_HEADER_IMAGE_BASE_ADDRESS':'0x00010201',
 'XEX_HEADER_IMPORT_LIBRARIES':'0x000103FF',
 'XEX_HEADER_SYSTEM_FLAGS':'0x00030000',
 'XEX_HEADER_EXECUTION_INFO':'0x00040006',
}
failed=[]
for name,value in required.items():
    if not re.search(rf'\b{name}\s*=\s*{re.escape(value)}', text): failed.append(f'{name} != {value}')
for field in ['magic','module_flags','header_size','security_offset','header_count']:
    if not re.search(rf'\b{field}\b', text): failed.append(f'xex2_header missing {field}')
for sig in ['kXEX1Signature','kXEX2Signature','GetOptHeader']:
    if sig not in module_text: failed.append(f'xex_module.h missing {sig}')
if failed:
    print('Xenia contract drift detected:')
    for item in failed: print(' -',item)
    sys.exit(1)
print('PASS: V28 XEX portability contract still matches upstream Xenia definitions')
