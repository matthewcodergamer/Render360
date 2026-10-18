# Record-to-recompile (future, opt-in)

Status: **planned, not built.** Current priority is getting titles working
(Banjo-Tooie first). This is an option people can turn on later so their
titles get cached/recompiled automatically instead of anyone hunting for
functions by hand.

## Idea

Run the game once on a path that can execute anything (interpreter or JIT),
record every piece of code it reaches, and feed that record to an
ahead-of-time recompiler. Each later session reports what it found that
was not recompiled yet, so coverage grows toward 100% without manual work.

## Pipeline

1. **Record.** Run the XEX on the interpreter/fallback path and log, with
   hit counts:
   - function entries;
   - basic blocks;
   - jump-table targets;
   - resolved indirect calls (`bctr` / `bcctr`), including calls that
     resolve to 0 (unresolved).

   Save this as a manifest in the recompiler's function-boundary format.
   The manifest holds addresses and hashes only, never game code.
2. **Recompile.** Merge each new manifest into a master manifest, re-run
   codegen and the build, and report:
   - functions found;
   - unresolved calls (target 0);
   - new since the last run;
   - coverage %.
3. **Run.** Fully native where the platform forbids runtime code
   generation (iOS apps: no JIT). If execution reaches code that was not
   recompiled, it does not crash:
   - log the address to the manifest;
   - show a quiet notice;
   - fall back to an interpreter if one is built in, otherwise save and
     exit cleanly.
4. **Grow.** Each session sends newly discovered addresses back to the
   build machine; one command rebuilds and reinstalls.
5. **Persist.** Manifests are versioned in a private repo (addresses
   only). The build cache lives on the build machine's drive, with a
   backup copy elsewhere.

## Rules

- Only the player's own copy of the game.
- Game files and generated code are never committed or uploaded. Only
  address/hash manifests are kept, in a private repo.
- Every run reports coverage % and the unresolved-call count.

## What Render360 already has that this would build on

- **Recording path:** the HIR interpreter
  (`src/xenia_web_bootstrap/hir_correctness_executor.cpp`) executes any
  guest function. Call resolution (`ResolveAddressCall*`,
  `TranslateNestedGuestAddress` in `probe_backend.cpp`) sees every direct
  and indirect call target, including unresolved ones (target 0). These
  are the hook points for a manifest writer.
- **Compiled path:** the guest JIT (`hir_wasm_jit.cpp`) already compiles hot
  functions to WebAssembly. In browsers runtime code generation is
  allowed, so the Render360 form of "recompile" is an opt-in cache:
  persist the compiled modules per function (keyed by address + code hash)
  in the player's browser storage, so later sessions skip the interpreter
  warm-up. Only the player's own browser holds generated code.
- **Determinism:** `run-title --deterministic` replays a run exactly, so a
  recorded manifest can be checked against a replay.

The ReXGlue / iPhone pipeline (Watch Dogs) lives outside this repository
and would follow the same manifest format and rules.
