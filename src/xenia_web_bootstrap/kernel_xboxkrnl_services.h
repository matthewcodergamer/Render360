#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_KERNEL_XBOXKRNL_SERVICES_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_KERNEL_XBOXKRNL_SERVICES_H_

#include <cstdint>

namespace render360::xenia_web {

// Service status values shared with kernel_runtime_foundation.cpp and
// kernel_import_probe.cpp. They describe what the emulator did with a kernel
// call, not the NTSTATUS/Win32 value returned to the guest in r3.
enum KernelServiceStatus : uint32_t {
  kKernelServiceIdle = 0,
  kKernelServiceSuccess = 1,
  // The ordinal has no Render360 implementation: execution stops at an exact,
  // named blocker instead of inventing a result.
  kKernelServiceUnsupported = 2,
  // The emulator could not honour the call (bad guest pointer, missing thread
  // state). This is an emulator/ABI failure, not a guest error code.
  kKernelServiceInvalid = 3,
  // The title intentionally left: HalReturnToFirmware, KeBugCheck(Ex),
  // XamLoaderTerminateTitle, ExTerminateThread on the primary thread, ...
  // Xenia exits the process for these; Render360 stops with a terminal
  // boundary that names the reason.
  kKernelServiceTerminal = 4,
  // The call must block until another guest thread signals an object. The
  // synchronous PPC probe cannot run that thread, so it stops and reports the
  // exact wait instead of spinning or faking a signal.
  kKernelServiceWouldBlock = 5,
};

enum KernelTerminalKind : uint32_t {
  kTerminalNone = 0,
  kTerminalHalReturnToFirmware = 1,
  kTerminalBugCheck = 2,
  kTerminalThreadExit = 3,
  kTerminalTitleTerminate = 4,
  kTerminalLaunchTitle = 5,
  kTerminalProcessExit = 6,
};

// Dispatches an extended xboxkrnl/XAM export. Returns kKernelServiceIdle when
// the ordinal is not handled here so the caller can report it as unsupported.
uint32_t DispatchExtendedKernelService(uint32_t module, uint32_t ordinal,
                                       const uint32_t args[8],
                                       uint32_t* result);
void ResetExtendedKernelServices();
// KeSetCurrentStackPointers moves the calling thread's r1: returns true once
// with the new stack pointer after such a service call.
bool TakeKernelServiceStackPointer(uint32_t* value);
// A title-created guest thread running as a fiber ended: its entry returned
// (`returned`, exit code from r3) or ExTerminateThread ended it. Marks the
// thread exited and clears its thread-exit terminal so the rest of the title
// keeps running. Returns false when the thread stopped for another reason.
bool FinishGuestThreadFiber(uint32_t native, bool returned, uint32_t exit_code);
// Xenia GraphicsSystem interrupts: a 60 Hz vblank (source 0) and the PM4
// INTERRUPT packets the command processor executed (source 1) run the title's
// VdSetGraphicsInterruptCallback callback. Called at guest call boundaries.
void MaybeDeliverGuestInterrupts();

}  // namespace render360::xenia_web

extern "C" {
void r360_kernel_services_reset();
// Live PPC r13/LR/r1 of the calling guest thread. r13 points at the Xbox KPCR, so
// services can find the current KTHREAD exactly as the real kernel does.
void r360_kernel_service_set_caller(uint32_t r13, uint32_t lr, uint32_t r1);
}

#endif
