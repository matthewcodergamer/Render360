#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/render360_xenia_core_v32.cpp"
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
  r360_xex_file_format_info_offset
  r360_xam_scalar_value
  r360_runtime_reset r360_runtime_set_input r360_runtime_set_session
  r360_runtime_tick r360_runtime_ticks_lo r360_runtime_time_ms
  r360_runtime_work_lo r360_runtime_checksum r360_runtime_input_mask
  r360_runtime_session_kind r360_runtime_session_stage r360_runtime_title_id
  r360_stfs_mount_reset r360_stfs_mount_begin r360_stfs_submit_read
  r360_stfs_mount_status r360_stfs_package_kind r360_stfs_header_size
  r360_stfs_content_type r360_stfs_metadata_version r360_stfs_title_id
  r360_stfs_media_id r360_stfs_volume_type r360_stfs_descriptor_length
  r360_stfs_descriptor_version r360_stfs_descriptor_flags
  r360_stfs_data_file_count r360_stfs_file_table_block_count
  r360_stfs_file_table_block_number r360_stfs_total_block_count
  r360_stfs_free_block_count r360_stfs_directory_blocks_read
  r360_stfs_entry_count r360_stfs_default_xex_index r360_stfs_default_xex_kind
  r360_stfs_warnings r360_stfs_request_pending r360_stfs_request_size
  r360_stfs_request_kind r360_stfs_request_offset_lo r360_stfs_request_offset_hi
  r360_stfs_content_size_lo r360_stfs_content_size_hi
  r360_stfs_display_name_ptr r360_stfs_display_name_length
  r360_stfs_entry_name_ptr r360_stfs_entry_name_length r360_stfs_entry_flags
  r360_stfs_entry_valid_blocks r360_stfs_entry_allocated_blocks
  r360_stfs_entry_start_block r360_stfs_entry_parent_index
  r360_stfs_entry_length r360_stfs_entry_is_directory
  r360_stfs_entry_is_contiguous r360_stfs_block_offset_lo
  r360_stfs_block_offset_hi
  r360_stfs_extract_reset r360_stfs_extract_begin r360_stfs_extract_status
  r360_stfs_extract_entry_index r360_stfs_extract_current_block
  r360_stfs_extract_logical_offset r360_stfs_extract_bytes_total
  r360_stfs_extract_bytes_done r360_stfs_extract_blocks_done
  r360_stfs_extract_is_contiguous
  r360_feature_bits
)

ARGS=(
  --target=wasm32 -std=c++20 -O2 -nostdlib -I"$ROOT"
  -Wl,--no-entry -Wl,--export-memory
  -Wl,--initial-memory=16777216 -Wl,--max-memory=16777216
)
for symbol in "${EXPORTS[@]}"; do
  ARGS+=("-Wl,--export=$symbol")
done

"$CXX" "${ARGS[@]}" -o "$OUT" "$SRC"
printf 'Built %s from %s\n' "$OUT" "$(basename "$SRC")"
