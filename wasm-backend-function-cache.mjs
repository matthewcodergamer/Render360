export class CompiledGuestFunctionCache {
  constructor({ pageShift = 12 } = {}) {
    this.pageShift = pageShift;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
  }

  key(address) { return address >>> 0; }
  page(address) { return (address >>> this.pageShift) >>> 0; }

  async getOrCompile(address, generation, bytes) {
    address >>>= 0; generation >>>= 0;
    if (!generation || !(bytes instanceof Uint8Array) || !bytes.byteLength) {
      throw new Error('invalid compiled guest-function cache input');
    }
    const key = this.key(address);
    const existing = this.entries.get(key);
    if (existing && existing.generation === generation) {
      this.hits++;
      return existing.module;
    }
    if (existing) this.entries.delete(key);
    const module = await WebAssembly.compile(bytes);
    this.entries.set(key, { address, generation, page: this.page(address), module });
    this.misses++;
    return module;
  }

  lookup(address, generation) {
    address >>>= 0; generation >>>= 0;
    const entry = this.entries.get(this.key(address));
    if (!entry || entry.generation !== generation) return null;
    return entry.module;
  }

  invalidateRange(address, size) {
    address >>>= 0; size >>>= 0;
    if (!size) return 0;
    const end = Math.min(0xFFFFFFFF, address + size - 1) >>> 0;
    const first = this.page(address), last = this.page(end);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.page >= first && entry.page <= last) {
        this.entries.delete(key); removed++;
      }
    }
    this.invalidations++;
    return removed;
  }

  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
}
