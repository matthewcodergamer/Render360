#!/bin/bash
# Copies the Render360 website (the UI the app shows) into the app bundle's
# web/ folder. Run by Xcode before each build (project.yml preBuildScripts).
set -euo pipefail
ROOT="${SRCROOT:?}/.."
DEST="${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}/web"
mkdir -p "$DEST"
rsync -a --delete --delete-excluded \
  --exclude '.git*' --exclude 'build/' --exclude 'upstream/' --exclude 'native/' --exclude 'ios/' \
  --exclude 'docs/' --exclude 'tests/' --exclude 'tools/' --exclude 'deploy/' --exclude 'GamesToTest/' \
  --exclude 'Games/' --exclude 'logs/' --exclude 'src/' --exclude 'xenia_port/' --exclude 'recompiled/' \
  --exclude '__pycache__/' --exclude 'node_modules/' --exclude 'test-*' --exclude '*_test*' --exclude '*.py' \
  --exclude '*.sh' --exclude '*.md' --exclude '*.cpp' --exclude '*.h' --exclude '*.txt' \
  --exclude 'xenia_ppc_bootstrap.wasm' --exclude 'xenia_ppc_bootstrap.meta.json' --exclude 'render360-sw.js' \
  "$ROOT/" "$DEST/"
