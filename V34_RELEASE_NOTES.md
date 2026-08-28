# Render360 Xenia-Web V34 — CPU Foundations Milestone

V34 is the active Render360 emulator-development milestone. It does **not** replace the deployed Core V32 browser package/XEX runtime or the V33 responsive UI shell.

## Version map

```text
Project development line   V34
Stable browser core        V32
Responsive UI shell        V33
```

## Authoritative gate

GitHub Actions run **168** (`33149796414`) completed successfully at implementation commit `2533a1fa855bdc4b1df2a348edc31f1ba169bb8c`.

```text
PACKAGE_XEX_FOUNDATION                    PASS
PPC_TRANSLATION_FOUNDATION                PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION         PASS
GUEST_CONTROL_FOUNDATION                  PASS
FPU_FOUNDATION                            PASS
wasm32 compile matrix                     64 / 64 PASS
strict full-export link                   LINKED
rooted exports                            25
real PPC/FPU/VMX correctness suite        24 / 24 PASS
```

## Five completed foundations

1. STFS / Xbox package / XEX foundation — 100%
2. Xenia PPC translation foundation — 100%
3. Scalar PPC correctness foundation — 100%
4. Guest function / control foundation — 100%
5. FPU foundation — 100%

## FPU closure

The V34 FPU baseline includes genuine PPC coverage for:

- FPR state and `lfd` / `stfd`;
- FLOAT64 add/subtract/multiply/divide;
- `fcmpu` comparison into CR;
- `fctiwz` float-to-integer round-to-zero;
- `fcfid` signed integer-to-FLOAT64 conversion;
- `frsp` FLOAT64-to-FLOAT32 rounding path;
- current upstream Xenia FPSCR update behavior;
- `mffs` FPSCR readback.

Render360 follows upstream Xenia's current FPSCR implementation and does not fabricate deeper exception semantics still marked TODO upstream.

## Active V34 work

VMX / VMX128 is the next foundation target. After that:

```text
VMX / VMX128 foundation
  -> hot WasmBackend
  -> compiled function cache + invalidation
  -> sparse/page-backed full Xbox guest memory
  -> map real default.xex sections
  -> execute real XEX entry point
  -> KernelState / xboxkrnl / XAM
  -> Xenos browser GPU layer
  -> WebGPU / WGSL / EDRAM primary path
  -> WebGL2 / GLSL ES fallback
  -> WebAudio
  -> first genuine guest framebuffer
```

## Status language

V34 is a CPU/emulator-development milestone. Retail titles are **not** claimed playable yet. The stable deployed browser runtime remains Core V32 until the V34 CPU path and later memory/kernel/GPU work are integrated into title bring-up.
