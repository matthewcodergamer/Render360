#include <array>
#include <cstdint>
#include <cstring>

#include "sparse_guest_memory.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kStatusIdle = 0;
constexpr uint32_t kStatusSuccess = 1;
constexpr uint32_t kStatusUnsupported = 2;
constexpr uint32_t kStatusInvalid = 3;
constexpr uint32_t kRegisterCount = 0x5000;
constexpr uint32_t kRingCapacity = 4096;
constexpr uint32_t kMaxIndirectDepth = 8;
constexpr uint32_t kShaderWordCapacity = 8192;
constexpr uint32_t kFrameWidth = 64;
constexpr uint32_t kFrameHeight = 64;
constexpr uint32_t kFrameBytes = kFrameWidth * kFrameHeight * 4;
constexpr uint32_t kEdramTiles = 2048;
constexpr uint32_t kTileWidth = 80;
constexpr uint32_t kTileHeight = 16;

constexpr uint32_t kRegRbSurfaceInfo = 0x2000;
constexpr uint32_t kRegRbColorInfo = 0x2001;
constexpr uint32_t kRegRbColorMask = 0x2104;
constexpr uint32_t kRegVgtEventInitiator = 0x21F9;

constexpr uint32_t kPm4Nop = 0x10;
constexpr uint32_t kPm4RegRmw = 0x21;
constexpr uint32_t kPm4DrawIndx = 0x22;
constexpr uint32_t kPm4WaitForIdle = 0x26;
constexpr uint32_t kPm4ImLoad = 0x27;
constexpr uint32_t kPm4ImLoadImmediate = 0x2B;
constexpr uint32_t kPm4SetConstant = 0x2D;
constexpr uint32_t kPm4LoadAluConstant = 0x2F;
constexpr uint32_t kPm4DrawIndx2 = 0x36;
constexpr uint32_t kPm4IndirectBufferPfd = 0x37;
constexpr uint32_t kPm4InvalidateState = 0x3B;
constexpr uint32_t kPm4MemWrite = 0x3D;
constexpr uint32_t kPm4RegToMem = 0x3E;
constexpr uint32_t kPm4IndirectBuffer = 0x3F;
constexpr uint32_t kPm4CondWrite = 0x45;
constexpr uint32_t kPm4EventWrite = 0x46;
constexpr uint32_t kPm4MeInit = 0x48;
constexpr uint32_t kPm4SetBinMask = 0x50;
constexpr uint32_t kPm4SetBinSelect = 0x51;
constexpr uint32_t kPm4Interrupt = 0x54;
constexpr uint32_t kPm4SetConstant2 = 0x55;
constexpr uint32_t kPm4SetShaderConstants = 0x56;
constexpr uint32_t kPm4EventWriteShd = 0x58;
constexpr uint32_t kPm4ContextUpdate = 0x5E;
constexpr uint32_t kPm4SetBinMaskLo = 0x60;
constexpr uint32_t kPm4SetBinMaskHi = 0x61;
constexpr uint32_t kPm4SetBinSelectLo = 0x62;
constexpr uint32_t kPm4SetBinSelectHi = 0x63;
constexpr uint32_t kPm4XeSwap = 0x64;
constexpr uint32_t kSwapSignature = 0x50415753u;

constexpr uint32_t kShaderVertex = 0;
constexpr uint32_t kShaderPixel = 1;
constexpr uint32_t kShaderSourceNone = 0;
constexpr uint32_t kShaderSourceGuestMemory = 1;
constexpr uint32_t kShaderSourceImmediate = 2;
constexpr uint32_t kFrameProvSwap = 1u << 0;
constexpr uint32_t kFrameProvVertexShader = 1u << 1;
constexpr uint32_t kFrameProvPixelShader = 1u << 2;
constexpr uint32_t kFrameProvFetchResources = 1u << 3;
constexpr uint32_t kFrameProvBoundedRaster = 1u << 4;

