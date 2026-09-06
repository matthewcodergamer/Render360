#!/usr/bin/env python3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def read(path): return (ROOT/path).read_text()
def write(path,text): (ROOT/path).write_text(text)
def replace_once(text,old,new,label):
    if new in text: return text
    count=text.count(old)
    if count!=1: raise SystemExit(f'{label}: expected one anchor, found {count}')
    return text.replace(old,new,1)

# --- Sparse memory: side-effect-free page mapping query --------------------
path='src/xenia_web_bootstrap/sparse_guest_memory.h'; text=read(path)
text=replace_once(text,
'''bool ProtectSparseGuestMemory(uint32_t virtual_address, uint32_t page_count,
                              uint32_t protection);
bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count);
''',
'''bool ProtectSparseGuestMemory(uint32_t virtual_address, uint32_t page_count,
                              uint32_t protection);
// Side-effect-free page-presence query used by the virtual-memory HLE. Unlike
// a read probe it does not mutate the sparse fault registers.
bool SparseGuestMemoryPageMapped(uint32_t virtual_address);
bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count);
''','sparse page query declaration')
write(path,text)

path='src/xenia_web_bootstrap/sparse_guest_memory.cpp'; text=read(path)
text=replace_once(text,
'''bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count) {
''',
'''bool SparseGuestMemoryPageMapped(uint32_t virtual_address) {
  return g_pages.find(virtual_address >> kPageShift) != g_pages.end();
}

bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count) {
''','sparse page query implementation')
write(path,text)

