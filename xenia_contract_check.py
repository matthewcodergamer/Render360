#!/usr/bin/env python3
from pathlib import Path
import re, sys
root=Path(__file__).resolve().parents[1]
info=root/'upstream/xenia/src/xenia/kernel/util/xex2_info.h'
module=root/'upstream/xenia/src/xenia/cpu/xex_module.h'
stfs=root/'upstream/xenia/src/xenia/vfs/devices/stfs_xbox.h'
device=root/'upstream/xenia/src/xenia/vfs/devices/stfs_container_device.cc'
missing=[p for p in (info,module,stfs,device) if not p.exists()]
if missing:
    raise SystemExit('Run scripts/fetch-xenia.sh first; missing: '+', '.join(str(p) for p in missing))
texts={p:p.read_text(errors='replace') for p in (info,module,stfs,device)}
failed=[]
required_xex={
 'XEX_HEADER_FILE_FORMAT_INFO':'0x000003FF',
 'XEX_HEADER_ENTRY_POINT':'0x00010100',
 'XEX_HEADER_IMAGE_BASE_ADDRESS':'0x00010201',
 'XEX_HEADER_IMPORT_LIBRARIES':'0x000103FF',
 'XEX_HEADER_SYSTEM_FLAGS':'0x00030000',
 'XEX_HEADER_EXECUTION_INFO':'0x00040006',
}
for name,value in required_xex.items():
    if not re.search(rf'\b{name}\s*=\s*{re.escape(value)}',texts[info]): failed.append(f'{name} != {value}')
for token in ['magic','module_flags','header_size','security_offset','header_count']:
    if not re.search(rf'\b{token}\b',texts[info]): failed.append(f'xex2_info.h missing {token}')
for token in ['kXEX1Signature','kXEX2Signature','GetOptHeader']:
    if token not in texts[module]: failed.append(f'xex_module.h missing {token}')
for sig,value in [('kCon','0x434F4E20'),('kPirs','0x50495253'),('kLive','0x4C495645')]:
    if not re.search(rf'\b{sig}\s*=\s*{value}',texts[stfs]): failed.append(f'STFS package magic {sig} drifted')
for token in [
    'struct StfsVolumeDescriptor','read_only_format','root_active_index',
    'file_table_block_count','file_table_block_number_raw',
    'struct StfsHashEntry','level0_next_block','levelN_active_index',
    'struct StfsDirectoryEntry','static_assert_size(StfsDirectoryEntry, 0x40)',
    'static_assert_size(StfsHashTable, 0x1000)','static_assert_size(StfsHeader, 0x971A)']:
    if token not in texts[stfs]: failed.append(f'stfs_xbox.h missing {token}')
for token in [
    'ReadSTFS()','BlockToOffsetSTFS','BlockToHashBlockNumberSTFS',
    'BlockToHashBlockOffsetSTFS','GetBlockHash','kBlocksPerHashLevel[0]',
    'blocks_per_hash_table_','level0_next_block()']:
    if token not in texts[device]: failed.append(f'stfs_container_device.cc missing {token}')
if failed:
    print('Xenia contract drift detected:')
    for item in failed: print(' -',item)
    sys.exit(1)
print('PASS: V30 XEX + native STFS portability contract still matches upstream Xenia')
