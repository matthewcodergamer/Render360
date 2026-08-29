#include <algorithm>
#include <array>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string_view>
#include <utility>

#include "xenia/base/logging.h"

namespace xe {
namespace {
thread_local std::array<char, 64 * 1024> g_log_buffer{};
}  // namespace

FileLogSink::~FileLogSink() {
  if (file_) {
    std::fflush(file_);
    if (owns_file_) std::fclose(file_);
  }
}

void FileLogSink::Write(const char* buf, size_t size) {
  if (file_ && buf && size) std::fwrite(buf, 1, size, file_);
}

void FileLogSink::Flush() {
  if (file_) std::fflush(file_);
}

void DebugPrintLogSink::Write(const char* buf, size_t size) {
  // Browser bootstrap logging deliberately avoids a native writer thread.
  // Host UI/JS telemetry can consume exported probe state separately.
  (void)buf;
  (void)size;
}

void InitializeLogging(const std::string_view app_name) { (void)app_name; }
void ShutdownLogging() {}

namespace logging {

bool ShouldLog(LogLevel log_level) {
  // Keep error/warning/info formatting paths live so upstream Xenia code does
  // not need logging-specific source changes. The browser sink is synchronous.
  return static_cast<int>(log_level) <= static_cast<int>(LogLevel::Info);
}

namespace internal {

std::pair<char*, size_t> GetThreadBuffer() {
  return {g_log_buffer.data(), g_log_buffer.size() - 1};
}

void AppendLogLine(LogLevel log_level, const char prefix_char, size_t written) {
  (void)log_level;
  (void)prefix_char;
  const size_t clamped = std::min(written, g_log_buffer.size() - 1);
  g_log_buffer[clamped] = '\0';
  // Do not create a native logging thread or filesystem sink in wasm32. The
  // formatted line remains available in the thread-local buffer during the
  // call and diagnostics are surfaced through Render360 probe telemetry.
}

}  // namespace internal

void AppendLogLine(LogLevel log_level, const char prefix_char,
                   const std::string_view str) {
  if (!ShouldLog(log_level)) return;
  auto target = internal::GetThreadBuffer();
  const size_t count = std::min(target.second, str.size());
  if (count) std::memcpy(target.first, str.data(), count);
  internal::AppendLogLine(log_level, prefix_char, count);
}

}  // namespace logging

void FatalError(const std::string_view str) {
  logging::AppendLogLine(LogLevel::Error, logging::kPrefixCharError, str);
  std::abort();
}

}  // namespace xe

// Xenia's vendored libmspack LZX decoder is C code and uses this diagnostic
// callback directly. Keep the ABI, but avoid native stderr/filesystem/thread
// dependencies in the browser bootstrap. Decoder success/failure is surfaced
// through explicit Render360 status exports and CI critics.
extern "C" void xenia_log(const char* format, ...) {
  (void)format;
}
