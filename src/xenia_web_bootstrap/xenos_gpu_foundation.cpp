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

// Xenia register_table.inc dword indices.
constexpr uint32_t kRegRbSurfaceInfo = 0x2000;
constexpr uint32_t kRegRbColorInfo = 0x2001;
constexpr uint32_t kRegRbColorMask = 0x2104;

// Xenos PM4 type-3 opcodes, mirrored from the pinned upstream Xenia xenos.h.
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
constexpr uint32_t kPm4IndirectBuffer = 0x3F;
constexpr uint32_t kPm4MeInit = 0x48;
constexpr uint32_t kPm4SetBinMask = 0x50;
constexpr uint32_t kPm4SetBinSelect = 0x51;
constexpr uint32_t kPm4SetConstant2 = 0x55;
constexpr uint32_t kPm4SetShaderConstants = 0x56;
constexpr uint32_t kPm4ContextUpdate = 0x5E;
constexpr uint32_t kPm4SetBinMaskLo = 0x60;
constexpr uint32_t kPm4SetBinMaskHi = 0x61;
constexpr uint32_t kPm4SetBinSelectLo = 0x62;
constexpr uint32_t kPm4SetBinSelectHi = 0x63;

constexpr uint32_t kShaderVertex = 0;
constexpr uint32_t kShaderPixel = 1;
constexpr uint32_t kShaderSourceNone = 0;
constexpr uint32_t kShaderSourceGuestMemory = 1;
constexpr uint32_t kShaderSourceImmediate = 2;

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
uint32_t g_indirect_buffers = 0;
uint32_t g_shader_loads = 0;
uint32_t g_last_opcode = 0;
uint32_t g_last_fault_word = 0;
uint32_t g_last_fault_depth = 0;
uint32_t g_last_invalidate_mask = 0;
uint32_t g_frame_generation = 0;
uint32_t g_frame_hash = 0;
uint64_t g_bin_mask = 0xFFFFFFFFull;
uint64_t g_bin_select = 0xFFFFFFFFull;

uint32_t HashWords(const uint32_t* words, uint32_t count) {
  uint32_t h = 2166136261u;
  for (uint32_t i = 0; i < count; ++i) {
    const uint32_t word = words[i];
    for (int shift = 24; shift >= 0; shift -= 8) {
      h ^= (word >> shift) & 0xFFu;
      h *= 16777619u;
    }
  }
  return h;
}

uint32_t HashFrame() {
  uint32_t h = 2166136261u;
  for (uint8_t b : g_frame) {
    h ^= b;
    h *= 16777619u;
  }
  return h;
}

