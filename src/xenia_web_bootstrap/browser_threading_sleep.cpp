// Render360 V33 browser host adapter for the one Xenia threading primitive
// required by the translation-only runtime closure.
//
// This is host behavior, not Xbox behavior. Keep the Xbox-facing CPU/module
// implementation upstream Xenia; provide the POSIX-style sleep operation with
// libc nanosleep so standalone wasm32 does not need Xenia's full native
// pthread/signal/timer thread subsystem merely to translate PPC into HIR.

#include "xenia/base/threading.h"

#include <cerrno>
#include <chrono>
#include <ctime>

namespace xe {
namespace threading {

void Sleep(std::chrono::microseconds duration) {
  if (duration.count() <= 0) {
    return;
  }

  const auto nanoseconds =
      std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();
  timespec requested{};
  requested.tv_sec = static_cast<time_t>(nanoseconds / 1000000000LL);
  requested.tv_nsec = static_cast<long>(nanoseconds % 1000000000LL);

  timespec remaining{};
  while (nanosleep(&requested, &remaining) == -1 && errno == EINTR) {
    requested = remaining;
  }
}

}  // namespace threading
}  // namespace xe
