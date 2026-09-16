#!/usr/bin/env bash
# ============================================================
# WorkLoom Release 本地发布脚本（已封禁）
# 正式发行只能由 .github/workflows/build-desktop.yml 的受保护发布 job 完成。
# ============================================================
set -euo pipefail
echo "❌ 本地/长期令牌 Release 通道已封禁。"
echo "请从受保护的 build-desktop workflow 发布已签名、已公证、双平台完整制品。"
exit 1
