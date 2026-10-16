#ifndef RENDER360_XAM_XDBF_H_
#define RENDER360_XAM_XDBF_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace render360::xenia_web {

// One XDBF achievement table entry with its strings resolved.
struct XdbfAchievement {
  uint32_t id = 0, image_id = 0, gamerscore = 0, flags = 0;
  std::u16string label, description, unachieved;
};

std::vector<XdbfAchievement> ParseXdbfAchievements(const uint8_t* data, size_t size);

}  // namespace render360::xenia_web

#endif  // RENDER360_XAM_XDBF_H_
