#!/usr/bin/env bash
# WorkLoom IM 底座 · 数据重置（演示剧本前置：回到干净的云栖酒店数据集）
# 注意：biz_events 为 append-only（触发器禁 DELETE，L1.1），
#      因此重置 = 整库重建（drop schema）→ 迁移 → 种子，而非清表。
# 用法：./scripts/reset.sh [--yes]（--yes/-y 仅跳过交互确认；目标安全校验与备份永不跳过）
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf "❌ %s\n" "$1" >&2; exit "${2:-1}"; }

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    *) fail "未知参数：${arg}（仅支持 --yes/-y）" 64 ;;
  esac
done

echo "== WorkLoom IM 底座 · 重置演示数据 =="
echo "⚠️  将删除本地演示库全部数据（append-only 事件库只能整库重建）"

case "${NODE_ENV:-${WORKLOOM_ENV:-development}}" in
  production|prod) fail "生产环境禁止运行演示数据重置" ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
  [ -f .env ] || fail ".env 不存在且未显式提供 DATABASE_URL，拒绝猜测重置目标"
  DB_URL=$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- || true)
else
  DB_URL=$DATABASE_URL
fi
[ -n "$DB_URL" ] || fail "DATABASE_URL 为空，拒绝重置"

DB_HOST=$(DATABASE_URL="$DB_URL" node -e 'try { process.stdout.write(new URL(process.env.DATABASE_URL).hostname) } catch { process.exit(1) }') \
  || fail "DATABASE_URL 不是有效 URL，拒绝重置"
DB_PORT=$(DATABASE_URL="$DB_URL" node -e 'try { const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.port || "5432") } catch { process.exit(1) }') \
  || fail "无法解析 DATABASE_URL 端口，拒绝重置"
DB_NAME=$(DATABASE_URL="$DB_URL" node -e 'try { const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.pathname.replace(/^\//, ""))) } catch { process.exit(1) }') \
  || fail "无法解析 DATABASE_URL 数据库名，拒绝重置"

case "$DB_HOST" in
  localhost|127.0.0.1|::1) ;;
  *) fail "只允许重置本机演示库；当前目标主机为 ${DB_HOST:-<empty>}" ;;
esac
[ "$DB_NAME" = "workloom" ] || fail "只允许重置名为 workloom 的演示库；当前数据库为 ${DB_NAME:-<empty>}"

if [ "$ASSUME_YES" != "1" ]; then
  [ -t 0 ] || fail "非交互环境必须显式传入 --yes；本次未执行任何删除" 64
  read -r -p "确认重置 ${DB_HOST}:${DB_PORT}/${DB_NAME}？请输入数据库名 workloom：" answer
  [ "$answer" = "workloom" ] || { echo "已取消，未修改数据库"; exit 0; }
fi

# docker 通道仅在容器真实存在时启用；否则回退本机 psql（D24 修复：有 docker 守护进程但无 workloom-im-pg 容器时不再误走 docker exec）
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
   && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'workloom-im-pg' \
   && [ "$DB_PORT" = "5432" ]; then
  db_query() { docker exec workloom-im-pg psql -U postgres -d workloom -v ON_ERROR_STOP=1 -Atq -c "$1"; }
  db_backup() { docker exec workloom-im-pg pg_dump -U postgres -d workloom -Fc; }
else
  command -v psql >/dev/null 2>&1 || fail "psql 不可用，拒绝在无法核验目标的情况下重置"
  command -v pg_dump >/dev/null 2>&1 || fail "pg_dump 不可用，无法生成重置前备份"
  db_query() { psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }
  db_backup() { pg_dump "$DB_URL" -Fc; }
fi

TABLE_STATE=$(db_query "SELECT CASE WHEN to_regclass('public.workspaces') IS NULL THEN 'absent' ELSE 'present' END" \
  || fail "无法核验目标数据库，拒绝重置")
if [ "$TABLE_STATE" = "present" ]; then
  HAS_EXAMPLE_COLUMN=$(db_query "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='workspaces' AND column_name='is_example'" \
    || fail "无法核验工作区类型，拒绝重置")
  [ "$HAS_EXAMPLE_COLUMN" = "1" ] || fail "workspaces.is_example 缺失，无法证明这是演示库，拒绝重置"
  NON_EXAMPLE=$(db_query "SELECT count(*) FROM workspaces WHERE is_example IS NOT TRUE" \
    || fail "无法核验客户工作区，拒绝重置")
  [ "$NON_EXAMPLE" = "0" ] || fail "检测到 $NON_EXAMPLE 个非演示工作区；禁止用演示重置脚本删除客户数据"
elif [ "$TABLE_STATE" != "absent" ]; then
  fail "无法识别目标数据库结构，拒绝重置"
fi

BACKUP_DIR="data/reset-backups"
BACKUP_PATH="$BACKUP_DIR/${DB_NAME}-$(date -u '+%Y%m%dT%H%M%SZ')-$$.dump"
mkdir -p "$BACKUP_DIR"
db_backup >"$BACKUP_PATH" || fail "重置前备份失败，未执行删除"
[ -s "$BACKUP_PATH" ] || fail "重置前备份为空，未执行删除"
echo "✅ 已生成重置前备份：$BACKUP_PATH"

db_query "BEGIN; DROP SCHEMA public CASCADE; CREATE SCHEMA public; COMMIT;" >/dev/null
echo "✅ schema 已重建"

pnpm db:migrate
pnpm db:seed
echo "== 重置完成：云栖酒店演示数据集（含「昨夜」夜班数据）已就绪 =="