# --- Kernel HLE: support commit/decommit subranges inside reservations ------
path='src/xenia_web_bootstrap/kernel_runtime_foundation.cpp'; text=read(path)
text=replace_once(text,'#include <cstdint>\n','#include <cstdint>\n#include <utility>\n#include <vector>\n','kernel includes')
text=replace_once(text,
'''void ReleaseVirtualAllocations() {
  for (auto& allocation : g_virtual_allocations) {
    if (allocation.used && allocation.committed && allocation.base && allocation.size) {
      UnmapSparseGuestMemory(allocation.base, allocation.size / kGuestPageSize);
    }
    allocation = {};
  }
''',
'''void ReleaseVirtualAllocations() {
  for (auto& allocation : g_virtual_allocations) {
    if (allocation.used && allocation.committed && allocation.base && allocation.size) {
      for (uint32_t address = allocation.base;
           uint64_t(address) < uint64_t(allocation.base) + allocation.size;
           address += kGuestPageSize) {
        if (SparseGuestMemoryPageMapped(address)) {
          UnmapSparseGuestMemory(address, 1);
        }
      }
    }
    allocation = {};
  }
''','partial virtual allocation reset')
text=replace_once(text,
'''GuestVirtualAllocation* FindVirtualAllocation(uint32_t base, uint32_t size) {
  for (auto& allocation : g_virtual_allocations) {
    if (allocation.used && allocation.base == base && allocation.size == size) {
      return &allocation;
    }
  }
  return nullptr;
}
''',
'''GuestVirtualAllocation* FindVirtualAllocation(uint32_t base, uint32_t size) {
  for (auto& allocation : g_virtual_allocations) {
    if (allocation.used && allocation.base == base && allocation.size == size) {
      return &allocation;
    }
  }
  return nullptr;
}

GuestVirtualAllocation* FindContainingVirtualAllocation(uint32_t base,
                                                        uint32_t size,
                                                        uint32_t page_size) {
  const uint64_t requested_end = uint64_t(base) + size;
  for (auto& allocation : g_virtual_allocations) {
    if (!allocation.used || allocation.page_size != page_size) continue;
    const uint64_t allocation_end = uint64_t(allocation.base) + allocation.size;
    if (base >= allocation.base && requested_end <= allocation_end) {
      return &allocation;
    }
  }
  return nullptr;
}
''','containing virtual reservation lookup')
old_commit='''bool CommitVirtualAllocation(GuestVirtualAllocation* allocation,
                             uint32_t protection) {
  if (!allocation || !allocation->used || !allocation->size) return false;
  if (allocation->committed) {
    allocation->protection = protection;
    return ProtectSparseGuestMemory(allocation->base,
                                    allocation->size / kGuestPageSize,
                                    protection);
  }
  const uint32_t pages = allocation->size / kGuestPageSize;
  const uint32_t backing = AllocateSparseGuestBacking(pages);
  if (!backing ||
      !MapSparseGuestMemory(allocation->base, pages, backing, 0, protection)) {
    return false;
  }
  allocation->committed = true;
  allocation->protection = protection;
  return true;
}
'''
new_commit='''bool CommitVirtualAllocationRange(GuestVirtualAllocation* allocation,
                                  uint32_t base, uint32_t size,
                                  uint32_t protection) {
  if (!allocation || !allocation->used || !size ||
      (base & (kGuestPageSize - 1u)) || (size & (kGuestPageSize - 1u))) {
    return false;
  }
  const uint64_t end = uint64_t(base) + size;
  const uint64_t allocation_end = uint64_t(allocation->base) + allocation->size;
  if (base < allocation->base || end > allocation_end) return false;

  std::vector<std::pair<uint32_t, uint32_t>> newly_mapped;
  uint32_t address = base;
  while (uint64_t(address) < end) {
    if (SparseGuestMemoryPageMapped(address)) {
      if (!ProtectSparseGuestMemory(address, 1, protection)) {
        for (auto it = newly_mapped.rbegin(); it != newly_mapped.rend(); ++it) {
          UnmapSparseGuestMemory(it->first, it->second);
        }
        return false;
      }
      address += kGuestPageSize;
      continue;
    }

    const uint32_t run_base = address;
    uint32_t run_pages = 0;
    while (uint64_t(address) < end && !SparseGuestMemoryPageMapped(address)) {
      ++run_pages;
      address += kGuestPageSize;
    }
    const uint32_t backing = AllocateSparseGuestBacking(run_pages);
    if (!backing || !MapSparseGuestMemory(run_base, run_pages, backing, 0,
                                          protection)) {
      for (auto it = newly_mapped.rbegin(); it != newly_mapped.rend(); ++it) {
        UnmapSparseGuestMemory(it->first, it->second);
      }
      return false;
    }
    newly_mapped.emplace_back(run_base, run_pages);
  }

  allocation->committed = true;
  allocation->protection = protection;
  return true;
}

bool VirtualAllocationHasMappedPages(const GuestVirtualAllocation& allocation) {
  for (uint32_t address = allocation.base;
       uint64_t(address) < uint64_t(allocation.base) + allocation.size;
       address += kGuestPageSize) {
    if (SparseGuestMemoryPageMapped(address)) return true;
  }
  return false;
}

bool UnmapMappedVirtualRange(uint32_t base, uint32_t size, bool* unmapped_any = nullptr) {
  bool any = false;
  const uint64_t end = uint64_t(base) + size;
  for (uint32_t address = base; uint64_t(address) < end;
       address += kGuestPageSize) {
    if (!SparseGuestMemoryPageMapped(address)) continue;
    if (!UnmapSparseGuestMemory(address, 1)) return false;
    any = true;
  }
  if (unmapped_any) *unmapped_any = any;
  return true;
}
'''
text=replace_once(text,old_commit,new_commit,'range-aware virtual commit')
text=replace_once(text,
'''  uint32_t base = requested_base ? requested_base & ~(page_size - 1u) : 0u;
  GuestVirtualAllocation* allocation = nullptr;
  if (base) {
    allocation = FindVirtualAllocation(base, adjusted_size);
    if (!allocation) {
      const uint32_t range_begin =
          page_size == kGuestLargePageSize ? kGuestVirtual64kBase : 0x00010000u;
      const uint32_t range_end =
          page_size == kGuestLargePageSize ? 0x80000000u : kGuestVirtual4kEnd;
      if (base < range_begin || uint64_t(base) + adjusted_size > range_end ||
          !VirtualRangeAvailable(base, adjusted_size)) {
        return kXStatusNoMemory;
      }
      allocation = AcquireVirtualAllocationSlot();
      if (!allocation) return kXStatusNoMemory;
      *allocation = {true, false, base, adjusted_size, page_size, 0};
    }
  } else {
''',
'''  uint32_t base = requested_base ? requested_base & ~(page_size - 1u) : 0u;
  GuestVirtualAllocation* allocation = nullptr;
  bool created_reservation = false;
  if (base) {
    allocation = FindVirtualAllocation(base, adjusted_size);
    if (!allocation) {
      allocation = FindContainingVirtualAllocation(base, adjusted_size, page_size);
    }
    if (!allocation) {
      const uint32_t range_begin =
          page_size == kGuestLargePageSize ? kGuestVirtual64kBase : 0x00010000u;
      const uint32_t range_end =
          page_size == kGuestLargePageSize ? 0x80000000u : kGuestVirtual4kEnd;
      if (base < range_begin || uint64_t(base) + adjusted_size > range_end ||
          !VirtualRangeAvailable(base, adjusted_size)) {
        return kXStatusNoMemory;
      }
      allocation = AcquireVirtualAllocationSlot();
      if (!allocation) return kXStatusNoMemory;
      *allocation = {true, false, base, adjusted_size, page_size, 0};
      created_reservation = true;
    }
    if (allocation->page_size != page_size) return kXStatusNoMemory;
  } else {
''','fixed commit inside existing reservation')
text=replace_once(text,
'''    *allocation = {true, false, base, adjusted_size, page_size, 0};
  }

  if ((alloc_type & kXMemCommit) &&
      !CommitVirtualAllocation(allocation, SparseProtectionFromXPage(protect_bits))) {
    if (!allocation->committed) *allocation = {};
    return kXStatusNoMemory;
  }
''',
'''    *allocation = {true, false, base, adjusted_size, page_size, 0};
    created_reservation = true;
  }

  if ((alloc_type & kXMemCommit) &&
      !CommitVirtualAllocationRange(allocation, base, adjusted_size,
                                    SparseProtectionFromXPage(protect_bits))) {
    if (created_reservation && !allocation->committed) *allocation = {};
    return kXStatusNoMemory;
  }
''','range commit dispatch')
text=replace_once(text,
'''  GuestVirtualAllocation* allocation = nullptr;
  for (auto& candidate : g_virtual_allocations) {
    if (candidate.used && candidate.base == base_addr_value) {
      allocation = &candidate;
      break;
    }
  }
''',
'''  GuestVirtualAllocation* allocation = nullptr;
  for (auto& candidate : g_virtual_allocations) {
    if (candidate.used && candidate.base == base_addr_value) {
      allocation = &candidate;
      break;
    }
  }
  if (!allocation) {
    for (auto& candidate : g_virtual_allocations) {
      if (!candidate.used) continue;
      const uint64_t end = uint64_t(candidate.base) + candidate.size;
      if (base_addr_value >= candidate.base && uint64_t(base_addr_value) < end) {
        allocation = &candidate;
        break;
      }
    }
  }
''','free containing reservation lookup')
text=replace_once(text,
'''  if (free_type == kXMemDecommit) {
    // Xenia permits range decommit. The browser allocator currently tracks one
    // commit state per reservation, so only the whole reservation can be
    // decommitted without lying about page state. Fail closed for partial
    // decommits until per-page reservation state is introduced.
    uint32_t adjusted_size = 0;
    if (!region_size_value ||
        !RoundUpGuestSize(region_size_value, allocation->page_size,
                          &adjusted_size) ||
        adjusted_size != allocation->size) {
      return kXStatusUnsuccessful;
    }
    if (allocation->committed) {
      if (!UnmapSparseGuestMemory(allocation->base,
                                  allocation->size / kGuestPageSize)) {
        return kXStatusUnsuccessful;
      }
      allocation->committed = false;
      allocation->protection = 0;
    }
    if (!WriteGuestBe32(base_addr_ptr, base_addr_value) ||
        !WriteGuestBe32(region_size_ptr, adjusted_size)) {
      return kXStatusInvalidParameter;
    }
    return kXStatusSuccess;
  }

  // Match Xenia BaseHeap::Release: the supplied address must be the reservation
  // base, the whole region is released, and RegionSize receives its real size.
  // Upstream treats every non-DECOMMIT FreeType through the release path.
  (void)kXMemRelease;
  const uint32_t released_size = allocation->size;
  if (allocation->committed &&
      !UnmapSparseGuestMemory(allocation->base,
                              allocation->size / kGuestPageSize)) {
    return kXStatusUnsuccessful;
  }
  *allocation = {};
''',
'''  if (free_type == kXMemDecommit) {
    uint32_t adjusted_size = 0;
    if (!region_size_value ||
        !RoundUpGuestSize(region_size_value, allocation->page_size,
                          &adjusted_size) ||
        base_addr_value < allocation->base ||
        uint64_t(base_addr_value) + adjusted_size >
            uint64_t(allocation->base) + allocation->size) {
      return kXStatusUnsuccessful;
    }
    bool unmapped_any = false;
    if (!UnmapMappedVirtualRange(base_addr_value, adjusted_size, &unmapped_any) ||
        !unmapped_any) {
      return kXStatusUnsuccessful;
    }
    allocation->committed = VirtualAllocationHasMappedPages(*allocation);
    if (!allocation->committed) allocation->protection = 0;
    if (!WriteGuestBe32(base_addr_ptr, base_addr_value) ||
        !WriteGuestBe32(region_size_ptr, adjusted_size)) {
      return kXStatusInvalidParameter;
    }
    return kXStatusSuccess;
  }

  // Match Xenia BaseHeap::Release: release must start at the reservation base,
  // and committed subranges are unmapped without requiring the untouched
  // reserved pages to have sparse backing.
  (void)kXMemRelease;
  if (base_addr_value != allocation->base) return kXStatusUnsuccessful;
  const uint32_t released_size = allocation->size;
  if (allocation->committed &&
      !UnmapMappedVirtualRange(allocation->base, allocation->size)) {
    return kXStatusUnsuccessful;
  }
  *allocation = {};
''','partial decommit and reservation release')
write(path,text)

