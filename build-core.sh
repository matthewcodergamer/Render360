#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/render360_xenia_core.cpp"
OUT="$ROOT/render360_xenia_core.wasm"
CXX="${CXX:-clang++}"
EXPORTS=(
  r360_build_version r360_abi_version r360_io_capacity r360_io_ptr
  r360_probe_container r360_probe_xex r360_inspect_xex
  r360_xex_status r360_xex_module_flags r360_xex_header_size
  r360_xex_security_offset r360_xex_header_count r360_xex_entry_point
  r360_xex_image_base r360_xex_system_flags r360_xex_title_id
  r360_xex_media_id r360_xex_image_size r360_xex_load_address
  r360_xex_region r360_xex_allowed_media_types r360_xex_page_descriptor_count
  r360_xex_encryption_type r360_xex_compression_type
  r360_xex_import_libraries_offset r360_xex_execution_info_offset
  r360_xex_file_format_info_offset r360_xam_scalar_value
  r360_runtime_reset r360_runtime_set_input r360_runtime_tick
  r360_runtime_ticks_lo r360_runtime_time_ms r360_runtime_work_lo
  r360_runtime_checksum r360_runtime_input_mask r360_feature_bits
)
ARGS=(--target=wasm32 -std=c++20 -O2 -nostdlib -I"$ROOT/src" -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=16777216 -Wl,--max-memory=16777216)
for symbol in "${EXPORTS[@]}"; do ARGS+=("-Wl,--export=$symbol"); done
"$CXX" "${ARGS[@]}" -o "$OUT" "$SRC"
printf 'Built %s\n' "$OUT"
