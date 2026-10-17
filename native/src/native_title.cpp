// Native title boot: a C++ port of the browser's JavaScript boot path, so the
// iOS app and the native runner start titles exactly like the web player.
//
//   render360-title-controller.mjs   handoffDefaultXex and its helpers
//   retail-xex-image-pipeline.mjs    prepareRetailXexImage (AES + NONE/BASIC/NORMAL)
//   render360-xex-imports.mjs        decodeXexImportLibraries
//   render360-kernel-imports.mjs     buildKernelImportPlan
//   render360-guest-vfs.mjs          registerGuestVfs, listStfsVfsFiles
//   render360-xdvdfs.mjs             mountXdvdfs
//   render360-iso-title-controller   extractXex2EncryptedImageKey
//   wasm-core.js                     mountStfs / extractStfsEntry
//   tools/run-title.mjs              openTitle, the JSON report
//
// Function names below match the JavaScript ones; keep them in step.
#include "render360_core.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

// Package core (render360_xenia_core.wasm in the browser), linked as one
// object whose exports are renamed r360_* -> r360pkg_* (native/build-native.sh).
extern "C" {
uintptr_t r360pkg_io_ptr();
uint32_t r360pkg_io_capacity();
uint32_t r360pkg_stfs_mount_begin(uint32_t size_lo, uint32_t size_hi);
uint32_t r360pkg_stfs_submit_read(uint32_t length);
uint32_t r360pkg_stfs_request_pending();
uint32_t r360pkg_stfs_request_offset_lo();
uint32_t r360pkg_stfs_request_offset_hi();
uint32_t r360pkg_stfs_request_size();
uint32_t r360pkg_stfs_mount_status();
uint32_t r360pkg_stfs_entry_count();
uintptr_t r360pkg_stfs_entry_name_ptr(uint32_t index);
uint32_t r360pkg_stfs_entry_name_length(uint32_t index);
uint32_t r360pkg_stfs_entry_is_directory(uint32_t index);
uint32_t r360pkg_stfs_entry_parent_index(uint32_t index);
uint32_t r360pkg_stfs_entry_length(uint32_t index);
uintptr_t r360pkg_stfs_display_name_ptr();
uint32_t r360pkg_stfs_display_name_length();
uint32_t r360pkg_stfs_extract_begin(uint32_t entry_index);
uint32_t r360pkg_stfs_extract_status();
uint32_t r360pkg_stfs_extract_bytes_done();
uint32_t r360pkg_stfs_extract_bytes_total();
void r360pkg_stfs_extract_reset();
uint32_t r360pkg_xex_decode(uint32_t length);
uint32_t r360pkg_xex_decode_encryption_type();
uint32_t r360pkg_xex_decode_compression_type();
uint32_t r360pkg_xex_decode_image_size();
uint32_t r360pkg_xex_prepare_none_begin(uint32_t header_length, uint32_t source_length);
uint32_t r360pkg_xex_prepare_none_accept(uint32_t length);
uint32_t r360pkg_xex_prepare_basic_begin(uint32_t header_length, uint32_t source_length);
uint32_t r360pkg_xex_prepare_basic_accept_data(uint32_t length);
uint32_t r360pkg_xex_prepare_basic_consume_zero(uint32_t length);
uint32_t r360pkg_xex_prepare_basic_data_remaining();
uint32_t r360pkg_xex_prepare_basic_zero_remaining();
uint32_t r360pkg_xex_prepare_status();
uint32_t r360pkg_xex_prepare_last_output_kind();
uint32_t r360pkg_xex_prepare_last_output_bytes();
uint32_t r360pkg_xex_prepare_normal_frame_begin(uint32_t header_length, uint32_t source_length);
uint32_t r360pkg_xex_prepare_normal_frame_accept(uint32_t length);
uint32_t r360pkg_xex_prepare_normal_window_size();
}

namespace {

using Bytes = std::vector<uint8_t>;

[[noreturn]] void Fail(const char* format, ...) {
  char text[256];
  va_list args;
  va_start(args, format);
  std::vsnprintf(text, sizeof(text), format, args);
  va_end(args);
  throw std::runtime_error(text);
}

uint32_t be32(const uint8_t* b, size_t o) {
  return (uint32_t(b[o]) << 24) | (uint32_t(b[o + 1]) << 16) | (uint32_t(b[o + 2]) << 8) | b[o + 3];
}
uint32_t be16(const uint8_t* b, size_t o) { return (uint32_t(b[o]) << 8) | b[o + 1]; }
uint32_t le16(const uint8_t* b, size_t o) { return b[o] | (uint32_t(b[o + 1]) << 8); }
uint32_t le32(const uint8_t* b, size_t o) {
  return b[o] | (uint32_t(b[o + 1]) << 8) | (uint32_t(b[o + 2]) << 16) | (uint32_t(b[o + 3]) << 24);
}

// --- Host files -------------------------------------------------------------

struct HostFile {
  int fd = -1;
  uint64_t size = 0;
  bool Open(const std::string& path) {
    fd = ::open(path.c_str(), O_RDONLY);
    if (fd < 0) return false;
    struct stat st {};
    if (fstat(fd, &st) != 0) return false;
    size = uint64_t(st.st_size);
    return true;
  }
  void Read(uint64_t offset, void* out, size_t length) const {
    size_t done = 0;
    while (done < length) {
      const ssize_t n = ::pread(fd, static_cast<uint8_t*>(out) + done, length - done, off_t(offset + done));
      if (n <= 0) Fail("short read at 0x%llx (%zu/%zu)", (unsigned long long)(offset + done), done, length);
      done += size_t(n);
    }
  }
  Bytes ReadBytes(uint64_t offset, size_t length) const {
    Bytes out(length);
    Read(offset, out.data(), length);
    return out;
  }
};
// Descriptors stay open for the process lifetime: the kernel VFS reads them.
std::vector<std::unique_ptr<HostFile>> g_host_files;
HostFile* OpenHostFile(const std::string& path) {
  auto file = std::make_unique<HostFile>();
  if (!file->Open(path)) Fail("cannot open %s", path.c_str());
  g_host_files.push_back(std::move(file));
  return g_host_files.back().get();
}

// --- Guest VFS (render360-guest-vfs.mjs) ----------------------------------------

struct VfsFile {
  std::string path;  // relative to \Device\Cdrom0, '\' separated
  bool directory = false;
  uint64_t size = 0;
  int host_fd = 0;
  uint64_t host_offset = 0;
  Bytes data;        // attached up front (STFS extraction)
  bool has_data = false;
};

constexpr uint32_t FILE_ATTRIBUTE_READONLY = 0x01;
constexpr uint32_t FILE_ATTRIBUTE_DIRECTORY = 0x10;
constexpr uint32_t FILE_ATTRIBUTE_NORMAL = 0x80;

uint32_t registerGuestVfs(const std::vector<VfsFile>& files) {
  r360_vfs_reset();
  auto* path_buffer = reinterpret_cast<char*>(r360_vfs_path_buffer());
  uint32_t registered = 0;
  for (const auto& file : files) {
    std::string path = file.path;
    std::replace(path.begin(), path.end(), '/', '\\');
    while (!path.empty() && path[0] == '\\') path.erase(0, 1);
    if (path.empty()) continue;
    if (path.size() >= 1024) Fail("guest path too long for VFS: %s", path.c_str());
    std::memcpy(path_buffer, path.data(), path.size());
    const uint64_t size = file.directory ? 0 : file.size;
    const uint32_t attributes = file.directory ? (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_READONLY)
                                               : (FILE_ATTRIBUTE_NORMAL | FILE_ATTRIBUTE_READONLY);
    const uint32_t id = r360_vfs_register(uint32_t(path.size()), uint32_t(size), uint32_t(size >> 32), attributes,
                                          uint32_t(file.host_fd), uint32_t(file.host_offset),
                                          uint32_t(file.host_offset >> 32));
    if (!id) Fail("native VFS rejected %s", path.c_str());
    ++registered;
    if (file.has_data && !file.directory) {
      auto* ptr = reinterpret_cast<uint8_t*>(r360_vfs_data_buffer(id));
      if (!ptr) Fail("native VFS could not allocate %zu bytes for %s", file.data.size(), path.c_str());
      if (!file.data.empty()) std::memcpy(ptr, file.data.data(), file.data.size());
    }
  }
  return registered;
}

// --- XDVDFS (render360-xdvdfs.mjs) ------------------------------------------------

constexpr uint32_t kSector = 2048;
const char kXdvdfsMagic[] = "MICROSOFT*XBOX*MEDIA";

struct XdvdfsEntry {
  std::string name;
  uint32_t left = 0, right = 0, start_sector = 0, size = 0, attributes = 0;
  bool directory = false;
};

struct XdvdfsVolume {
  const HostFile* file = nullptr;
  std::string layout;
  uint64_t partition_offset = 0;
  uint32_t root_sector = 0, root_size = 0;

