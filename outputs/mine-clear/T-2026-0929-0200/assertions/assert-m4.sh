#!/bin/bash
# MCD · M4 交付面断言集（每条 = 一个可运行的通过/失败信号）
# 用法：bash assert-m4.sh <MC-20x> [--repo DIR] [--base URL]
# 约定：exit 0 = 问题已修复（断言通过）；exit 1 = 问题仍存在（断言失败）
set -uo pipefail
CARD="${1:-}"; shift || true
REPO="${M4_REPO:-/Users/mac/WorkLoom-fleet/.wt-mcd-c}"
BASE="${M4_BASE:-http://127.0.0.1:8922}"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
done
ok()   { echo "PASS  $CARD :: $1"; exit 0; }
bad()  { echo "FAIL  $CARD :: $1"; exit 1; }
skip() { echo "SKIP  $CARD :: $1"; exit 2; }
cd "$REPO" || exit 2

case "$CARD" in
  MC-201)
    # 断言：三份客户文档里出现的安装包名，必须都能在发布产线的产物清单里找到
    DOC_ARTIFACTS="$(grep -rhoE 'WorkLoom-[A-Za-z0-9._-]+\.(zip|dmg|exe)' README.md docs/*.md 2>/dev/null | sort -u)"
    PIPE_ARTIFACTS="$(grep -oE 'WorkLoom-(mac|win)-[a-z0-9_]+\.(dmg|exe)' .github/workflows/desktop-production-release.yml 2>/dev/null | sort -u)"
    [ -n "$DOC_ARTIFACTS" ] || bad "未在文档中找到安装包名（断言失去意义）"
    MISSING="$(comm -23 <(printf '%s\n' "$DOC_ARTIFACTS") <(printf '%s\n' "$PIPE_ARTIFACTS"))"
    [ -z "$MISSING" ] && ok "文档产物名与产线一致：$(echo $DOC_ARTIFACTS | tr '\n' ' ')" \
      || bad "文档承诺的产物在产线不存在：$(echo $MISSING | tr '\n' ' ')"
    ;;
  MC-202)
    # 断言：事实源（CNB .cnb.yml）内存在桌面安装包的发布流水线
    grep -qE "desktop-production-release|electron-builder.*(dist|dmg|nsis)|pack-electron-payload" .cnb.yml \
      && ok "CNB 侧存在桌面发布流水线" \
      || bad "CNB(.cnb.yml) 无桌面发布流水线；安装包只能依赖 GitHub Actions"
    ;;
  MC-203)
    # 断言：发布门禁对「生产档运行时」有明确口径（可用生产身份通道，或显式声明不适用）
    grep -qE "NODE_ENV|production" scripts/release-gate.ts \
      && ok "release-gate 已含生产档口径" \
      || bad "release-gate 无生产档口径：生产实例上 G-01/A-01/A-02/Q-01/Q-02/T-02 恒失败，门禁结论与交付形态脱节"
    ;;
  MC-204)
    # 断言：E2E 套件拉起自有服务失败时必须 fail closed（端口冲突不可被静默当成"服务已就绪"）
    SRC=apps/server/src/service/e2e.test.ts
    if grep -qE "EADDRINUSE|端口.*占用|实例归属|health.*instance|child\.exitCode|stdio: *\[\"ignore\"" "$SRC"; then
      if grep -qE "EADDRINUSE|端口.*占用|实例归属" "$SRC"; then ok "E2E 已做端口/实例归属校验"; else bad "仍以 stdio:ignore 吞掉子进程失败，且只探 /health 200"; fi
    else
      bad "E2E 仅探测 /health 200，不校验实例归属；端口被占时会对外部实例断言（假红/假绿）"
    fi
    ;;
  MC-205)
    # 断言：套件的 stub 端口可通过环境变量覆盖
    grep -qE "process\.env\.(SUITE_)?STUB_PORT|STUB_PORT *= *Number\(process\.env" scripts/suite.ts \
      && ok "stub 端口可配置" \
      || bad "scripts/suite.ts 的 8791 硬编码不可配置，占用即 EADDRINUSE 崩"
    ;;
  MC-206)
    # 断言：500 响应体不得携带内部实现细节（表名/索引/约束/权限原文）
    if ! curl -sf -m 5 -o /dev/null "$BASE/health"; then bad "目标实例 $BASE 不可达（断言必须 fail-closed）"; fi
    BODY="$(node -e '
      const {execSync}=require("child_process");const pg=require("pg");const fs=require("fs");
      const env=Object.fromEntries(fs.readFileSync(".env","utf8").split("\n").filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1)]));
      const {createHmac}=require("crypto");
      const b64=(s)=>Buffer.from(s).toString("base64url");
      const c=new pg.Client({connectionString:process.env.M4_DB_URL||env.DATABASE_URL});
      (async()=>{await c.connect();
        const m=await c.query("SELECT m.id,m.member_no,m.name,m.role,w.tenant_id FROM members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.member_no=$2",["ws-yunqi","MEM-001"]);
        const r=m.rows[0];const now=Math.floor(Date.now()/1000);
        const head=b64(JSON.stringify({alg:"HS256",typ:"JWT"}));
        const claims=b64(JSON.stringify({kind:"member",memberId:r.id,memberNo:r.member_no,name:r.name,role:r.role,tenantId:r.tenant_id,workspaceId:"ws-yunqi",plan:"vpc",iss:"workloom-im",iat:now,exp:now+600}));
        const sig=createHmac("sha256",env.JWT_SECRET).update(head+"."+claims).digest("base64url");
        await c.query("REVOKE SELECT ON approvals FROM workloom_app");
        const res=await fetch(process.argv[1]+"/trpc/approvals.list?input="+encodeURIComponent(JSON.stringify({status:"pending"})),{headers:{authorization:"Bearer "+head+"."+claims+"."+sig}});
        const text=await res.text();
        await c.query("GRANT SELECT, INSERT, UPDATE, DELETE ON approvals TO workloom_app");
        await c.end();process.stdout.write(text);
      })().catch(e=>{process.stdout.write("ERR "+e.message);process.exit(9);});
    ' "$BASE" 2>/dev/null)"
    case "$BODY" in
      ERR*) skip "需要可写 DB 的本地实例（${BODY}）" ;;
    esac
    if printf '%s' "$BODY" | grep -qE "permission denied for table|duplicate key value violates unique constraint|relation \"|column \""; then
      bad "5xx 响应体回传了内部实现细节：$(printf '%s' "$BODY" | head -c 160)"
    else
      ok "5xx 响应体不含内部实现细节"
    fi
    ;;
  MC-207)
    # 断言：生产档（NODE_ENV=production）下匿名设备不得换取 C 端会话，且不得反射任意来源
    if ! curl -sf -m 5 -o /dev/null "$BASE/health"; then bad "目标实例 $BASE 不可达（断言必须 fail-closed，不得因连接失败假绿）"; fi
    RESP="$(curl -s -m 5 -o /tmp/m4-c207.json -w '%{http_code}' -X POST "$BASE/c/session" -H 'content-type: application/json' -H 'x-forwarded-for: 198.51.100.201' -d "{\"channel\":\"h5\",\"openid\":\"assert-$(date +%s)\"}")"
    ACAO="$(curl -s -m 5 -D - -o /dev/null -H 'Origin: http://evil.example' "$BASE/health" | grep -ci 'access-control-allow-origin: http://evil.example')"
    if [ "$RESP" = "200" ]; then bad "生产档仍可匿名签发 C 端会话（HTTP 200）"; fi
    if [ "$ACAO" != "0" ]; then bad "任意来源被反射进 ACAO"; fi
    ok "生产档匿名会话被拒（HTTP ${RESP}）且不反射任意来源"
    ;;
  MC-208)
    # 断言：桌面首启随机化的密钥集合必须覆盖 C 端会话密钥（不能全机共用出厂常量）
    grep -qE 'upsertEnvValue\(envText, *"SERVICE_C_SECRET"' apps/desktop/electron/bootstrap.cjs \
      && ok "首启随机化 SERVICE_C_SECRET" \
      || bad "首启只随机化 JWT_SECRET/PII_SALT；SERVICE_C_SECRET 保持出厂常量"
    ;;
  MC-209)
    # 断言：审批队列查询不得对 (workspace_id,status) 全集排序
    PLAN="$(PATH=/Users/mac/.local/pg17/bin:$PATH psql "${DATABASE_URL:-postgres://postgres:workloom@127.0.0.1:5432/wl_mcd_c}" -c "
      BEGIN; SELECT set_config('app.workspace_id','ws-yunqi',true);
      EXPLAIN SELECT a.approval_id, a.created_at, e.payload FROM approvals a
        LEFT JOIN biz_events e ON e.tenant_id=a.tenant_id AND e.event_id=a.event_id
       WHERE a.workspace_id='ws-yunqi' AND a.status='pending' ORDER BY a.created_at DESC LIMIT 50;
      ROLLBACK;" 2>&1)"
    if printf '%s' "$PLAN" | grep -qE 'Index Scan using .*approvals.*created_at'; then ok "队列排序走覆盖索引"; else
      ROWS="$(printf '%s' "$PLAN" | grep -oE 'Seq Scan on approvals.*rows=[0-9]+' | head -1)"
      bad "队列 ORDER BY 无覆盖索引，需全量排序（plan: ${ROWS:-未取到}）"
    fi
    ;;
  MC-210)
    # 断言：验链子进程的输出上限已显式放大（否则大批异常时门禁报 ENOBUFS 而非"链断"）
    grep -qE 'execSync\("pnpm db:verify-chain"[^)]*maxBuffer' scripts/release-gate.ts \
      && ok "验链调用已设 maxBuffer" \
      || bad "验链用 execSync 默认 1MB maxBuffer：账本大批异常时输出 160MB → 门禁以 ENOBUFS 失败"
    ;;
  *) echo "未知卡号 $CARD"; exit 2 ;;
esac