# --- Braid regression: reserve large range, then commit an interior range ---
path='test-kernel-nt-allocate-virtual-memory.mjs'; text=read(path)
marker="""// Guest API failures are NTSTATUS results, not an unsupported-service blocker.\n"""
insert="""// Braid startup reserves a large-page virtual range and then commits a\n// subrange through a different BaseAddress/RegionSize cell. Xenia's BaseHeap\n// permits this; treating the reservation overlap as a new allocation produced\n// STATUS_NO_MEMORY (0xC0000017) and made Braid request HalReturnToFirmware.\nconst beforeLarge=mappedPages()>>>0;\nif((write32(basePtr,0)>>>0)!==1||(write32(sizePtr,0x18000)>>>0)!==1)throw new Error('unable to initialize large-page reservation');\nconst reserveLarge=service(1,0x00CC,basePtr,sizePtr,0x60002000,0x04,0,0,0,0)>>>0;\nconst largeBase=readBe32(basePtr),largeSize=readBe32(sizePtr);\nif(reserveLarge!==0||largeBase!==0x40000000||largeSize!==0x20000)throw new Error(`large reservation mismatch status=0x${reserveLarge.toString(16)} base=0x${largeBase.toString(16)} size=0x${largeSize.toString(16)}`);\nif((mappedPages()>>>0)!==beforeLarge)throw new Error('reserve-only large-page allocation unexpectedly committed sparse backing');\nif((write32(basePtr,largeBase+0x10000)>>>0)!==1||(write32(sizePtr,0x1000)>>>0)!==1)throw new Error('unable to initialize interior large-page commit');\nconst commitInterior=service(1,0x00CC,basePtr,sizePtr,0x60001000,0x04,0,0,0,0)>>>0;\nif(commitInterior!==0)throw new Error(`interior commit returned 0x${commitInterior.toString(16)} instead of success`);\nif(readBe32(basePtr)!==largeBase+0x10000||readBe32(sizePtr)!==0x10000)throw new Error('interior large-page commit output mismatch');\nif((mappedPages()>>>0)!==beforeLarge+16)throw new Error(`interior 64 KiB commit should map 16 sparse pages, got ${(mappedPages()>>>0)-beforeLarge}`);\nif((write32(basePtr,largeBase)>>>0)!==1||(write32(sizePtr,0)>>>0)!==1)throw new Error('unable to initialize large reservation release');\nconst releaseLarge=service(1,0x00DC,basePtr,sizePtr,0x8000,0,0,0,0,0)>>>0;\nif(releaseLarge!==0||(mappedPages()>>>0)!==beforeLarge)throw new Error(`large reservation release mismatch status=0x${releaseLarge.toString(16)} pages=${mappedPages()>>>0}`);\n\n"""
if 'BRAID_LARGE_PAGE_INTERIOR_COMMIT=PASS' not in text:
    if marker not in text: raise SystemExit('NtAllocate Braid test insertion anchor drifted')
    text=text.replace(marker,insert+marker,1)
    text=text.replace("console.log('NT_ALLOCATE_VIRTUAL_MEMORY_NO_ALIAS=PASS');\n","console.log('NT_ALLOCATE_VIRTUAL_MEMORY_NO_ALIAS=PASS');\nconsole.log('BRAID_LARGE_PAGE_INTERIOR_COMMIT=PASS');\n",1)
