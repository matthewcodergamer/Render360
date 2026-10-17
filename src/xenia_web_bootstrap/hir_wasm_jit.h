#pragma once

#include <cstdint>

namespace xe::cpu::hir {
class Block;
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
  // The compiled code holds no pointer into its HIR builder (no single-op
  // executor fallbacks), so it can run after the builder is freed.
  bool builder_free = false;
  // No HIR value is used outside its defining block, so the code can be
  // entered at any block head (JitOsrFunction).
  bool osr_capable = false;
};

// Compiled code can run (a JIT compiler is installed and enabled).
bool JitEnabled();

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

// Entering compiled code from the interpreter (on-stack replacement): a
// function entered once that loops (a thread's main loop, a wait loop) never
// reaches the call-count threshold and would stay interpreted.
// The slot the interpreter's current run of `builder` belongs to (the
// candidate JitTakeFunction declined, or one an interior entry never took).
JitSlot* JitTakeOsrSlot(xe::cpu::hir::HIRBuilder* builder);
// Compiled function for entering `builder` mid-run, compiling it now when
// `hot` (else when it has run often enough); 0 when it cannot be entered.
uint32_t JitOsrFunction(xe::cpu::hir::HIRBuilder* builder, JitSlot* slot, bool hot);
// Dispatcher segment where `block` starts in the compiled function.
uint32_t JitSegmentOfBlock(xe::cpu::hir::HIRBuilder* builder,
                           const xe::cpu::hir::Block* block);

// The cache entry owning `slot` is being destroyed.
void JitReleaseSlot(JitSlot* slot);

// Generated function return values.
constexpr uint32_t kJitStatusFailed = 0;     // blocker recorded by a helper
constexpr uint32_t kJitStatusReturned = 1;   // reached a RETURN
constexpr uint32_t kJitStatusFellOff = 2;    // ran past the last block
constexpr uint32_t kJitStatusUnwinding = 3;  // Asyncify unwind in progress

}  // namespace render360::xenia_web
