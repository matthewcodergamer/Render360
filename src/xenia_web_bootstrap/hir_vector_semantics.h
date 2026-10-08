// Render360 HIR vector semantics.
//
// Scalar transcription of Xenia's x64 backend vector sequences
// (src/xenia/cpu/backend/x64/x64_seq_vector.cc, x64_sequences.cc) so the
// browser HIR executor computes exactly what Xenia computes. Values use
// Xenia's in-register layout: vec128_t u32[k] is PPC word k, u16[k ^ 1] is
// PPC halfword k and u8[j ^ 3] is PPC byte j - the layout every Xenia
// LOAD/STORE with byte swap produces. Where Xenia's sequence is built from
// SSE shuffles with constant tables, the same instructions are modelled on
// the same constants (Xmm helpers below) instead of re-deriving the format.
//
// Xenia's own PPC instruction tests (src/xenia/cpu/ppc/testing/*.s) are the
// oracle; see test-xenia-ppc-instruction-suite.mjs.

#ifndef RENDER360_HIR_VECTOR_SEMANTICS_H_
#define RENDER360_HIR_VECTOR_SEMANTICS_H_

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>

#include "third_party/half/include/half.hpp"
#include "xenia/base/vec128.h"
#include "xenia/cpu/hir/opcodes.h"

