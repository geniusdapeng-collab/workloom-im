#!/usr/bin/env bash
# WorkLoom IM · 新子仓接入脚本（adopt）
#
# 用途：让一个使用 WorkLoom IM 基座能力的仓库接入可审计升级机制。
# 做的事（全部幂等）：
#   ① 校验三端入口并锁定 WorkLoom IM 最新稳定 UI 制品
#   ② 注入 .github/workflows/base-sync-heartbeat.yml（心跳触发器，cron 按仓名错峰）
#   ③ 真实拉齐基座 scope 并写入可复核基线（不自动提交）
#   ④ 逐文件复检为零差异后，输出注册到基座订阅清单的人工动作
#
# 用法：
#   bash adopt.sh <子仓本地路径> [--path-prefix governance/]
set -euo pipefail

CHILD="${1:?用法: bash adopt.sh <子仓路径> [--path-prefix <prefix>]}"
shift
PREFIX=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --path-prefix)
      [ "$#" -ge 2 ] || { echo "❌ --path-prefix 缺少目录参数"; exit 64; }
      PREFIX="${2%/}/"
      shift 2
      ;;
    *) echo "❌ 未知参数：$1"; exit 64 ;;
  esac
done
case "$PREFIX" in
  /*|../*|*/../*|*/..) echo "❌ pathPrefix 必须是子仓内的相对目录：$PREFIX"; exit 64 ;;
esac
SYNC_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SYNC_DIR/.." && pwd)"
REPO_NAME="$(basename "$CHILD")"
WORKDIR="$CHILD"
[ -n "$PREFIX" ] && WORKDIR="$CHILD/${PREFIX%/}"

git -C "$CHILD" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "❌ $CHILD 不是 git 仓库"; exit 1; }
[ -d "$WORKDIR" ] || { echo "❌ 工作目录不存在：$WORKDIR"; exit 1; }
CHILD_ROOT="$(cd "$CHILD" && pwd -P)"
WORK_ROOT="$(cd "$WORKDIR" && pwd -P)"
case "$WORK_ROOT" in
  "$CHILD_ROOT"|"$CHILD_ROOT"/*) ;;
  *) echo "❌ 工作目录解析后越出子仓：$WORK_ROOT"; exit 64 ;;
esac
CHILD="$CHILD_ROOT"
WORKDIR="$WORK_ROOT"
[ -z "$(git -C "$BASE_DIR" status --porcelain)" ] || {
  echo "❌ WorkLoom IM 基座工作树存在未提交变化；无法用 HEAD SHA 证明待接入内容，请先完成基座评审与提交"
  exit 1
}

echo "== WorkLoom IM 基座同步接入 =="
echo "   子仓：$REPO_NAME（工作目录前缀：${PREFIX:-（根）}）"

# ① 新行业只能消费已通过门禁的稳定 UI；并且三个生产客户端必须齐备。
node "$SYNC_DIR/set-ui-version.mjs" --repo "$CHILD" --path-prefix "${PREFIX%/}" --require-all
if command -v pnpm >/dev/null 2>&1; then
  pnpm -C "$WORKDIR" install --lockfile-only
  echo "  ✅ 三端已锁定最新稳定 UI，锁文件已刷新"
else
  echo "  ⚠️ 三端已锁定最新稳定 UI；未发现 pnpm，请在提交前手动刷新锁文件"
fi

# ② 注入心跳 workflow（cron 按仓名错峰：0-59 分钟由仓名哈希决定；__REPO_DIR__ 按 pathPrefix 适配工作区）
mkdir -p "$CHILD/.github/workflows"
MIN=$(( $(echo -n "$REPO_NAME" | cksum | awk '{print $1}') % 60 ))
HOUR=$(( 3 + $(echo -n "$REPO_NAME" | cksum | awk '{print $1}') % 3 ))   # 凌晨 3-5 点段
REPO_DIR="${PREFIX%/}"; [ -z "$REPO_DIR" ] && REPO_DIR="."
sed -e "s/__CRON__/$MIN $HOUR * * */" -e "s/__REPO_DIR__/$REPO_DIR/g" "$SYNC_DIR/heartbeat-template.yml" > "$CHILD/.github/workflows/base-sync-heartbeat.yml"
sed -e "s|__REPO_DIR__|$REPO_DIR|g" "$SYNC_DIR/ui-consumer-template.yml" > "$CHILD/.github/workflows/workloom-ui-contract.yml"
mkdir -p "$WORKDIR/scripts"
cp "$BASE_DIR/scripts/verify-ui-consumer.mjs" "$WORKDIR/scripts/verify-ui-consumer.mjs"
echo "  ✅ 心跳 workflow 已注入（cron: $MIN $HOUR * * *，工作区: $REPO_DIR）"
echo "  ✅ 三端 UI 同源门禁 workflow 与独立校验器已注入"

# 新行业不得只锁版本而继续使用本地复制壳；三端必须真实消费共享壳、弹层、表单与样式。
node "$WORKDIR/scripts/verify-ui-consumer.mjs" --repo "$WORKDIR"
echo "  ✅ 三端已实际消费最新稳定基座界面，未发现公共组件分叉"

# ③ 不能只写一个“看似已同步”的 SHA：逐文件按 scope 真正拉齐后才能登记基线。
node "$SYNC_DIR/base-sync.mjs" pull --repo "$WORKDIR" --base-dir "$BASE_DIR" --no-commit
# detect 使用同一个基座快照并保持只读；只有逐文件零差异才允许 adopt 成功。
node "$SYNC_DIR/base-sync.mjs" detect --repo "$WORKDIR" --base-dir "$BASE_DIR" --dry-run >/dev/null
echo "  ✅ 基座公共能力已逐文件对齐并复检为零差异；基座 SHA 已写入状态账本"

# ④ 后续人工动作提示
cat <<EOF

  📋 还差一步（人工，一次性）：
  1. 把本仓注册到基座订阅清单——编辑 workloom-im 仓 sync/child-repos.json，children 追加：
       { "repo": "<owner>/$REPO_NAME", "pathPrefix": "$PREFIX", "note": "" }

  凭据只配置在 WorkLoom IM 基座仓；行业仓心跳只读检测。基座 main 的 ci-gate 通过后，
  中央流程会向本仓创建独立升级 PR，待本仓 CI 与人工评审通过后再合并。

  验证：本仓 push 任意提交触发只读 heartbeat，或手动 Actions → base-sync-heartbeat → Run workflow。
EOF
