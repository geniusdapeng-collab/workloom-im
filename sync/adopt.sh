#!/usr/bin/env bash
# WorkLoom IM · 新子仓安全接入
#
# 存量模式只安装根级必备资产；--new-industry 先完整同步公共运行时，再从最新
# 稳定标签一次安装三端客户端基座。两种模式都不触碰 Bundle/行业扩展，且不暂存、
# 不提交、不推送。
#
# 存量仓只接入治理：bash sync/adopt.sh <子仓本地路径> [--path-prefix governance/]
# 新行业完整脚手架：bash sync/adopt.sh <子仓本地路径> --new-industry [--path-prefix governance/] [--dry-run]
set -euo pipefail

CHILD="${1:?用法: bash sync/adopt.sh <子仓路径> [--new-industry] [--path-prefix <prefix>] [--dry-run]}"
shift
PREFIX=""
NEW_INDUSTRY=false
DRY_RUN=false
FOUNDATION_VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --new-industry)
      NEW_INDUSTRY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --version)
      [ -n "${2:-}" ] || { echo "❌ --version 需要精确稳定版本"; exit 64; }
      FOUNDATION_VERSION="$2"
      shift 2
      ;;
    --path-prefix)
      [ -n "${2:-}" ] || { echo "❌ --path-prefix 需要目录参数"; exit 64; }
      RAW_PREFIX="${2%/}"
      shift 2
      ;;
    *)
      echo "❌ 未知参数：$1"
      exit 64
      ;;
  esac
done

if [ -n "${RAW_PREFIX:-}" ]; then
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
[ "$NEW_INDUSTRY" = false ] || command -v pnpm >/dev/null 2>&1 || { echo "❌ 未找到 pnpm（需要 10.14.0）"; exit 1; }

# 所有在写入前承担决策的控制器都必须来自当前基座 HEAD；不允许用尚未提交的
# 本地脚本给子仓登记一个来源提交中不存在的“完成状态”。
verify_head_file() {
  local REL="$1"
  local WORKTREE_HASH HEAD_HASH
  WORKTREE_HASH="$(git -C "$BASE_DIR" hash-object -- "$REL" 2>/dev/null || true)"
  HEAD_HASH="$(git -C "$BASE_DIR" rev-parse "HEAD:$REL" 2>/dev/null || true)"
  [ -n "$HEAD_HASH" ] && [ "$WORKTREE_HASH" = "$HEAD_HASH" ] || {
    echo "❌ 基座 $REL 与 HEAD 不一致；请先评审并提交基座变更"
    exit 1
  }
}
verify_head_file "sync/adopt.sh"
if [ "$NEW_INDUSTRY" = true ]; then
  for CONTROL_FILE in \
    sync/adoption-contract.mjs \
    sync/adoption-transaction.mjs \
    sync/client-foundation.mjs \
    sync/install-adoption-assets.mjs \
    sync/install-ui-governance.mjs \
    sync/set-ui-version.mjs \
    sync/ui-lockfile-integrity.mjs \
    sync/base-capabilities.json \
    sync/ui-consumer-template.yml \
    scripts/verify-client-foundation-consumer.mjs \
    scripts/verify-production-client-boundary.mjs \
    scripts/verify-ui-consumer.mjs \
    scripts/ui-governance-rules.mjs
  do
    verify_head_file "$CONTROL_FILE"
  done
fi

ADOPTION_TRANSACTION=""
rollback_adoption() {
  local STATUS="${1:-1}"
  trap - ERR INT TERM
  if [ -n "$ADOPTION_TRANSACTION" ]; then
    if node "$SYNC_DIR/adoption-transaction.mjs" rollback "$ADOPTION_TRANSACTION"; then
      echo "  ↩️ 新行业接入失败，Git 工作树与 index 已恢复到接入前状态" >&2
      ADOPTION_TRANSACTION=""
    else
      echo "❌ 新行业接入事务自动回滚失败；保留事务目录供人工恢复：$ADOPTION_TRANSACTION" >&2
      exit 70
    fi
  fi
  exit "$STATUS"
}

echo "== WorkLoom IM 根级上下文接入 =="
echo "   子仓：${REPO_NAME}（行业基座目录：${PREFIX:-（根）}）"

FOUNDATION_ARGS=(--repo "$CHILD" --base-dir "$BASE_DIR")
[ -n "$PREFIX" ] && FOUNDATION_ARGS+=(--path-prefix "${PREFIX%/}")
[ -n "$FOUNDATION_VERSION" ] && FOUNDATION_ARGS+=(--version "$FOUNDATION_VERSION")

