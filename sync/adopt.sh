#!/usr/bin/env bash
# WorkLoom IM · 新子仓安全接入
#
# 只安装根级必备资产（完整产品上下文、AGENTS 受控块、同步 state）与心跳
# workflow，不触碰行业代码。所有产物留在工作树中供人工复核、白名单暂存和提交。
#
# 用法：bash sync/adopt.sh <子仓本地路径> [--path-prefix governance/]
set -euo pipefail

CHILD="${1:?用法: bash sync/adopt.sh <子仓路径> [--path-prefix <prefix>]}"
PREFIX=""
if [ "${2:-}" = "--path-prefix" ]; then
  [ -n "${3:-}" ] || { echo "❌ --path-prefix 需要目录参数"; exit 64; }
  RAW_PREFIX="${3%/}"
  case "$RAW_PREFIX" in
    ""|/*|*//*|*\\*|*[!A-Za-z0-9._/-]*) echo "❌ --path-prefix 必须是仓库内安全相对目录"; exit 64 ;;
  esac
  IFS='/' read -r -a PREFIX_PARTS <<< "$RAW_PREFIX"
  for PART in "${PREFIX_PARTS[@]}"; do
    [ -n "$PART" ] && [ "$PART" != "." ] && [ "$PART" != ".." ] || {
      echo "❌ --path-prefix 必须是仓库内安全相对目录"
      exit 64
    }
  done
  PREFIX="$RAW_PREFIX/"
elif [ -n "${2:-}" ]; then
  echo "❌ 未知参数：$2"
  exit 64
fi

SYNC_DIR="$(cd "$(dirname "$0")" && pwd -P)"
BASE_DIR="$(cd "$SYNC_DIR/.." && pwd -P)"
CHILD="$(cd "$CHILD" 2>/dev/null && pwd -P)" || { echo "❌ 子仓目录不存在"; exit 1; }
REPO_NAME="$(basename "$CHILD")"
WORKDIR="$CHILD"
[ -n "$PREFIX" ] && WORKDIR="$CHILD/${PREFIX%/}"

git -C "$CHILD" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "❌ $CHILD 不是 Git 仓库或 linked worktree"
  exit 1
}
GIT_ROOT="$(git -C "$CHILD" rev-parse --show-toplevel)"
GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
[ "$CHILD" = "$GIT_ROOT" ] || { echo "❌ 请把子仓 Git 根目录作为第一个参数：$GIT_ROOT"; exit 64; }
[ -d "$WORKDIR" ] || { echo "❌ pathPrefix 目录不存在：$WORKDIR"; exit 1; }
case "${WORKDIR}/" in
  "${CHILD}/"*) ;;
  *) echo "❌ pathPrefix 解析后逃逸出目标 Git 工作树"; exit 64 ;;
esac
command -v node >/dev/null 2>&1 || { echo "❌ 未找到 Node.js（需要 Node >= 20）"; exit 1; }

# adopt 本身也必须来自当前基座 HEAD；不允许用工作树里尚未提交的接入逻辑
# 给子仓登记一个并不存在于来源提交中的版本。
ADOPT_WORKTREE_HASH="$(git -C "$BASE_DIR" hash-object -- sync/adopt.sh)"
ADOPT_HEAD_HASH="$(git -C "$BASE_DIR" rev-parse HEAD:sync/adopt.sh 2>/dev/null || true)"
[ -n "$ADOPT_HEAD_HASH" ] && [ "$ADOPT_WORKTREE_HASH" = "$ADOPT_HEAD_HASH" ] || {
  echo "❌ 基座 sync/adopt.sh 与 HEAD 不一致；请先评审并提交基座变更"
  exit 1
}

echo "== WorkLoom IM 根级上下文接入 =="
echo "   子仓：${REPO_NAME}（行业基座目录：${PREFIX:-（根）}）"

# ① 只安装根级 required assets。引擎先写内容、逐项复验，再写根级 state。
# --no-commit 使既有工作树也能安全接入，且不会偷偷暂存或提交任何用户文件。
node "$SYNC_DIR/base-sync.mjs" pull \
  --repo "$WORKDIR" \
  --base-dir "$BASE_DIR" \
  --required-only \
  --no-commit \
  --adopt

# ② 独立复验；即使 state 的 SHA 看似相同，也会重新读取文件并比较受控区块/哈希。
node "$SYNC_DIR/base-sync.mjs" detect \
  --repo "$WORKDIR" \
  --base-dir "$BASE_DIR" \
  --required-only
(cd "$CHILD" && node "$BASE_DIR/scripts/secret-scan.mjs" --files \
  AGENTS.md \
  WORKLOOM_PRODUCT_CONTEXT.md \
  .workloom-base-sync.json \
  .github/workflows/base-sync-heartbeat.yml)
echo "  ✅ 根级产品上下文、AGENTS 受控块与 state 已安装并验真"

# ③ heartbeat 是 required copied asset，已由引擎从受控模板逐字节安装；
# 运行时从根级 state.pathPrefix 读取行业基座目录，因此无需仓别模板渲染。
echo "  ✅ 通用 heartbeat workflow 已安装（行业基座目录由根级 state.pathPrefix 解析）"

# ④ 只读报告三端/身份迁移阶段。adopt 负责治理接入，不复制行业客户端，
# 因此缺端必须显式暴露，不能因为根资产对齐就宣称行业产品已三端合规。
MISSING_CLIENTS=()
for CLIENT_PACKAGE in apps/web/package.json apps/webb/package.json apps/webc/package.json; do
  [ -f "$WORKDIR/$CLIENT_PACKAGE" ] || MISSING_CLIENTS+=("$CLIENT_PACKAGE")
done
if [ "${#MISSING_CLIENTS[@]}" -gt 0 ]; then
  echo "  ⚠️ 第一阶段迁移未完成：缺少 ${MISSING_CLIENTS[*]}"
  echo "     请先从最新版基座模板补齐真实生产客户端；当前不得登记为三端合规。"
elif [ ! -f "$WORKDIR/product.manifest.json" ]; then
  echo "  ⚠️ 第一阶段迁移未完成：缺少 product.manifest.json（产品身份、端口与发布标识不得继承基座默认值）"
elif [ ! -f "$WORKDIR/.workloom-ui.json" ]; then
  echo "  ⚠️ 第二阶段迁移未完成：三端结构已存在，但尚未锁定 @workloom/ui 稳定制品"
else
  echo "  ℹ️ 三端结构与 UI 清单已存在；仍须通过 scripts/verify-ui-consumer.mjs 才能认定合规"
fi

cat <<EOF

  📋 接入文件已写入但未暂存、未提交、未推送。请先审查：
       git -C "$CHILD" diff -- WORKLOOM_PRODUCT_CONTEXT.md AGENTS.md AGENTS.repo.md .workloom-base-sync.json .github/workflows/base-sync-heartbeat.yml .github/workflows/base-sync-push.yml

  若目标由 workloom-im fork/template 派生，adopt 仅在逐字节 fingerprint
  完全相同时把父仓 AGENTS.repo.md 改为通用待填写 scaffold，并移除父仓专属
  base-sync-push workflow；任何已定制内容都会保留。审查通过后只白名单暂存
  上述接入变更并提交。随后先完成“三端真实入口 + product.manifest.json”
  结构迁移，再通过稳定 UI 升级 PR 锁定 @workloom/ui 并执行消费门禁；两阶段
  都通过后才把本仓登记到 workloom-im/sync/child-repos.json。GitHub Actions 使用仓库自带的短期
  GITHUB_TOKEN 建同步 PR；不要配置或提交个人访问令牌。
EOF
