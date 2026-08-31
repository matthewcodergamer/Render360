#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/package-core.cpp"
DECODER="$ROOT/src/xenia_web_bootstrap/xex_image_decoder.cpp"
DECODER_EXPORTS="$ROOT/src/xenia_web_bootstrap/xex_image_decoder_exports.cpp"
PREPARER="$ROOT/src/xenia_web_bootstrap/xex_image_preparer.cpp"
PREPARER_EXPORTS="$ROOT/src/xenia_web_bootstrap/xex_image_preparer_exports.cpp"
PE_IMAGE="$ROOT/src/xenia_web_bootstrap/xex_pe_image.cpp"
PE_EXPORTS="$ROOT/src/xenia_web_bootstrap/xex_pe_image_exports.cpp"
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
  r360_stfs_extract_reset r360_stfs_extract_begin r360_stfs_extract_default_xex
  r360_stfs_extract_status r360_stfs_extract_entry_index
  r360_stfs_extract_current_block r360_stfs_extract_logical_offset
  r360_stfs_extract_bytes_total r360_stfs_extract_bytes_done
  r360_stfs_extract_blocks_done r360_stfs_extract_expected_blocks
  r360_stfs_extract_declared_valid_blocks
  r360_stfs_extract_declared_allocated_blocks r360_stfs_extract_is_contiguous
  r360_xex_decode_reset r360_xex_decode r360_xex_decode_status
  r360_xex_decode_module_flags r360_xex_decode_header_size
  r360_xex_decode_security_offset r360_xex_decode_header_count
  r360_xex_decode_entry_point r360_xex_decode_image_base
  r360_xex_decode_system_flags r360_xex_decode_execution_info_offset
  r360_xex_decode_file_format_info_offset r360_xex_decode_import_libraries_offset
  r360_xex_decode_title_id r360_xex_decode_media_id r360_xex_decode_image_size
  r360_xex_decode_image_flags r360_xex_decode_load_address
  r360_xex_decode_region r360_xex_decode_allowed_media_types
  r360_xex_decode_encryption_type r360_xex_decode_compression_type
  r360_xex_decode_page_size r360_xex_decode_page_descriptor_count
  r360_xex_decode_mapped_span r360_xex_decode_page_type
  r360_xex_decode_page_count r360_xex_decode_page_address r360_xex_decode_page_bytes
  r360_xex_prepare_reset r360_xex_prepare_none_begin r360_xex_prepare_none_accept
  r360_xex_prepare_basic_begin r360_xex_prepare_basic_accept_data
  r360_xex_prepare_basic_consume_zero r360_xex_prepare_basic_data_remaining
  r360_xex_prepare_basic_zero_remaining
  r360_xex_prepare_normal_frame_begin r360_xex_prepare_normal_frame_accept
  r360_xex_prepare_status r360_xex_prepare_source_offset
  r360_xex_prepare_source_bytes r360_xex_prepare_output_bytes
  r360_xex_prepare_bytes_done r360_xex_prepare_output_done
  r360_xex_prepare_encryption_type r360_xex_prepare_compression_type
  r360_xex_prepare_basic_block_count r360_xex_prepare_basic_block_index
  r360_xex_prepare_normal_window_size r360_xex_prepare_normal_block_size
  r360_xex_prepare_normal_block_seen r360_xex_prepare_normal_blocks_done
  r360_xex_prepare_last_output_kind r360_xex_prepare_last_output_bytes
  r360_xex_pe_reset r360_xex_pe_decode r360_xex_pe_status
  r360_xex_pe_nt_offset r360_xex_pe_machine r360_xex_pe_characteristics
  r360_xex_pe_section_count r360_xex_pe_entry_rva r360_xex_pe_image_base
  r360_xex_pe_section_alignment r360_xex_pe_file_alignment
  r360_xex_pe_size_of_image r360_xex_pe_size_of_headers r360_xex_pe_subsystem
  r360_xex_pe_section_virtual_address r360_xex_pe_section_virtual_size
  r360_xex_pe_section_raw_address r360_xex_pe_section_raw_size
  r360_xex_pe_section_characteristics
  r360_feature_bits
)

ARGS=(
  --target=wasm32 -std=c++20 -O2 -nostdlib -I"$ROOT"
  -I"$ROOT/src/xenia_web_bootstrap"
  -Wl,--no-entry -Wl,--export-memory
  -Wl,--initial-memory=16777216 -Wl,--max-memory=16777216
)
for symbol in "${EXPORTS[@]}"; do ARGS+=("-Wl,--export=$symbol"); done

"$CXX" "${ARGS[@]}" -o "$OUT" \
  "$SRC" "$DECODER" "$DECODER_EXPORTS" "$PREPARER" "$PREPARER_EXPORTS" \
  "$PE_IMAGE" "$PE_EXPORTS"
printf 'Built %s from canonical package core + XEX decode/preparation/PE layers\n' "$OUT"
