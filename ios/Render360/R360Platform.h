// Small C helpers Swift cannot call directly.
#pragma once
#include <stddef.h>
#include <stdint.h>

// Bytes the process may still allocate before iOS jetsams it
// (os_proc_available_memory), and the current physical footprint.
uint64_t r360_platform_available_memory(void);
uint64_t r360_platform_footprint(void);
// Breadcrumbs: append one line and fsync, so the last lines survive a crash.
void r360_breadcrumb_open(const char* path);
void r360_breadcrumb(const char* line);
// Installs signal handlers that write a final breadcrumb on a crash.
void r360_install_crash_handlers(void);

// Native Xenos GPU renderer (native/gpu, wgpu-native on Metal).
int r360_gpu_backend_start(void* metal_layer);
int r360_gpu_backend_frame(int present, unsigned width, unsigned height);
const char* r360_gpu_backend_error(void);
unsigned r360_gpu_backend_errors(void);
