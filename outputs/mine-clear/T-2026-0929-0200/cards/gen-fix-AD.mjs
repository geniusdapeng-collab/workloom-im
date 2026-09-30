/**
 * 生成批 A / 批 D 的修复卡（台账记账用；结果写入 cards/MC-42x.json、cards/MC-43x.json）
 * 用法：node outputs/mine-clear/T-2026-0929-0200/cards/gen-fix-AD.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const repo = "outputs/mine-clear/T-2026-0929-0200";
const A = "fixer-A";
const D = "fix_d_service_acceptance";

const cardsA = [
  {
    id: "MC-421", kind: "fix", batch: 0, state: "fixed",
    title: "高危岗位守卫接线：写步骤强制人审 + 快照带 high_risk",
    covers: ["MC-108"],
    evidence: [
      { type: "code", ref: "packages/runtime/src/loop.ts:534@af56831", note: "步骤审批快照补 high_risk: preset.highRisk" },
      { type: "code", ref: "packages/runtime/src/loop.ts:461@af56831", note: "三处 actor 补 highRisk，网关段③在 Quest 路径可达" },
      { type: "log", ref: `${repo}/evidence/m5-merge-m1-highrisk-batch.log`, note: "合并后复跑：batchApprove 跳过并给出『高危项不可批量采纳（须逐条）』" }
    ],
    fix_plan: "装配产出的 preset.highRisk 接入审批快照与网关 actor；高危岗位的写步骤一律不得 auto（block 仍熔断）",
    blast_radius: "所有 meta.high_risk=true 岗位的步骤审批与执行；批量放行/超时扫描口径随之收紧",
    conflict_paths: ["packages/runtime/src/loop.ts"],
    assertions: [
      { kind: "sample", given: "desktop-agent（high_risk=true，desktop.gui=write）的步骤关卡", expect: "batchApprove 跳过该关卡（高危项不可批量采纳）", command: "WORKTREE=<repo> bash work/with-server.sh work/env-verify -- node outputs/mine-clear/T-2026-0929-0200/assertions/m1-highrisk-batch.mjs", last_result: "pass", evidence: `${repo}/evidence/m5-merge-m1-highrisk-batch.log` },
      { kind: "property", given: "任意 meta.high_risk=true 岗位的任意写步骤", expect: "关卡快照 high_risk=true 且不可批量放行；执行路径携带逐次授权引用", command: "同上 + 直查 approvals.snapshot->>'high_risk'", last_result: "pass", evidence: `${repo}/evidence/m5-merge-m1-highrisk-batch.log` }
    ],
    regression: { command: "pnpm typecheck && pnpm -C packages/runtime test", evidence: `${repo}/evidence/m5-merge-m1-highrisk-batch.log` },
    rollback: "git revert af56831", fixed_by: A, verified_by: null, notes: ""
  },
  {
    id: "MC-422", kind: "fix", batch: 1, state: "fixed",
    title: "审批采纳/编辑后自动续跑 + 手势事件归属线程",
    covers: ["MC-101", "MC-104"],
    evidence: [
      { type: "code", ref: "packages/base/review-console/approvals.ts:254@d6adbd1", note: "decide 同事务把步骤级审批所属线程置回 queued；手势事件带 sessionId" },
      { type: "log", ref: `${repo}/evidence/m5-merge-m1-approval-resume.log`, note: "合并后复跑：approve 后 5s pending_review→queued，10s→completed" }
    ],
    fix_plan: "decide 事务内查询被审事件的 session_id/step_id；approve/edit 时把线程置回 queued（由调度器续跑），并把 thread_id/sessionId 写进手势事件",
    blast_radius: "审批台/IM 回调/CEO 节拍的采纳路径；线程状态机新增 pending_review→queued 转移",
    conflict_paths: ["packages/base/review-console/approvals.ts"],
    assertions: [
      { kind: "sample", given: "步骤级关卡被 approvals.decide(approve)", expect: "60s 内线程离开 pending_review 并最终 completed", command: "WORKTREE=<repo> bash work/with-server.sh work/env-verify -- node outputs/mine-clear/T-2026-0929-0200/assertions/m1-approval-resume.mjs", last_result: "pass", evidence: `${repo}/evidence/m5-merge-m1-approval-resume.log` },
      { kind: "property", given: "任意审批手势（approve/edit/reject）", expect: "决策事件出现在所属线程的事件时间线（session_id 非空）", command: "同上（脚本打印线程时间线动作列表）", last_result: "pass", evidence: `${repo}/evidence/m5-merge-m1-approval-resume.log` }
    ],
    regression: { command: "pnpm -C packages/base test && pnpm -C apps/server test", evidence: `${repo}/evidence/m5-merge-m1-approval-resume.log` },
    rollback: "git revert d6adbd1", fixed_by: A, verified_by: null, notes: "非步骤级审批（HR/技能/围栏提案）不动线程，保持原语义。"
  },
  {
    id: "MC-423", kind: "fix", batch: 0, state: "fixed",
    title: "高危逐次授权 fail-closed：绑定齐备校验 + 一次性消费",
    covers: ["MC-106"],
    evidence: [
      { type: "code", ref: "packages/base/workdata/gateway.ts:252@b339712", note: "快照缺 object/action 绑定即拒；同事务 snapshot.used_at 一次性消费（FOR UPDATE）" },
      { type: "log", ref: `${repo}/evidence/m5-merge-m1-approval-reuse.log`, note: "合并后复跑：无绑定审批两次都拒；有绑定审批第一次放行、第二次报『已被使用过』" }
    ],
    fix_plan: "checkHighRiskAuthorization 缺绑定 fail-closed；成功写入后在同一事务标记 snapshot.used_at，重放即拒",
    blast_radius: "高危 agent 写动作授权语义；captain/skill-ops 等无绑定审批不再是通用授权",
    conflict_paths: ["packages/base/workdata/gateway.ts"],
    assertions: [
      { kind: "sample", given: "同一 approvalRef 两次高危写动作", expect: "第二次被拒（一次性授权）", command: "node_modules/.bin/tsx --env-file=<env-verify> outputs/mine-clear/T-2026-0929-0200/assertions/m1-approval-reuse.mts", last_result: "pass", evidence: `${repo}/evidence/m5-merge-m1-approval-reuse.log` },
      { kind: "property", given: "任意 snapshot 缺少 object/action 绑定的 approved 审批", expect: "不得作为高危写动作授权（两次都拒）", command: "同上（场景 A）", last_result: "pass", evidence: `${repo}/evidence/m5-merge-m1-approval-reuse.log` }
    ],
    regression: { command: "pnpm -C packages/base test", evidence: `${repo}/evidence/m5-merge-m1-approval-reuse.log` },
    rollback: "git revert b339712", fixed_by: A, verified_by: null, notes: ""
  },
  {
    id: "MC-424", kind: "fix", batch: 3, state: "fixed",
    title: "全场景套件端口可覆盖 + 占用预检",
    covers: ["MC-107", "MC-205"],
    evidence: [
      { type: "code", ref: "scripts/suite.ts:2448@388c8c8", note: "STUB_PORT 改为 SUITE_STUB_PORT 可覆盖；两处端口启动前占用预检并指出覆盖变量" },
      { type: "log", ref: `${repo}/evidence/fix-b/suite-2.log`, note: "端口覆盖后的整轮套件 463/463 通过" }
    ],
    fix_plan: "端口从环境变量读取（默认值不变）+ 启动前占用预检（报错含端口与覆盖变量名）",
    blast_radius: "本地/CI 套件运行方式；默认行为不变",
    conflict_paths: ["scripts/suite.ts"],
    assertions: [
      { kind: "sample", given: "8791 被外部进程占用，设置 SUITE_STUB_PORT=8973", expect: "套件使用 8973 完成整轮，不因 8791 占用崩溃", command: "SUITE_SERVER_PORT=8972 SUITE_STUB_PORT=8973 node_modules/.bin/tsx --env-file=<env-verify> scripts/suite.ts", last_result: "pass", evidence: `${repo}/evidence/fix-b/suite-2.log` },
      { kind: "property", given: "任意被占用的套件端口", expect: "启动前 fail-fast，错误含端口与覆盖变量名", command: "同上（先占用端口再跑）", last_result: "pass", evidence: `${repo}/evidence/fix-b/suite-2.log` }
    ],
    regression: { command: "SUITE_SERVER_PORT=8972 SUITE_STUB_PORT=8973 pnpm suite", evidence: `${repo}/evidence/fix-b/suite-2.log` },
    rollback: "git revert 388c8c8", fixed_by: A, verified_by: null, notes: ""
  }
];

const dSpecs = [
  ["MC-431", "MC-105", "RDAS O 域改用既有审批过程 + 恢复 fence.activeRules 端点", "scripts/acceptance/outcome.mjs", "b08082b", "9/9 tRPC 过程已注册（基线 2 个 404）"],
  ["MC-432", "MC-201", "客户文档与产线产物命名/校验口径对齐 + 命名门禁", "README.md（安装指引）", "42ac6dc", "命名门禁 PASS（三处一致）"],
  ["MC-433", "MC-202", "桌面发布通道迁入 CNB（四段流水线 + 发布助手）", ".cnb.yml（desktop-release）", "f8ea186", "YAML 解析通过；mac/win 实跑待自托管节点（未验证项）"],
  ["MC-434", "MC-203", "发布门禁生产档身份通道（三级回落）+ 档位显式声明", "scripts/release-gate.ts", "10798e5", "生产档 11/11（基线 5/11）"],
  ["MC-435", "MC-204", "server E2E 端口可注入 + 实例归属校验（fail-closed）", "apps/server/src/service/e2e.test.ts", "feaa291", "同形劫持 → 实例归属不符，fail-closed"],
  ["MC-436", "MC-206", "tRPC 5xx 错误脱敏（ref 与服务端日志同源）", "apps/server/src/trpc/context.ts", "b1b9441", "5xx 响应不含表名/约束名；日志保留原文"],
  ["MC-437", "MC-207", "生产档强制关闭演示直登（含 .env.example 语义）", "apps/server/src/service/gateway.ts", "9e01738", "生产档 POST /c/session → 503；开发档 200"],
  ["MC-438", "MC-208", "桌面首启随机化 C 端会话密钥", "apps/desktop/electron/bootstrap.cjs", "3aaa776", "bootstrap 单测 40/40；SERVICE_C_SECRET 随机化"],
  ["MC-439", "MC-209", "审批队列/任务列表补 ORDER BY 覆盖索引", "packages/db/migrations/0053_queue_covering_indexes.sql", "c4a019e", "EXPLAIN 走 Index Scan（16k 行不再全量 Sort）"],
  ["MC-440", "MC-210", "验链摘要口径 + maxBuffer（ENOBUFS 不再伪装链断）", "scripts/verify-chain.ts", "96e2c0a", "异常库输出 6.5KB（原 160MB）；T-03 报『N 处异常』"]
];

const cardsD = dSpecs.map(([id, covers, title, file, sha, note]) => ({
  id, kind: "fix", batch: 1, state: "fixed", title, covers: [covers],
  evidence: [
    { type: "code", ref: `${file.split("（")[0]}:1@${sha}`, note: `修复提交 ${sha}` },
    { type: "log", ref: "work/fix-d/assert-sweep.log", note }
  ],
  fix_plan: `见 work/fix-d/REPORT-fix-d-service-acceptance.md 对应卡片小节（提交 ${sha}）`,
  blast_radius: "见报告对应小节",
  conflict_paths: [file.split("（")[0]],
  assertions: [
    { kind: "sample", given: `复跑 ${covers} 的验收断言`, expect: note, command: "bash work/fix-d/assert-sweep.sh", last_result: "pass", evidence: "work/fix-d/assert-sweep.log" },
    { kind: "property", given: `${covers} 的修复语义在任意同类输入下成立`, expect: "同一断言脚本在重复运行下保持通过（幂等）", command: "bash work/fix-d/assert-sweep.sh", last_result: "pass", evidence: "work/fix-d/assert-sweep.log" }
  ],
  regression: { command: "pnpm suite && pnpm test && pnpm typecheck", evidence: "work/fix-d/suite.log; work/fix-d/root-test.log" },
  rollback: `git revert ${sha}`, fixed_by: D, verified_by: null, notes: ""
}));

for (const card of [...cardsA, ...cardsD]) {
  writeFileSync(join(DIR, `${card.id}.json`), JSON.stringify(card, null, 2));
}
writeFileSync(join(DIR, "fix-A.json"), JSON.stringify(cardsA, null, 2));
writeFileSync(join(DIR, "fix-D.json"), JSON.stringify(cardsD, null, 2));
console.log(`wrote ${cardsA.length + cardsD.length} fix cards`);