namespace render360::xenia_web::vector_semantics {

using xe::vec128_t;
using xe::vec128b;
using xe::vec128f;
using xe::vec128i;

// --- SSE instruction models (lane order = xmm dword/word/byte order) ------

inline float BitsToFloat(uint32_t v) { float f; std::memcpy(&f, &v, 4); return f; }
inline uint32_t FloatToBits(float f) { uint32_t v; std::memcpy(&v, &f, 4); return v; }

inline vec128_t PShufB(const vec128_t& a, const vec128_t& control) {
  vec128_t r;
  for (int i = 0; i < 16; ++i) {
    const uint8_t c = control.u8[i];
    r.u8[i] = (c & 0x80) ? 0 : a.u8[c & 0x0F];
  }
  return r;
}
// maxps/minps return the second operand when either is NaN.
inline vec128_t MaxPS(const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int i = 0; i < 4; ++i) r.f32[i] = a.f32[i] > b.f32[i] ? a.f32[i] : b.f32[i];
  return r;
}
inline vec128_t MinPS(const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int i = 0; i < 4; ++i) r.f32[i] = a.f32[i] < b.f32[i] ? a.f32[i] : b.f32[i];
  return r;
}
inline vec128_t PAnd(const vec128_t& a, const vec128_t& b) {
  vec128_t r; r.u64[0] = a.u64[0] & b.u64[0]; r.u64[1] = a.u64[1] & b.u64[1]; return r;
}
inline vec128_t POr(const vec128_t& a, const vec128_t& b) {
  vec128_t r; r.u64[0] = a.u64[0] | b.u64[0]; r.u64[1] = a.u64[1] | b.u64[1]; return r;
}
inline vec128_t PSllD(const vec128_t& a, int n) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.u32[i] = a.u32[i] << n; return r;
}
inline vec128_t PSrlD(const vec128_t& a, int n) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.u32[i] = a.u32[i] >> n; return r;
}
inline vec128_t PSraD(const vec128_t& a, int n) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.i32[i] = a.i32[i] >> n; return r;
}
inline vec128_t PSraW(const vec128_t& a, int n) {
  vec128_t r; for (int i = 0; i < 8; ++i) r.i16[i] = int16_t(a.i16[i] >> n); return r;
}
inline vec128_t PAddD(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.u32[i] = a.u32[i] + b.u32[i]; return r;
}
inline vec128_t CmpEqPS(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.u32[i] = a.f32[i] == b.f32[i] ? ~0u : 0u; return r;
}
inline vec128_t BlendVPS(const vec128_t& a, const vec128_t& b, const vec128_t& mask) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.u32[i] = (mask.u32[i] & 0x80000000u) ? b.u32[i] : a.u32[i]; return r;
}
inline vec128_t ShufPS(const vec128_t& a, const vec128_t& b, uint8_t imm) {
  vec128_t r;
  r.u32[0] = a.u32[imm & 3]; r.u32[1] = a.u32[(imm >> 2) & 3];
  r.u32[2] = b.u32[(imm >> 4) & 3]; r.u32[3] = b.u32[(imm >> 6) & 3];
  return r;
}
inline vec128_t PShufD(const vec128_t& a, uint8_t imm) { return ShufPS(a, a, imm); }
inline vec128_t PShufLW(const vec128_t& a, uint8_t imm) {
  vec128_t r = a; for (int i = 0; i < 4; ++i) r.u16[i] = a.u16[(imm >> (2 * i)) & 3]; return r;
}
inline vec128_t PShufHW(const vec128_t& a, uint8_t imm) {
  vec128_t r = a; for (int i = 0; i < 4; ++i) r.u16[4 + i] = a.u16[4 + ((imm >> (2 * i)) & 3)]; return r;
}
inline vec128_t PBlendW(const vec128_t& a, const vec128_t& b, uint8_t imm) {
  vec128_t r; for (int i = 0; i < 8; ++i) r.u16[i] = (imm >> i) & 1 ? b.u16[i] : a.u16[i]; return r;
}
inline vec128_t PMinUD(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 4; ++i) r.u32[i] = std::min(a.u32[i], b.u32[i]); return r;
}
inline vec128_t PUnpackLBW(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 8; ++i) { r.u8[2 * i] = a.u8[i]; r.u8[2 * i + 1] = b.u8[i]; } return r;
}
inline vec128_t PUnpackHBW(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 8; ++i) { r.u8[2 * i] = a.u8[8 + i]; r.u8[2 * i + 1] = b.u8[8 + i]; } return r;
}
inline vec128_t PUnpackLWD(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 4; ++i) { r.u16[2 * i] = a.u16[i]; r.u16[2 * i + 1] = b.u16[i]; } return r;
}
inline vec128_t PUnpackHWD(const vec128_t& a, const vec128_t& b) {
  vec128_t r; for (int i = 0; i < 4; ++i) { r.u16[2 * i] = a.u16[4 + i]; r.u16[2 * i + 1] = b.u16[4 + i]; } return r;
}
template <typename T, typename S>
inline T SaturateTo(S v) {
  if (v < S(std::numeric_limits<T>::min())) return std::numeric_limits<T>::min();
  if (v > S(std::numeric_limits<T>::max())) return std::numeric_limits<T>::max();
  return T(v);
}
inline vec128_t PackSSWB(const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int i = 0; i < 8; ++i) { r.i8[i] = SaturateTo<int8_t>(int32_t(a.i16[i])); r.i8[8 + i] = SaturateTo<int8_t>(int32_t(b.i16[i])); }
  return r;
}
inline vec128_t PackUSWB(const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int i = 0; i < 8; ++i) { r.u8[i] = SaturateTo<uint8_t>(int32_t(a.i16[i])); r.u8[8 + i] = SaturateTo<uint8_t>(int32_t(b.i16[i])); }
  return r;
}
inline vec128_t PackSSDW(const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int i = 0; i < 4; ++i) { r.i16[i] = SaturateTo<int16_t>(int64_t(a.i32[i])); r.i16[4 + i] = SaturateTo<int16_t>(int64_t(b.i32[i])); }
  return r;
}
inline vec128_t PackUSDW(const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int i = 0; i < 4; ++i) { r.u16[i] = SaturateTo<uint16_t>(int64_t(a.i32[i])); r.u16[4 + i] = SaturateTo<uint16_t>(int64_t(b.i32[i])); }
  return r;
}
constexpr uint8_t Shuffle(int z, int y, int x, int w) { return uint8_t((z << 6) | (y << 4) | (x << 2) | w); }

