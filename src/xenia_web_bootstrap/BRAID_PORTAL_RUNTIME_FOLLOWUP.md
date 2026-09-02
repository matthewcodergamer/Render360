# Braid / Portal runtime follow-up

This marker documents the September 2026 runtime correctness follow-up and intentionally participates in the Xenia WASM32 bootstrap path filter.

The associated source change makes SparseGuestMemory authoritative for real-title HIR loads/stores, permitting the movable xe::Memory decoder window only for addresses inside the currently loaded synthetic probe window. It also records the Xenia scanner-discovered function end and surfaces assembled-function / HIR-block telemetry for scanned-entry zero-HIR diagnosis.

The full Xenia WASM32 bootstrap must rebuild and publish after these changes before device testing.
