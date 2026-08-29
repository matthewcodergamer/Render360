use naga::{
    back::wgsl::{self, WriterFlags},
    front::spv,
    valid::{Capabilities, ValidationFlags, Validator},
};
use wasm_bindgen::prelude::*;

fn js_error(prefix: &str, error: impl core::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{prefix}: {error}"))
}

/// Convert a complete SPIR-V binary module to WebGPU WGSL.
///
/// Render360 intentionally keeps this as a separate small WASM module from the
/// Xenia bootstrap. Xenia remains authoritative for Xenos -> SPIR-V lowering;
/// Naga only performs the standardized SPIR-V -> WGSL bridge required by web
/// WebGPU implementations such as Safari.
#[wasm_bindgen]
pub fn spirv_to_wgsl(bytes: &[u8]) -> Result<String, JsValue> {
    if bytes.len() < 20 || bytes.len() & 3 != 0 {
        return Err(JsValue::from_str("SPIR-V input must be at least 5 words and 4-byte aligned"));
    }
    if u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != 0x0723_0203 {
        return Err(JsValue::from_str("SPIR-V magic mismatch"));
    }

    let options = spv::Options {
        // Xenia's translator already owns the guest/host coordinate decisions.
        // Do not silently flip position a second time at the format bridge.
        adjust_coordinate_space: false,
        strict_capabilities: false,
        block_ctx_dump_prefix: None,
    };
    let module = spv::parse_u8_slice(bytes, &options)
        .map_err(|e| js_error("Naga SPIR-V parse failed", e))?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|e| js_error("Naga validation failed", e))?;
    let source = wgsl::write_string(&module, &info, WriterFlags::empty())
        .map_err(|e| js_error("Naga WGSL write failed", e))?;
    if source.trim().is_empty() {
        return Err(JsValue::from_str("Naga produced empty WGSL"));
    }
    Ok(source)
}

#[wasm_bindgen]
pub fn converter_version() -> String {
    format!("render360-naga-{}", env!("CARGO_PKG_VERSION"))
}
