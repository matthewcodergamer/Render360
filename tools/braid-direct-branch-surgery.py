from pathlib import Path

executor = Path('src/xenia_web_bootstrap/hir_correctness_executor.cpp')
text = executor.read_text()
if 'DecodeDirectBranchTarget(' in text:
    raise SystemExit('direct-branch decoder is already installed')

helper_anchor = '''bool ExecuteIndirect(uint64_t target, uint32_t flags, bool* reached_return,
                     bool* block_terminated) {'''
helper = r'''bool DecodeDirectBranchTarget(uint32_t source_address, uint32_t* target,
                                    uint32_t* raw_instruction) {
  if (!target) return false;
  uint8_t raw[4] = {};
  if (!ReadSparseGuestMemory(source_address, raw, sizeof(raw))) return false;
  const uint32_t ppc = (uint32_t(raw[0]) << 24) |
                       (uint32_t(raw[1]) << 16) |
                       (uint32_t(raw[2]) << 8) | uint32_t(raw[3]);
  if (raw_instruction) *raw_instruction = ppc;

  // Xenia lowers direct branch forms outside the current HIR function to
  // OPCODE_CALL / OPCODE_CALL_TRUE even when Processor::LookupFunction has
  // not materialized a Function symbol yet. Recover the target from the
  // actual PPC instruction. LK must not be required: plain b / bc is a
  // CALL_TAIL, while bl / bcl is a normal call.
  const uint32_t primary = ppc >> 26;
  int32_t displacement = 0;
  if (primary == 18u) {  // b / bl
    displacement = static_cast<int32_t>(ppc & 0x03FFFFFCu);
    if (displacement & 0x02000000) {
      displacement |= static_cast<int32_t>(0xFC000000u);
    }
  } else if (primary == 16u) {  // bc / bcl
    displacement = static_cast<int32_t>(ppc & 0x0000FFFCu);
    if (displacement & 0x00008000) {
      displacement |= static_cast<int32_t>(0xFFFF0000u);
    }
  } else {
    return false;
  }

  // AA is bit 1 in both I-form and B-form direct branches.
  *target = (ppc & 0x2u)
                ? static_cast<uint32_t>(displacement)
                : source_address + static_cast<uint32_t>(displacement);
  return true;
}

void ApplyResolvedDirectCallFlags(uint32_t flags, bool* reached_return,
                                  bool* block_terminated) {
  if (!reached_return || !block_terminated) return;
  if (flags & xe::cpu::hir::CALL_TAIL) {
    *reached_return = true;
    *block_terminated = true;
  }
}

'''
if helper_anchor not in text:
    raise SystemExit('ExecuteIndirect anchor not found')
text = text.replace(helper_anchor, helper + helper_anchor, 1)

call_start = text.index('        case xe::cpu::hir::OPCODE_CALL: {')
return_start = text.index('        case xe::cpu::hir::OPCODE_RETURN:', call_start)
new_calls = r'''        case xe::cpu::hir::OPCODE_CALL: {
          if (instr->src1.symbol) {
            // Known HIR symbols stay authoritative, but CALL_TAIL still has to
            // terminate the caller exactly as Xenia's branch lowering expects.
            supported = g_call_resolver && g_call_resolver(instr->src1.symbol);
            if (supported) {
              ApplyResolvedDirectCallFlags(instr->flags, &reached_return,
                                           &block_terminated);
            }
          } else if (g_address_resolver) {
            uint32_t target = 0;
            uint32_t ppc = 0;
            const bool decoded = DecodeDirectBranchTarget(
                current_source_address, &target, &ppc);
            if (!decoded) {
              std::fprintf(stderr,
                           "R360_DIRECT_CALL_DECODE_FAIL source=0x%08X raw=0x%08X primary=%u flags=0x%X\n",
                           current_source_address, ppc, ppc >> 26,
                           static_cast<unsigned>(instr->flags));
              supported = false;
              break;
            }
            std::fprintf(stderr,
                         "R360_DIRECT_CALL_FALLBACK source=0x%08X target=0x%08X primary=%u lk=%u aa=%u flags=0x%X\n",
                         current_source_address, target, ppc >> 26, ppc & 1u,
                         (ppc >> 1) & 1u, static_cast<unsigned>(instr->flags));
            supported = g_address_resolver(target);
            if (supported) {
              ApplyResolvedDirectCallFlags(instr->flags, &reached_return,
                                           &block_terminated);
            }
          } else {
            supported = false;
          }
          break;
        }
        case xe::cpu::hir::OPCODE_CALL_TRUE: {
          bool condition = false;
          supported = ResolveCondition(instr->src1.value, values, &condition);
          if (supported && condition) {
            if (instr->src2.symbol) {
              supported = g_call_resolver && g_call_resolver(instr->src2.symbol);
              if (supported) {
                ApplyResolvedDirectCallFlags(instr->flags, &reached_return,
                                             &block_terminated);
              }
            } else if (g_address_resolver) {
              uint32_t target = 0;
              uint32_t ppc = 0;
              const bool decoded = DecodeDirectBranchTarget(
                  current_source_address, &target, &ppc);
              if (!decoded) {
                std::fprintf(stderr,
                             "R360_DIRECT_CALL_TRUE_DECODE_FAIL source=0x%08X raw=0x%08X primary=%u flags=0x%X\n",
                             current_source_address, ppc, ppc >> 26,
                             static_cast<unsigned>(instr->flags));
                supported = false;
                break;
              }
              std::fprintf(stderr,
                           "R360_DIRECT_CALL_TRUE_FALLBACK source=0x%08X target=0x%08X primary=%u lk=%u aa=%u flags=0x%X\n",
                           current_source_address, target, ppc >> 26, ppc & 1u,
                           (ppc >> 1) & 1u, static_cast<unsigned>(instr->flags));
              supported = g_address_resolver(target);
              if (supported) {
                ApplyResolvedDirectCallFlags(instr->flags, &reached_return,
                                             &block_terminated);
              }
            } else {
              supported = false;
            }
          }
          break;
        }

'''
text = text[:call_start] + new_calls + text[return_start:]
executor.write_text(text)

