#pragma once

#include <cstdint>

// Guest threads for the native HIR compatibility executor.
//
// Xenia runs every XThread on its own host thread. The browser core has one
// host thread and the HIR executor keeps a guest call chain on the host stack,
// so each guest thread runs as a fiber: its own C stack, its own copy of the
// R360_FIBER_LOCAL executor state, and a Binaryen Asyncify buffer that holds
// the suspended wasm call stack. A kernel call that would block (an infinite
// wait on an unsignalled object, a contended lock) yields to another runnable
// guest thread and retries when this one is resumed. The JS driver
// (render360-guest-fibers.mjs) performs the unwind/rewind hand-off.
namespace render360::xenia_web {

// Switches to another guest thread that can make progress. Returns true after
// this thread has been resumed, false (without switching) when no other guest
// thread can run - a real deadlock or a single-threaded title. `blocked` marks
// a failed wait: this thread is only resumed after some other kernel progress.
bool GuestFiberYield(bool blocked);

// Counts a completed, non-blocking kernel service call: a blocked fiber is
// worth retrying only after some other thread made progress.
void GuestFiberNoteProgress();

// True while guest threads are scheduled as fibers (a title run in progress).
bool GuestFibersActive();

// Lowest usable address of the current fiber's C stack (headroom checks).
uintptr_t GuestFiberStackLow();

// Xenia Processor::ExecuteInterrupt: runs the guest function at `address`
// with r3/r4 as an interrupt on its own guest stack (stack_top) and KPCR
// (pcr), nested inside whatever guest code is running, with a fresh copy of
// the per-thread executor state. Interrupts do not nest and cannot yield.
bool RunGuestInterrupt(uint32_t address, uint32_t r3, uint32_t r4,
                       uint32_t stack_top, uint32_t pcr);
bool GuestInterruptActive();

}  // namespace render360::xenia_web
