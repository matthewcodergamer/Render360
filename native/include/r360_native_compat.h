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
#endif