test = Path('test-direct-call-sparse-window.mjs')
test.write_text(r'''import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(module);
for (const entry of WebAssembly.Module.imports(module)) {
  if (entry.module === 'env' && entry.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const e = instance.exports;
const pick = (name) => e[name] ?? e[`_${name}`];

const required = [
  'r360_ppc_probe_reset', 'r360_ppc_probe_input_buffer',
  'r360_ppc_probe_load_at', 'r360_ppc_probe_translate',
  'r360_ppc_probe_correctness_status', 'r360_ppc_probe_correctness_r3',
  'r360_ppc_probe_correctness_blocker_opcode',
  'r360_ppc_probe_correctness_blocker_address',
  'r360_sparse_guest_memory_reset', 'r360_sparse_guest_memory_alloc',
  'r360_sparse_guest_memory_map', 'r360_sparse_guest_memory_protect',
  'r360_sparse_guest_memory_write_u32_be',
];
for (const name of required) {
  if (typeof pick(name) !== 'function') throw new Error(`missing direct-call regression export ${name}`);
}

const encodeB = (source, target, {link = false, absolute = false} = {}) => {
  const displacement = absolute ? target : target - source;
  if ((displacement & 3) !== 0 || displacement < -0x02000000 || displacement > 0x01FFFFFC) {
    throw new RangeError(`I-form branch out of range ${displacement}`);
  }
  return ((18 << 26) | (displacement & 0x03FFFFFC) |
          (absolute ? 2 : 0) | (link ? 1 : 0)) >>> 0;
};

const encodeBc = (source, target, {link = false, absolute = false, bo = 20, bi = 0} = {}) => {
  const displacement = absolute ? target : target - source;
  if ((displacement & 3) !== 0 || displacement < -0x8000 || displacement > 0x7FFC) {
    throw new RangeError(`B-form branch out of range ${displacement}`);
  }
  return ((16 << 26) | ((bo & 31) << 21) | ((bi & 31) << 16) |
          (displacement & 0xFFFC) | (absolute ? 2 : 0) |
          (link ? 1 : 0)) >>> 0;
};

const writeWords = (address, words) => {
  for (let i = 0; i < words.length; i++) {
    if ((pick('r360_sparse_guest_memory_write_u32_be')(address + i * 4, words[i]) >>> 0) !== 1) {
      throw new Error(`could not seed sparse PPC @ 0x${(address + i * 4).toString(16)}`);
    }
  }
};

const runCase = ({name, caller, callee, callerWords, calleeWords, expectedR3}) => {
  pick('r360_sparse_guest_memory_reset')();
  const callerBacking = pick('r360_sparse_guest_memory_alloc')(1) >>> 0;
  const calleeBacking = pick('r360_sparse_guest_memory_alloc')(1) >>> 0;
  if (!callerBacking || !calleeBacking) throw new Error(`${name}: could not allocate sparse pages`);
  if ((pick('r360_sparse_guest_memory_map')(caller, 1, callerBacking, 0, 7) >>> 0) !== 1 ||
      (pick('r360_sparse_guest_memory_map')(callee, 1, calleeBacking, 0, 7) >>> 0) !== 1) {
    throw new Error(`${name}: could not map sparse pages`);
  }
  writeWords(caller, callerWords);
  writeWords(callee, calleeWords);
  if ((pick('r360_sparse_guest_memory_protect')(caller, 1, 5) >>> 0) !== 1 ||
      (pick('r360_sparse_guest_memory_protect')(callee, 1, 5) >>> 0) !== 1) {
    throw new Error(`${name}: could not seal sparse pages RX`);
  }

  pick('r360_ppc_probe_reset')();
  const input = pick('r360_ppc_probe_input_buffer')() >>> 0;
  const bytes = new Uint8Array(e.memory.buffer, input, callerWords.length * 4);
  callerWords.forEach((word, i) => {
    bytes[i * 4] = word >>> 24;
    bytes[i * 4 + 1] = (word >>> 16) & 255;
    bytes[i * 4 + 2] = (word >>> 8) & 255;
    bytes[i * 4 + 3] = word & 255;
  });
  if ((pick('r360_ppc_probe_load_at')(caller, input, bytes.length) >>> 0) !== bytes.length) {
    throw new Error(`${name}: could not stage caller`);
  }
  if (!(pick('r360_ppc_probe_translate')() >>> 0)) throw new Error(`${name}: translation failed`);
  const status = pick('r360_ppc_probe_correctness_status')() >>> 0;
  const r3 = BigInt.asUintN(64, pick('r360_ppc_probe_correctness_r3')());
  if (status !== 3 || r3 !== BigInt(expectedR3)) {
    const opcode = pick('r360_ppc_probe_correctness_blocker_opcode')() >>> 0;
    const address = pick('r360_ppc_probe_correctness_blocker_address')() >>> 0;
    throw new Error(`${name}: status=${status} r3=${r3} blockerOpcode=${opcode} blockerAddress=0x${address.toString(16)}`);
  }
};

{
  const caller = 0x20000000;
  const callee = 0x20008000;
  runCase({
    name: 'far-bl', caller, callee,
    callerWords: [
      0x7CA802A6,
      encodeB(caller + 4, callee, {link: true}),
      0x38630002,
      0x7CA803A6,
      0x4E800020,
    ],
    calleeWords: [0x38600005, 0x4E800020],
    expectedR3: 7,
  });
}

// Braid's unresolved HIR CALL can be a non-linking direct branch. Xenia lowers
// it as OPCODE_CALL + CALL_TAIL. The old critic never covered this and the old
// decoder incorrectly required LK=1.
{
  const caller = 0x22000000;
  const callee = 0x22008000;
  runCase({
    name: 'far-b-tail', caller, callee,
    callerWords: [encodeB(caller, callee), 0x3860007F, 0x4E800020],
    calleeWords: [0x38600009, 0x4E800020],
    expectedR3: 9,
  });
}

// Xenia can also emit direct call HIR from the B-form bc/bcl family.
{
  const caller = 0x23000000;
  const callee = 0x23001000;
  runCase({
    name: 'far-bcl', caller, callee,
    callerWords: [
      0x7CA802A6,
      encodeBc(caller + 4, callee, {link: true}),
      0x38630001,
      0x7CA803A6,
      0x4E800020,
    ],
    calleeWords: [0x3860000B, 0x4E800020],
    expectedR3: 12,
  });
}

// Cover B-form tail semantics too, so LK=0 cannot regress again.
{
  const caller = 0x24000000;
  const callee = 0x24001000;
  runCase({
    name: 'far-bc-tail', caller, callee,
    callerWords: [encodeBc(caller, callee), 0x3860007E, 0x4E800020],
    calleeWords: [0x3860000D, 0x4E800020],
    expectedR3: 13,
  });
}

console.log('DIRECT_CALL_SPARSE_SUBWINDOW=PASS');
console.log('DIRECT_CALL_BRANCH_FORMS=PASS');
''')

# The installer is deliberately one-shot. Its bot commit leaves only the real
# runtime change and regression critic in the repository.
Path('.github/workflows/braid-direct-branch-surgery.yml').unlink(missing_ok=True)
Path('tools/braid-direct-branch-surgery.py').unlink(missing_ok=True)
