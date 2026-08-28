/**
 * Render360 browser host shim for Xenia's platform switch.
 *
 * This file intentionally contains host/platform facts only. It does not
 * replace any Xbox 360 emulation behavior.
 */
#ifndef XENIA_BASE_PLATFORM_H_
#define XENIA_BASE_PLATFORM_H_

#if !defined(__EMSCRIPTEN__)
#error Render360 Xenia web platform shim requires Emscripten.
#endif

#define XE_PLATFORM_WEB 1
#define XE_COMPILER_CLANG 1
#define XE_ARCH_WASM32 1

#if defined(__wasm64__)
#define XE_ARCH_WASM64 1
#endif

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