struct ShaderCapture {
  std::array<uint32_t, kShaderWordCapacity> words{};
  uint32_t dword_count = 0;
  uint32_t guest_address = 0;
  uint32_t hash = 0;
  uint32_t source = kShaderSourceNone;
};

std::array<uint32_t, kRegisterCount> g_regs{};
std::array<uint32_t, kRingCapacity> g_ring{};
std::array<uint32_t, kFrameWidth * kFrameHeight> g_edram_linear{};
std::array<uint8_t, kFrameBytes> g_frame{};
ShaderCapture g_vertex_shader{};
ShaderCapture g_pixel_shader{};
uint32_t g_status = kStatusIdle;
uint32_t g_ring_words = 0;
uint32_t g_packets = 0;
uint32_t g_register_writes = 0;
uint32_t g_draws = 0;
uint32_t g_presents = 0;
uint32_t g_swaps = 0;
uint32_t g_indirect_buffers = 0;
uint32_t g_shader_loads = 0;
uint32_t g_memory_writes = 0;
uint32_t g_interrupts = 0;
uint32_t g_last_interrupt_mask = 0;
uint32_t g_last_opcode = 0;
uint32_t g_last_fault_word = 0;
uint32_t g_last_fault_depth = 0;
uint32_t g_last_invalidate_mask = 0;
uint32_t g_frame_generation = 0;
uint32_t g_frame_hash = 0;
uint32_t g_frontbuffer_ptr = 0;
uint32_t g_frontbuffer_width = 0;
uint32_t g_frontbuffer_height = 0;
uint64_t g_bin_mask = 0xFFFFFFFFull;
uint64_t g_bin_select = 0xFFFFFFFFull;

