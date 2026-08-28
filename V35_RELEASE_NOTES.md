# Render360 V35 — VMX Foundation Complete

V35 is the emulator-development milestone that closes the defined VMX / VMX128 browser correctness foundation and moves active work to the hot WebAssembly execution backend.

Stable deployed browser core remains **V32**. Responsive UI remains **V33**. V35 is the active development/architecture track.

## Authoritative implementation gate

GitHub Actions run **175** (`33152187091`) is green at commit `fe11632ec806cb6be53da6ff419b77aa201f4b1f`.

```text
64 / 64 wasm32 compile PASS
strict link LINKED
25 rooted exports
24 / 24 general PPC/FPU/VMX programs PASS
VMX_STANDARD_BASELINE=PASS cases=11
VMX128_REPRESENTATIVE=PASS cases=1
VMX_FOUNDATION=PASS cases=12
```

## V35 completion

The VMX baseline now verifies VEC128 load/store and endian behavior, INT16/INT32 modulo addition, byte/halfword/word subtraction, vector AND/OR/XOR, integer equality comparison, word shifts, and a genuine Xbox 360 `vand128` encoding.

This creates six completed 100% foundations:

1. Package / XEX
2. PPC translation
3. Scalar PPC correctness
4. Guest function/control
5. FPU
6. VMX / VMX128

`100% foundation` is deliberately scoped. It means the named regression contract is complete; it does not claim full retail-title compatibility for every instruction or edge case.

## V35 next target

The active architecture target is **Render360 WasmBackend**:

```text
finalized Xenia HIR
  -> Render360 WasmBackend
  -> generated WebAssembly guest function
  -> browser WASM engine
```

After baseline lowering and equivalence tests: compiled-function cache, executable-page invalidation, sparse full Xbox guest memory, real XEX section mapping, and real `default.xex` entry execution.