// --- x64_emitter.cc xmm_consts used by PACK/UNPACK ------------------------
// Functions, not globals: the browser core has no global constructors.
inline vec128_t kXMMOne() { return vec128f(1.0f); }
inline vec128_t kXMM0001() { return vec128f(0.0f, 0.0f, 0.0f, 1.0f); }
inline vec128_t kXMM3301() { return vec128f(3.0f, 3.0f, 0.0f, 1.0f); }
inline vec128_t kXMM3331() { return vec128f(3.0f, 3.0f, 3.0f, 1.0f); }
inline vec128_t kXMM3333() { return vec128f(3.0f, 3.0f, 3.0f, 3.0f); }
inline vec128_t kXMMQNaN() { return vec128i(0x7FC00000u); }
inline vec128_t kXMMByteOrderMask() { return vec128i(0x01000302u, 0x05040706u, 0x09080B0Au, 0x0D0C0F0Eu); }
inline vec128_t kXMMPackD3DCOLORSat() { return vec128i(0x404000FFu); }
inline vec128_t kXMMPackD3DCOLOR() { return vec128i(0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0x0C000408u); }
inline vec128_t kXMMUnpackD3DCOLOR() { return vec128i(0xFFFFFF0Eu, 0xFFFFFF0Du, 0xFFFFFF0Cu, 0xFFFFFF0Fu); }
inline vec128_t kXMMPackSHORT_Min() { return vec128i(0x403F8001u); }
inline vec128_t kXMMPackSHORT_Max() { return vec128i(0x40407FFFu); }
inline vec128_t kXMMPackSHORT_2() { return vec128i(0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0x01000504u); }
inline vec128_t kXMMPackSHORT_4() { return vec128i(0xFFFFFFFFu, 0xFFFFFFFFu, 0x01000504u, 0x09080D0Cu); }
inline vec128_t kXMMUnpackSHORT_2() { return vec128i(0xFFFF0F0Eu, 0xFFFF0D0Cu, 0xFFFFFFFFu, 0xFFFFFFFFu); }
inline vec128_t kXMMUnpackSHORT_4() { return vec128i(0xFFFF0B0Au, 0xFFFF0908u, 0xFFFF0F0Eu, 0xFFFF0D0Cu); }
inline vec128_t kXMMUnpackSHORT_Overflow() { return vec128i(0x403F8000u); }
inline vec128_t kXMMPackUINT_2101010_MinUnpacked() { return vec128i(0x403FFE01u, 0x403FFE01u, 0x403FFE01u, 0x40400000u); }
inline vec128_t kXMMPackUINT_2101010_MaxUnpacked() { return vec128i(0x404001FFu, 0x404001FFu, 0x404001FFu, 0x40400003u); }
inline vec128_t kXMMPackUINT_2101010_MaskUnpacked() { return vec128i(0x3FFu, 0x3FFu, 0x3FFu, 0x3u); }
inline vec128_t kXMMPackUINT_2101010_MaskPacked() { return vec128i(0x3FFu, 0x3FFu << 10, 0x3FFu << 20, 0x3u << 30); }
inline vec128_t kXMMPackUINT_2101010_Shift() { return vec128i(0, 10, 20, 30); }
inline vec128_t kXMMUnpackUINT_2101010_Overflow() { return vec128i(0x403FFE00u); }
inline vec128_t kXMMPackULONG_4202020_MinUnpacked() { return vec128i(0x40380001u, 0x40380001u, 0x40380001u, 0x40400000u); }
inline vec128_t kXMMPackULONG_4202020_MaxUnpacked() { return vec128i(0x4047FFFFu, 0x4047FFFFu, 0x4047FFFFu, 0x4040000Fu); }
inline vec128_t kXMMPackULONG_4202020_MaskUnpacked() { return vec128i(0xFFFFFu, 0xFFFFFu, 0xFFFFFu, 0xFu); }
inline vec128_t kXMMPackULONG_4202020_PermuteXZ() { return vec128i(0xFFFFFFFFu, 0xFFFFFFFFu, 0x0A0908FFu, 0xFF020100u); }
inline vec128_t kXMMPackULONG_4202020_PermuteYW() { return vec128i(0xFFFFFFFFu, 0xFFFFFFFFu, 0x0CFFFF06u, 0x0504FFFFu); }
inline vec128_t kXMMUnpackULONG_4202020_Permute() { return vec128i(0xFF0E0D0Cu, 0xFF0B0A09u, 0xFF080F0Eu, 0xFFFFFF0Bu); }
inline vec128_t kXMMUnpackULONG_4202020_Overflow() { return vec128i(0x40380000u); }