# 新行业先对行业自有工程契约、完整公共基座计划、稳定标签、独立产品身份、
# 三端受管路径与全部潜在冲突做零写入预检。任一失败都必须在写根资产前终止。
if [ "$NEW_INDUSTRY" = true ]; then
  node "$SYNC_DIR/adoption-contract.mjs" preflight --repo "$CHILD" --workdir "$WORKDIR"
  node "$SYNC_DIR/install-ui-governance.mjs" --repo "$WORKDIR" --repository-root "$CHILD" --source-root "$BASE_DIR" --dry-run
  node "$SYNC_DIR/install-adoption-assets.mjs" \
    --repo "$CHILD" \
    --workdir "$WORKDIR" \
    --source-root "$BASE_DIR" \
    --template "$SYNC_DIR/ui-consumer-template.yml" \
    --dry-run
  node "$SYNC_DIR/base-sync.mjs" pull \
    --repo "$WORKDIR" \
    --base-dir "$BASE_DIR" \
    --no-commit \
    --adopt \
    --dry-run
  node "$SYNC_DIR/client-foundation.mjs" scaffold "${FOUNDATION_ARGS[@]}" --dry-run
  echo "  ✅ 新行业完整基座、工程契约与三端脚手架预检通过（默认采用 latest stable）"
fi

# 预检全部通过后才创建跨阶段事务。事务保存接入前所有 Git 可见文件、用户脏树
# 与 index；后续任一安装、lockfile 或 verifier 失败都会恢复原状。
if [ "$NEW_INDUSTRY" = true ] && [ "$DRY_RUN" = false ]; then
  TRANSACTION_ARGS=(begin "$CHILD" "$WORKDIR" --base-dir "$BASE_DIR")
  [ -n "$FOUNDATION_VERSION" ] && TRANSACTION_ARGS+=(--version "$FOUNDATION_VERSION")
  ADOPTION_TRANSACTION="$(node "$SYNC_DIR/adoption-transaction.mjs" "${TRANSACTION_ARGS[@]}")"
  trap 'rollback_adoption $?' ERR
  trap 'rollback_adoption 130' INT TERM
fi

# ① 存量接入只安装根级 required assets；新行业必须安装完整公共基座。引擎先
# 写内容、逐项复验，再写根级 state。--no-commit 不会偷偷暂存或提交用户文件。
BASE_SYNC_ARGS=(pull \
  --repo "$WORKDIR" \
  --base-dir "$BASE_DIR" \
  --no-commit \
  --adopt)
[ "$NEW_INDUSTRY" = false ] && BASE_SYNC_ARGS+=(--required-only)
[ "$DRY_RUN" = true ] && BASE_SYNC_ARGS+=(--dry-run)
node "$SYNC_DIR/base-sync.mjs" "${BASE_SYNC_ARGS[@]}"

if [ "$DRY_RUN" = true ]; then
  echo "  ✅ dry-run 完成：根级资产与三端客户端均未写入"
  exit 0
fi

# ② 独立复验；新行业必须由 full detect 证明公共文件零漂移，不能用 required-only
# state 冒充完整基座。存量治理接入仍只复验根级资产。
DETECT_ARGS=(detect \
  --repo "$WORKDIR" \
  --base-dir "$BASE_DIR")
[ "$NEW_INDUSTRY" = false ] && DETECT_ARGS+=(--required-only)
node "$SYNC_DIR/base-sync.mjs" "${DETECT_ARGS[@]}"
(cd "$CHILD" && node "$BASE_DIR/scripts/secret-scan.mjs" --files \
  AGENTS.md \
  WORKLOOM_PRODUCT_CONTEXT.md \
  .workloom-base-sync.json \
  .github/workflows/base-sync-heartbeat.yml)
if [ "$NEW_INDUSTRY" = true ]; then
  echo "  ✅ 公共运行时、根级治理资产与 full state 已安装并验真"
else
  echo "  ✅ 根级产品上下文、AGENTS 受控块与 required-only state 已安装并验真"
fi

# ③ heartbeat 是 required copied asset，已由引擎从受控模板逐字节安装；
# 运行时从根级 state.pathPrefix 读取行业基座目录，因此无需仓别模板渲染。
echo "  ✅ 通用 heartbeat workflow 已安装（行业基座目录由根级 state.pathPrefix 解析）"

