// Force-included by native/build-native.sh. Darwin's off_t is always 64-bit,
// so Xenia's glibc *64 POSIX names map directly onto the plain ones.
#pragma once
#if defined(__APPLE__)
#define off64_t off_t
#define ftello64 ftello
#define fseeko64 fseeko
#define ftruncate64 ftruncate
#define mmap64 mmap
#define lseek64 lseek
#define pread64 pread
#define pwrite64 pwrite
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
// The iOS SDK has no stat64; off_t/stat are 64-bit already.
#define stat64 stat
#define fstat64 fstat
#endif
#endif
