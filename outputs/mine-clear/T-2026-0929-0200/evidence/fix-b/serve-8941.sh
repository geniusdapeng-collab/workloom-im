#!/bin/bash
# fix_b_fence 专用：.wt-mcd-fb 服务常驻（DB wl_mcd_fb / 端口 8941）
set -u
REPO=/Users/mac/WorkLoom-fleet/.wt-mcd-fb
ENVF=/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/env-fb
LOG=/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/fix-b/server-8941.log
export PATH=/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-5/work/bin:/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
cd "$REPO" || exit 1
while true; do
  echo "[supervisor $(date +%H:%M:%S)] starting server" >> "$LOG"
  node_modules/.bin/tsx --env-file="$ENVF" apps/server/src/index.ts >> "$LOG" 2>&1
  echo "[supervisor $(date +%H:%M:%S)] server exited code=$?" >> "$LOG"
  sleep 2
done