uint32_t ByteSwap32(uint32_t v) {
  return ((v & 0x000000FFu) << 24) | ((v & 0x0000FF00u) << 8) |
         ((v & 0x00FF0000u) >> 8) | ((v & 0xFF000000u) >> 24);
}
uint32_t GpuSwap32(uint32_t v, uint32_t endian) {
  switch (endian & 3u) {
    case 0: return v;
    case 1: return ((v & 0x00FF00FFu) << 8) | ((v & 0xFF00FF00u) >> 8);
    case 2: return ByteSwap32(v);
    case 3: return (v << 16) | (v >> 16);
  }
  return v;
}
uint32_t HashWords(const uint32_t* words, uint32_t count) {
  uint32_t h = 2166136261u;
  for (uint32_t i = 0; i < count; ++i) for (int s = 24; s >= 0; s -= 8) {
    h ^= (words[i] >> s) & 0xFFu; h *= 16777619u;
  }
  return h;
}
uint32_t HashFrame() {
  uint32_t h = 2166136261u;
  for (uint8_t b : g_frame) { h ^= b; h *= 16777619u; }
  return h;
}
bool ReadGuestWordBE(uint32_t address, uint32_t* out) {
  if (!out || address > 0xFFFFFFFCu) return false;
  uint8_t b[4] = {};
  if (!ReadSparseGuestMemory(address, b, 4)) return false;
  *out = (uint32_t(b[0]) << 24) | (uint32_t(b[1]) << 16) |
         (uint32_t(b[2]) << 8) | uint32_t(b[3]);
  return true;
}
bool WriteGuestGpuWord(uint32_t encoded_address, uint32_t value) {
  const uint32_t endian = encoded_address & 3u;
  const uint32_t address = encoded_address & ~3u;
  if (address > 0xFFFFFFFCu) return false;
  const uint32_t v = GpuSwap32(value, endian);
  const uint8_t b[4] = {uint8_t(v), uint8_t(v >> 8), uint8_t(v >> 16), uint8_t(v >> 24)};
  if (!WriteSparseGuestMemory(address, b, 4)) return false;
  ++g_memory_writes;
  return true;
}
bool ReadGuestGpuWord(uint32_t encoded_address, uint32_t* out) {
  uint32_t be = 0;
  if (!out || !ReadGuestWordBE(encoded_address & ~3u, &be)) return false;
  *out = GpuSwap32(ByteSwap32(be), encoded_address & 3u);
  return true;
}
bool CompareWait(uint32_t info, uint32_t value, uint32_t ref, uint32_t mask) {
  value &= mask;
  switch (info & 7u) {
    case 0: return false; case 1: return value < ref; case 2: return value <= ref;
    case 3: return value == ref; case 4: return value != ref; case 5: return value >= ref;
    case 6: return value > ref; case 7: return true;
  }
  return false;
}
void SetFault(uint32_t word, uint32_t depth, uint32_t status) {
  g_last_fault_word = word; g_last_fault_depth = depth; g_status = status;
}
void ClearFrame(uint32_t rgba) { g_edram_linear.fill(rgba); }
void RasterTriangle(uint32_t rgba) {
  for (uint32_t y = 8; y < 56; ++y) {
    const uint32_t half = (y - 8) / 2;
    const uint32_t x0 = 32 > half ? 32 - half : 0;
    const uint32_t x1 = 32 + half;
    for (uint32_t x = x0; x <= x1 && x < kFrameWidth; ++x)
      g_edram_linear[y * kFrameWidth + x] = rgba;
  }
}
void ResolveEdramToFrame() {
  for (uint32_t i = 0; i < kFrameWidth * kFrameHeight; ++i) {
    const uint32_t c = g_edram_linear[i];
    g_frame[i * 4] = uint8_t(c >> 24); g_frame[i * 4 + 1] = uint8_t(c >> 16);
    g_frame[i * 4 + 2] = uint8_t(c >> 8); g_frame[i * 4 + 3] = uint8_t(c);
  }
  g_frame_hash = HashFrame(); ++g_frame_generation; ++g_presents;
}
bool WriteRegister(uint32_t index, uint32_t value) {
  if (index >= g_regs.size()) { g_status = kStatusInvalid; return false; }
  g_regs[index] = value; ++g_register_writes; return true;
}
ShaderCapture* ShaderForType(uint32_t type) {
  return type == kShaderVertex ? &g_vertex_shader : type == kShaderPixel ? &g_pixel_shader : nullptr;
}
void ResetShaderCapture(ShaderCapture* s) {
  if (!s) return; s->dword_count = s->guest_address = s->hash = 0; s->source = kShaderSourceNone;
}
bool CaptureShader(uint32_t type, uint32_t address, const uint32_t* words,
                   uint32_t count, uint32_t source) {
  ShaderCapture* s = ShaderForType(type);
  if (!s || !words || !count || count > kShaderWordCapacity) {
    g_status = count > kShaderWordCapacity ? kStatusUnsupported : kStatusInvalid; return false;
  }
  std::memcpy(s->words.data(), words, count * sizeof(uint32_t));
  s->dword_count = count; s->guest_address = address; s->hash = HashWords(words, count);
  s->source = source; ++g_shader_loads; return true;
}
bool CaptureShaderFromGuest(uint32_t type, uint32_t address, uint32_t count) {
  if (!count || count > kShaderWordCapacity) {
    g_status = count > kShaderWordCapacity ? kStatusUnsupported : kStatusInvalid; return false;
  }
  ShaderCapture* s = ShaderForType(type);
  if (!s) { g_status = kStatusInvalid; return false; }
  for (uint32_t i = 0; i < count; ++i) {
    const uint64_t a = uint64_t(address) + uint64_t(i) * 4u;
    if (a > 0xFFFFFFFCull || !ReadGuestWordBE(uint32_t(a), &s->words[i])) {
      g_status = kStatusInvalid; return false;
    }
  }
  s->dword_count = count; s->guest_address = address; s->hash = HashWords(s->words.data(), count);
  s->source = kShaderSourceGuestMemory; ++g_shader_loads; return true;
}
bool HasFetchResources() {
  for (uint32_t i = 0x4800; i < 0x48C0; ++i) if (g_regs[i]) return true;
  return false;
}
uint32_t FrameProvenance() {
  uint32_t p = 0;
  if (g_swaps) p |= kFrameProvSwap;
  if (g_vertex_shader.dword_count) p |= kFrameProvVertexShader;
  if (g_pixel_shader.dword_count) p |= kFrameProvPixelShader;
  if (HasFetchResources()) p |= kFrameProvFetchResources;
  if (g_draws) p |= kFrameProvBoundedRaster;
  return p;
}
bool ExecuteDraw(uint32_t opcode, const uint32_t* payload, uint32_t count) {
  if (!count) { g_status = kStatusInvalid; return false; }
  const uint32_t initiator = payload[count - 1], primitive = initiator & 0x3Fu;
  if (!primitive || primitive > 0x0Fu) { g_status = kStatusUnsupported; return false; }
  const uint32_t seed = g_regs[kRegRbColorInfo] ^
      (g_regs[kRegRbColorMask] ? g_regs[kRegRbColorMask] : 0xFu) ^ initiator;
  const uint32_t rgba = ((0x40u + (seed & 0x7Fu)) << 24) |
      ((0x40u + ((seed >> 7) & 0x7Fu)) << 16) |
      ((0x40u + ((seed >> 14) & 0x7Fu)) << 8) | 0xFFu;
  RasterTriangle(rgba); ++g_draws; g_last_opcode = opcode; return true;
}
bool ExecuteSwap(const uint32_t* payload, uint32_t count) {
  if (count < 4u || payload[0] != kSwapSignature) {
    g_status = count < 4u ? kStatusInvalid : kStatusUnsupported; return false;
  }
  if (!payload[2] || !payload[3] || payload[2] > 8192u || payload[3] > 8192u) {
    g_status = kStatusInvalid; return false;
  }
  g_frontbuffer_ptr = payload[1]; g_frontbuffer_width = payload[2];
  g_frontbuffer_height = payload[3]; ++g_swaps; ResolveEdramToFrame(); return true;
}
bool WriteConstantGroup(uint32_t offset_type, const uint32_t* values, uint32_t count) {
  uint32_t index = offset_type & 0x7FFu;
  switch ((offset_type >> 16) & 0xFFu) {
    case 0: index += 0x4000u; break; case 1: index += 0x4800u; break;
    case 2: index += 0x4900u; break; case 3: index += 0x4908u; break;
    case 4: index += 0x2000u; break; default: g_status = kStatusUnsupported; return false;
  }
  if (index >= kRegisterCount || count > kRegisterCount - index) { g_status = kStatusInvalid; return false; }
  for (uint32_t n = 0; n < count; ++n) if (!WriteRegister(index + n, values[n])) return false;
  return true;
}

