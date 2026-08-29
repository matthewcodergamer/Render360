#include <cstdint>
#include <cstring>

extern "C" {
#include "third_party/crypto/rijndael-alg-fst.h"
}

namespace {
constexpr uint32_t kBufferCapacity = 256 * 1024;
alignas(16) uint8_t io_buffer[kBufferCapacity] = {};
uint8_t session_key[16] = {};
uint8_t cbc_iv[16] = {};
uint32_t decrypt_round_keys[4 * (MAXNR + 1)] = {};
int32_t decrypt_rounds = 0;
uint32_t status = 0;
uint32_t bytes_done = 0;
bool session_ready = false;

constexpr uint8_t kRetailKey[16] = {
    0x20, 0xB1, 0x85, 0xA5, 0x9D, 0x28, 0xFD, 0xC3,
    0x40, 0x58, 0x3F, 0xBB, 0x08, 0x96, 0xBF, 0x91};
constexpr uint8_t kDevkitKey[16] = {};

void CbcDecryptOne(const uint32_t* round_keys, int32_t rounds,
                   const uint8_t ciphertext[16], uint8_t plaintext[16],
                   uint8_t iv[16]) {
  uint8_t previous[16];
  std::memcpy(previous, ciphertext, sizeof(previous));
  rijndaelDecrypt(round_keys, rounds, ciphertext, plaintext);
  for (uint32_t i = 0; i < 16; ++i) plaintext[i] ^= iv[i];
  std::memcpy(iv, previous, sizeof(previous));
}
}

extern "C" {

__attribute__((used, visibility("default"))) uint8_t* r360_xex_crypto_buffer() {
  return io_buffer;
}
__attribute__((used, visibility("default"))) uint32_t r360_xex_crypto_capacity() {
  return kBufferCapacity;
}
__attribute__((used, visibility("default"))) uint32_t r360_xex_crypto_status() {
  return status;
}
__attribute__((used, visibility("default"))) uint32_t r360_xex_crypto_bytes_done() {
  return bytes_done;
}

__attribute__((used, visibility("default"))) void r360_xex_crypto_reset() {
  std::memset(io_buffer, 0, sizeof(io_buffer));
  std::memset(session_key, 0, sizeof(session_key));
  std::memset(cbc_iv, 0, sizeof(cbc_iv));
  std::memset(decrypt_round_keys, 0, sizeof(decrypt_round_keys));
  decrypt_rounds = 0;
  status = 0;
  bytes_done = 0;
  session_ready = false;
}

// io_buffer[0..15] must contain the encrypted XEX security-info AES key.
// This follows Xenia XexModule::ReadImage exactly: decrypt the title key using
// the retail/devkit master key with AES-128-CBC and a zero IV.
__attribute__((used, visibility("default"))) uint32_t
r360_xex_crypto_begin_session(uint32_t use_devkit_key) {
  uint32_t master_round_keys[4 * (MAXNR + 1)] = {};
  uint8_t master_iv[16] = {};
  const uint8_t* master_key = use_devkit_key ? kDevkitKey : kRetailKey;
  const int32_t master_rounds =
      rijndaelKeySetupDec(master_round_keys, master_key, 128);
  if (master_rounds <= 0) {
    status = 100;
    return status;
  }
  CbcDecryptOne(master_round_keys, master_rounds, io_buffer, session_key,
                master_iv);
  decrypt_rounds = rijndaelKeySetupDec(decrypt_round_keys, session_key, 128);
  if (decrypt_rounds <= 0) {
    status = 101;
    return status;
  }
  std::memset(cbc_iv, 0, sizeof(cbc_iv));
  bytes_done = 0;
  session_ready = true;
  status = 1;
  return status;
}

// Caller stages encrypted executable bytes at io_buffer. Chunks must preserve
// Xenia's AES-CBC block boundaries; the IV chains across calls.
__attribute__((used, visibility("default"))) uint32_t
r360_xex_crypto_decrypt_chunk(uint32_t chunk_length) {
  if (!session_ready) {
    status = 102;
    return status;
  }
  if (!chunk_length || chunk_length > kBufferCapacity ||
      (chunk_length & 15u) != 0u) {
    status = 103;
    return status;
  }
  for (uint32_t offset = 0; offset < chunk_length; offset += 16u) {
    uint8_t plaintext[16];
    CbcDecryptOne(decrypt_round_keys, decrypt_rounds, io_buffer + offset,
                  plaintext, cbc_iv);
    std::memcpy(io_buffer + offset, plaintext, sizeof(plaintext));
  }
  if (bytes_done > 0xFFFFFFFFu - chunk_length) {
    status = 104;
    return status;
  }
  bytes_done += chunk_length;
  status = 1;
  return status;
}

}  // extern "C"
