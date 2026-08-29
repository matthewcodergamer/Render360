#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$ROOT/upstream/xenia"
XENIA_REV="95a5c3ee250f80c3b9d139658649d9ffb6db3eec"
mkdir -p "$ROOT/upstream"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --depth=1 origin "$XENIA_REV"
  git -C "$DEST" reset --hard "$XENIA_REV"
else
  git clone --filter=blob:none --no-checkout https://github.com/xenia-project/xenia.git "$DEST"
  git -C "$DEST" fetch --depth=1 origin "$XENIA_REV"
  git -C "$DEST" checkout --detach "$XENIA_REV"
fi

# Pull only dependencies used by the browser CPU/HIR bootstrap and the
# translation-only Xenos -> SPIR-V accelerator seam. This intentionally does
# not initialize Vulkan/SDL/media backends.
git -C "$DEST" submodule update --init --depth=1 \
  third_party/fmt \
  third_party/utfcpp \
  third_party/capstone \
  third_party/cpptoml \
  third_party/cxxopts \
  third_party/date \
  third_party/glslang

actual="$(git -C "$DEST" rev-parse HEAD)"
if [ "$actual" != "$XENIA_REV" ]; then
  printf 'Pinned Xenia revision mismatch: expected %s got %s\n' "$XENIA_REV" "$actual" >&2
  exit 1
fi
printf '%s\n' "$actual" | tee "$ROOT/upstream/XENIA_HEAD.txt"
printf 'Xenia source ready at pinned revision: %s\n' "$actual"
printf 'SPIR-V dependency revision: %s\n' "$(git -C "$DEST/third_party/glslang" rev-parse HEAD)"