write(path,text)

# --- CPU: retain compiled WebAssembly.Module objects across registry refreshes
# and expose hot-function/cache telemetry. Instances are still recreated so
# their guest_call closure always sees the newest dispatch table. ------------
path='render360-browser-ppc-session.mjs'; text=read(path)
text=replace_once(text,
'''  let cfgFallbackLoads=0;
  let nextCfgSlot=0;
  const cfgContinuations=new Map();
''',
'''  let cfgFallbackLoads=0;
  let nextCfgSlot=0;
  const cfgContinuations=new Map();
  const compiledModuleCache=new Map();
  const functionExecutions=new Map();
  const hotFunctionThreshold=256;
  let moduleCompileHits=0;
  let moduleCompileMisses=0;
''','PPC module cache state')
text=replace_once(text,
'''    const next=new Map();
    for(const descriptor of descriptors){
      const moduleBytes=new Uint8Array(memory.buffer,descriptor.ptr,descriptor.size).slice();
      const module=await WebAssembly.compile(moduleBytes);
      next.set(descriptor.address,{...descriptor,module,instance:null});
      if(descriptor.tier==='cfg-fallback')cfgFallbackLoads++;
    }
''',
'''    const next=new Map();
    for(const descriptor of descriptors){
      const cacheKey=`${descriptor.address}:${descriptor.generation}:${descriptor.size}:${descriptor.lowered}:${descriptor.tier}`;
      let module=compiledModuleCache.get(cacheKey);
      if(module){
        moduleCompileHits++;
        // Refresh LRU order without recompiling the generated guest function.
        compiledModuleCache.delete(cacheKey);compiledModuleCache.set(cacheKey,module);
      }else{
        const moduleBytes=new Uint8Array(memory.buffer,descriptor.ptr,descriptor.size).slice();
        module=await WebAssembly.compile(moduleBytes);
        compiledModuleCache.set(cacheKey,module);
        moduleCompileMisses++;
        while(compiledModuleCache.size>512)compiledModuleCache.delete(compiledModuleCache.keys().next().value);
      }
      next.set(descriptor.address,{...descriptor,module,instance:null,cacheKey});
      if(descriptor.tier==='cfg-fallback')cfgFallbackLoads++;
    }
''','PPC compiled module reuse')
text=replace_once(text,
'''    const result=BigInt.asUintN(64,rawResult);
    sliceCount++;
    return {
''',
'''    const result=BigInt.asUintN(64,rawResult);
    sliceCount++;
    functionExecutions.set(address,(functionExecutions.get(address)??0)+1);
    return {
''','PPC function hotness accounting')
text=replace_once(text,
'''    get cfgContinuationCount(){return cfgContinuations.size;},
    get functionCount(){return records.size;},
    get functionTiers(){return [...records.values()].map(r=>({address:r.address,generation:r.generation,tier:r.tier,lowered:r.lowered}));},
    contract:{persistentPpcContext:true,generationAwareFunctions:true,cooperativeBrowserYield:true,liveKernelImportContextDispatch:typeof kernelDispatch==='function',cfgFallback:true,cfgFuelBounded:true,cfgFuelExhaustionYields:true,cfgPerThreadContinuationSlots:hasCfgContinuation,unsupportedKernelImportsFailClosed:true,preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',fullXboxThreadScheduler:false},
''',
'''    get cfgContinuationCount(){return cfgContinuations.size;},
    get functionCount(){return records.size;},
    get moduleCompileHits(){return moduleCompileHits;},
    get moduleCompileMisses(){return moduleCompileMisses;},
    get compiledModuleCacheEntries(){return compiledModuleCache.size;},
    get hotFunctionCount(){return [...functionExecutions.values()].filter(count=>count>=hotFunctionThreshold).length;},
    get functionTiers(){return [...records.values()].map(r=>{const executionCount=functionExecutions.get(r.address)??0;return {address:r.address,generation:r.generation,tier:r.tier,lowered:r.lowered,executionCount,hot:executionCount>=hotFunctionThreshold};});},
    contract:{persistentPpcContext:true,generationAwareFunctions:true,compiledModuleReuse:true,compiledModuleCacheLimit:512,hotFunctionTelemetry:true,hotFunctionThreshold,cooperativeBrowserYield:true,liveKernelImportContextDispatch:typeof kernelDispatch==='function',cfgFallback:true,cfgFuelBounded:true,cfgFuelExhaustionYields:true,cfgPerThreadContinuationSlots:hasCfgContinuation,unsupportedKernelImportsFailClosed:true,preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',fullXboxThreadScheduler:false},
''','PPC cache telemetry API')
text=replace_once(text,
'''export function persistentPpcSessionContract(){
  return {persistentPpcContext:true,backend:'Xenia-generated per-function WebAssembly + resumable fuel-bounded integer CFG fallback',cacheInvalidation:'Xenia executable page/content generation',browserYield:'between completed guest functions or yielded CFG quanta',kernelImports:'live PPCContext dispatch in callable tier when bootstrap export is present',cfgFallback:'most recently translated multi-block integer function',cfgFuelLimit:4096,cfgFuelExhaustionYields:true,cfgContinuationState:'per-thread status + dispatcher PC + live integer HIR locals',unsupportedKernelImportsFailClosed:true,failClosedUnknownTargets:true,preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',fullXboxThreadScheduler:false};
}
''',
'''export function persistentPpcSessionContract(){
  return {persistentPpcContext:true,backend:'Xenia-generated per-function WebAssembly + resumable fuel-bounded integer CFG fallback',cacheInvalidation:'Xenia executable page/content generation',compiledModuleReuse:true,compiledModuleCacheLimit:512,hotFunctionTelemetry:true,browserYield:'between completed guest functions or yielded CFG quanta',kernelImports:'live PPCContext dispatch in callable tier when bootstrap export is present',cfgFallback:'most recently translated multi-block integer function',cfgFuelLimit:4096,cfgFuelExhaustionYields:true,cfgContinuationState:'per-thread status + dispatcher PC + live integer HIR locals',unsupportedKernelImportsFailClosed:true,failClosedUnknownTargets:true,preemptionBoundary:'cfg-block-boundary-or-guest-function-return',midFunctionPreemption:true,midFunctionPreemptionTier:'integer-cfg-fallback',fullXboxThreadScheduler:false};
}
''','PPC session contract')
write(path,text)

