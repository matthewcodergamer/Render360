#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$ROOT/upstream/xenia"
mkdir -p "$ROOT/upstream"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --depth=1 origin master
  git -C "$DEST" reset --hard origin/master
else
  git clone --depth=1 https://github.com/xenia-project/xenia.git "$DEST"
fi

# Pull only the small third-party dependencies needed by the CPU/HIR bootstrap.
# Do not initialize the graphics/media stack here.
git -C "$DEST" submodule update --init --depth=1 \
  third_party/fmt \
  third_party/utfcpp \
  third_party/capstone \
  third_party/cpptoml \
  third_party/cxxopts

git -C "$DEST" rev-parse HEAD | tee "$ROOT/upstream/XENIA_HEAD.txt"
printf 'Xenia source ready: %s\n' "$DEST"
