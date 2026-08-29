#ifndef RENDER360_XENIA_WEB_TITLE_GPU_RUNTIME_H_
#define RENDER360_XENIA_WEB_TITLE_GPU_RUNTIME_H_

#include <cstddef>
#include <cstdint>

namespace render360::xenia_web {

void ResetTitleGpuRuntime();

// Handles the small xboxkrnl video/HW service surface needed to reach the
// Xenos command processor. Returns true only for an explicitly implemented
// service; unknown ordinals remain real title blockers.
bool TryTitleGpuKernelService(uint32_t module, uint32_t ordinal,
                              uint32_t r3, uint32_t r4, uint32_t r5,
                              uint32_t r6, uint32_t r7, uint32_t r8,
                              uint32_t r9, uint32_t r10,
                              uint32_t* result);

// Xenia registers the GPU MMIO aperture at 0x7FC80000/0xFFFF0000. These
// helpers intentionally recognize only that aperture and explicit registers.
bool ReadTitleGpuMmio(uint32_t address, uint32_t* value);
bool WriteTitleGpuMmio(uint32_t address, uint32_t value);

uint32_t TitleGpuRingBase();
uint32_t TitleGpuRingSizeLog2();
uint32_t TitleGpuRingBytes();
uint32_t TitleGpuRingWordCapacity();
uint32_t TitleGpuWritePointer();
uint32_t TitleGpuReadPointerWriteback();
uint32_t TitleGpuReadPointerBlockSizeLog2();
uint32_t TitleGpuMmioWrites();
uint32_t TitleGpuStatus();
uint32_t TitleGpuRingWord(uint32_t index, bool* ok);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_TITLE_GPU_RUNTIME_H_