# 新行业不是“报告缺端后留给人工复制”：通过预检后一次安装同一稳定标签里的
# PC/B移动/C移动应用壳，并建立逐文件旧基座指纹。随后锁定同版本 @workloom/ui
# 且运行真实消费门禁。product.manifest.json 始终由行业仓预先提供，两个脚本均
# 不生成、不覆盖该身份文件。
if [ "$NEW_INDUSTRY" = true ]; then
  node "$SYNC_DIR/client-foundation.mjs" scaffold "${FOUNDATION_ARGS[@]}"
  UI_ARGS=(--repo "$CHILD")
  [ -n "$PREFIX" ] && UI_ARGS+=(--path-prefix "${PREFIX%/}")
  [ -n "$FOUNDATION_VERSION" ] && UI_ARGS+=(--version "$FOUNDATION_VERSION")
  node "$SYNC_DIR/set-ui-version.mjs" "${UI_ARGS[@]}"
  node "$SYNC_DIR/install-ui-governance.mjs" --repo "$WORKDIR" --repository-root "$CHILD" --source-root "$BASE_DIR"
  node "$SYNC_DIR/install-adoption-assets.mjs" \
    --repo "$CHILD" \
    --workdir "$WORKDIR" \
    --source-root "$BASE_DIR" \
    --template "$SYNC_DIR/ui-consumer-template.yml"
  (cd "$WORKDIR" && pnpm install --lockfile-only --ignore-scripts) || {
    STATUS=$?
    rollback_adoption "$STATUS"
  }
  # pnpm 10 对 URL tarball 不会自动把 sha512 写进 lockfile。使用已由 HEAD 验真的
  # 零外部依赖绑定器把 .workloom-ui.json 的受控摘要注入唯一 canonical resolution；
  # 下一步 frozen install 将由 pnpm 自身执行该 SRI。
  node "$SYNC_DIR/ui-lockfile-integrity.mjs" --repo "$WORKDIR"
  # verifier 静态导入固定 TypeScript/YAML 解析器；临时 clone/新仓不能依赖基座 node_modules 偶然兜底。
  # 先生成锁文件，再按该锁文件真实安装，随后才允许执行消费门禁。
  (cd "$WORKDIR" && pnpm install --frozen-lockfile --ignore-scripts) || {
    STATUS=$?
    rollback_adoption "$STATUS"
  }
  node "$WORKDIR/scripts/verify-ui-consumer.mjs" --repo "$WORKDIR"
  node "$WORKDIR/scripts/verify-client-foundation-consumer.mjs" --repo "$WORKDIR"
  node "$SYNC_DIR/adoption-contract.mjs" post --repo "$CHILD" --workdir "$WORKDIR"
  node "$SYNC_DIR/adoption-transaction.mjs" commit "$ADOPTION_TRANSACTION"
  ADOPTION_TRANSACTION=""
  trap - ERR INT TERM
  echo "  ✅ 完整公共基座、最新稳定三端客户端基座与共享 UI 已一次接入"
fi

# ④ 报告三端/身份迁移阶段。存量模式不复制客户端；新行业模式已在上一步
# 安装并验真完整三端。任何缺端都不能因为根资产对齐就被宣称合规。
MISSING_CLIENTS=()
for CLIENT_PACKAGE in apps/web/package.json apps/webb/package.json apps/webc/package.json; do
  [ -f "$WORKDIR/$CLIENT_PACKAGE" ] || MISSING_CLIENTS+=("$CLIENT_PACKAGE")
done
if [ "$NEW_INDUSTRY" = true ]; then
  echo "  ✅ 新行业 full 基座状态、三端结构、客户端基座指纹与 UI 消费契约已通过"
elif [ "${#MISSING_CLIENTS[@]}" -gt 0 ]; then
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

  --new-industry 还须审查：完整公共基座文件、$WORKDIR/.workloom-ui.json、
  $WORKDIR/.workloom-client-foundation.json、$WORKDIR/.workloom-ui-governance.json、三个 apps 客户端、
  UI verifier + AST 规则与其余两个消费/生产门禁脚本，
  以及 .github/workflows/workloom-ui-contract.yml。

  若目标由 workloom-im fork/template 派生，adopt 仅在逐字节 fingerprint
  完全相同时把父仓 AGENTS.repo.md 改为通用待填写 scaffold，并移除父仓专属
  base-sync-push workflow；任何已定制内容都会保留。审查通过后只白名单暂存
  上述接入变更并提交。随后先完成“三端真实入口 + product.manifest.json”
  结构迁移，再通过稳定 UI + 三端客户端基座升级 PR 锁定 @workloom/ui、应用壳
  指纹并执行消费门禁；两阶段
  都通过后才把本仓登记到 workloom-im/sync/child-repos.json。GitHub Actions 使用仓库自带的短期
  GITHUB_TOKEN 建同步 PR；不要配置或提交个人访问令牌。
EOF
