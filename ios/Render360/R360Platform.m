#import "R360Platform.h"

#include <fcntl.h>
#include <mach/mach.h>
#include <os/proc.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

uint64_t r360_platform_available_memory(void) { return (uint64_t)os_proc_available_memory(); }

uint64_t r360_platform_footprint(void) {
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return info.phys_footprint;
}

static int g_breadcrumb_fd = -1;

void r360_breadcrumb_open(const char* path) {
  if (g_breadcrumb_fd >= 0) close(g_breadcrumb_fd);
  g_breadcrumb_fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
}

static void write_line(const char* line) {
  if (g_breadcrumb_fd < 0) return;
  char stamp[32];
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  const int n = snprintf(stamp, sizeof(stamp), "%lld.%03ld ", (long long)ts.tv_sec, ts.tv_nsec / 1000000);
  write(g_breadcrumb_fd, stamp, (size_t)n);
  write(g_breadcrumb_fd, line, strlen(line));
  write(g_breadcrumb_fd, "\n", 1);
}

void r360_breadcrumb(const char* line) {
  write_line(line);
  if (g_breadcrumb_fd >= 0) fsync(g_breadcrumb_fd);
}

static void crash_handler(int sig) {
  // Async-signal-safe only: write + fsync, then re-raise for the system report.
  char line[64];
  const char* name = sig == SIGSEGV ? "SIGSEGV" : sig == SIGBUS ? "SIGBUS" : sig == SIGILL ? "SIGILL"
                   : sig == SIGABRT ? "SIGABRT" : sig == SIGFPE ? "SIGFPE" : sig == SIGTRAP ? "SIGTRAP" : "signal";
  size_t n = 0;
  const char* prefix = "CRASH ";
  for (const char* p = prefix; *p; ++p) line[n++] = *p;
  for (const char* p = name; *p && n < sizeof(line) - 2; ++p) line[n++] = *p;
  line[n++] = '\n';
  if (g_breadcrumb_fd >= 0) {
    write(g_breadcrumb_fd, line, n);
    fsync(g_breadcrumb_fd);
  }
  signal(sig, SIG_DFL);
  raise(sig);
}

void r360_install_crash_handlers(void) {
  const int signals[] = {SIGSEGV, SIGBUS, SIGILL, SIGABRT, SIGFPE, SIGTRAP};
  for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i) signal(signals[i], crash_handler);
}
