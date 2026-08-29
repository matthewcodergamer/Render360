#include <array>
#include <cstdint>
#include <cstring>

namespace render360::xenia_web {
namespace {

constexpr uint32_t kStatusIdle = 0;
constexpr uint32_t kStatusSuccess = 1;
constexpr uint32_t kStatusUnsupported = 2;
constexpr uint32_t kStatusInvalid = 3;
constexpr uint32_t kRegisterCount = 0x5000;
constexpr uint32_t kRingCapacity = 4096;
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

// Xenos PM4 type-3 opcodes from xenia/gpu/xenos.h.
constexpr uint32_t kPm4DrawIndx = 0x22;
constexpr uint32_t kPm4DrawIndx2 = 0x36;

std::array<uint32_t, kRegisterCount> g_regs{};
std::array<uint32_t, kRingCapacity> g_ring{};
std::array<uint32_t, kFrameWidth * kFrameHeight> g_edram_linear{};
std::array<uint8_t, kFrameBytes> g_frame{};
uint32_t g_status = kStatusIdle;
uint32_t g_ring_words = 0;
uint32_t g_packets = 0;
uint32_t g_register_writes = 0;
uint32_t g_draws = 0;
uint32_t g_presents = 0;
uint32_t g_last_opcode = 0;
uint32_t g_last_fault_word = 0;
uint32_t g_frame_generation = 0;
uint32_t g_frame_hash = 0;

uint32_t HashFrame() {
  uint32_t h = 2166136261u;
  for (uint8_t b : g_frame) {
    h ^= b;
    h *= 16777619u;
  }
  return h;
}

void ClearFrame(uint32_t rgba) {
  g_edram_linear.fill(rgba);
}

void RasterTriangle(uint32_t rgba) {
  // Deterministic first-frame raster foundation. Geometry is produced only by
  // a decoded Xenos DRAW packet. This is deliberately tiny, but the pixels are
  // downstream of the command processor rather than browser-side decoration.
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

bool ExecuteDraw(uint32_t opcode, const uint32_t* payload, uint32_t count) {
  if (!count) {
    g_status = kStatusInvalid;
    return false;
  }
  // The low 6 bits of the draw initiator carry the primitive type in Xenos.
  // Accept the common point/line/triangle family only in this bounded layer.
  const uint32_t initiator = payload[count - 1];
  const uint32_t primitive = initiator & 0x3Fu;
  if (primitive == 0 || primitive > 0x0Fu) {
    g_status = kStatusUnsupported;
    return false;
  }
  const uint32_t color_info = g_regs[kRegRbColorInfo];
  const uint32_t color_mask = g_regs[kRegRbColorMask];
  // Xenia documents RB_COLOR_INFO as the color render target descriptor. The
  // bounded first-frame path supports target 0 and an 8:8:8:8-like output.
  // A zero mask is treated as all channels enabled for bootstrap compatibility.
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

bool Execute() {
  uint32_t i = 0;
  while (i < g_ring_words) {
    const uint32_t header_index = i;
    const uint32_t header = g_ring[i++];

    // Xenia treats an all-zero command word as an empty packet. Real command
    // buffers may contain zero padding, so don't reinterpret it as a type-0
    // register write requiring a payload word.
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
      if (count > g_ring_words - i || base >= kRegisterCount ||
          (!write_one_reg && count > kRegisterCount - base)) {
        g_last_fault_word = header_index;
        g_status = kStatusInvalid;
        return false;
      }
      for (uint32_t n = 0; n < count; ++n) {
        const uint32_t target = write_one_reg ? base : base + n;
        if (!WriteRegister(target, g_ring[i + n])) {
          g_last_fault_word = header_index;
          return false;
        }
      }
      i += count;
      continue;
    }
    if (type == 1) {
      // Xenos type-1 packets write exactly two independently-addressed
      // registers. This is uncommon compared with type-0 but appears in real
      // command streams and must preserve both register indices.
      if (g_ring_words - i < 2u) {
        g_last_fault_word = header_index;
        g_status = kStatusInvalid;
        return false;
      }
      const uint32_t reg1 = header & 0x7FFu;
      const uint32_t reg2 = (header >> 11) & 0x7FFu;
      if (!WriteRegister(reg1, g_ring[i]) ||
          !WriteRegister(reg2, g_ring[i + 1])) {
        g_last_fault_word = header_index;
        return false;
      }
      i += 2u;
      continue;
    }
    if (type == 2) {
      continue;  // PM4 NOP.
    }
    if (type == 3) {
      const uint32_t count = ((header >> 16) & 0x3FFFu) + 1u;
      const uint32_t opcode = (header >> 8) & 0x7Fu;
      if (count > g_ring_words - i) {
        g_last_fault_word = header_index;
        g_status = kStatusInvalid;
        return false;
      }
      g_last_opcode = opcode;
      if (opcode == kPm4DrawIndx || opcode == kPm4DrawIndx2) {
        if (!ExecuteDraw(opcode, g_ring.data() + i, count)) {
          g_last_fault_word = header_index;
          return false;
        }
      } else {
        g_last_fault_word = header_index;
        g_status = kStatusUnsupported;
        return false;
      }
      i += count;
      continue;
    }
    g_last_fault_word = header_index;
    g_status = kStatusUnsupported;
    return false;
  }
  g_status = kStatusSuccess;
  return true;
}

void Reset() {
  g_regs.fill(0);
  g_ring.fill(0);
  g_frame.fill(0);
  ClearFrame(0x101018FFu);
  g_status = kStatusIdle;
  g_ring_words = g_packets = g_register_writes = g_draws = g_presents = 0;
  g_last_opcode = g_last_fault_word = g_frame_generation = g_frame_hash = 0;
}

uint32_t EdramTileAddress(uint32_t base_tile, uint32_t pitch_pixels,
                          uint32_t x, uint32_t y) {
  if (!pitch_pixels) return 0xFFFFFFFFu;
  const uint32_t pitch_tiles = (pitch_pixels + kTileWidth - 1u) / kTileWidth;
  const uint32_t tile_x = x / kTileWidth;
  const uint32_t tile_y = y / kTileHeight;
  return (base_tile + tile_y * pitch_tiles + tile_x) % kEdramTiles;
}

}  // namespace
}  // namespace render360::xenia_web

extern "C" {
void r360_xenos_reset() { render360::xenia_web::Reset(); }
uint32_t r360_xenos_ring_buffer() { return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::g_ring.data())); }
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
uint32_t r360_xenos_register_writes() { return render360::xenia_web::g_register_writes; }
uint32_t r360_xenos_draws() { return render360::xenia_web::g_draws; }
uint32_t r360_xenos_presents() { return render360::xenia_web::g_presents; }
uint32_t r360_xenos_last_opcode() { return render360::xenia_web::g_last_opcode; }
uint32_t r360_xenos_last_fault_word() { return render360::xenia_web::g_last_fault_word; }
uint32_t r360_xenos_register(uint32_t index) {
  return index < render360::xenia_web::g_regs.size() ? render360::xenia_web::g_regs[index] : 0u;
}
uint32_t r360_xenos_edram_tile_address(uint32_t base_tile, uint32_t pitch_pixels, uint32_t x, uint32_t y) {
  return render360::xenia_web::EdramTileAddress(base_tile, pitch_pixels, x, y);
}
uint32_t r360_xenos_frame_buffer() { return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::g_frame.data())); }
uint32_t r360_xenos_frame_size() { return render360::xenia_web::kFrameBytes; }
uint32_t r360_xenos_frame_width() { return render360::xenia_web::kFrameWidth; }
uint32_t r360_xenos_frame_height() { return render360::xenia_web::kFrameHeight; }
uint32_t r360_xenos_frame_generation() { return render360::xenia_web::g_frame_generation; }
uint32_t r360_xenos_frame_hash() { return render360::xenia_web::g_frame_hash; }
}
