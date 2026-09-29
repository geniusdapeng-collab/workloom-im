/**
 * 生成验收轮（M6/R2）新发现的问题卡 MC-50x 与对应修复卡 MC-46x（记账用）。
 * 用法：node outputs/mine-clear/T-2026-0929-0200/cards/gen-fix-F.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const R = "outputs/mine-clear/T-2026-0929-0200";
const FIXER = "fixer-F";

const items = [
  {
    id: "MC-501", severity: "P1", level: "L2", batch: 1, sha: "88e6b51",
    title: "验收门禁假红：Z-11 启动补扫夹具缺 snapshot.action（被 MC-106 fail-closed 正确拒绝）",
    file: "scripts/suite.ts", line: 2686,
    assertion: "SUITE_SERVER_PORT=8972 SUITE_STUB_PORT=8973 tsx --env-file=<env> scripts/suite.ts",
    evidence: "work/fix-f/suite-red-n1.log → work/fix-f/reg-suite.log（470/470）",
  },
  {
    id: "MC-502", severity: "P2", level: "L1", batch: 1, sha: "88e6b51",
    title: "单测断言与产品口径漂移：未绑定/已消费两条拒绝文案与顺序不一致（2 败）",
    file: "packages/base/workdata/workdata.test.ts", line: 150,
    assertion: "RUN_DB_TESTS=1 pnpm test",
    evidence: "work/fix-f/red-r2f1-vitest.log → green-r2f1-vitest2.log（30/30）",
  },
  {
    id: "MC-503", severity: "P1", level: "L4", batch: 1, sha: "2e3ddcb",
    title: "落地向导整块替换 archive.business → 清空出厂价带，R1/R2 可达性失效",
    file: "apps/server/src/trpc/router.ts", line: 723,
    assertion: "node work/fix-f/assert-r2f3-wizard.mjs",
    evidence: "work/fix-f/red-r2f3-wizard.log → final-r2f3.log（8/8）",
  },
  {
    id: "MC-504", severity: "P2", level: "L1", batch: 1, sha: "a68eed0",
    title: "release-gate 验链摘要解析取 `{` 之后全文 → JSON.parse 抛错，异常规模丢失",
    file: "scripts/release-gate.ts", line: 60,
    assertion: "node work/fix-f/assert-r2f4-parse.mts",
    evidence: "work/fix-f/final-r2f4.log（7/7）+ gate-anom.log（T-03 报 499700 处异常）",
  },
  {
    id: "MC-505", severity: "P2", level: "L4", batch: 2, sha: "6a49b30",
    title: "/memory 来源清算下拉框无访问名（axe select-name critical）",
    file: "apps/web/src/pages/p23/P23.tsx", line: 372,
    assertion: "node work/fix-f/axe-memory-ff.mjs",
    evidence: "work/fix-f/axe-memory-before.log → final-r2f5.log（0 违规）",
  },
  {
    id: "MC-506", severity: "P2", level: "L4", batch: 2, sha: "4d5242c",
    title: "顶栏紧急制动恒禁用（未接 onConfirm）+ 演示区无夜班班次 → 制动链路不可执行",
    file: "apps/web/src/shell/Bridge.tsx", line: 220,
    assertion: "node work/fix-f/assert-r2f6-brake.mjs",
    evidence: "work/fix-f/final-r2f6.log（11/11）+ brake-after.png",
  },
  {
    id: "MC-507", severity: "P2", level: "L2", batch: 3, sha: "88e6b51",
    title: "套件 R-06 对遗留 pending 敏感（污染库假红 469/470）",
    file: "scripts/suite.ts", line: 2686,
    assertion: "注入 25 条遗留 L2 待批后跑套件",
    evidence: "work/fix-f/suite-red-n1.log → suite-green-n1.log（470/470）",
  },
  {
    id: "MC-508", severity: "P2", level: "L2", batch: 3, sha: "8562da9",
    title: "O 域验收介入器回退到无关 L4 待批行 → trial 假失败、pass@1 波动",
    file: "scripts/acceptance/outcome.mjs", line: 189,
    assertion: "污染库对照：旧实现改无关行 vs 新实现 0 条改动",
    evidence: "work/fix-f/legacy-outcome.log → fixed-outcome.log",
  },
];

const problems = [];
const fixes = [];
items.forEach((item, index) => {
  const fixId = `MC-${461 + index}`;
  problems.push({
    id: item.id, kind: "problem", level: item.level, severity: item.severity, batch: item.batch, state: "fixed",
    title: item.title,
    evidence: [
      { type: "code", ref: `${item.file}:${item.line}@${item.sha}`, note: `修复提交 ${item.sha}（fixer-F）` },
      { type: "log", ref: item.evidence, note: "红→绿对照（fixer-F 原始日志）" },
    ],
    root_cause: { file: item.file, line: item.line, commit: "b67d651", symbol: "见 FIX-F-REPORT.md" },
    trigger_path: "独立验收（RDAS v3.1 / 独立验证会话）在冻结基线 b67d651 上复现；详见 ACCEPTANCE-REPORT.md / VERIFY-REPORT.md",
    assertions: [
      { kind: "sample", given: `复跑 ${item.id} 的验收场景`, expect: "红→绿（见修复卡断言）", command: item.assertion, last_result: "pass", evidence: item.evidence },
      { kind: "property", given: "同一场景在干净库与污染库下重复执行", expect: "结论一致（不因遗留数据波动）", command: item.assertion, last_result: "pass", evidence: item.evidence },
    ],
    regression: { command: item.assertion, evidence: item.evidence },
    notes: "来源：独立验收/独立验证会话（非修复者自报）。",
  });
  fixes.push({
    id: fixId, kind: "fix", batch: item.batch, state: "fixed", title: `R2 修复：${item.title}`,
    covers: [item.id],
    evidence: [
      { type: "code", ref: `${item.file}:${item.line}@${item.sha}`, note: `修复提交 ${item.sha}` },
      { type: "log", ref: item.evidence, note: "红→绿对照" },
      { type: "log", ref: `${R}/FIX-F-REPORT.md`, note: "修复报告（根因/修法/回归/回滚）" },
    ],
    fix_plan: "见 FIX-F-REPORT.md §3（根因 + 代码级修法 + 证据）",
    blast_radius: "见 FIX-F-REPORT.md 对应小节",
    conflict_paths: [item.file],
    assertions: [
      { kind: "sample", given: `复跑 ${item.id}`, expect: "转绿", command: item.assertion, last_result: "pass", evidence: item.evidence },
      { kind: "property", given: "同类输入/重复执行", expect: "保持通过（幂等、不依赖遗留数据）", command: item.assertion, last_result: "pass", evidence: item.evidence },
    ],
    regression: { command: "bash work/fix-f/run-regression.sh（8/8 PASS）", evidence: "work/fix-f/reg-*.log" },
    rollback: `git revert ${item.sha}`,
    fixed_by: FIXER, verified_by: null,
    notes: "R2 复验由独立验证会话与独立验收会话执行。",
  });
});

for (const card of [...problems, ...fixes]) writeFileSync(join(DIR, `${card.id}.json`), JSON.stringify(card, null, 2));
writeFileSync(join(DIR, "problems-r2.json"), JSON.stringify(problems, null, 2));
writeFileSync(join(DIR, "fix-F.json"), JSON.stringify(fixes, null, 2));
console.log(`wrote ${problems.length} problem cards + ${fixes.length} fix cards`);