  Bytes Table(uint32_t sector, uint32_t size) const {
    if (!size) return {};
    if (size > 16u * 1024u * 1024u) Fail("XDVDFS directory table too large %u", size);
    return file->ReadBytes(partition_offset + uint64_t(sector) * kSector, size);
  }
  static std::vector<XdvdfsEntry> WalkTree(const Bytes& table) {
    std::vector<XdvdfsEntry> out;
    if (table.empty()) return out;
    std::vector<uint32_t> stack{0};
    std::vector<bool> seen(table.size() / 4 + 1, false);
    size_t visited = 0;
    while (!stack.empty()) {
      const uint32_t off = stack.back();
      stack.pop_back();
      if (seen[off / 4]) Fail("XDVDFS directory tree cycle at 0x%x", off);
      seen[off / 4] = true;
      if (++visited > 65536) Fail("XDVDFS directory entry guard exceeded");
      if (off + 14 > table.size()) Fail("XDVDFS directory entry out of bounds 0x%x", off);
      const uint32_t name_len = table[off + 13];
      if (!name_len || off + 14 + name_len > table.size()) Fail("XDVDFS directory filename out of bounds 0x%x", off);
      XdvdfsEntry e;
      e.left = le16(table.data(), off);
      e.right = le16(table.data(), off + 2);
      e.start_sector = le32(table.data(), off + 4);
      e.size = le32(table.data(), off + 8);
      e.attributes = table[off + 12];
      e.directory = (e.attributes & 0x10) != 0;
      e.name.assign(reinterpret_cast<const char*>(table.data() + off + 14), name_len);
      if (e.name.find_first_of(std::string("\0/\\", 3)) != std::string::npos) Fail("invalid XDVDFS filename");
      out.push_back(e);
      for (uint32_t d : {e.right, e.left}) {
        if (!d) continue;
        if (d * 4 >= table.size()) Fail("XDVDFS child pointer out of bounds 0x%x", d * 4);
        stack.push_back(d * 4);
      }
    }
    return out;
  }
};

XdvdfsVolume mountXdvdfs(const HostFile* file) {
  static const std::pair<const char*, uint64_t> kPartitions[] = {
      {"XISO", 0x00000000ull}, {"XGD3", 0x02080000ull}, {"XGD2", 0x0FD90000ull}, {"XGD1", 0x18300000ull}};
  for (const auto& [layout, partition_offset] : kPartitions) {
    const uint64_t descriptor = partition_offset + 32ull * kSector;
    if (descriptor + kSector > file->size) continue;
    Bytes d = file->ReadBytes(descriptor, kSector);
    if (std::memcmp(d.data(), kXdvdfsMagic, 20) || std::memcmp(d.data() + 0x7EC, kXdvdfsMagic, 20)) continue;
    XdvdfsVolume volume;
    volume.file = file;
    volume.layout = layout;
    volume.partition_offset = partition_offset;
    volume.root_sector = le32(d.data(), 0x14);
    volume.root_size = le32(d.data(), 0x18);
    if (!volume.root_sector || !volume.root_size) Fail("XDVDFS root directory is empty");
    if (volume.root_size > 16u * 1024u * 1024u) Fail("XDVDFS root directory size unreasonable");
    if (partition_offset + uint64_t(volume.root_sector) * kSector + volume.root_size > file->size)
      Fail("XDVDFS root directory outside image");
    return volume;
  }
  Fail("XDVDFS volume not found (XISO/XGD1/XGD2/XGD3)");
}

// listXdvdfsVfsFiles: every file is a contiguous extent of the image.
void listXdvdfsVfsFiles(const XdvdfsVolume& volume, uint32_t sector, uint32_t size, const std::string& prefix,
                        std::vector<VfsFile>& files, int depth = 0) {
  if (depth > 64) Fail("XDVDFS directory nesting too deep");
  for (const auto& entry : XdvdfsVolume::WalkTree(volume.Table(sector, size))) {
    const std::string path = prefix.empty() ? entry.name : prefix + "\\" + entry.name;
    VfsFile f;
    f.path = path;
    if (entry.directory) {
      f.directory = true;
      files.push_back(f);
      listXdvdfsVfsFiles(volume, entry.start_sector, entry.size, path, files, depth + 1);
    } else {
      f.size = entry.size;
      f.host_fd = volume.file->fd;
      f.host_offset = volume.partition_offset + uint64_t(entry.start_sector) * kSector;
      files.push_back(f);
    }
  }
}

// --- STFS packages (wasm-core.js mountStfs / extractStfsEntry) --------------------

void StageSlice(const HostFile* file, uint64_t offset, uint32_t size) {
  if (!size || size > r360pkg_io_capacity()) Fail("invalid native STFS read size %u", size);
  file->Read(offset, reinterpret_cast<void*>(r360pkg_io_ptr()), size);
}
uint64_t RequestOffset() {
  return (uint64_t(r360pkg_stfs_request_offset_hi()) << 32) | r360pkg_stfs_request_offset_lo();
}

std::string mountStfs(const HostFile* file) {
  r360pkg_stfs_mount_begin(uint32_t(file->size), uint32_t(file->size >> 32));
  uint32_t requests = 0;
  while (r360pkg_stfs_request_pending()) {
    if (++requests > 4096) Fail("STFS mount exceeded 4096 native read requests");
    const uint32_t size = r360pkg_stfs_request_size();
    StageSlice(file, RequestOffset(), size);
    r360pkg_stfs_submit_read(size);
  }
  const uint32_t status = r360pkg_stfs_mount_status();
  if (status != 2 && status != 3) Fail("STFS package did not mount (status %u)", status);
  return std::string(reinterpret_cast<const char*>(r360pkg_stfs_display_name_ptr()),
                     r360pkg_stfs_display_name_length());
}

Bytes extractStfsEntry(const HostFile* file, uint32_t index) {
  r360pkg_stfs_extract_begin(index);
  Bytes out(r360pkg_stfs_extract_bytes_total());
  uint32_t requests = 0;
  while (r360pkg_stfs_request_pending()) {
    if (++requests > (1u << 20)) {
      r360pkg_stfs_extract_reset();
      Fail("STFS extraction exceeded native read request limit");
    }
    const uint32_t size = r360pkg_stfs_request_size();
    const uint32_t dest = r360pkg_stfs_extract_bytes_done();
    StageSlice(file, RequestOffset(), size);
    if (dest < out.size()) {
      std::memcpy(out.data() + dest, reinterpret_cast<const void*>(r360pkg_io_ptr()),
                  std::min<size_t>(size, out.size() - dest));
    }
    r360pkg_stfs_submit_read(size);
  }
  if (r360pkg_stfs_extract_status() != 2) Fail("STFS extraction of entry %u failed (status %u)", index,
                                               r360pkg_stfs_extract_status());
  return out;
}

// listStfsVfsFiles + run-title's eager extraction of every file.
std::vector<VfsFile> listStfsVfsFiles(const HostFile* file, Bytes* default_xex) {
  const uint32_t count = r360pkg_stfs_entry_count();
  std::vector<std::string> names(count);
  std::vector<uint32_t> parents(count);
  for (uint32_t i = 0; i < count; ++i) {
    names[i].assign(reinterpret_cast<const char*>(r360pkg_stfs_entry_name_ptr(i)), r360pkg_stfs_entry_name_length(i));
    parents[i] = r360pkg_stfs_entry_parent_index(i);
  }
  auto path_of = [&](uint32_t i) {
    std::string path = names[i];
    for (uint32_t p = parents[i], depth = 0; p < count && p != i; p = parents[p]) {
      if (++depth > 64) Fail("STFS directory chain too deep");
      path = names[p] + "\\" + path;
      if (parents[p] == p) break;
    }
    return path;
  };
  std::vector<VfsFile> files;
  for (uint32_t i = 0; i < count; ++i) {
    VfsFile f;
    f.path = path_of(i);
    f.directory = r360pkg_stfs_entry_is_directory(i) != 0;
    if (!f.directory) {
      f.size = r360pkg_stfs_entry_length(i);
      f.data = extractStfsEntry(file, i);
      f.has_data = true;
      std::string lower = f.path;
      std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
      if (lower == "default.xex") *default_xex = f.data;
    }
    files.push_back(std::move(f));
  }
  return files;
}

// --- Folders ---------------------------------------------------------------------

void walkFolder(const std::string& root, const std::string& prefix, std::vector<VfsFile>& files) {
  DIR* dir = opendir(root.c_str());
  if (!dir) Fail("cannot list %s", root.c_str());
  std::vector<std::string> names;
  while (dirent* e = readdir(dir)) {
    if (!std::strcmp(e->d_name, ".") || !std::strcmp(e->d_name, "..")) continue;
    names.push_back(e->d_name);
  }
  closedir(dir);
  std::sort(names.begin(), names.end());  // fs.readdirSync order on APFS/HFS+
  for (const auto& name : names) {
    const std::string full = root + "/" + name;
    const std::string guest = prefix.empty() ? name : prefix + "\\" + name;
    struct stat st {};
    if (stat(full.c_str(), &st) != 0) continue;
    VfsFile f;
    f.path = guest;
    if (S_ISDIR(st.st_mode)) {
      f.directory = true;
      files.push_back(f);
      walkFolder(full, guest, files);
    } else if (S_ISREG(st.st_mode)) {
      f.size = uint64_t(st.st_size);
      f.host_fd = OpenHostFile(full)->fd;
      files.push_back(f);
    }
  }
}

// --- openTitle (tools/run-title.mjs) ------------------------------------------------

struct OpenedTitle {
  R360SourceKind kind = R360_SOURCE_UNKNOWN;
  Bytes default_xex;
  std::vector<VfsFile> files;
  std::string title;
};

OpenedTitle openTitle(const std::string& input) {
  OpenedTitle title;
  struct stat st {};
  if (stat(input.c_str(), &st) != 0) Fail("cannot stat %s", input.c_str());
  if (S_ISDIR(st.st_mode)) {
    const std::string xex = input + "/default.xex";
    title.kind = R360_SOURCE_FOLDER;
    walkFolder(input, "", title.files);
    const HostFile* file = OpenHostFile(xex);
    title.default_xex = file->ReadBytes(0, size_t(file->size));
    return title;
  }
  const HostFile* file = OpenHostFile(input);
  uint8_t magic[4] = {};
  if (file->size >= 4) file->Read(0, magic, 4);
  if (!std::memcmp(magic, "XEX2", 4)) {
    // A bare XEX: its folder is the game root, as when launched from a HDD.
    title.kind = R360_SOURCE_XEX;
    std::string root = input.substr(0, input.find_last_of('/'));
    if (root == input) root = ".";
    walkFolder(root, "", title.files);
    bool has_default = false;
    for (const auto& f : title.files) {
      std::string lower = f.path;
      std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
      has_default |= lower == "default.xex";
    }
    if (!has_default) {
      VfsFile f;
      f.path = "default.xex";
      f.size = file->size;
      f.host_fd = file->fd;
      title.files.push_back(f);
    }
    title.default_xex = file->ReadBytes(0, size_t(file->size));
    return title;
  }
  if (!std::memcmp(magic, "LIVE", 4) || !std::memcmp(magic, "PIRS", 4) || !std::memcmp(magic, "CON ", 4)) {
    title.kind = R360_SOURCE_STFS;
    title.title = mountStfs(file);
    title.files = listStfsVfsFiles(file, &title.default_xex);
    if (title.default_xex.empty()) Fail("package has no default.xex");
    return title;
  }
  // Otherwise try an Xbox game disc image (XISO / XGD1-3).
  title.kind = R360_SOURCE_DISC;
  const XdvdfsVolume volume = mountXdvdfs(file);
  listXdvdfsVfsFiles(volume, volume.root_sector, volume.root_size, "", title.files);
  for (const auto& f : title.files) {
    std::string lower = f.path;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (lower == "default.xex" && !f.directory) title.default_xex = file->ReadBytes(f.host_offset, size_t(f.size));
  }
  if (title.default_xex.empty()) Fail("disc has no default.xex");
  return title;
}

// --- XEX helpers (render360-title-controller.mjs) ------------------------------------

constexpr uint32_t XEX_HEADER_ENTRY_POINT = 0x00010100;
constexpr uint32_t XENIA_KERNEL_DATA_BASE = 0x50010000;
constexpr uint32_t XENIA_EXECUTABLE_MODULE_VAR = XENIA_KERNEL_DATA_BASE;
constexpr uint32_t XENIA_KE_DEBUG_MONITOR_DATA = XENIA_KERNEL_DATA_BASE + 0x004;
constexpr uint32_t XENIA_KE_CERT_MONITOR_DATA = XENIA_KERNEL_DATA_BASE + 0x008;
constexpr uint32_t XENIA_EXECUTABLE_HMODULE = XENIA_KERNEL_DATA_BASE + 0x100;
constexpr uint32_t XENIA_XEX_HEADER_BASE = XENIA_KERNEL_DATA_BASE + 0x1000;
constexpr uint32_t XENIA_PROCESS_INFO_BLOCK = XENIA_KERNEL_DATA_BASE + 0x200;

struct KernelVariableSpec {
  uint32_t ordinal;
  const char* name;
  uint32_t address;
  std::vector<uint32_t> words;
  const char* text = nullptr;
  uint32_t bytes = 0;
};
// Every xboxkrnl variable export Xenia backs with real guest storage
// (XboxkrnlModule constructor + RegisterVideoExports), in the kernel data page.
const std::vector<KernelVariableSpec>& KernelVariableLayout() {
  static const std::vector<KernelVariableSpec> kLayout = {
      {0x0C, "ExConsoleGameRegion", XENIA_KERNEL_DATA_BASE + 0x00C, {0xFFFFFFFFu}},
      {0x59, "KeDebugMonitorData", XENIA_KE_DEBUG_MONITOR_DATA, {0}},
      {0xAD, "KeTimeStampBundle", XENIA_KERNEL_DATA_BASE + 0x040, {0, 0, 0, 0, 0, 0}},
      {0x156, "XboxHardwareInfo", XENIA_KERNEL_DATA_BASE + 0x010, {0x20, 0x06000000, 0, 0}},
      {0x158, "XboxKrnlVersion", XENIA_KERNEL_DATA_BASE + 0x020, {0x0002FFFF, 0xFFFF8000}},
      {0x193, "XexExecutableModuleHandle", XENIA_EXECUTABLE_MODULE_VAR, {}},
      {0x1AE, "ExLoadedCommandLine", XENIA_KERNEL_DATA_BASE + 0x800, {}, "\"default.xex\"", 0x400},
      {0x1AF, "ExLoadedImageName", XENIA_KERNEL_DATA_BASE + 0x400, {}, "\\Device\\Cdrom0\\default.xex", 0x100},
      {0x1BE, "VdGlobalDevice", XENIA_KERNEL_DATA_BASE + 0x028, {0}},
      {0x1BF, "VdGlobalXamDevice", XENIA_KERNEL_DATA_BASE + 0x02C, {0}},
      {0x1C0, "VdGpuClockInMHz", XENIA_KERNEL_DATA_BASE + 0x030, {500}},
      // X_RTL_CRITICAL_SECTION initialized with spin count 10000 (Xenia).
      {0x1C1, "VdHSIOCalibrationLock", XENIA_KERNEL_DATA_BASE + 0x060, {0x01280000, 0, 0, 0, 0xFFFFFFFFu, 0, 0}},
      {0x266, "KeCertMonitorData", XENIA_KE_CERT_MONITOR_DATA, {0}},
  };
  return kLayout;
}
const KernelVariableSpec* FindKernelVariable(uint32_t ordinal) {
  for (const auto& spec : KernelVariableLayout()) {
    if (spec.ordinal == ordinal) return &spec;
  }
  return nullptr;
}
// Xenia XexModule::SetupLibraryImports placeholder for unbacked variables.
uint32_t xeniaUnmappedVariableValue(uint32_t ordinal) { return 0xD000BEEFu | ((ordinal & 0xFFFu) << 16); }

uint32_t readXexEntryPoint(const Bytes& xex, uint32_t header_size) {
  const uint32_t count = be32(xex.data(), 0x14);
  if (header_size < 0x18 || count > ((header_size - 0x18) >> 3)) Fail("XEX optional-header table out of bounds");
  for (uint32_t i = 0, p = 0x18; i < count; ++i, p += 8) {
    if (be32(xex.data(), p) != XEX_HEADER_ENTRY_POINT) continue;
    const uint32_t entry = be32(xex.data(), p + 4);
    if (!entry) Fail("XEX entry point is zero");
    return entry;
  }
  Fail("XEX entry point optional header missing");
}

// {inline value} for key&0xff == 0, {offset p+4} for 1, else {offset value}.
bool readXexOptionalHeader(const Bytes& xex, uint32_t header_size, uint32_t key, uint32_t* inline_value,
                           uint32_t* offset) {
  const uint32_t count = be32(xex.data(), 0x14);
  if (header_size < 0x18 || count > ((header_size - 0x18) >> 3)) return false;
  for (uint32_t i = 0, p = 0x18; i < count; ++i, p += 8) {
    if (be32(xex.data(), p) != key) continue;
    const uint32_t value = be32(xex.data(), p + 4);
    *inline_value = (key & 0xFF) == 0 ? value : 0;
    *offset = (key & 0xFF) == 0 ? 0 : (key & 0xFF) == 1 ? p + 4 : value;
    return true;
  }
  return false;
}

struct XexTlsInfo {
  uint32_t slot_count = 0, raw_data_address = 0, data_size = 0, raw_data_size = 0;
};
bool readXexTlsInfo(const Bytes& xex, uint32_t header_size, XexTlsInfo* info) {
  uint32_t value = 0, o = 0;
  if (!readXexOptionalHeader(xex, header_size, 0x00020104, &value, &o) || !o || o + 16 > header_size) return false;
  info->slot_count = be32(xex.data(), o);
  info->raw_data_address = be32(xex.data(), o + 4);
  info->data_size = be32(xex.data(), o + 8);
  info->raw_data_size = be32(xex.data(), o + 12);
  return true;
}
uint32_t readXexDefaultStackSize(const Bytes& xex, uint32_t header_size) {
  uint32_t value = 0, o = 0;
  return readXexOptionalHeader(xex, header_size, 0x00020200, &value, &o) ? value : 0;
}

struct XexPages {
  std::vector<uint32_t> words;
  uint32_t page_size = 0, load_address = 0;
};
bool readXexPageDescriptors(const Bytes& xex, XexPages* pages) {
  if (xex.size() < 0x18) return false;
  const uint32_t sec = be32(xex.data(), 0x10);
  if (uint64_t(sec) + 0x184 > xex.size()) return false;
  pages->load_address = be32(xex.data(), sec + 0x110);
  const uint32_t count = be32(xex.data(), sec + 0x180);
  if (!count || count > 4096 || uint64_t(sec) + 0x184 + uint64_t(count) * 0x18 > xex.size()) return false;
  pages->words.resize(count);
  for (uint32_t i = 0; i < count; ++i) pages->words[i] = be32(xex.data(), sec + 0x184 + i * 0x18);
  pages->page_size = pages->load_address <= 0x90000000u ? 0x10000 : 0x1000;
  return true;
}

Bytes extractXex2EncryptedImageKey(const Bytes& xex) {
  if (xex.size() < 0x18 || std::memcmp(xex.data(), "XEX2", 4)) Fail("default.xex is not XEX2");
  const uint32_t header_size = be32(xex.data(), 8), security = be32(xex.data(), 0x10);
  if (header_size < 0x18 || header_size > xex.size()) Fail("XEX header size out of bounds");
  if (!security || security > header_size - 0x160) Fail("XEX2 security info is too small for AES key");
  return Bytes(xex.begin() + security + 0x150, xex.begin() + security + 0x160);
}

// --- prepareRetailXexImage (retail-xex-image-pipeline.mjs) ----------------------------

void coreStage(const uint8_t* bytes, size_t length) {
  if (length > r360pkg_io_capacity()) Fail("XEX core staging overflow");
  std::memcpy(reinterpret_cast<void*>(r360pkg_io_ptr()), bytes, length);
}

Bytes normalizeDecryptedHeader(const Bytes& header) {
  Bytes out = header;
  const uint32_t count = be32(out.data(), 0x14);
  uint32_t ffi = 0;
  bool found = false;
  for (uint32_t i = 0, p = 0x18; i < count; ++i, p += 8) {
    if (p + 8 > out.size()) Fail("XEX optional-header table truncated");
    if (be32(out.data(), p) == 0x3FF) {
      ffi = be32(out.data(), p + 4);
      found = true;
      break;
    }
  }
  if (!found) Fail("XEX file-format info missing");
  if (ffi + 8 > out.size()) Fail("XEX file-format info out of range");
  out[ffi + 4] = 0;
  out[ffi + 5] = 0;
  return out;
}

Bytes decryptBody(const Bytes& key, const uint8_t* body, size_t length) {
  auto* ptr = r360_xex_crypto_buffer();
  const uint32_t cap = r360_xex_crypto_capacity();
  if (key.size() != 16) Fail("encrypted XEX security key must be 16 bytes");
  if (!length || (length & 15)) Fail("encrypted XEX body must be non-empty and AES-block aligned");
  r360_xex_crypto_reset();
  std::memcpy(ptr, key.data(), 16);
  if (r360_xex_crypto_begin_session(0) != 1) Fail("XEX session derivation failed %u", r360_xex_crypto_status());
  Bytes out(length);
  size_t off = 0;
  while (off < length) {
    const uint32_t n = uint32_t(std::min<size_t>(cap, length - off)) & ~15u;
    if (!n) Fail("XEX AES chunk accounting failed");
    std::memcpy(ptr, body + off, n);
    if (r360_xex_crypto_decrypt_chunk(n) != 1) Fail("XEX AES decrypt failed %u", r360_xex_crypto_status());
    std::memcpy(out.data() + off, ptr, n);
    off += n;
  }
  if (r360_xex_crypto_bytes_done() != length) Fail("XEX AES byte accounting mismatch");
  return out;
}

Bytes prepareNone(const Bytes& header, const Bytes& body) {
  coreStage(header.data(), header.size());
  uint32_t st = r360pkg_xex_prepare_none_begin(uint32_t(header.size()), uint32_t(header.size() + body.size()));
  if (st != 1) Fail("NONE begin failed %u", st);
  Bytes out;
  size_t off = 0;
  while (off < body.size()) {
    const size_t n = std::min<size_t>(body.size() - off, 0x7000);
    coreStage(body.data() + off, n);
    st = r360pkg_xex_prepare_none_accept(uint32_t(n));
    out.insert(out.end(), body.begin() + off, body.begin() + off + n);
    off += n;
  }
  if (st != 2) Fail("NONE preparation failed %u", st);
  return out;
}

Bytes prepareBasic(const Bytes& header, const Bytes& body) {
  coreStage(header.data(), header.size());
  uint32_t st = r360pkg_xex_prepare_basic_begin(uint32_t(header.size()), uint32_t(header.size() + body.size()));
  if (st != 1) Fail("BASIC begin failed %u", st);
  Bytes out;
  size_t off = 0, guard = 0;
  while (r360pkg_xex_prepare_status() == 1) {
    if (++guard > 100000) Fail("BASIC preparation loop runaway");
    const uint32_t zero = r360pkg_xex_prepare_basic_zero_remaining();
    if (zero) {
      st = r360pkg_xex_prepare_basic_consume_zero(std::min<uint32_t>(zero, 0x4000));
      const uint32_t outn = r360pkg_xex_prepare_last_output_bytes();
      if (!outn || r360pkg_xex_prepare_last_output_kind() != 2) Fail("BASIC zero event mismatch");
      out.insert(out.end(), outn, 0);
      continue;
    }
    const uint32_t data = r360pkg_xex_prepare_basic_data_remaining();
    if (!data) Fail("BASIC state has no work");
    const size_t n = std::min<size_t>({size_t(data), body.size() - off, size_t(0x7000)});
    if (!n) Fail("BASIC encrypted source truncated");
    coreStage(body.data() + off, n);
    st = r360pkg_xex_prepare_basic_accept_data(uint32_t(n));
    if (r360pkg_xex_prepare_last_output_bytes() != n || r360pkg_xex_prepare_last_output_kind() != 1)
      Fail("BASIC data event mismatch");
    out.insert(out.end(), body.begin() + off, body.begin() + off + n);
    off += n;
  }
  if (st != 2 || off != body.size()) Fail("BASIC preparation failed status=%u source=%zu/%zu", st, off, body.size());
  return out;
}

Bytes prepareNormal(const Bytes& header, const Bytes& body) {
  coreStage(header.data(), header.size());
  uint32_t st = r360pkg_xex_prepare_normal_frame_begin(uint32_t(header.size()), uint32_t(header.size() + body.size()));
  if (st >= 100) Fail("NORMAL begin failed %u", st);
  Bytes stream;
  size_t off = 0, pi = 0;
  static const size_t kPattern[] = {17, 31, 67, 127, 251, 509};
  while (off < body.size() && st != 2 && st < 100) {
    const size_t n = std::min(body.size() - off, kPattern[pi++ % 6]);
    coreStage(body.data() + off, n);
    st = r360pkg_xex_prepare_normal_frame_accept(uint32_t(n));
    const uint32_t outn = r360pkg_xex_prepare_last_output_bytes();
    if (outn) {
      const auto* io = reinterpret_cast<const uint8_t*>(r360pkg_io_ptr());
      stream.insert(stream.end(), io, io + outn);
    }
    off += n;
  }
  if (st != 2) Fail("NORMAL framing failed %u", st);
  const uint32_t expected = r360pkg_xex_decode_image_size();
  if (stream.empty() || stream.size() > r360_lzx_input_capacity() || !expected || expected > r360_lzx_output_capacity())
    Fail("NORMAL LZX bounds");
  r360_lzx_reset();
  std::memcpy(r360_lzx_input_buffer(), stream.data(), stream.size());
  const uint32_t ls = r360_lzx_decompress(uint32_t(stream.size()), expected, r360pkg_xex_prepare_normal_window_size());
  if (ls != 0 || r360_lzx_output_size() != expected) Fail("NORMAL LZX failed %u", ls);
  return Bytes(r360_lzx_output_buffer(), r360_lzx_output_buffer() + expected);
}

Bytes prepareRetailXexImage(const Bytes& header, const Bytes& body, const Bytes& key) {
  coreStage(header.data(), header.size());
  const uint32_t decode = r360pkg_xex_decode(uint32_t(header.size()));
  if (decode != 1) Fail("XEX metadata decode failed status=%u", decode);
  const uint32_t enc = r360pkg_xex_decode_encryption_type();
  const uint32_t comp = r360pkg_xex_decode_compression_type();
  if (comp > 2) Fail("unsupported XEX patch/delta compression %u", comp);
  Bytes plain = body, effective = header;
  if (enc == 1) {
    plain = decryptBody(key, body.data(), body.size());
    effective = normalizeDecryptedHeader(header);
  } else if (enc != 0) {
    Fail("unsupported XEX encryption %u", enc);
  }
  if (comp == 0) return prepareNone(effective, plain);
  if (comp == 1) return prepareBasic(effective, plain);
  return prepareNormal(effective, plain);
}

// --- Kernel import plan (render360-xex-imports.mjs, render360-kernel-imports.mjs) ---

struct ImportLibrary {
  std::string name;
  std::vector<uint32_t> imports;
};

std::vector<ImportLibrary> decodeXexImportLibraries(const Bytes& x) {
  const uint32_t header_size = be32(x.data(), 8), header_count = be32(x.data(), 0x14);
  if (header_size < 0x18 || header_size > x.size() || header_count > ((header_size - 0x18) >> 3))
    Fail("XEX optional header table out of bounds");
  uint32_t offset = 0;
  for (uint32_t i = 0; i < header_count; ++i) {
    if (be32(x.data(), 0x18 + i * 8) == 0x000103FF) {
      offset = be32(x.data(), 0x18 + i * 8 + 4);
      break;
    }
  }
  std::vector<ImportLibrary> libraries;
  if (!offset) return libraries;
  if (offset > header_size - 12) Fail("XEX import header out of bounds");
  const uint32_t total = be32(x.data(), offset), string_bytes = be32(x.data(), offset + 4),
                 string_count = be32(x.data(), offset + 8);
  if (total < 12 || offset + total > header_size || 12 + string_bytes > total || string_count > 256)
    Fail("XEX import header size invalid");
  std::vector<std::string> strings;
  for (uint32_t s = 0; s < string_bytes && strings.size() < string_count;) {
    const uint32_t start = offset + 12 + s, limit = offset + 12 + string_bytes;
    uint32_t end = start;
    while (end < limit && x[end]) ++end;
    if (end == limit) Fail("unterminated XEX import string");
    strings.emplace_back(reinterpret_cast<const char*>(x.data() + start), end - start);
    s += (end - start) + 1;
    if (s & 3) s += 4 - (s & 3);
  }
  if (strings.size() != string_count) Fail("XEX import string count mismatch");
  uint32_t p = offset + 12 + string_bytes;
  const uint32_t end = offset + total;
  while (p < end) {
    if (end - p < 0x28) Fail("truncated XEX import library");
    const uint32_t size = be32(x.data(), p);
    if (!size) break;
    if (size < 0x28 || size > end - p) Fail("XEX import library size invalid");
    const uint32_t name_index = be16(x.data(), p + 0x24) & 0xFF, count = be16(x.data(), p + 0x26);
    if (name_index >= strings.size()) Fail("XEX import library name index invalid");
    if (0x28 + count * 4 > size) Fail("XEX import table exceeds library record");
    ImportLibrary lib;
    lib.name = strings[name_index];
    for (uint32_t i = 0; i < count; ++i) lib.imports.push_back(be32(x.data(), p + 0x28 + i * 4));
    libraries.push_back(std::move(lib));
    p += size;
  }
  return libraries;
}

uint32_t imageBaseFromXex(const Bytes& x) {
  const uint32_t header_count = be32(x.data(), 0x14);
  for (uint32_t i = 0; i < header_count; ++i) {
    if (be32(x.data(), 0x18 + i * 8) == 0x00010201) return be32(x.data(), 0x18 + i * 8 + 4);
  }
  Fail("XEX image base optional header missing");
}

struct PeSection {
  uint32_t virtual_size, virtual_address, raw_size, raw_pointer, virtual_span;
};
struct PreparedPe {
  const Bytes* bytes;
  uint32_t size_of_image = 0, size_of_headers = 0;
  std::vector<PeSection> sections;
};

PreparedPe parsePreparedPe(const Bytes& p) {
  if (p.size() < 0x40 || p[0] != 0x4D || p[1] != 0x5A) Fail("kernel import prepared image is not PE");
  const uint32_t nt = le32(p.data(), 0x3C);
  if (nt > p.size() - 24 || le32(p.data(), nt) != 0x00004550) Fail("kernel import PE NT header invalid");
  const uint32_t section_count = le16(p.data(), nt + 6), optional_size = le16(p.data(), nt + 20), optional = nt + 24;
  if (optional > p.size() || optional_size > p.size() - optional) Fail("kernel import PE optional header out of bounds");
  if (optional_size < 64) Fail("kernel import PE optional header too small");
  PreparedPe pe;
  pe.bytes = &p;
  pe.size_of_image = le32(p.data(), optional + 56);
  pe.size_of_headers = le32(p.data(), optional + 60);
  if (!pe.size_of_image || pe.size_of_headers > p.size()) Fail("kernel import PE image/header size invalid");
  const uint32_t table = optional + optional_size;
  if (section_count > (p.size() - table) / 40) Fail("kernel import PE section table out of bounds");
  for (uint32_t i = 0; i < section_count; ++i) {
    const uint32_t s = table + i * 40;
    PeSection sec{le32(p.data(), s + 8), le32(p.data(), s + 12), le32(p.data(), s + 16), le32(p.data(), s + 20), 0};
    sec.virtual_span = std::max(sec.virtual_size, sec.raw_size);
    const uint64_t vend = uint64_t(sec.virtual_address) + sec.virtual_span;
    if (vend > 0x100000000ull || vend > pe.size_of_image) Fail("kernel import PE section RVA wraps/exceeds image");
    pe.sections.push_back(sec);
  }
  return pe;
}

bool rvaInsideMappedPe(const PreparedPe& pe, uint64_t rva, uint64_t size) {
  const uint64_t len = pe.bytes->size();
  if (rva < pe.size_of_headers) return rva + size <= pe.size_of_headers && rva + size <= len;
  for (const auto& s : pe.sections) {
    if (rva < s.virtual_address) continue;
    const uint64_t delta = rva - s.virtual_address;
    if (delta >= s.virtual_span) continue;
    return rva + size <= len && delta + size <= s.virtual_span;
  }
  return false;
}

bool rawOffsetForRva(const PreparedPe& pe, uint64_t rva, uint64_t size, uint64_t* out) {
  const uint64_t len = pe.bytes->size();
  if (rva < pe.size_of_headers) {
    if (rva + size <= pe.size_of_headers && rva + size <= len) {
      *out = rva;
      return true;
    }
    return false;
  }
  for (const auto& s : pe.sections) {
    if (rva < s.virtual_address) continue;
    const uint64_t delta = rva - s.virtual_address;
    if (delta >= s.virtual_span) continue;
    if (int64_t(delta) > int64_t(s.raw_size) - int64_t(size)) return false;
    const uint64_t raw = s.raw_pointer + delta;
    if (raw + size > len) return false;
    *out = raw;
    return true;
  }
  return false;
}

bool isMappedImageLayout(const PreparedPe& pe) {
  const uint64_t len = pe.bytes->size();
  if (len >= pe.size_of_image) return true;
  uint64_t disk_end = pe.size_of_headers;
  for (const auto& s : pe.sections) disk_end = std::max<uint64_t>(disk_end, uint64_t(s.raw_pointer) + s.raw_size);
  if (len > disk_end) return true;
  if (pe.sections.empty()) return false;
  for (const auto& s : pe.sections) {
    if (uint64_t(s.virtual_address) + std::min(s.raw_size, s.virtual_span) > len) return false;
  }
  return true;
}

struct ResolvedDescriptor {
  bool mapped;
  uint64_t offset;
  uint32_t descriptor, type, ordinal;
};
ResolvedDescriptor resolveImportDescriptor(const PreparedPe& pe, uint64_t rva) {
  std::vector<ResolvedDescriptor> candidates;
  if (rvaInsideMappedPe(pe, rva, 4)) candidates.push_back({true, rva, 0, 0, 0});
  uint64_t raw = 0;
  if (rawOffsetForRva(pe, rva, 4, &raw)) {
    bool dup = false;
    for (const auto& c : candidates) dup |= c.offset == raw;
    if (!dup) candidates.push_back({false, raw, 0, 0, 0});
  }
  if (candidates.empty()) Fail("XEX import descriptor RVA is outside PE mappings");
  for (auto& c : candidates) {
    c.descriptor = be32(pe.bytes->data(), size_t(c.offset));
    c.type = (c.descriptor >> 24) & 0xFF;
    c.ordinal = c.descriptor & 0xFFFF;
  }
  std::vector<ResolvedDescriptor> valid;
  for (const auto& c : candidates) {
    if (c.type == 0 || c.type == 1) valid.push_back(c);
  }
  if (valid.size() == 1) return valid[0];
  if (valid.size() > 1) {
    const bool want_mapped = isMappedImageLayout(pe);
    for (const auto& c : valid) {
      if (c.mapped == want_mapped) return c;
    }
    return valid[0];
  }
  Fail("unsupported XEX import descriptor type %u", candidates[0].type);
}

struct KernelImport {
  std::string module;
  uint32_t ordinal = 0;
  bool function = false;
  bool kernel_module = false;
  uint32_t value_address = 0, thunk_address = 0;
};
struct KernelImportPlan {
  uint32_t image_base = 0;
  std::vector<KernelImport> plan;
};

KernelImportPlan buildKernelImportPlan(const Bytes& xex, const Bytes& prepared) {
  KernelImportPlan out;
  const auto libraries = decodeXexImportLibraries(xex);
  const PreparedPe pe = parsePreparedPe(prepared);
  out.image_base = imageBaseFromXex(xex);
  for (const auto& lib : libraries) {
    std::string lower = lib.name;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    const bool kernel = lower == "xboxkrnl.exe" || lower == "xam.xex";
    std::vector<KernelImport> imports;
    for (uint32_t record : lib.imports) {
      if (record < out.image_base) Fail("XEX import descriptor below image base: %s@0x%x", lib.name.c_str(), record);
      const ResolvedDescriptor d = resolveImportDescriptor(pe, uint64_t(record) - out.image_base);
      if (d.type == 0) {
        KernelImport item;
        item.module = lib.name;
        item.ordinal = d.ordinal;
        item.kernel_module = kernel;
        item.value_address = record;
        imports.push_back(item);
        continue;
      }
      if (imports.empty() || imports.back().ordinal != d.ordinal || imports.back().thunk_address)
        Fail("XEX import thunk has no matching descriptor: %s ordinal 0x%x", lib.name.c_str(), d.ordinal);
      imports.back().function = true;
      imports.back().thunk_address = record;
    }
    out.plan.insert(out.plan.end(), imports.begin(), imports.end());
  }
  return out;
}

uint32_t moduleId(const std::string& name) {
  std::string lower = name;
  std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
  return lower == "xboxkrnl.exe" ? 1 : lower == "xam.xex" ? 2 : 0;
}

// registerKernelImportPlan: no browser HLE in the native build (the native
// title-GPU runtime is always present), so no function import is
// "implemented" by a relocated shim.
uint32_t registerKernelImportPlan(const KernelImportPlan& imports) {
  r360_kernel_import_reset();
  uint32_t registered = 0;
  for (const auto& item : imports.plan) {
    if (!item.kernel_module || !item.function || !item.thunk_address) continue;
    const uint32_t id = moduleId(item.module);
    if (!id) continue;
    if (r360_kernel_import_register(item.thunk_address, id, item.ordinal, 0, 0) != 1)
      Fail("failed to register kernel import %s ordinal 0x%x", item.module.c_str(), item.ordinal);
    ++registered;
  }
  return registered;
}

void put8(uint32_t address, uint32_t value) {
  if (r360_sparse_guest_memory_write_u8(address, value & 0xFF) != 1)
    Fail("unable to initialize guest memory @ 0x%x", address);
}
void put32(uint32_t address, uint32_t value) {
  for (int i = 0; i < 4; ++i) put8(address + i, (value >> (24 - i * 8)) & 0xFF);
}

uint32_t installKernelVariableImports(const KernelImportPlan& imports, const Bytes& xex, uint32_t entry,
                                      uint32_t header_size) {
  bool any = false;
  for (const auto& item : imports.plan) any |= item.kernel_module && !item.function;
  if (!any) return 0;
  const uint32_t page = 4096, read_write = 3;
  const uint32_t pages = 1 + (header_size + page - 1) / page;
  const uint32_t backing = r360_sparse_guest_memory_alloc(pages);
  if (!backing || r360_sparse_guest_memory_map(XENIA_KERNEL_DATA_BASE, pages, backing, 0, read_write) != 1)
    Fail("unable to map Xenia kernel variable/module state");
  for (uint32_t i = 0; i < header_size; ++i) put8(XENIA_XEX_HEADER_BASE + i, xex[i]);
  const uint32_t security = be32(xex.data(), 0x10);
  if (security > header_size - 8) Fail("XEX security header is outside copied guest header");
  const uint32_t image_size = be32(xex.data(), security + 4);
  // X_LDR_DATA_TABLE_ENTRY fields used by Xenia UserModule::LoadXexContinue.
  put32(XENIA_EXECUTABLE_HMODULE + 0x18, 0);
  put32(XENIA_EXECUTABLE_HMODULE + 0x1C, imports.image_base);
  put32(XENIA_EXECUTABLE_HMODULE + 0x38, image_size);
  put32(XENIA_EXECUTABLE_HMODULE + 0x3C, entry);
  put32(XENIA_EXECUTABLE_HMODULE + 0x58, XENIA_XEX_HEADER_BASE);
  put32(XENIA_EXECUTABLE_MODULE_VAR, XENIA_EXECUTABLE_HMODULE);
  for (const auto& spec : KernelVariableLayout()) {
    for (size_t i = 0; i < spec.words.size(); ++i) put32(spec.address + uint32_t(i) * 4, spec.words[i]);
    if (spec.text) {
      const size_t n = std::strlen(spec.text);
      for (uint32_t i = 0; i < spec.bytes; ++i) put8(spec.address + i, i < n ? uint8_t(spec.text[i]) : 0);
    }
  }
  // ProcessInfoBlock (KernelState::SetExecutableModule).
  XexTlsInfo tls;
  const bool has_tls = readXexTlsInfo(xex, header_size, &tls);
  for (uint32_t i = 0; i < 0x60; i += 4) put32(XENIA_PROCESS_INFO_BLOCK + i, 0);
  put32(XENIA_PROCESS_INFO_BLOCK + 0x0C, 0x0000007F);
  put32(XENIA_PROCESS_INFO_BLOCK + 0x10, 0x001F0000);
  put8(XENIA_PROCESS_INFO_BLOCK + 0x1B, 0x06);
  put32(XENIA_PROCESS_INFO_BLOCK + 0x1C, 16 * 1024);
  if (has_tls) {
    put32(XENIA_PROCESS_INFO_BLOCK + 0x24, tls.data_size);
    put32(XENIA_PROCESS_INFO_BLOCK + 0x28, tls.raw_data_size);
    put8(XENIA_PROCESS_INFO_BLOCK + 0x2C, ((tls.slot_count * 4) >> 8) & 0xFF);
    put8(XENIA_PROCESS_INFO_BLOCK + 0x2D, (tls.slot_count * 4) & 0xFF);
  }
  put8(XENIA_PROCESS_INFO_BLOCK + 0x2F, 1);  // X_PROCTYPE_USER
  if (r360_kernel_set_executable_module(XENIA_EXECUTABLE_HMODULE, XENIA_XEX_HEADER_BASE, XENIA_PROCESS_INFO_BLOCK) != 1)
    Fail("native kernel rejected the guest XEX header");
  r360_kernel_set_timestamp_bundle(XENIA_KERNEL_DATA_BASE + 0x040);
  uint32_t relocated = 0;
  for (const auto& item : imports.plan) {
    if (!item.kernel_module || item.function) continue;
    std::string lower = item.module;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    const KernelVariableSpec* spec = lower == "xboxkrnl.exe" ? FindKernelVariable(item.ordinal) : nullptr;
    const uint32_t target = spec ? spec->address : xeniaUnmappedVariableValue(item.ordinal);
    if (r360_xex_guest_mapper_patch_u32_be(item.value_address, target) != 1)
      Fail("failed to relocate %s ordinal 0x%x at 0x%x (mapper 0x%x)", item.module.c_str(), item.ordinal,
           item.value_address, r360_xex_guest_mapper_status());
    if (spec) ++relocated;
  }
  return relocated;
}

struct MainThreadContext {
  uint32_t stack_top = 0, pcr = 0;
};

MainThreadContext prepareBrowserMainThreadContext(uint32_t entry, const Bytes& xex, uint32_t header_size) {
  const uint32_t page = 4096, stack_slot_base = 0x70000000, stack_limit = stack_slot_base + page;
  const uint32_t xex_stack = readXexDefaultStackSize(xex, header_size);
  const uint32_t stack_pages = std::max<uint32_t>(128, std::min<uint32_t>(0x0F00, (xex_stack + 4095) / 4096));
  const uint32_t stack_base = stack_limit + stack_pages * page;
  MainThreadContext ctx;
  ctx.stack_top = (stack_base - (64 + 112)) & ~0xFu;
  ctx.pcr = 0x50000000;
  const uint32_t tls_address = 0x50001000, thread = 0x50002000, context_pages = 3, read_write = 3;
  const uint32_t stack_backing = r360_sparse_guest_memory_alloc(stack_pages);
  if (!stack_backing || r360_sparse_guest_memory_map(stack_limit, stack_pages, stack_backing, 0, read_write) != 1)
    Fail("unable to map Xbox main-thread stack");
  const uint32_t context_backing = r360_sparse_guest_memory_alloc(context_pages);
  if (!context_backing || r360_sparse_guest_memory_map(ctx.pcr, context_pages, context_backing, 0, read_write) != 1)
    Fail("unable to map Xbox main-thread PCR/TLS");
  put32(ctx.pcr + 0x000, tls_address);
  put32(ctx.pcr + 0x030, ctx.pcr);
  put32(ctx.pcr + 0x070, stack_base);
  put32(ctx.pcr + 0x074, stack_limit);
  put32(ctx.pcr + 0x100, thread);
  put32(ctx.pcr + 0x150, 0);
  put32(thread + 0x05C, stack_base);
  put32(thread + 0x060, stack_limit);
  put32(thread + 0x068, tls_address);
  put32(thread + 0x0D0, stack_base);
  put32(thread + 0x14C, 1);
  put32(thread + 0x150, entry);
  // XThread::InitializeGuestObject: dispatcher header type 6, self-linked
  // list heads, process info block, creation time, flags.
  put8(thread + 0x000, 6);
  static const uint32_t kLinks[][2] = {{0x008, 0x008}, {0x00C, 0x008}, {0x010, 0x010}, {0x014, 0x010},
                                       {0x040, 0x020}, {0x044, 0x020}, {0x048, 0x000}, {0x04C, 0x018},
                                       {0x074, 0x074}, {0x078, 0x074}, {0x07C, 0x07C}, {0x080, 0x07C},
                                       {0x144, 0x144}, {0x148, 0x144}, {0x154, 0x154}, {0x158, 0x154}};
  for (const auto& link : kLinks) put32(thread + link[0], thread + link[1]);
  put32(thread + 0x054, 0x01020001);
  put32(thread + 0x084, XENIA_PROCESS_INFO_BLOCK);
  put8(thread + 0x08B, 1);
  put32(thread + 0x09C, 0xFDFFD7FF);
  put32(thread + 0x17C, 1);
  // TLS: slots*4 + extended data, with the XEX TLS template copied in.
  XexTlsInfo tls;
  if (readXexTlsInfo(xex, header_size, &tls)) {
    const uint32_t slots = tls.slot_count ? tls.slot_count : 1024;
    const uint32_t total = slots * 4 + tls.data_size;
    uint32_t block = tls_address;
    if (total > page) {
      block = r360_kernel_pool_alloc(total, 16);
      if (!block) Fail("unable to allocate %u-byte Xbox TLS block", total);
    }
    const uint32_t copy = std::min(tls.raw_data_size, tls.data_size);
    for (uint32_t i = 0; copy && tls.raw_data_address && i < copy; ++i)
      put8(block + i, r360_sparse_guest_memory_read_u8(tls.raw_data_address + i));
    put32(ctx.pcr + 0x000, block);
    put32(thread + 0x068, block);
  }
  r360_guest_thread_register_external(entry, stack_base, stack_limit, ctx.pcr, thread, 1);
  return ctx;
}

void stagePreparedPeImage(const Bytes& prepared, uint32_t xex_entry, const Bytes& xex) {
  uintptr_t input = r360_xex_guest_mapper_input_buffer();
  uint32_t cap = r360_xex_guest_mapper_input_capacity();
  if (prepared.size() > cap) {
    const uint32_t max = r360_xex_guest_mapper_input_max_capacity();
    if (max && prepared.size() > max) Fail("prepared image exceeds bounded PE staging ceiling %zu/%u", prepared.size(), max);
    if (r360_xex_guest_mapper_reserve_input(uint32_t(prepared.size())) != 1)
      Fail("unable to reserve PE staging for prepared image %zu bytes (status 0x%x)", prepared.size(),
           r360_xex_guest_mapper_status());
    input = r360_xex_guest_mapper_input_buffer();
    cap = r360_xex_guest_mapper_input_capacity();
  }
  if (!input || prepared.size() > cap) Fail("prepared image exceeds current PE staging capacity %zu/%u", prepared.size(), cap);
  XexPages pages;
  if (readXexPageDescriptors(xex, &pages) && pages.words.size() * 4 <= cap) {
    std::memcpy(reinterpret_cast<void*>(input), pages.words.data(), pages.words.size() * 4);
    r360_pe_guest_set_xex_pages(input, uint32_t(pages.words.size()), pages.page_size);
  }
  std::memcpy(reinterpret_cast<void*>(input), prepared.data(), prepared.size());
  if (r360_pe_guest_load_at_entry(input, uint32_t(prepared.size()), xex_entry) != 1)
    Fail("prepared PE guest load failed 0x%x", r360_pe_guest_status());
}

uint32_t RunScannedEntry(void*) { return r360_title_handoff_translate_scanned_entry(); }

// Mirrors the runtimeBoundary expression in handoffDefaultXex.
const char* RuntimeBoundary(bool stopped, uint32_t exec_status, uint32_t kernel_status, uint32_t blocker_kind) {
  if (stopped) return "stopped-by-user";
  if (exec_status == 3) return "guest-return";
  if (kernel_status == 2) return "kernel-import-unimplemented";
  if (kernel_status == 3) return "kernel-import-abi-failed";
  if (kernel_status == 4) return "title-requested-exit";
  if (kernel_status == 5) return "guest-wait-blocked";
  if (exec_status == 2) return "no-return-boundary";
  if (exec_status == 1) {
    return blocker_kind == 2 ? "unresolved-guest-call"
           : blocker_kind == 3 ? "instruction-limit"
           : blocker_kind == 5 ? "guest-memory-dependency"
                               : "unsupported-hir";
  }
  return "execution-not-observed";
}

const char* const kTerminalKinds[] = {"none", "HalReturnToFirmware", "KeBugCheck", "ExTerminateThread",
                                      "XamLoaderTerminateTitle", "XamLoaderLaunchTitle", "title process exit"};
const char* const kWaitReasons[] = {"none",
                                    "infinite wait on an unsignalled object",
                                    "bounded wait spinning without progress",
                                    "lock held by another guest thread",
                                    "game file bytes not yet available to the synchronous kernel",
                                    "XMA audio buffers waiting for a decoder (not implemented yet)"};

// Disc list of the last boot (multi-disc titles).
std::vector<std::string> g_discs;
uint32_t g_current_disc = 0;

void handoffDefaultXex(const Bytes& xex, const Bytes& key, const R360BootOptions& options, R360BootResult* r) {
  if (xex.size() < 0x18 || std::memcmp(xex.data(), "XEX2", 4)) Fail("default.xex is not XEX2");
  const uint32_t header_size = be32(xex.data(), 8);
  if (header_size < 0x18 || header_size > xex.size()) Fail("default.xex header size out of bounds");
  const uint32_t xex_entry = readXexEntryPoint(xex, header_size);
  const Bytes header(xex.begin(), xex.begin() + header_size), body(xex.begin() + header_size, xex.end());
  const Bytes prepared = prepareRetailXexImage(header, body, key);

  // Each handoff is a fresh title boot (the registered guest VFS is kept).
  r360_kernel_runtime_reset();
  r360_kernel_services_reset();
  r360_xam_set_license_mask(options.license_full ? 1 : 0);
  r360_kernel_service_reset();
  stagePreparedPeImage(prepared, xex_entry, xex);
  // XexModule::FindSaveRest.
  XexPages pages;
  if (readXexPageDescriptors(xex, &pages)) {
    uint32_t address = pages.load_address;
    for (uint32_t word : pages.words) {
      const uint32_t size = (word >> 4) * pages.page_size;
      if ((word & 0xF) == 1 && r360_ppc_probe_register_save_rest(address, address + size) == 3) break;
      address += size;
    }
  }
  const uint32_t entry = r360_pe_guest_entry_address();
  r->pe_entry = r360_pe_guest_pe_entry_address();
  if (entry != xex_entry) Fail("XEX entry selection mismatch 0x%x/0x%x", entry, xex_entry);
  r->entry = entry;

  const KernelImportPlan imports = buildKernelImportPlan(xex, prepared);
  r->kernel_imports = uint32_t(imports.plan.size());
  r->kernel_registered = registerKernelImportPlan(imports);
  r->kernel_variables_relocated = installKernelVariableImports(imports, xex, entry, header_size);

  r360_title_handoff_reset();
  if (r360_ppc_probe_page_sparse_code(entry) == 0) Fail("unable to initialize Xenia title decoder before main-thread context");
  r360_title_handoff_reset();
  const MainThreadContext ctx = prepareBrowserMainThreadContext(entry, xex, header_size);
  // R360_XENIA_ENTRY_ABI_V51: upstream Processor::Execute special state.
  if (r360_ppc_probe_set_initial_lr(0xBCBCBCBCull) != 1) Fail("unable to initialize Xenia title-entry LR");
  if (uint32_t(r360_ppc_probe_initial_lr()) != 0xBCBCBCBCu) Fail("Xenia title-entry LR verification failed");
  if (r360_ppc_probe_set_initial_gpr(1, ctx.stack_top) != 1 || r360_ppc_probe_set_initial_gpr(13, ctx.pcr) != 1)
    Fail("failed to set startup GPRs");
  // A sliced run lifts the per-function HIR instruction guard (as the browser).
  if (options.slice_ms) r360_hir_set_instruction_budget(0xFFFFFFFFu);

  uint32_t stopped = 0;
  const uint32_t hir = r360_native_run_with_fibers(RunScannedEntry, nullptr, options.slice_ms, options.on_slice,
                                                   options.user, &stopped);
  r->stopped_by_host = stopped == 1;
  r->hir = r->stopped_by_host ? 1 : hir;
  if (!r->hir) {
    Fail("title entry handoff failed 0x%x probe=0x%x entry=0x%x", r360_title_handoff_status(), r360_ppc_probe_status(),
         entry);
  }
  r->execution_status = r360_ppc_probe_correctness_status();
  r->execution_instructions = r360_ppc_probe_correctness_instructions();
  r->blocker_kind = r360_ppc_probe_correctness_blocker_kind();
  r->blocker_opcode = r360_ppc_probe_correctness_blocker_opcode();
  r->blocker_address = r360_ppc_probe_correctness_blocker_address();
  r->memory_fault_address = r360_sparse_guest_memory_last_fault_address();
  r->memory_fault_code = r360_sparse_guest_memory_last_fault_code();
  r->kernel_calls = r360_kernel_import_calls();
  r->kernel_last_status = r360_kernel_import_last_status();
  r->kernel_last_module = r360_kernel_import_last_module();
  r->kernel_last_ordinal = r360_kernel_import_last_ordinal();
  std::snprintf(r->runtime_boundary, sizeof(r->runtime_boundary), "%s",
                RuntimeBoundary(r->stopped_by_host, r->execution_status, r->kernel_last_status, r->blocker_kind));
  char name[96];
  if (r->kernel_last_status == 4) {
    const uint32_t kind = r360_kernel_terminal_kind();
    std::snprintf(r->kernel_boundary, sizeof(r->kernel_boundary), "title-requested-exit: %s via %s code 0x%X lr 0x%08X",
                  kind < 7 ? kTerminalKinds[kind] : "terminal",
                  r360_native_kernel_export_name(r360_kernel_terminal_module(), r360_kernel_terminal_ordinal(), name,
                                                 sizeof(name)),
                  r360_kernel_terminal_code(), r360_kernel_terminal_lr());
  } else if (r->kernel_last_status == 5) {
    const uint32_t reason = r360_kernel_wait_reason();
    std::snprintf(r->kernel_boundary, sizeof(r->kernel_boundary), "guest-wait-blocked: %s via %s object 0x%08X",
                  reason < 6 ? kWaitReasons[reason] : "wait",
                  r360_native_kernel_export_name(r360_kernel_wait_module(), r360_kernel_wait_ordinal(), name,
                                                 sizeof(name)),
                  r360_kernel_wait_object());
  }
}

struct ExportName {
  uint32_t ordinal;
  const char* name;
};
const ExportName kXboxkrnl[] = {
#define XE_EXPORT(module, ordinal, name, kind) {ordinal, #name}
#include "xenia/kernel/xboxkrnl/xboxkrnl_table.inc"
#undef XE_EXPORT
};
const ExportName kXam[] = {
#define XE_EXPORT(module, ordinal, name, kind) {ordinal, #name}
#include "xenia/kernel/xam/xam_table.inc"
#undef XE_EXPORT
};

void JsonString(std::string& out, const char* s) {
  out += '"';
  for (; *s; ++s) {
    const unsigned char c = static_cast<unsigned char>(*s);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += char(c);
    } else if (c < 0x20) {
      char esc[8];
      std::snprintf(esc, sizeof(esc), "\\u%04x", c);
      out += esc;
    } else {
      out += char(c);
    }
  }
  out += '"';
}

