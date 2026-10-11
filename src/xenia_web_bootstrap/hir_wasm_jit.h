#pragma once

#include <cstdint>

namespace xe::cpu::hir {
class HIRBuilder;
}

// Render360 guest JIT: compiles a finalized Xenia HIRBuilder (the same HIR
// the HIR executor interprets) into one WebAssembly function, the way Xenia's
// x64 backend compiles it to machine code. The browser host instantiates the
// generated module next to the core (render360-guest-jit.mjs) and places the
// function in the core's indirect function table.
//
// Generated code shares the core's linear memory: the PPCContext is accessed
// in place, and guest calls, guest memory, atomics and other side effects go
// through helpers exported by the HIR executor (hir_jit_glue.inc), so their
// behaviour is the executor's. A function that uses HIR the JIT does not
// lower yet stays on the executor.
//
// Guest threads are Asyncify fibers: a guest call made from generated code may
// unwind. Each call site is a resumable segment; on unwind the function stores
// its locals in the fiber's Asyncify buffer and returns, and on rewind it
// reloads them and re-issues the call, following Binaryen's Asyncify protocol.
namespace render360::xenia_web {

// Compiled-code state of one translation-cache entry (probe_backend.cpp):
// its lifetime is the cached translation's, so code is never reused for a
// different builder.
struct JitSlot {
  uint32_t function = 0;  // table index of the compiled function
  uint32_t state = 0;     // 0 not compiled, 1 compile pending, 2 not compilable
  uint32_t runs = 0;
  uint32_t request = 0;   // pending asynchronous compile request id
};

// The next HIR execution of `builder` belongs to `slot` (set by the cache just
// before it runs the builder).
void JitSetCandidate(xe::cpu::hir::HIRBuilder* builder, JitSlot* slot);

// Table index of the compiled function for `builder` (signature
// (i32 context) -> i32 status), or 0 to run it on the executor. Consumes the
// candidate set above; counts runs and requests compilation when hot.
uint32_t JitTakeFunction(xe::cpu::hir::HIRBuilder* builder);

// Why the last JitTakeFunction returned 0: 1 uncached execution, 2 cold,
// 3 compile pending, 4 not compilable, 5 JIT off.
uint32_t JitLastDecision();
// First HIR opcode that kept `builder` from compiling (diagnostics).
uint32_t JitRejectOpcode(xe::cpu::hir::HIRBuilder* builder);

// The cache entry owning `slot` is being destroyed.
void JitReleaseSlot(JitSlot* slot);

// Generated function return values.
constexpr uint32_t kJitStatusFailed = 0;     // blocker recorded by a helper
constexpr uint32_t kJitStatusReturned = 1;   // reached a RETURN
constexpr uint32_t kJitStatusFellOff = 2;    // ran past the last block
constexpr uint32_t kJitStatusUnwinding = 3;  // Asyncify unwind in progress

}  // namespace render360::xenia_web
