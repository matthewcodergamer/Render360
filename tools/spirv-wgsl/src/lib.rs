use naga::{
    back::wgsl::{self, WriterFlags},
    front::spv,
    valid::{Capabilities, ValidationFlags, Validator},
};
use wasm_bindgen::prelude::*;

fn js_error(prefix: &str, error: impl core::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{prefix}: {error}"))
}

fn js_debug_error(prefix: &str, error: impl core::fmt::Debug) -> JsValue {
    JsValue::from_str(&format!("{prefix}: {error:#?}"))
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
    let info = match Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
    {
        Ok(info) => info,
        Err(error) => {
            // Keep validation strict, but expose the parsed IR type table so a
            // Vulkan-oriented Xenia resource construct can be lowered
            // deliberately for WebGPU instead of being guessed from a handle
            // number such as "Type [29]".
            let mut types = String::new();
            for (handle, ty) in module.types.iter() {
                use core::fmt::Write as _;
                let _ = writeln!(&mut types, "{handle:?}: {ty:#?}");
            }
            return Err(JsValue::from_str(&format!(
                "Naga validation failed: {error:#?}\nNAGA_PARSED_TYPES_BEGIN\n{types}NAGA_PARSED_TYPES_END"
            )));
        }
    };
    let source = wgsl::write_string(&module, &info, WriterFlags::empty())
        .map_err(|e| js_debug_error("Naga WGSL write failed", e))?;
    if source.trim().is_empty() {
        return Err(JsValue::from_str("Naga produced empty WGSL"));
    }
    Ok(source)
}

#[wasm_bindgen]
pub fn converter_version() -> String {
    format!("render360-naga-{}", env!("CARGO_PKG_VERSION"))
}