// --- OPCODE_PACK ----------------------------------------------------------
inline bool Pack(uint32_t flags, const vec128_t& src1, const vec128_t& src2, vec128_t* out) {
  using namespace xe::cpu::hir;
  vec128_t d;
  switch (flags & PACK_TYPE_MODE) {
    case PACK_TYPE_D3DCOLOR:
      // max before min so NaN packs as zero.
      d = MinPS(MaxPS(src1, kXMM3333()), kXMMPackD3DCOLORSat());
      *out = PShufB(d, kXMMPackD3DCOLOR());
      return true;
    case PACK_TYPE_FLOAT16_2:
    case PACK_TYPE_FLOAT16_4: {
      // EmulateFLOAT16_2/4: round toward zero.
      vec128_t b{};
      const bool four = (flags & PACK_TYPE_MODE) == PACK_TYPE_FLOAT16_4;
      for (int i = 0; i < (four ? 4 : 2); ++i) {
        b.u16[7 - (four ? (i ^ 2) : i)] =
            half_float::detail::float2half<std::round_toward_zero>(src1.f32[i]);
      }
      *out = b;
      return true;
    }
    case PACK_TYPE_SHORT_2:
    case PACK_TYPE_SHORT_4:
      d = MinPS(MaxPS(src1, kXMMPackSHORT_Min()), kXMMPackSHORT_Max());
      *out = PShufB(d, (flags & PACK_TYPE_MODE) == PACK_TYPE_SHORT_2 ? kXMMPackSHORT_2() : kXMMPackSHORT_4());
      return true;
    case PACK_TYPE_UINT_2101010: {
      d = MinPS(MaxPS(src1, kXMMPackUINT_2101010_MinUnpacked()), kXMMPackUINT_2101010_MaxUnpacked());
      d = PAnd(d, kXMMPackUINT_2101010_MaskUnpacked());
      for (int i = 0; i < 4; ++i) d.u32[i] <<= kXMMPackUINT_2101010_Shift().u32[i];
      d = POr(d, ShufPS(d, d, Shuffle(2, 3, 0, 1)));
      d = POr(d, ShufPS(d, d, Shuffle(1, 0, 3, 2)));
      *out = d;
      return true;
    }
    case PACK_TYPE_ULONG_4202020: {
      d = MinPS(MaxPS(src1, kXMMPackULONG_4202020_MinUnpacked()), kXMMPackULONG_4202020_MaxUnpacked());
      d = PAnd(d, kXMMPackULONG_4202020_MaskUnpacked());
      const vec128_t yw = PShufB(PSllD(d, 4), kXMMPackULONG_4202020_PermuteYW());
      *out = POr(PShufB(d, kXMMPackULONG_4202020_PermuteXZ()), yw);
      return true;
    }
    case PACK_TYPE_8_IN_16: {
      const bool in_unsigned = IsPackInUnsigned(flags), out_unsigned = IsPackOutUnsigned(flags), sat = IsPackOutSaturate(flags);
      if (in_unsigned && out_unsigned) {
        vec128_t c{};
        for (int i = 0; i < 8; ++i) {
          c.u8[i] = sat ? uint8_t(std::min<uint16_t>(255, src1.u16[i])) : src1.u8[i * 2];
          c.u8[i + 8] = sat ? uint8_t(std::min<uint16_t>(255, src2.u16[i])) : src2.u8[i * 2];
        }
        *out = PShufB(c, kXMMByteOrderMask());
        return true;
      }
      if (!in_unsigned && out_unsigned && sat) { *out = PShufB(PackUSWB(src1, src2), kXMMByteOrderMask()); return true; }
      if (!in_unsigned && !out_unsigned && sat) { *out = PShufB(PackSSWB(src1, src2), kXMMByteOrderMask()); return true; }
      return false;  // assert_always() in Xenia.
    }
    case PACK_TYPE_16_IN_32: {
      const bool in_unsigned = IsPackInUnsigned(flags), out_unsigned = IsPackOutUnsigned(flags), sat = IsPackOutSaturate(flags);
      if (in_unsigned && out_unsigned) {
        const vec128_t max = vec128i(0xFFFFu);
        vec128_t lo = sat ? PMinUD(src1, max) : src1;
        vec128_t hi = sat ? PMinUD(src2, max) : src2;
        lo = PShufD(PShufHW(PShufLW(lo, 0b00100010), 0b00100010), 0b00001000);
        hi = PShufD(PShufHW(PShufLW(hi, 0b00100010), 0b00100010), 0b10000000);
        *out = PBlendW(hi, lo, 0b00001111);
        return true;
      }
      if (!in_unsigned && sat) {
        d = out_unsigned ? PackUSDW(src1, src2) : PackSSDW(src1, src2);
        *out = PShufHW(PShufLW(d, 0b10110001), 0b10110001);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// --- OPCODE_UNPACK --------------------------------------------------------
inline bool Unpack(uint32_t flags, const vec128_t& src, vec128_t* out) {
  using namespace xe::cpu::hir;
  vec128_t d;
  auto finish = [&](const vec128_t& bias, const vec128_t& overflow) {
    d = PAddD(d, bias);
    *out = BlendVPS(d, kXMMQNaN(), CmpEqPS(d, overflow));
  };
  switch (flags & PACK_TYPE_MODE) {
    case PACK_TYPE_D3DCOLOR:
      *out = POr(PShufB(src, kXMMUnpackD3DCOLOR()), kXMMOne());
      return true;
    case PACK_TYPE_FLOAT16_2: {
      vec128_t b{};
      for (int i = 0; i < 2; ++i) b.f32[i] = half_float::detail::half2float(src.u16[(6 + i) ^ 1]);
      b.f32[2] = 0.0f;
      b.f32[3] = 1.0f;
      *out = b;
      return true;
    }
    case PACK_TYPE_FLOAT16_4: {
      vec128_t b{};
      for (int i = 0; i < 4; ++i) b.f32[i] = half_float::detail::half2float(src.u16[(4 + i) ^ 1]);
      *out = b;
      return true;
    }
    case PACK_TYPE_SHORT_2:
      d = PSraD(PSllD(PShufB(src, kXMMUnpackSHORT_2()), 16), 16);
      finish(kXMM3301(), kXMMUnpackSHORT_Overflow());
      return true;
    case PACK_TYPE_SHORT_4:
      d = PSraD(PSllD(PShufB(src, kXMMUnpackSHORT_4()), 16), 16);
      finish(kXMM3333(), kXMMUnpackSHORT_Overflow());
      return true;
    case PACK_TYPE_UINT_2101010:
      d = PAnd(ShufPS(src, src, Shuffle(3, 3, 3, 3)), kXMMPackUINT_2101010_MaskPacked());
      for (int i = 0; i < 4; ++i) d.u32[i] >>= kXMMPackUINT_2101010_Shift().u32[i];
      d = PSraD(PSllD(d, 22), 22);
      finish(kXMM3331(), kXMMUnpackUINT_2101010_Overflow());
      return true;
    case PACK_TYPE_ULONG_4202020: {
      d = PShufB(src, kXMMUnpackULONG_4202020_Permute());
      const vec128_t shifted = PSrlD(d, 4);
      d = ShufPS(d, shifted, Shuffle(3, 2, 1, 0));
      d = ShufPS(d, d, Shuffle(3, 1, 2, 0));
      d = PSraD(PSllD(d, 12), 12);
      finish(kXMM3331(), kXMMUnpackULONG_4202020_Overflow());
      return true;
    }
    case PACK_TYPE_8_IN_16:
      if (IsPackOutSaturate(flags) || IsPackInUnsigned(flags) || IsPackOutUnsigned(flags)) return false;
      d = PShufB(src, kXMMByteOrderMask());
      d = IsPackToLo(flags) ? PUnpackHBW(d, d) : PUnpackLBW(d, d);
      *out = PSraW(d, 8);
      return true;
    case PACK_TYPE_16_IN_32:
      if (IsPackOutSaturate(flags) || IsPackInUnsigned(flags) || IsPackOutUnsigned(flags)) return false;
      d = IsPackToLo(flags) ? PUnpackHWD(src, src) : PUnpackLWD(src, src);
      *out = PShufD(PSraD(d, 16), 0xB1);
      return true;
    default:
      return false;
  }
}

// --- OPCODE_PERMUTE -------------------------------------------------------
// PERMUTE_I32: control word lanes select (bit 2 = src3) a word.
inline vec128_t PermuteI32(uint32_t control, const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int k = 0; k < 4; ++k) {
    const uint32_t sel = (control >> (8 * k)) & 0x7;
    r.u32[k] = (sel & 4) ? b.u32[sel & 3] : a.u32[sel & 3];
  }
  return r;
}
// PERMUTE_V128 by bytes (vperm) or halfwords: PPC element j of the result is
// element (control_j & mask) of the PPC-ordered concatenation a || b.
inline vec128_t PermuteBytes(const vec128_t& control, const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int j = 0; j < 16; ++j) {
    const uint8_t c = control.u8[j ^ 3] & 0x1F;
    r.u8[j ^ 3] = c < 16 ? a.u8[c ^ 3] : b.u8[(c - 16) ^ 3];
  }
  return r;
}
inline vec128_t PermuteHalves(const vec128_t& control, const vec128_t& a, const vec128_t& b) {
  vec128_t r;
  for (int j = 0; j < 8; ++j) {
    const uint16_t c = control.u16[j ^ 1] & 0xF;
    r.u16[j ^ 1] = c < 8 ? a.u16[c ^ 1] : b.u16[(c - 8) ^ 1];
  }
  return r;
}

// --- OPCODE_VECTOR_CONVERT ------------------------------------------------
inline vec128_t VectorConvertI2F(const vec128_t& a, bool is_unsigned) {
  vec128_t r;
  for (int i = 0; i < 4; ++i) r.f32[i] = is_unsigned ? float(a.u32[i]) : float(a.i32[i]);
  return r;
}
// Saturating truncation; NaN converts to 0 (vctsxs/vctuxs).
inline vec128_t VectorConvertF2I(const vec128_t& a, bool is_unsigned) {
  vec128_t r;
  for (int i = 0; i < 4; ++i) {
    const float f = a.f32[i];
    if (std::isnan(f)) { r.u32[i] = 0; continue; }
    if (is_unsigned) {
      r.u32[i] = f <= 0.0f ? 0u : (f >= 4294967296.0f ? 0xFFFFFFFFu : uint32_t(f));
    } else {
      r.i32[i] = f <= -2147483648.0f ? INT32_MIN : (f >= 2147483648.0f ? INT32_MAX : int32_t(f));
    }
  }
  return r;
}

// --- lane arithmetic ------------------------------------------------------
template <typename T>
inline T AddSat(T a, T b) { using W = int64_t; return SaturateTo<T>(W(a) + W(b)); }
template <typename T>
inline T SubSat(T a, T b) { using W = int64_t; return SaturateTo<T>(W(a) - W(b)); }

// VECTOR_ADD / VECTOR_SUB: flags = part_type | arithmetic_flags << 8.
inline bool VectorAddSub(uint32_t flags, bool subtract, const vec128_t& a, const vec128_t& b, vec128_t* out) {
  using namespace xe::cpu::hir;
  const auto part = TypeName(flags & 0xFF);
  const uint32_t arith = flags >> 8;
  const bool is_unsigned = arith & ARITHMETIC_UNSIGNED, sat = arith & ARITHMETIC_SATURATE;
  vec128_t r;
#define R360_LANES(N, U, S, FU, FS)                                              \
  for (int i = 0; i < N; ++i) {                                                  \
    if (!sat) {                                                                  \
      r.FU[i] = U(subtract ? U(a.FU[i] - b.FU[i]) : U(a.FU[i] + b.FU[i]));        \
    } else if (is_unsigned) {                                                    \
      r.FU[i] = subtract ? SubSat<U>(a.FU[i], b.FU[i]) : AddSat<U>(a.FU[i], b.FU[i]); \
    } else {                                                                     \
      r.FS[i] = subtract ? SubSat<S>(a.FS[i], b.FS[i]) : AddSat<S>(a.FS[i], b.FS[i]); \
    }                                                                            \
  }
  switch (part) {
    case INT8_TYPE: R360_LANES(16, uint8_t, int8_t, u8, i8) break;
    case INT16_TYPE: R360_LANES(8, uint16_t, int16_t, u16, i16) break;
    case INT32_TYPE: R360_LANES(4, uint32_t, int32_t, u32, i32) break;
    case FLOAT32_TYPE:
      for (int i = 0; i < 4; ++i) r.f32[i] = subtract ? a.f32[i] - b.f32[i] : a.f32[i] + b.f32[i];
      break;
    default:
      return false;
  }
#undef R360_LANES
  *out = r;
  return true;
}

// VECTOR_MAX / VECTOR_MIN: flags = arithmetic_flags | part_type << 8.
inline bool VectorMinMax(uint32_t flags, bool is_max, const vec128_t& a, const vec128_t& b, vec128_t* out) {
  using namespace xe::cpu::hir;
  const auto part = TypeName(flags >> 8);
  const bool is_unsigned = flags & ARITHMETIC_UNSIGNED;
  vec128_t r;
#define R360_MM(N, FU, FS)                                                        \
  for (int i = 0; i < N; ++i) {                                                   \
    if (is_unsigned) r.FU[i] = is_max ? std::max(a.FU[i], b.FU[i]) : std::min(a.FU[i], b.FU[i]); \
    else r.FS[i] = is_max ? std::max(a.FS[i], b.FS[i]) : std::min(a.FS[i], b.FS[i]); \
  }
  switch (part) {
    case INT8_TYPE: R360_MM(16, u8, i8) break;
    case INT16_TYPE: R360_MM(8, u16, i16) break;
    case INT32_TYPE: R360_MM(4, u32, i32) break;
    default: return false;
  }
#undef R360_MM
  *out = r;
  return true;
}

// VECTOR_COMPARE_* with FLOAT32 lanes (vcmpeqps/vcmpgtps/vcmpgeps).
inline bool VectorCompareFloat(uint32_t opcode, const vec128_t& a, const vec128_t& b, vec128_t* out) {
  using namespace xe::cpu::hir;
  vec128_t r;
  for (int i = 0; i < 4; ++i) {
    bool yes;
    switch (opcode) {
      case OPCODE_VECTOR_COMPARE_EQ: yes = a.f32[i] == b.f32[i]; break;
      case OPCODE_VECTOR_COMPARE_SGT: case OPCODE_VECTOR_COMPARE_UGT: yes = a.f32[i] > b.f32[i]; break;
      case OPCODE_VECTOR_COMPARE_SGE: case OPCODE_VECTOR_COMPARE_UGE: yes = a.f32[i] >= b.f32[i]; break;
      default: return false;
    }
    r.u32[i] = yes ? ~0u : 0u;
  }
  *out = r;
  return true;
}

// VECTOR_ROTATE_LEFT (EmulateVectorRotateLeft) / VECTOR_AVERAGE.
inline bool VectorRotateLeft(uint32_t part, const vec128_t& a, const vec128_t& b, vec128_t* out) {
  using namespace xe::cpu::hir;
  vec128_t r;
#define R360_ROL(N, F, U, BITS)                                                   \
  for (int i = 0; i < N; ++i) {                                                   \
    const unsigned s = b.F[i] & (BITS - 1);                                       \
    r.F[i] = s ? U((a.F[i] << s) | (a.F[i] >> (BITS - s))) : a.F[i];              \
  }
  switch (part) {
    case INT8_TYPE: R360_ROL(16, u8, uint8_t, 8) break;
    case INT16_TYPE: R360_ROL(8, u16, uint16_t, 16) break;
    case INT32_TYPE: R360_ROL(4, u32, uint32_t, 32) break;
    default: return false;
  }
#undef R360_ROL
  *out = r;
  return true;
}
inline bool VectorAverage(uint32_t flags, const vec128_t& a, const vec128_t& b, vec128_t* out) {
  using namespace xe::cpu::hir;
  const auto part = TypeName(flags & 0xFF);
  const bool is_unsigned = (flags >> 8) & ARITHMETIC_UNSIGNED;
  vec128_t r;
#define R360_AVG(N, FU, FS)                                                       \
  for (int i = 0; i < N; ++i) {                                                   \
    if (is_unsigned) r.FU[i] = std::remove_reference_t<decltype(r.FU[0])>((uint64_t(a.FU[i]) + b.FU[i] + 1) >> 1); \
    else r.FS[i] = std::remove_reference_t<decltype(r.FS[0])>((int64_t(a.FS[i]) + b.FS[i] + 1) >> 1);      \
  }
  switch (part) {
    case INT8_TYPE: R360_AVG(16, u8, i8) break;
    case INT16_TYPE: R360_AVG(8, u16, i16) break;
    case INT32_TYPE: R360_AVG(4, u32, i32) break;
    default: return false;
  }
#undef R360_AVG
  *out = r;
  return true;
}

// DOT_PRODUCT_3/4 (vdpps): lane-0 sum; an overflow to infinity yields QNaN.
inline float DotProduct(const vec128_t& a, const vec128_t& b, int lanes) {
  float sum = 0.0f;
  bool finite_inputs = true;
  for (int i = 0; i < lanes; ++i) {
    if (!std::isfinite(a.f32[i]) || !std::isfinite(b.f32[i])) finite_inputs = false;
    sum += a.f32[i] * b.f32[i];
  }
  if (finite_inputs && std::isinf(sum)) return BitsToFloat(0x7FC00000u);
  return sum;
}

}  // namespace render360::xenia_web::vector_semantics

#endif  // RENDER360_HIR_VECTOR_SEMANTICS_H_