bool ExecuteBuffer(const uint32_t* words, uint32_t word_count, uint32_t depth) {
  if (!words || depth > kMaxIndirectDepth) { SetFault(0, depth, kStatusInvalid); return false; }
  uint32_t i = 0;
  while (i < word_count) {
    const uint32_t header_index = i, header = words[i++];
    if (!header) { ++g_packets; continue; }
    const uint32_t type = header >> 30; ++g_packets;
    if (type == 0) {
      const uint32_t count = ((header >> 16) & 0x3FFFu) + 1u, base = header & 0x7FFFu;
      const bool one = ((header >> 15) & 1u) != 0;
      if (count > word_count - i || base >= kRegisterCount || (!one && count > kRegisterCount - base)) {
        SetFault(header_index, depth, kStatusInvalid); return false;
      }
      for (uint32_t n = 0; n < count; ++n) if (!WriteRegister(one ? base : base + n, words[i + n])) {
        SetFault(header_index, depth, kStatusInvalid); return false;
      }
      i += count; continue;
    }
    if (type == 1) {
      if (word_count - i < 2u || !WriteRegister(header & 0x7FFu, words[i]) ||
          !WriteRegister((header >> 11) & 0x7FFu, words[i + 1])) {
        SetFault(header_index, depth, kStatusInvalid); return false;
      }
      i += 2; continue;
    }
    if (type == 2) continue;
    if (type != 3) { SetFault(header_index, depth, kStatusUnsupported); return false; }
    const uint32_t count = ((header >> 16) & 0x3FFFu) + 1u, opcode = (header >> 8) & 0x7Fu;
    if (count > word_count - i) { SetFault(header_index, depth, kStatusInvalid); return false; }
    const uint32_t* p = words + i; g_last_opcode = opcode; bool handled = true;
    switch (opcode) {
      case kPm4Nop: case kPm4MeInit: case kPm4WaitForIdle: break;
      case kPm4DrawIndx: case kPm4DrawIndx2: handled = ExecuteDraw(opcode, p, count); break;
      case kPm4XeSwap: handled = ExecuteSwap(p, count); break;
      case kPm4RegRmw: {
        if (count != 3u) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t info = p[0], target = info & 0x1FFFu;
        if (target >= kRegisterCount) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t ai = p[1] & 0x1FFFu, oi = p[2] & 0x1FFFu;
        if (((info >> 31) & 1u) && ai >= kRegisterCount) { handled = false; g_status = kStatusInvalid; break; }
        if (((info >> 30) & 1u) && oi >= kRegisterCount) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t av = ((info >> 31) & 1u) ? g_regs[ai] : p[1];
        const uint32_t ov = ((info >> 30) & 1u) ? g_regs[oi] : p[2];
        handled = WriteRegister(target, (g_regs[target] & av) | ov); break;
      }
      case kPm4RegToMem:
        if (count != 2u || p[0] >= kRegisterCount) { handled = false; g_status = kStatusInvalid; }
        else if (!(handled = WriteGuestGpuWord(p[1], g_regs[p[0]]))) g_status = kStatusInvalid;
        break;
      case kPm4MemWrite: {
        if (count < 2u) { handled = false; g_status = kStatusInvalid; break; }
        uint32_t address = p[0];
        for (uint32_t n = 1; n < count && handled; ++n) {
          handled = WriteGuestGpuWord(address, p[n]);
          address = (address & 3u) | ((address & ~3u) + 4u);
        }
        if (!handled) g_status = kStatusInvalid; break;
      }
      case kPm4CondWrite: {
        if (count != 6u) { handled = false; g_status = kStatusInvalid; break; }
        uint32_t value = 0;
        if (p[0] & 0x10u) handled = ReadGuestGpuWord(p[1], &value);
        else if (p[1] >= kRegisterCount) handled = false;
        else value = g_regs[p[1]];
        if (!handled) { g_status = kStatusInvalid; break; }
        if (CompareWait(p[0], value, p[2], p[3])) {
          handled = (p[0] & 0x100u) ? WriteGuestGpuWord(p[4], p[5]) : WriteRegister(p[4], p[5]);
          if (!handled) g_status = kStatusInvalid;
        }
        break;
      }
      case kPm4EventWrite:
        if (!count) { handled = false; g_status = kStatusInvalid; }
        else { handled = WriteRegister(kRegVgtEventInitiator, p[0] & 0x3Fu); if (handled && count > 1u) { handled = false; g_status = kStatusUnsupported; } }
        break;
      case kPm4EventWriteShd:
        if (count != 3u) { handled = false; g_status = kStatusInvalid; }
        else { handled = WriteRegister(kRegVgtEventInitiator, p[0] & 0x3Fu) &&
                         WriteGuestGpuWord(p[1], (p[0] >> 31) ? g_presents : p[2]); if (!handled) g_status = kStatusInvalid; }
        break;
      case kPm4Interrupt:
        if (count != 1u) { handled = false; g_status = kStatusInvalid; }
        else { ++g_interrupts; g_last_interrupt_mask = p[0] & 0x3Fu; }
        break;
      case kPm4SetConstant:
        handled = count && WriteConstantGroup(p[0], p + 1, count - 1u); if (!handled && g_status == kStatusIdle) g_status = kStatusInvalid; break;
      case kPm4SetConstant2: case kPm4SetShaderConstants: {
        if (!count) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t index = p[0] & 0xFFFFu, n = count - 1u;
        if (index >= kRegisterCount || n > kRegisterCount - index) { handled = false; g_status = kStatusInvalid; break; }
        for (uint32_t q = 0; q < n && handled; ++q) handled = WriteRegister(index + q, p[q + 1]);
        break;
      }
      case kPm4LoadAluConstant: {
        if (count < 3u) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t address = p[0] & 0x3FFFFFFFu, offset_type = p[1], n = p[2] & 0xFFFu;
        if (!n || n > kRegisterCount) { handled = false; g_status = kStatusInvalid; break; }
        std::array<uint32_t, kRegisterCount> loaded{};
        for (uint32_t q = 0; q < n; ++q) {
          const uint64_t a = uint64_t(address) + uint64_t(q) * 4u;
          if (a > 0xFFFFFFFCull || !ReadGuestWordBE(uint32_t(a), &loaded[q])) { handled = false; g_status = kStatusInvalid; break; }
        }
        if (handled) handled = WriteConstantGroup(offset_type, loaded.data(), n); break;
      }
      case kPm4ImLoad: {
        if (count < 2u) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t type = p[0] & 3u, address = p[0] & ~3u, start = p[1] >> 16, n = p[1] & 0xFFFFu;
        if (start) { handled = false; g_status = kStatusUnsupported; }
        else handled = CaptureShaderFromGuest(type, address, n); break;
      }
      case kPm4ImLoadImmediate: {
        if (count < 2u) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t start = p[1] >> 16, n = p[1] & 0xFFFFu;
        if (start || n > count - 2u) { handled = false; g_status = start ? kStatusUnsupported : kStatusInvalid; }
        else handled = CaptureShader(p[0], 0, p + 2, n, kShaderSourceImmediate); break;
      }
      case kPm4IndirectBuffer: case kPm4IndirectBufferPfd: {
        if (count < 2u || depth >= kMaxIndirectDepth) { handled = false; g_status = kStatusInvalid; break; }
        const uint32_t address = p[0] & ~3u, n = p[1] & 0xFFFFFu;
        if (!n || n > kRingCapacity) { handled = false; g_status = n > kRingCapacity ? kStatusUnsupported : kStatusInvalid; break; }
        std::array<uint32_t, kRingCapacity> ib{};
        for (uint32_t q = 0; q < n; ++q) {
          const uint64_t a = uint64_t(address) + uint64_t(q) * 4u;
          if (a > 0xFFFFFFFCull || !ReadGuestWordBE(uint32_t(a), &ib[q])) { handled = false; g_status = kStatusInvalid; break; }
        }
        if (handled) { ++g_indirect_buffers; handled = ExecuteBuffer(ib.data(), n, depth + 1u); }
        break;
      }
      case kPm4InvalidateState:
        if (!count) { handled = false; g_status = kStatusInvalid; } else g_last_invalidate_mask = p[0]; break;
      case kPm4ContextUpdate:
        if (count != 1u || p[0]) { handled = false; g_status = kStatusUnsupported; } break;
      case kPm4SetBinMaskLo:
        if (count != 1u) { handled = false; g_status = kStatusInvalid; } else g_bin_mask = (g_bin_mask & 0xFFFFFFFF00000000ull) | p[0]; break;
      case kPm4SetBinMaskHi:
        if (count != 1u) { handled = false; g_status = kStatusInvalid; } else g_bin_mask = (g_bin_mask & 0xFFFFFFFFull) | (uint64_t(p[0]) << 32); break;
      case kPm4SetBinSelectLo:
        if (count != 1u) { handled = false; g_status = kStatusInvalid; } else g_bin_select = (g_bin_select & 0xFFFFFFFF00000000ull) | p[0]; break;
      case kPm4SetBinSelectHi:
        if (count != 1u) { handled = false; g_status = kStatusInvalid; } else g_bin_select = (g_bin_select & 0xFFFFFFFFull) | (uint64_t(p[0]) << 32); break;
      case kPm4SetBinMask:
        if (count != 2u) { handled = false; g_status = kStatusInvalid; } else g_bin_mask = (uint64_t(p[0]) << 32) | p[1]; break;
      case kPm4SetBinSelect:
        if (count != 2u) { handled = false; g_status = kStatusInvalid; } else g_bin_select = (uint64_t(p[0]) << 32) | p[1]; break;
      default: handled = false; g_status = kStatusUnsupported; break;
    }
    if (!handled) {
      if (g_last_fault_depth < depth || g_status == kStatusIdle) g_last_fault_depth = depth;
      if (g_last_fault_depth == depth) g_last_fault_word = header_index;
      if (g_status == kStatusIdle) g_status = kStatusUnsupported;
      return false;
    }
    i += count;
  }
  return true;
}
bool Execute() { if (!ExecuteBuffer(g_ring.data(), g_ring_words, 0)) return false; g_status = kStatusSuccess; return true; }
void Reset() {
  g_regs.fill(0); g_ring.fill(0); g_frame.fill(0);
  ResetShaderCapture(&g_vertex_shader); ResetShaderCapture(&g_pixel_shader);
  ClearFrame(0x101018FFu); g_status = kStatusIdle;
  g_ring_words = g_packets = g_register_writes = g_draws = g_presents = 0;
  g_swaps = g_indirect_buffers = g_shader_loads = g_memory_writes = 0;
  g_interrupts = g_last_interrupt_mask = 0;
  g_last_opcode = g_last_fault_word = g_last_fault_depth = g_last_invalidate_mask = 0;
  g_frame_generation = g_frame_hash = 0;
  g_frontbuffer_ptr = g_frontbuffer_width = g_frontbuffer_height = 0;
  g_bin_mask = g_bin_select = 0xFFFFFFFFull;
}
uint32_t EdramTileAddress(uint32_t base, uint32_t pitch, uint32_t x, uint32_t y) {
  if (!pitch) return 0xFFFFFFFFu;
  return (base + (y / kTileHeight) * ((pitch + kTileWidth - 1u) / kTileWidth) + x / kTileWidth) % kEdramTiles;
}
const ShaderCapture* ShaderForExport(uint32_t type) {
  return type == kShaderVertex ? &g_vertex_shader : type == kShaderPixel ? &g_pixel_shader : nullptr;
}
}  // namespace
}  // namespace render360::xenia_web