std::chrono::steady_clock::time_point g_boot_started;

}  // namespace

extern "C" const char* r360_native_kernel_export_name(uint32_t module, uint32_t ordinal, char* buf, size_t size) {
  const ExportName* table = module == 1 ? kXboxkrnl : module == 2 ? kXam : nullptr;
  const size_t count = module == 1 ? sizeof(kXboxkrnl) / sizeof(kXboxkrnl[0]) : sizeof(kXam) / sizeof(kXam[0]);
  for (size_t i = 0; table && i < count; ++i) {
    if (table[i].ordinal == ordinal) {
      std::snprintf(buf, size, "%s", table[i].name);
      return buf;
    }
  }
  std::snprintf(buf, size, "%s!0x%X", module == 1 ? "xboxkrnl.exe" : module == 2 ? "xam.xex" : "module", ordinal);
  return buf;
}

extern "C" uint32_t r360_native_boot(const R360BootOptions* options, R360BootResult* result) {
  *result = R360BootResult{};
  g_boot_started = std::chrono::steady_clock::now();
  try {
    if (!options || !options->path) Fail("no title path");
    g_discs.clear();
    g_discs.push_back(options->path);
    for (uint32_t i = 0; options->discs && i < options->disc_count; ++i) {
      if (options->discs[i] && g_discs[0] != options->discs[i]) g_discs.push_back(options->discs[i]);
    }
    g_current_disc = 0;
    OpenedTitle title = openTitle(options->path);
    result->kind = title.kind;
    std::snprintf(result->title, sizeof(result->title), "%s", title.title.c_str());
    for (const auto& f : title.files) (f.directory ? result->vfs_directories : result->vfs_files)++;
    registerGuestVfs(title.files);
    title.files.clear();  // attached STFS data now lives in the kernel VFS
    const Bytes key = extractXex2EncryptedImageKey(title.default_xex);
    r360_hir_set_instruction_budget(options->function_budget ? options->function_budget : (1u << 30));
    r360_trace_set_verbose(0);
    if (options->deterministic_ps) r360_set_deterministic_clock(options->deterministic_ps);
    r360_hir_set_total_instruction_budget(options->max_minstr);
    if (options->dialog_button >= 0) r360_xam_dialog_set_auto_answer(options->dialog_button);
    r360_ppc_probe_set_execute_on_translate(1);
    handoffDefaultXex(title.default_xex, key, *options, result);
    result->ok = 1;
  } catch (const std::exception& e) {
    std::snprintf(result->error, sizeof(result->error), "%s", e.what());
    result->ok = 0;
  }
  result->elapsed_ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - g_boot_started).count();
  return result->ok;
}