bool ReadGuestWordBE(uint32_t address, uint32_t* out_value) {
  if (!out_value || address > 0xFFFFFFFCu) return false;
  uint8_t bytes[4] = {};
  if (!ReadSparseGuestMemory(address, bytes, sizeof(bytes))) return false;
  *out_value = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
               (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
  return true;
}

void SetFault(uint32_t word, uint32_t depth, uint32_t status) {
  g_last_fault_word = word;
  g_last_fault_depth = depth;
  g_status = status;
}

void ClearFrame(uint32_t rgba) { g_edram_linear.fill(rgba); }

void RasterTriangle(uint32_t rgba) {
  // The old bounded raster remains a bring-up visualization only. A commercial
  // title is not considered rendered merely because a DRAW packet reaches it;
  // real shader/resource capture is tracked separately below.
  for (uint32_t y = 8; y < 56; ++y) {
    const uint32_t half = (y - 8) / 2;
    const uint32_t x0 = 32 > half ? 32 - half : 0;
    const uint32_t x1 = 32 + half;
    for (uint32_t x = x0; x <= x1 && x < kFrameWidth; ++x) {
      g_edram_linear[y * kFrameWidth + x] = rgba;
    }
  }
}

void ResolveEdramToFrame() {
  for (uint32_t i = 0; i < kFrameWidth * kFrameHeight; ++i) {
    const uint32_t c = g_edram_linear[i];
    g_frame[i * 4 + 0] = uint8_t(c >> 24);
    g_frame[i * 4 + 1] = uint8_t(c >> 16);
    g_frame[i * 4 + 2] = uint8_t(c >> 8);
    g_frame[i * 4 + 3] = uint8_t(c);
  }
  g_frame_hash = HashFrame();
  ++g_frame_generation;
  ++g_presents;
}

bool WriteRegister(uint32_t index, uint32_t value) {
  if (index >= g_regs.size()) {
    g_status = kStatusInvalid;
    return false;
  }
  g_regs[index] = value;
  ++g_register_writes;
  return true;
}

ShaderCapture* ShaderForType(uint32_t shader_type) {
  if (shader_type == kShaderVertex) return &g_vertex_shader;
  if (shader_type == kShaderPixel) return &g_pixel_shader;
  return nullptr;
}

bool CaptureShader(uint32_t shader_type, uint32_t guest_address,
                   const uint32_t* words, uint32_t dword_count,
                   uint32_t source) {
  ShaderCapture* shader = ShaderForType(shader_type);
  if (!shader || !words || !dword_count || dword_count > kShaderWordCapacity) {
    g_status = dword_count > kShaderWordCapacity ? kStatusUnsupported
                                                 : kStatusInvalid;
    return false;
  }
  std::memcpy(shader->words.data(), words, dword_count * sizeof(uint32_t));
  if (dword_count < shader->words.size()) {
    std::memset(shader->words.data() + dword_count, 0,
                (shader->words.size() - dword_count) * sizeof(uint32_t));
  }
  shader->dword_count = dword_count;
  shader->guest_address = guest_address;
  shader->hash = HashWords(words, dword_count);
  shader->source = source;
  ++g_shader_loads;
  return true;
}

bool CaptureShaderFromGuest(uint32_t shader_type, uint32_t guest_address,
                            uint32_t dword_count) {
  if (!dword_count || dword_count > kShaderWordCapacity) {
    g_status = dword_count > kShaderWordCapacity ? kStatusUnsupported
                                                 : kStatusInvalid;
    return false;
  }
  std::array<uint32_t, kShaderWordCapacity> words{};
  for (uint32_t i = 0; i < dword_count; ++i) {
    const uint64_t address = uint64_t(guest_address) + uint64_t(i) * 4u;
    if (address > 0xFFFFFFFCull ||
        !ReadGuestWordBE(static_cast<uint32_t>(address), &words[i])) {
      g_status = kStatusInvalid;
      return false;
    }
  }
  return CaptureShader(shader_type, guest_address, words.data(), dword_count,
                       kShaderSourceGuestMemory);
}

bool ExecuteDraw(uint32_t opcode, const uint32_t* payload, uint32_t count) {
  if (!count) {
    g_status = kStatusInvalid;
    return false;
  }
  const uint32_t initiator = payload[count - 1];
  const uint32_t primitive = initiator & 0x3Fu;
  if (primitive == 0 || primitive > 0x0Fu) {
    g_status = kStatusUnsupported;
    return false;
  }
  const uint32_t color_info = g_regs[kRegRbColorInfo];
  const uint32_t color_mask = g_regs[kRegRbColorMask];
  const uint32_t seed = color_info ^ (color_mask ? color_mask : 0xFu) ^ initiator;
  const uint32_t r = 0x40u + ((seed >> 0) & 0x7Fu);
  const uint32_t g = 0x40u + ((seed >> 7) & 0x7Fu);
  const uint32_t b = 0x40u + ((seed >> 14) & 0x7Fu);
  const uint32_t rgba = (r << 24) | (g << 16) | (b << 8) | 0xFFu;
  RasterTriangle(rgba);
  ++g_draws;
  g_last_opcode = opcode;
  ResolveEdramToFrame();
  return true;
}

bool WriteConstantGroup(uint32_t offset_type, const uint32_t* values,
                        uint32_t value_count) {
  if (!values && value_count) return false;
  uint32_t index = offset_type & 0x7FFu;
  const uint32_t type = (offset_type >> 16) & 0xFFu;
  switch (type) {
    case 0:
      index += 0x4000u;  // ALU constants.
      break;
    case 1:
      index += 0x4800u;  // Fetch constants (textures / vertex buffers).
      break;
    case 2:
      index += 0x4900u;  // Boolean constants.
      break;
    case 3:
      index += 0x4908u;  // Loop constants.
      break;
    case 4:
      index += 0x2000u;  // Ordinary GPU registers.
      break;
    default:
      g_status = kStatusUnsupported;
      return false;
  }
  if (index >= kRegisterCount || value_count > kRegisterCount - index) {
    g_status = kStatusInvalid;
    return false;
  }
  for (uint32_t n = 0; n < value_count; ++n) {
    if (!WriteRegister(index + n, values[n])) return false;
  }
  return true;
}

bool ExecuteBuffer(const uint32_t* words, uint32_t word_count, uint32_t depth) {
  if (!words || depth > kMaxIndirectDepth) {
    SetFault(0, depth, kStatusInvalid);
    return false;
  }
  uint32_t i = 0;
  while (i < word_count) {
    const uint32_t header_index = i;
    const uint32_t header = words[i++];
    if (header == 0) {
      ++g_packets;
      continue;
    }
    const uint32_t type = header >> 30;
    ++g_packets;
    if (type == 0) {
      const uint32_t count = ((header >> 16) & 0x3FFFu) + 1u;
      const uint32_t base = header & 0x7FFFu;
      const bool write_one_reg = ((header >> 15) & 1u) != 0;
      if (count > word_count - i || base >= kRegisterCount ||
          (!write_one_reg && count > kRegisterCount - base)) {
        SetFault(header_index, depth, kStatusInvalid);
        return false;
      }
      for (uint32_t n = 0; n < count; ++n) {
        const uint32_t target = write_one_reg ? base : base + n;
        if (!WriteRegister(target, words[i + n])) {
          SetFault(header_index, depth, kStatusInvalid);
          return false;
        }
      }
      i += count;
      continue;
    }
    if (type == 1) {
      if (word_count - i < 2u) {
        SetFault(header_index, depth, kStatusInvalid);
        return false;
      }
      const uint32_t reg1 = header & 0x7FFu;
      const uint32_t reg2 = (header >> 11) & 0x7FFu;
      if (!WriteRegister(reg1, words[i]) || !WriteRegister(reg2, words[i + 1])) {
        SetFault(header_index, depth, kStatusInvalid);
        return false;
      }
      i += 2u;
      continue;
    }
    if (type == 2) continue;
    if (type != 3) {
      SetFault(header_index, depth, kStatusUnsupported);
      return false;
    }

    const uint32_t count = ((header >> 16) & 0x3FFFu) + 1u;
    const uint32_t opcode = (header >> 8) & 0x7Fu;
    if (count > word_count - i) {
      SetFault(header_index, depth, kStatusInvalid);
      return false;
    }
    const uint32_t* payload = words + i;
    g_last_opcode = opcode;
    bool handled = true;

    switch (opcode) {
      case kPm4Nop:
      case kPm4MeInit:
      case kPm4WaitForIdle:
        break;

      case kPm4DrawIndx:
      case kPm4DrawIndx2:
        handled = ExecuteDraw(opcode, payload, count);
        break;

      case kPm4RegRmw: {
        if (count != 3u) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        const uint32_t rmw_info = payload[0];
        const uint32_t target = rmw_info & 0x1FFFu;
        if (target >= kRegisterCount) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        uint32_t value = g_regs[target];
        const uint32_t and_value = ((rmw_info >> 31) & 1u)
                                       ? ((payload[1] & 0x1FFFu) < kRegisterCount
                                              ? g_regs[payload[1] & 0x1FFFu]
                                              : 0u)
                                       : payload[1];
        const uint32_t or_value = ((rmw_info >> 30) & 1u)
                                      ? ((payload[2] & 0x1FFFu) < kRegisterCount
                                             ? g_regs[payload[2] & 0x1FFFu]
                                             : 0u)
                                      : payload[2];
        value = (value & and_value) | or_value;
        handled = WriteRegister(target, value);
        break;
      }

      case kPm4SetConstant:
        if (!count) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          handled = WriteConstantGroup(payload[0], payload + 1, count - 1u);
        }
        break;

      case kPm4SetConstant2:
      case kPm4SetShaderConstants: {
        if (!count) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        const uint32_t index = payload[0] & 0xFFFFu;
        const uint32_t value_count = count - 1u;
        if (index >= kRegisterCount || value_count > kRegisterCount - index) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        for (uint32_t n = 0; n < value_count && handled; ++n) {
          handled = WriteRegister(index + n, payload[n + 1]);
        }
        break;
      }

      case kPm4LoadAluConstant: {
        if (count < 3u) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        const uint32_t address = payload[0] & 0x3FFFFFFFu;
        const uint32_t offset_type = payload[1];
        const uint32_t size_dwords = payload[2] & 0xFFFu;
        if (!size_dwords || size_dwords > kRegisterCount) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        std::array<uint32_t, kRegisterCount> loaded{};
        for (uint32_t n = 0; n < size_dwords; ++n) {
          const uint64_t read_address = uint64_t(address) + uint64_t(n) * 4u;
          if (read_address > 0xFFFFFFFCull ||
              !ReadGuestWordBE(static_cast<uint32_t>(read_address), &loaded[n])) {
            handled = false;
            g_status = kStatusInvalid;
            break;
          }
        }
        if (handled) {
          handled = WriteConstantGroup(offset_type, loaded.data(), size_dwords);
        }
        break;
      }

      case kPm4ImLoad: {
        if (count < 2u) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        const uint32_t addr_type = payload[0];
        const uint32_t shader_type = addr_type & 0x3u;
        const uint32_t address = addr_type & ~0x3u;
        const uint32_t start_size = payload[1];
        const uint32_t start = start_size >> 16;
        const uint32_t size_dwords = start_size & 0xFFFFu;
        if (start != 0u) {
          handled = false;
          g_status = kStatusUnsupported;
          break;
        }
        handled = CaptureShaderFromGuest(shader_type, address, size_dwords);
        break;
      }

      case kPm4ImLoadImmediate: {
        if (count < 2u) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        const uint32_t shader_type = payload[0];
        const uint32_t start_size = payload[1];
        const uint32_t start = start_size >> 16;
        const uint32_t size_dwords = start_size & 0xFFFFu;
        if (start != 0u || size_dwords > count - 2u) {
          handled = false;
          g_status = start ? kStatusUnsupported : kStatusInvalid;
          break;
        }
        handled = CaptureShader(shader_type, 0u, payload + 2, size_dwords,
                                kShaderSourceImmediate);
        break;
      }

      case kPm4IndirectBuffer:
      case kPm4IndirectBufferPfd: {
        if (count < 2u || depth >= kMaxIndirectDepth) {
          handled = false;
          g_status = kStatusInvalid;
          break;
        }
        // Xenia ultimately executes this from guest physical memory. Render360
        // keeps sparse guest memory authoritative and therefore accepts the
        // packet's aligned pointer only when that exact range is mapped. No
        // guessed alias or hard-coded title address is introduced here.
        const uint32_t list_ptr = payload[0] & ~0x3u;
        const uint32_t list_length = payload[1] & 0xFFFFFu;
        if (!list_length || list_length > kRingCapacity) {
          handled = false;
          g_status = list_length > kRingCapacity ? kStatusUnsupported
                                                 : kStatusInvalid;
          break;
        }
        std::array<uint32_t, kRingCapacity> indirect{};
        for (uint32_t n = 0; n < list_length; ++n) {
          const uint64_t read_address = uint64_t(list_ptr) + uint64_t(n) * 4u;
          if (read_address > 0xFFFFFFFCull ||
              !ReadGuestWordBE(static_cast<uint32_t>(read_address),
                               &indirect[n])) {
            handled = false;
            g_status = kStatusInvalid;
            break;
          }
        }
        if (handled) {
          ++g_indirect_buffers;
          handled = ExecuteBuffer(indirect.data(), list_length, depth + 1u);
        }
        break;
      }

      case kPm4InvalidateState:
        if (count < 1u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_last_invalidate_mask = payload[0];
        }
        break;

      case kPm4ContextUpdate:
        if (count != 1u || payload[0] != 0u) {
          handled = false;
          g_status = kStatusUnsupported;
        }
        break;

      case kPm4SetBinMaskLo:
        if (count != 1u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_bin_mask = (g_bin_mask & 0xFFFFFFFF00000000ull) | payload[0];
        }
        break;
      case kPm4SetBinMaskHi:
        if (count != 1u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_bin_mask = (g_bin_mask & 0xFFFFFFFFull) |
                       (uint64_t(payload[0]) << 32);
        }
        break;
      case kPm4SetBinSelectLo:
        if (count != 1u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_bin_select = (g_bin_select & 0xFFFFFFFF00000000ull) | payload[0];
        }
        break;
      case kPm4SetBinSelectHi:
        if (count != 1u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_bin_select = (g_bin_select & 0xFFFFFFFFull) |
                         (uint64_t(payload[0]) << 32);
        }
        break;
      case kPm4SetBinMask:
        if (count != 2u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_bin_mask = (uint64_t(payload[0]) << 32) | payload[1];
        }
        break;
      case kPm4SetBinSelect:
        if (count != 2u) {
          handled = false;
          g_status = kStatusInvalid;
        } else {
          g_bin_select = (uint64_t(payload[0]) << 32) | payload[1];
        }
        break;

      default:
        handled = false;
        g_status = kStatusUnsupported;
        break;
    }

    if (!handled) {
      if (g_last_fault_depth < depth || g_status == kStatusIdle) {
        g_last_fault_depth = depth;
      }
      if (g_last_fault_depth == depth) g_last_fault_word = header_index;
      if (g_status == kStatusIdle) g_status = kStatusUnsupported;
      return false;
    }
    i += count;
  }
  return true;
}