# --- Host GPU: dynamic presentation resolution with full-size source texture --
path='render360-title-frontbuffer.mjs'; text=read(path)
text=replace_once(text,
'''export function showTitleWebGPUCanvas(frame,{canvas=ensureTitleWebGPUCanvas()}={}){
  if(!canvas)throw new Error('WebGPU title framebuffer canvas unavailable');
  if(frame?.width&&canvas.width!==frame.width)canvas.width=frame.width;
  if(frame?.height&&canvas.height!==frame.height)canvas.height=frame.height;
''',
'''export function showTitleWebGPUCanvas(frame,{canvas=ensureTitleWebGPUCanvas(),resolutionScale=1}={}){
  if(!canvas)throw new Error('WebGPU title framebuffer canvas unavailable');
  const scale=Math.min(1,Math.max(0.5,Number(resolutionScale)||1));
  const outputWidth=frame?.width?Math.max(1,Math.round(frame.width*scale)):0;
  const outputHeight=frame?.height?Math.max(1,Math.round(frame.height*scale)):0;
  if(outputWidth&&canvas.width!==outputWidth)canvas.width=outputWidth;
  if(outputHeight&&canvas.height!==outputHeight)canvas.height=outputHeight;
  canvas.dataset.render360ResolutionScale=String(scale);
''','WebGPU canvas resolution scale')
write(path,text)