extern "C" uint32_t r360_native_current_disc() { return g_current_disc; }

extern "C" uint32_t r360_native_select_disc(uint32_t index) {
  if (index >= g_discs.size()) return 0;
  try {
    OpenedTitle disc = openTitle(g_discs[index]);
    registerGuestVfs(disc.files);
    g_current_disc = index;
    return 1;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "R360_DISC select %u failed: %s\n", index, e.what());
    return 0;
  }
}

extern "C" size_t r360_native_report_json(const R360BootResult* r, char* out, size_t capacity) {
  static const char* const kKinds[] = {"unknown", "folder", "xex", "stfs", "iso"};
  std::string j = "{";
  char buf[512];
  auto field = [&](const char* name, const char* format, auto... values) {
    std::snprintf(buf, sizeof(buf), format, values...);
    if (j.size() > 1) j += ',';
    j += '"';
    j += name;
    j += "\":";
    j += buf;
  };
  auto text = [&](const char* name, const char* value) {
    if (j.size() > 1) j += ',';
    j += '"';
    j += name;
    j += "\":";
    JsonString(j, value);
  };
  text("build", "native");
  text("kind", kKinds[r->kind < 5 ? r->kind : 0]);
  if (r->title[0]) text("title", r->title);
  field("elapsedMs", "%.0f", r->elapsed_ms);
  field("vfs", "{\"files\":%u,\"directories\":%u,\"reads\":%u}", r->vfs_files, r->vfs_directories, r360_vfs_reads());
  if (!r->ok) {
    if (j.size() > 1) j += ',';
    j += "\"error\":{\"message\":";
    JsonString(j, r->error);
    j += '}';
  } else {
    field("error", "null");
    field("entry", "\"0x%08X\"", r->entry);
    text("runtimeBoundary", r->runtime_boundary);
    field("executionStatus", "%u", r->execution_status);
    field("instructions", "%u", r->execution_instructions);
    field("kernelCalls", "%u", r->kernel_calls);
    if (r->kernel_boundary[0]) text("kernelBoundary", r->kernel_boundary);
    if (r->blocker_kind)
      field("hirBlocker", "{\"kind\":%u,\"opcode\":%u,\"address\":\"0x%08X\"}", r->blocker_kind, r->blocker_opcode,
            r->blocker_address);
    if (r->memory_fault_code)
      field("memoryFault", "{\"code\":%u,\"address\":\"0x%08X\"}", r->memory_fault_code, r->memory_fault_address);
    if (r->kernel_last_status == 2) {
      char name[96];
      if (j.size() > 1) j += ',';
      j += "\"unsupportedKernelCall\":";
      JsonString(j, r360_native_kernel_export_name(r->kernel_last_module, r->kernel_last_ordinal, name, sizeof(name)));
    }
    field("guestFibers", "{\"threads\":%u,\"switches\":%u,\"preemptions\":%u,\"endedOn\":%u}",
          r360_fiber_count() ? r360_fiber_count() - 1 : 0, r360_fiber_switches(), r360_fiber_preemptions(),
          r360_fiber_current());
    // The 30 FPS bar inputs (same definitions as run-title.mjs perf).
    const double wall = r->elapsed_ms / 1000.0;
    const double instr = r360_perf_counter(0), interp = r360_perf_counter(1);
    const uint32_t frames = r360_title_gpu_vd_swap_calls();
    field("perf",
          "{\"wallSeconds\":%.1f,\"guestFrames\":%u,\"gameFpsWall\":%.2f,\"mips\":%.1f,\"interpretedPercent\":%.3f,"
          "\"guestIdleMs\":%.0f}",
          wall, frames, frames / std::max(wall, 0.001), instr / std::max(wall, 0.001) / 1e6,
          instr ? 100.0 * interp / instr : 0.0, r360_fiber_idle_ms());
    field("framesPresented",
          "{\"vdSwapCalls\":%u,\"vblankInterrupts\":%u,\"cpInterrupts\":%u,\"gpuPackets\":%u,\"gpuDraws\":%u,"
          "\"softDraws\":%u,\"cacheHits\":%u,\"cacheMisses\":%u,\"cacheEntries\":%u,\"cacheKB\":%u,"
          "\"vdSwapFailures\":%u,\"width\":%u,\"height\":%u}",
          frames, r360_kernel_vblank_interrupts(), r360_kernel_cp_interrupts(), r360_xenos_packets(),
          r360_xenos_draws(), r360_xenos_soft_draws(), r360_hir_cache_hits(), r360_hir_cache_misses(),
          r360_hir_cache_entries(), r360_hir_cache_kilobytes(), r360_title_gpu_vd_swap_failures(),
          r360_title_gpu_last_vd_swap_width(), r360_title_gpu_last_vd_swap_height());
    // Last kernel calls (readKernelServiceTrace).
    j += ",\"kernelTrace\":[";
    const uint32_t n = r360_kernel_import_trace_count();
    for (uint32_t i = n > 48 ? n - 48 : 0, first = 1; i < n; ++i, first = 0) {
      char name[96];
      if (!first) j += ',';
      std::snprintf(buf, sizeof(buf),
                    "{\"sequence\":%u,\"name\":\"%s\",\"args\":[%u,%u,%u,%u],\"result\":%u,\"status\":%u}",
                    r360_kernel_import_trace_sequence(i),
                    r360_native_kernel_export_name(r360_kernel_import_trace_module(i),
                                                   r360_kernel_import_trace_ordinal(i), name, sizeof(name)),
                    r360_kernel_import_trace_arg(i, 0), r360_kernel_import_trace_arg(i, 1),
                    r360_kernel_import_trace_arg(i, 2), r360_kernel_import_trace_arg(i, 3),
                    r360_kernel_import_trace_result(i), r360_kernel_import_trace_status(i));
      j += buf;
    }
    j += ']';
    field("totalInstructionsMillions", "%u", r360_hir_total_instructions_millions());
    field("hostStackHeadroom", "%u", r360_trap_stack_headroom());
  }
  j += '}';
  if (capacity) {
    const size_t n = std::min(j.size(), capacity - 1);
    std::memcpy(out, j.data(), n);
    out[n] = 0;
  }
  return j.size();
}