bool Execute() {
  if (!ExecuteBuffer(g_ring.data(), g_ring_words, 0u)) return false;
  g_status = kStatusSuccess;
  return true;
}

void Reset() {
  g_regs.fill(0);
  g_ring.fill(0);
  g_frame.fill(0);
  g_vertex_shader = {};
  g_pixel_shader = {};
  ClearFrame(0x101018FFu);
  g_status = kStatusIdle;
  g_ring_words = g_packets = g_register_writes = g_draws = g_presents = 0;
  g_indirect_buffers = g_shader_loads = 0;
  g_last_opcode = g_last_fault_word = g_last_fault_depth = 0;
  g_last_invalidate_mask = 0;
  g_frame_generation = g_frame_hash = 0;
  g_bin_mask = g_bin_select = 0xFFFFFFFFull;
}

uint32_t EdramTileAddress(uint32_t base_tile, uint32_t pitch_pixels,
                          uint32_t x, uint32_t y) {
  if (!pitch_pixels) return 0xFFFFFFFFu;
  const uint32_t pitch_tiles = (pitch_pixels + kTileWidth - 1u) / kTileWidth;
  const uint32_t tile_x = x / kTileWidth;
  const uint32_t tile_y = y / kTileHeight;
  return (base_tile + tile_y * pitch_tiles + tile_x) % kEdramTiles;
}

