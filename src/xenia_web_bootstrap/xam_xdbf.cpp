// Title XDBF achievement table for XamUserCreateAchievementEnumerator,
// parsed by Xenia's own xdbf_utils (kept out of kernel_xboxkrnl_services.cpp,
// whose status constants collide with xenia/xbox.h macros).
#include "xam_xdbf.h"

#include "xenia/base/string.h"
#include "xenia/kernel/util/xdbf_utils.h"

namespace render360::xenia_web {

std::vector<XdbfAchievement> ParseXdbfAchievements(const uint8_t* data, size_t size) {
  std::vector<XdbfAchievement> out;
  const xe::kernel::util::XdbfGameData db(data, size);
  if (!db.is_valid()) return out;
  // Xenia xam_user.cc: cvars::user_language (default 1, English), or the
  // title's default language when it has no English strings.
  const auto language = db.GetExistingLanguage(xe::XLanguage::kEnglish);
  auto text = [&](uint16_t id) { return xe::to_utf16(db.GetStringTableEntry(language, id)); };
  for (const auto& entry : db.GetAchievements()) {
    XdbfAchievement item;
    item.id = entry.id;
    item.label = text(entry.label_id);
    item.description = text(entry.description_id);
    item.unachieved = text(entry.unachieved_id);
    item.image_id = entry.image_id;
    item.gamerscore = entry.gamerscore;
    item.flags = entry.flags;
    out.push_back(std::move(item));
  }
  return out;
}

}  // namespace render360::xenia_web