path='render360-webgpu-runtime.mjs'; text=read(path)
text=replace_once(text,
'''  function present(frame){if(!frame?.rgba||!frame.width||!frame.height)throw new TypeError('RGBA frame required');ensureTexture(frame.width>>>0,frame.height>>>0);const generation=Number(frame.generation??0);if(generation!==lastGeneration){device.queue.writeTexture({texture},{data:frame.rgba,bytesPerRow:(frame.width>>>0)*4,rowsPerImage:frame.height>>>0},{width:frame.width>>>0,height:frame.height>>>0,depthOrArrayLayers:1});lastGeneration=generation;}const encoder=device.createCommandEncoder({label:'Render360 frame present'});const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);return {presented:true,backend:'webgpu-real-title-frontbuffer',width:frame.width,height:frame.height,generation,hash:frame.hash??0};}
''',
'''  function present(frame,{scale=1}={}){if(!frame?.rgba||!frame.width||!frame.height)throw new TypeError('RGBA frame required');scale=Math.min(1,Math.max(0.5,Number(scale)||1));const outputWidth=Math.max(1,Math.round((frame.width>>>0)*scale)),outputHeight=Math.max(1,Math.round((frame.height>>>0)*scale));if(canvas.width!==outputWidth)canvas.width=outputWidth;if(canvas.height!==outputHeight)canvas.height=outputHeight;ensureTexture(frame.width>>>0,frame.height>>>0);const generation=Number(frame.generation??0);if(generation!==lastGeneration){device.queue.writeTexture({texture},{data:frame.rgba,bytesPerRow:(frame.width>>>0)*4,rowsPerImage:frame.height>>>0},{width:frame.width>>>0,height:frame.height>>>0,depthOrArrayLayers:1});lastGeneration=generation;}const encoder=device.createCommandEncoder({label:'Render360 frame present'});const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);return {presented:true,backend:'webgpu-real-title-frontbuffer',width:outputWidth,height:outputHeight,sourceWidth:frame.width,sourceHeight:frame.height,resolutionScale:scale,generation,hash:frame.hash??0};}
''','WebGPU scaled presentation')
text=replace_once(text,
'''export function webGPUFoundationContract(){return {xenosEDRAMMirrorBytes:EDRAM_BYTES,rawVertexStorageFetch:true,renderTargetCache:true,linearEDRAMResolveCompute:true,asyncRenderPipelines:true,asyncComputePipelines:true,deviceLossTelemetry:true,sharedMemoryMaximumBytes:DEFAULT_XBOX_MEMORY_PAGES*65536,fullXenosCommandProcessor:false,fullMemexport:false,fullEDRAMResolve:false,countsAsRealFrame:false};}
''',
'''export function webGPUFoundationContract(){return {xenosEDRAMMirrorBytes:EDRAM_BYTES,rawVertexStorageFetch:true,renderTargetCache:true,linearEDRAMResolveCompute:true,asyncRenderPipelines:true,asyncComputePipelines:true,adaptivePresentationResolution:true,deviceLossTelemetry:true,sharedMemoryMaximumBytes:DEFAULT_XBOX_MEMORY_PAGES*65536,fullXenosCommandProcessor:false,fullMemexport:false,fullEDRAMResolve:false,countsAsRealFrame:false};}
''','WebGPU performance contract')
write(path,text)

