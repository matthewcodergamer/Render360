/**
 * Render360 native (macOS / iOS) host shim for Xenia's platform switch.
 *
 * The native build deliberately takes the same portable code paths as the
 * browser build (sparse guest memory, no host page mapping tricks, no x64
 * backend) so that native and wasm runs stay deterministic and comparable.
 * XE_ARCH_WASM32 therefore means "Render360 portable host" here;
 * R360_NATIVE marks the places where 64-bit host pointers differ.
 */
#ifndef XENIA_BASE_PLATFORM_H_
#define XENIA_BASE_PLATFORM_H_

#if !defined(R360_NATIVE)
#error native/include must only be used by native/build-native.sh
#endif

#define XE_PLATFORM_WEB 1
#define XE_COMPILER_CLANG 1
#define XE_ARCH_WASM32 1

#define _XEPACKEDSCOPE(body)     \
  _Pragma("pack(push, 1)") body; \
  _Pragma("pack(pop)");

#define XEPACKEDSTRUCT(name, value) _XEPACKEDSCOPE(struct name value)
#define XEPACKEDSTRUCTANONYMOUS(value) _XEPACKEDSCOPE(struct value)
#define XEPACKEDUNION(name, value) _XEPACKEDSCOPE(union name value)

namespace xe {
const char kPathSeparator = '/';
const char kGuestPathSeparator = '\\';
}  // namespace xe

#endif  // XENIA_BASE_PLATFORM_H_
