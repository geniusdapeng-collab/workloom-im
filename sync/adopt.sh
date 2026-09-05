#!/usr/bin/env bash
# WorkLoom IM · 新子仓接入脚本（adopt）
#
# 用途：让一个使用 WorkLoom IM 基座能力的仓库自动继承双向同步机制。
# 做的事（全部幂等）：
#   ① 注入 .github/workflows/base-sync-heartbeat.yml（心跳触发器，cron 按仓名错峰）
#   ② 初始化 .workloom-base-sync.json 基线状态（以基座当前 main 为准）
#   ③ 输出后续两步人工动作：把新仓注册到基座 sync/child-repos.json + 配置 SYNC_TOKEN secret
#
# 用法：
#   bash adopt.sh <子仓本地路径> [--path-prefix governance/]
set -euo pipefail

CHILD="${1:?用法: bash adopt.sh <子仓路径> [--path-prefix <prefix>]}"
PREFIX=""
[ "${2:-}" = "--path-prefix" ] && PREFIX="${3%/}/"
SYNC_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SYNC_DIR/.." && pwd)"
REPO_NAME="$(basename "$CHILD")"
WORKDIR="$CHILD"
[ -n "$PREFIX" ] && WORKDIR="$CHILD/${PREFIX%/}"

[ -d "$CHILD/.git" ] || { echo "❌ $CHILD 不是 git 仓库"; exit 1; }

echo "== WorkLoom IM 基座同步接入 =="
echo "   子仓：$REPO_NAME（工作目录前缀：${PREFIX:-（根）}）"

# ① 注入心跳 workflow（cron 按仓名错峰：0-59 分钟由仓名哈希决定；__REPO_DIR__ 按 pathPrefix 适配工作区）
mkdir -p "$CHILD/.github/workflows"
MIN=$(( $(echo -n "$REPO_NAME" | cksum | awk '{print $1}') % 60 ))
HOUR=$(( 3 + $(echo -n "$REPO_NAME" | cksum | awk '{print $1}') % 3 ))   # 凌晨 3-5 点段
REPO_DIR="${PREFIX%/}"; [ -z "$REPO_DIR" ] && REPO_DIR="."
sed -e "s/__CRON__/$MIN $HOUR * * */" -e "s/__REPO_DIR__/$REPO_DIR/g" "$SYNC_DIR/heartbeat-template.yml" > "$CHILD/.github/workflows/base-sync-heartbeat.yml"
echo "  ✅ 心跳 workflow 已注入（cron: $MIN $HOUR * * *，工作区: $REPO_DIR）"

# ② 初始化基线状态（以基座当前 HEAD 为准；真实首次对齐由引擎 diff 决定）
BASE_SHA="$(git -C "$BASE_DIR" rev-parse HEAD)"
if [ ! -f "$WORKDIR/.workloom-base-sync.json" ]; then
  cat > "$WORKDIR/.workloom-base-sync.json" <<EOF
{
  "baseRepo": "geniusdapeng-collab/workloom-im",
  "lastSyncedBaseSha": "$BASE_SHA",
  "lastSyncAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filesTouched": 0,
  "note": "adopt.sh 初始化基线；首次心跳/拉取时由 base-sync 引擎按 scope 实际 diff 对齐"
}
EOF
  echo "  ✅ 基线状态已初始化（基座 ${BASE_SHA:0:8}）"
else
  echo "  ⏭️  基线状态已存在（跳过）"
fi

# ③ 后续人工动作提示
cat <<EOF

  📋 还差两步（人工，一次性）：
  1. 把本仓注册到基座订阅清单——编辑 workloom-im 仓 sync/child-repos.json，children 追加：
       { "repo": "<owner>/$REPO_NAME", "pathPrefix": "$PREFIX", "note": "" }
  2. 配置推送凭据（全自动模式）：本仓 Settings → Secrets and variables → Actions
       新建 secret：SYNC_TOKEN = <repo 权限的 GitHub PAT>
     （不配置则为半自动：心跳检测落后时 CI 标红提醒，人工执行拉取）

  验证：本仓 push 任意提交触发 heartbeat，或手动 Actions → base-sync-heartbeat → Run workflow。
EOF