const ShaderCapture* ShaderForExport(uint32_t shader_type) {
  if (shader_type == kShaderVertex) return &g_vertex_shader;
  if (shader_type == kShaderPixel) return &g_pixel_shader;
  return nullptr;
}

}  // namespace
}  // namespace render360::xenia_web

extern "C" {
void r360_xenos_reset() { render360::xenia_web::Reset(); }
uint32_t r360_xenos_ring_buffer() {
  return uint32_t(reinterpret_cast<uintptr_t>(
      render360::xenia_web::g_ring.data()));
}
uint32_t r360_xenos_ring_capacity() { return render360::xenia_web::kRingCapacity; }
uint32_t r360_xenos_submit(uint32_t words) {
  if (words > render360::xenia_web::kRingCapacity) {
    render360::xenia_web::g_status = render360::xenia_web::kStatusInvalid;
    return 0;
  }
  render360::xenia_web::g_ring_words = words;
  return render360::xenia_web::Execute() ? 1u : 0u;
}
uint32_t r360_xenos_status() { return render360::xenia_web::g_status; }
uint32_t r360_xenos_packets() { return render360::xenia_web::g_packets; }
uint32_t r360_xenos_register_writes() {
  return render360::xenia_web::g_register_writes;
}
uint32_t r360_xenos_draws() { return render360::xenia_web::g_draws; }
uint32_t r360_xenos_presents() { return render360::xenia_web::g_presents; }
uint32_t r360_xenos_indirect_buffers() {
  return render360::xenia_web::g_indirect_buffers;
}
uint32_t r360_xenos_shader_loads() {
  return render360::xenia_web::g_shader_loads;
}
uint32_t r360_xenos_last_opcode() { return render360::xenia_web::g_last_opcode; }
uint32_t r360_xenos_last_fault_word() {
  return render360::xenia_web::g_last_fault_word;
}
uint32_t r360_xenos_last_fault_depth() {
  return render360::xenia_web::g_last_fault_depth;
}
uint32_t r360_xenos_last_invalidate_mask() {
  return render360::xenia_web::g_last_invalidate_mask;
}
uint32_t r360_xenos_register(uint32_t index) {
  return index < render360::xenia_web::g_regs.size()
             ? render360::xenia_web::g_regs[index]
             : 0u;
}
uint32_t r360_xenos_shader_buffer(uint32_t shader_type) {
  const auto* shader = render360::xenia_web::ShaderForExport(shader_type);
  return shader ? uint32_t(reinterpret_cast<uintptr_t>(shader->words.data())) : 0u;
}
uint32_t r360_xenos_shader_dwords(uint32_t shader_type) {
  const auto* shader = render360::xenia_web::ShaderForExport(shader_type);
  return shader ? shader->dword_count : 0u;
}
uint32_t r360_xenos_shader_hash(uint32_t shader_type) {
  const auto* shader = render360::xenia_web::ShaderForExport(shader_type);
  return shader ? shader->hash : 0u;
}
uint32_t r360_xenos_shader_guest_address(uint32_t shader_type) {
  const auto* shader = render360::xenia_web::ShaderForExport(shader_type);
  return shader ? shader->guest_address : 0u;
}
uint32_t r360_xenos_shader_source(uint32_t shader_type) {
  const auto* shader = render360::xenia_web::ShaderForExport(shader_type);
  return shader ? shader->source : 0u;
}
uint32_t r360_xenos_fetch_constant_word(uint32_t group, uint32_t word) {
  if (word >= 6u) return 0u;
  const uint64_t index = 0x4800ull + uint64_t(group) * 6u + word;
  return index < render360::xenia_web::g_regs.size()
             ? render360::xenia_web::g_regs[static_cast<uint32_t>(index)]
             : 0u;
}
uint32_t r360_xenos_edram_tile_address(uint32_t base_tile,
                                       uint32_t pitch_pixels, uint32_t x,
                                       uint32_t y) {
  return render360::xenia_web::EdramTileAddress(base_tile, pitch_pixels, x, y);
}
uint32_t r360_xenos_frame_buffer() {
  return uint32_t(reinterpret_cast<uintptr_t>(
      render360::xenia_web::g_frame.data()));
}
uint32_t r360_xenos_frame_size() { return render360::xenia_web::kFrameBytes; }
uint32_t r360_xenos_frame_width() { return render360::xenia_web::kFrameWidth; }
uint32_t r360_xenos_frame_height() { return render360::xenia_web::kFrameHeight; }
uint32_t r360_xenos_frame_generation() {
  return render360::xenia_web::g_frame_generation;
}
uint32_t r360_xenos_frame_hash() { return render360::xenia_web::g_frame_hash; }
}
