/**
 * Render360 browser host atomic adapter for Xenia.
 *
 * Uses Clang/Emscripten atomic builtins so Xenia portable code doesn't need to
 * pretend wasm32 is Win32, Linux, x64 or ARM64.
 */
#ifndef XENIA_BASE_ATOMIC_H_
#define XENIA_BASE_ATOMIC_H_

#include <cstdint>
#include "xenia/base/platform.h"

namespace xe {

inline int32_t atomic_inc(volatile int32_t* value) {
  return __atomic_add_fetch(value, int32_t{1}, __ATOMIC_SEQ_CST);
}
inline int32_t atomic_dec(volatile int32_t* value) {
  return __atomic_sub_fetch(value, int32_t{1}, __ATOMIC_SEQ_CST);
}
inline int32_t atomic_exchange(int32_t new_value, volatile int32_t* value) {
  return __atomic_exchange_n(value, new_value, __ATOMIC_SEQ_CST);
}
inline int64_t atomic_exchange(int64_t new_value, volatile int64_t* value) {
  return __atomic_exchange_n(value, new_value, __ATOMIC_SEQ_CST);
}
inline int32_t atomic_exchange_add(int32_t amount, volatile int32_t* value) {
  return __atomic_fetch_add(value, amount, __ATOMIC_SEQ_CST);
}
inline int64_t atomic_exchange_add(int64_t amount, volatile int64_t* value) {
  return __atomic_fetch_add(value, amount, __ATOMIC_SEQ_CST);
}
inline bool atomic_cas(int32_t old_value, int32_t new_value,
                       volatile int32_t* value) {
  int32_t expected = old_value;
  return __atomic_compare_exchange_n(value, &expected, new_value, false,
                                     __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
}
inline bool atomic_cas(int64_t old_value, int64_t new_value,
                       volatile int64_t* value) {
  int64_t expected = old_value;
  return __atomic_compare_exchange_n(value, &expected, new_value, false,
                                     __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
}

inline uint32_t atomic_inc(volatile uint32_t* value) {
  return static_cast<uint32_t>(atomic_inc(
      reinterpret_cast<volatile int32_t*>(value)));
}
inline uint32_t atomic_dec(volatile uint32_t* value) {
  return static_cast<uint32_t>(atomic_dec(
      reinterpret_cast<volatile int32_t*>(value)));
}
inline uint32_t atomic_exchange(uint32_t new_value, volatile uint32_t* value) {
  return static_cast<uint32_t>(atomic_exchange(
      static_cast<int32_t>(new_value),
      reinterpret_cast<volatile int32_t*>(value)));
}
inline uint64_t atomic_exchange(uint64_t new_value, volatile uint64_t* value) {
  return static_cast<uint64_t>(atomic_exchange(
      static_cast<int64_t>(new_value),
      reinterpret_cast<volatile int64_t*>(value)));
}
inline uint32_t atomic_exchange_add(uint32_t amount,
                                    volatile uint32_t* value) {
  return static_cast<uint32_t>(atomic_exchange_add(
      static_cast<int32_t>(amount),
      reinterpret_cast<volatile int32_t*>(value)));
}
inline uint64_t atomic_exchange_add(uint64_t amount,
                                    volatile uint64_t* value) {
  return static_cast<uint64_t>(atomic_exchange_add(
      static_cast<int64_t>(amount),
      reinterpret_cast<volatile int64_t*>(value)));
}
inline bool atomic_cas(uint32_t old_value, uint32_t new_value,
                       volatile uint32_t* value) {
  return atomic_cas(static_cast<int32_t>(old_value),
                    static_cast<int32_t>(new_value),
                    reinterpret_cast<volatile int32_t*>(value));
}
inline bool atomic_cas(uint64_t old_value, uint64_t new_value,
                       volatile uint64_t* value) {
  return atomic_cas(static_cast<int64_t>(old_value),
                    static_cast<int64_t>(new_value),
                    reinterpret_cast<volatile int64_t*>(value));
}

}  // namespace xe

#endif  // XENIA_BASE_ATOMIC_H_