extern "C" {
void r360_xenos_reset(){render360::xenia_web::Reset();}
uint32_t r360_xenos_ring_buffer(){return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::g_ring.data()));}
uint32_t r360_xenos_ring_capacity(){return render360::xenia_web::kRingCapacity;}
uint32_t r360_xenos_submit(uint32_t n){if(n>render360::xenia_web::kRingCapacity){render360::xenia_web::g_status=render360::xenia_web::kStatusInvalid;return 0;}render360::xenia_web::g_ring_words=n;return render360::xenia_web::Execute()?1u:0u;}
uint32_t r360_xenos_status(){return render360::xenia_web::g_status;}
uint32_t r360_xenos_packets(){return render360::xenia_web::g_packets;}
uint32_t r360_xenos_register_writes(){return render360::xenia_web::g_register_writes;}
uint32_t r360_xenos_draws(){return render360::xenia_web::g_draws;}
uint32_t r360_xenos_presents(){return render360::xenia_web::g_presents;}
uint32_t r360_xenos_swaps(){return render360::xenia_web::g_swaps;}
uint32_t r360_xenos_indirect_buffers(){return render360::xenia_web::g_indirect_buffers;}
uint32_t r360_xenos_shader_loads(){return render360::xenia_web::g_shader_loads;}
uint32_t r360_xenos_memory_writes(){return render360::xenia_web::g_memory_writes;}
uint32_t r360_xenos_interrupts(){return render360::xenia_web::g_interrupts;}
uint32_t r360_xenos_last_interrupt_mask(){return render360::xenia_web::g_last_interrupt_mask;}
uint32_t r360_xenos_last_opcode(){return render360::xenia_web::g_last_opcode;}
uint32_t r360_xenos_last_fault_word(){return render360::xenia_web::g_last_fault_word;}
uint32_t r360_xenos_last_fault_depth(){return render360::xenia_web::g_last_fault_depth;}
uint32_t r360_xenos_last_invalidate_mask(){return render360::xenia_web::g_last_invalidate_mask;}
uint32_t r360_xenos_frontbuffer_ptr(){return render360::xenia_web::g_frontbuffer_ptr;}
uint32_t r360_xenos_frontbuffer_width(){return render360::xenia_web::g_frontbuffer_width;}
uint32_t r360_xenos_frontbuffer_height(){return render360::xenia_web::g_frontbuffer_height;}
uint32_t r360_xenos_frame_provenance(){return render360::xenia_web::FrameProvenance();}
uint32_t r360_xenos_real_title_frame_ready(){const uint32_t need=render360::xenia_web::kFrameProvSwap|render360::xenia_web::kFrameProvVertexShader|render360::xenia_web::kFrameProvPixelShader|render360::xenia_web::kFrameProvFetchResources;const uint32_t p=render360::xenia_web::FrameProvenance();return((p&need)==need&&!(p&render360::xenia_web::kFrameProvBoundedRaster))?1u:0u;}
uint32_t r360_xenos_register(uint32_t i){return i<render360::xenia_web::g_regs.size()?render360::xenia_web::g_regs[i]:0u;}
uint32_t r360_xenos_shader_buffer(uint32_t t){const auto*s=render360::xenia_web::ShaderForExport(t);return s?uint32_t(reinterpret_cast<uintptr_t>(s->words.data())):0u;}
uint32_t r360_xenos_shader_dwords(uint32_t t){const auto*s=render360::xenia_web::ShaderForExport(t);return s?s->dword_count:0u;}
uint32_t r360_xenos_shader_hash(uint32_t t){const auto*s=render360::xenia_web::ShaderForExport(t);return s?s->hash:0u;}
uint32_t r360_xenos_shader_guest_address(uint32_t t){const auto*s=render360::xenia_web::ShaderForExport(t);return s?s->guest_address:0u;}
uint32_t r360_xenos_shader_source(uint32_t t){const auto*s=render360::xenia_web::ShaderForExport(t);return s?s->source:0u;}
uint32_t r360_xenos_fetch_constant_word(uint32_t g,uint32_t w){if(w>=6u)return 0u;const uint64_t i=0x4800ull+uint64_t(g)*6u+w;return i<render360::xenia_web::g_regs.size()?render360::xenia_web::g_regs[uint32_t(i)]:0u;}
uint32_t r360_xenos_edram_tile_address(uint32_t b,uint32_t p,uint32_t x,uint32_t y){return render360::xenia_web::EdramTileAddress(b,p,x,y);}
uint32_t r360_xenos_frame_buffer(){return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::g_frame.data()));}
uint32_t r360_xenos_frame_size(){return render360::xenia_web::kFrameBytes;}
uint32_t r360_xenos_frame_width(){return render360::xenia_web::kFrameWidth;}
uint32_t r360_xenos_frame_height(){return render360::xenia_web::kFrameHeight;}
uint32_t r360_xenos_frame_generation(){return render360::xenia_web::g_frame_generation;}
uint32_t r360_xenos_frame_hash(){return render360::xenia_web::g_frame_hash;}
}