# --- Modern bridge: apply adaptive 30 FPS policy only to host presentation ---
path='render360-browser-modern-content-bridge.mjs'; text=read(path)
text=replace_once(text,
'''import {createRgbaFramePresenter} from './render360-webgpu-runtime.mjs';
''',
'''import {createRgbaFramePresenter} from './render360-webgpu-runtime.mjs';
import {browserPerformanceDefaults,createAdaptivePerformancePolicy} from './render360-performance-policy.mjs';
''','modern bridge performance import')
text=replace_once(text,
'''              showTitleWebGPUCanvas(frontbufferFrame,{canvas});
              state.webgpuPresenter=await createRgbaFramePresenter(canvas);
              activePresenter=state.webgpuPresenter;
            }else showTitleWebGPUCanvas(frontbufferFrame);
            presentation=state.webgpuPresenter.present(frontbufferFrame);
''',
'''              showTitleWebGPUCanvas(frontbufferFrame,{canvas,resolutionScale:state.config?.resolutionScale??1});
              state.webgpuPresenter=await createRgbaFramePresenter(canvas);
              activePresenter=state.webgpuPresenter;
            }else showTitleWebGPUCanvas(frontbufferFrame,{resolutionScale:state.config?.resolutionScale??1});
            presentation=state.webgpuPresenter.present(frontbufferFrame,{scale:state.config?.resolutionScale??1});
''','modern bridge scaled WebGPU presentation')
text=replace_once(text,
'''  Object.assign(state,{gpuTraffic,shaderRuntime,shaderWebGPU,frontbufferFrame,presentation,lastSwapCount:swaps});return state;
}
''',
'''  const now=globalThis.performance?.now?.()??Date.now();
  let performanceSample=state.performancePolicy?.snapshot?.()??null;
  if(state.performancePolicy&&swaps>0&&swaps!==state.lastPerformanceSwapCount){
    let fps=null;
    if(Number.isFinite(state.lastPerformanceSampleAt)&&state.lastPerformanceSwapCount>=0&&now>state.lastPerformanceSampleAt){
      fps=(swaps-state.lastPerformanceSwapCount)*1000/(now-state.lastPerformanceSampleAt);
      if(!Number.isFinite(fps)||fps<=0||fps>240)fps=null;
    }
    const budgetMb=Number(state.config?.performanceMemoryBudgetMB||0);
    performanceSample=state.performancePolicy.observe({fps,memoryBytes:state.bootstrap?.exports?.memory?.buffer?.byteLength||0,memoryBudgetBytes:budgetMb>0?budgetMb*1048576:0,now});
    if(performanceSample.changed){
      state.config.resolutionScale=performanceSample.resolutionScale;
      stage(state.onStage,'performance',`Adaptive resolution ${(performanceSample.resolutionScale*100).toFixed(0)}% · ${performanceSample.reason}`,{performance:performanceSample});
    }
    state.lastPerformanceSampleAt=now;state.lastPerformanceSwapCount=swaps;
  }
  Object.assign(state,{gpuTraffic,shaderRuntime,shaderWebGPU,frontbufferFrame,presentation,performanceSample,lastSwapCount:swaps});return state;
}
''','modern bridge adaptive observation')
text=replace_once(text,
'''  globalThis.render360ModernTitle={fileName:state.file?.name||'',inputKind:state.inputKind,result:state.result,persistentCpu:state.persistentCpu,ppcSession:state.ppcSession,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,schedulerBlocker:state.schedulerBlocker,runtimeLoop:state.runtimeLoop,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,shaderWebGPU:state.shaderWebGPU,frontbufferFrame:state.frontbufferFrame,presentation:state.presentation,webgpuPresenter:state.webgpuPresenter,bootstrap:state.bootstrap,core:state.core,config:state.config,stop:()=>state.threadScheduler?.stop?.(),inspectScheduler:()=>state.threadScheduler?.inspect?.()??null};
''',
'''  globalThis.render360ModernTitle={fileName:state.file?.name||'',inputKind:state.inputKind,result:state.result,persistentCpu:state.persistentCpu,ppcSession:state.ppcSession,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,schedulerBlocker:state.schedulerBlocker,runtimeLoop:state.runtimeLoop,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,shaderWebGPU:state.shaderWebGPU,frontbufferFrame:state.frontbufferFrame,presentation:state.presentation,performance:state.performanceSample,performancePolicy:state.performancePolicy,webgpuPresenter:state.webgpuPresenter,bootstrap:state.bootstrap,core:state.core,config:state.config,stop:()=>state.threadScheduler?.stop?.(),inspectScheduler:()=>state.threadScheduler?.inspect?.()??null};
''','modern bridge performance publish')
old_state='''const state={file,core,bootstrap,inputKind:prepared.inputKind,result,package:prepared.package,config,ppcSession:threaded?.ppcSession??null,threadScheduler:threaded?.scheduler??null,primaryThread:threaded?.primaryThread??null,schedulerReport:threaded?.schedulerReport??null,schedulerBlocker:null,runtimeLoop:null,persistentCpu:null,gpuTraffic:null,shaderRuntime:null,shaderWebGPU:null,frontbufferFrame:null,presentation:null,webgpuPresenter:null,lastSwapCount:-1};
'''
new_state='''const perfDefaults=browserPerformanceDefaults();
const effectiveConfig={...config,targetFps:Number(config.targetFps||perfDefaults.targetFps),resolutionScale:Number(config.resolutionScale??perfDefaults.initialScale)};
const performancePolicy=createAdaptivePerformancePolicy({targetFps:effectiveConfig.targetFps,initialScale:effectiveConfig.resolutionScale,minScale:Number(config.minResolutionScale??perfDefaults.minScale),maxScale:Number(config.maxResolutionScale??perfDefaults.maxScale)});
effectiveConfig.resolutionScale=performancePolicy.resolutionScale;
const state={file,core,bootstrap,inputKind:prepared.inputKind,result,package:prepared.package,config:effectiveConfig,onStage,performancePolicy,performanceSample:performancePolicy.snapshot(),lastPerformanceSampleAt:NaN,lastPerformanceSwapCount:-1,ppcSession:threaded?.ppcSession??null,threadScheduler:threaded?.scheduler??null,primaryThread:threaded?.primaryThread??null,schedulerReport:threaded?.schedulerReport??null,schedulerBlocker:null,runtimeLoop:null,persistentCpu:null,gpuTraffic:null,shaderRuntime:null,shaderWebGPU:null,frontbufferFrame:null,presentation:null,webgpuPresenter:null,lastSwapCount:-1};
'''
text=replace_once(text,old_state,new_state,'modern bridge performance state')
text=replace_once(text,
'''return {result:state.result,persistentCpu:state.persistentCpu,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,frontbufferFrame:state.frontbufferFrame,inputKind:state.inputKind};
''',
'''return {result:state.result,persistentCpu:state.persistentCpu,threadScheduler:state.threadScheduler,primaryThread:state.primaryThread,schedulerReport:state.schedulerReport,gpuTraffic:state.gpuTraffic,shaderRuntime:state.shaderRuntime,frontbufferFrame:state.frontbufferFrame,performance:state.performanceSample,inputKind:state.inputKind};
''','modern bridge performance result')
text=replace_once(text,
'''export function modernContentBridgeContract(){return {release:45,inputs:['xex','live','pirs','con'],stfsStreamingMount:true,wholePackageCopy:false,defaultXexBounded:true,translationSideEffects:false,generatedWasmExecution:true,nativeGuestThreadRegistry:true,cooperativeThreadScheduler:true,xenosTrafficInspection:true,realFrontbufferCapture:true,webgpuRealFrontbufferPresentation:true,canvas2dFallback:true,pauseResume:true,nativeHirCompatibilityFallback:true};}
''',
'''export function modernContentBridgeContract(){return {release:74,inputs:['xex','live','pirs','con'],stfsStreamingMount:true,wholePackageCopy:false,defaultXexBounded:true,translationSideEffects:false,generatedWasmExecution:true,compiledWasmReuse:true,hotFunctionTelemetry:true,nativeGuestThreadRegistry:true,cooperativeThreadScheduler:true,xenosTrafficInspection:true,realFrontbufferCapture:true,webgpuRealFrontbufferPresentation:true,adaptivePresentationResolution:true,targetFps:30,canvas2dFallback:true,pauseResume:true,nativeHirCompatibilityFallback:true};}
''','modern bridge V74 performance contract')
write(path,text)

print('R360_V74_PERFORMANCE_ARCHITECTURE_APPLIED=1')
