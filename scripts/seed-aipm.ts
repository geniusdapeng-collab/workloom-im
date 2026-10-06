/**
 * seed-aipm · AI 产品经理行业示例包种子（方案 V4 §12/P0）
 * 用法：DATABASE_URL=... tsx scripts/seed-aipm.ts
 * 内容：demo 租户 / 「织元产品部」工作区（is_example=true）/ 3 人类成员 /
 *      ai-pm 14 preset 实例（产品总监领队，V3 产品经理负责制）/ R-PM1-14 基线围栏 / 20 技能安装 /
 *      业务种子（需求池/竞档/指标/反馈/文档/评测中心/prompt版本库/失败案例库进知识库）/ 审批样例 / 晨报 /
 *      夜班编排 / bundle_installs 装配台账登记（一键清空依据）
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import YAML from "yaml";
import {
  appendEventIdempotent,
  gatewayAppendOnClient,
  reconcileEventStorageSequenceForSeed,
} from "@workloom/base/workdata";
import {
  bundleEvalQuestionId,
  loadVerifiedBundleManifest,
  loadVerifiedBundleEvalQuestions,
  loadVerifiedBundleWorkforcePresets,
} from "@workloom/base/bundles";
import { loadFencePack } from "@workloom/base/fence-engine";

import { fileURLToPath } from "node:url";
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/ai-pm");
const BUNDLE_MANIFEST = loadVerifiedBundleManifest("ai-pm", join(REPO_ROOT, "bundles"));
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL = process.env.DATABASE_GATEWAY_URL
  ?? "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

const TENANT_ID = "demo";
const WS_ID = "ws-aipm-demo";
const WS_SLUG = "ai-pm-demo";
const WS_NAME = "织元产品部（AI 产品经理示例团队）";

interface FenceRule {
  rule_id: string; name: string; level: string; is_baseline?: boolean;
  match: Record<string, unknown>; when?: string | Record<string, unknown>; note?: string;
}
interface SkillDoc { name: string; description: string; body: string; fenceBindings: string[] }

/**
 * HP-02：围栏包读取统一走 fence-engine 的 DSL 装载器（`rules ?? fences` 双形态 + zod 校验）。
 * 修复点：此前本脚本自己判 `fences ?? rules`，且入库时把 is_baseline 写死为 false ——
 * ai-pm 的 14 条基线规则因此全部失去"只可加严"保护。
 */
function loadFences(): FenceRule[] {
  return BUNDLE_MANIFEST.workloom.provides.fences.flatMap((assetPath) =>
    loadFencePack(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8")).rules
      .map((r) => ({
        rule_id: r.rule_id, name: r.name, level: r.level, is_baseline: r.is_baseline,
        match: { object_types: r.objectTypes, actions: r.actions }, when: r.when,
      })));
}
function loadSkills(): SkillDoc[] {
  return BUNDLE_MANIFEST.workloom.provides.skills.map((assetPath) => {
    const directoryName = assetPath.split("/").at(-2) ?? assetPath;
    const raw = readFileSync(join(BUNDLE_DIR, assetPath), "utf-8");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    const fm = m ? (YAML.parse(m[1]!) as { name: string; description: string }) : { name: directoryName, description: "" };
    return { name: fm.name, description: fm.description, body: raw, fenceBindings: [] };
  });
}
function loadSeed<T>(file: string): T {
  const assetPath = BUNDLE_MANIFEST.workloom.provides.seeds.find((path) => path.split("/").at(-1) === file);
  if (!assetPath) throw new Error(`AI 产品经理行业包未声明种子资产：${file}`);
  return JSON.parse(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8")) as T;
}

const MEMBERS = [
  { id: "MEM-001", name: "老板", role: "owner" },
  { id: "MEM-002", name: "产品负责人", role: "manager" },
  { id: "MEM-003", name: "运营同学", role: "readonly" },
];

export async function seedAiPm(): Promise<void> {
  // 清单、摘要/签名与题集 Schema 必须在建立数据库连接前全部通过。
  const evalPack = loadVerifiedBundleEvalQuestions("ai-pm", join(REPO_ROOT, "bundles"));
  const presets = loadVerifiedBundleWorkforcePresets("ai-pm", join(REPO_ROOT, "bundles"));
  const fences = loadFences();
  const skillsDocs = loadSkills();
  console.log(`✓ ai-pm Bundle 资产：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能`);

  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  const q = (text: string, params: unknown[]) => owner.query(text, params);
  const sequenceState = await reconcileEventStorageSequenceForSeed(owner);
  if (sequenceState.repaired) {
    console.log(`✓ 事件账本物理序列已从 ${sequenceState.nextBefore} 向前校准到 ${sequenceState.nextAfter}`);
  }

  await q(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`, [TENANT_ID, "织元演示租户"]);
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config, bundle_id, is_example)
     VALUES ($1,$2,$3,$4,'ai-pm','stable',$5,'ai-pm',true) ON CONFLICT (id) DO UPDATE SET bundle_id='ai-pm', is_example=true`,
    [WS_ID, TENANT_ID, WS_NAME, WS_SLUG, JSON.stringify({ enabled: true, candidateTime: "18:00", startTime: "22:00", packageTime: "08:30", timezone: "Asia/Shanghai" })],
  );
  console.log(`✓ 租户与工作区：demo / ${WS_NAME}（is_example=true）`);

  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-${WS_ID}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}`);

  /**
   * MC-113：ai-pm 示例团队同样要挂全局账号——P28 统一待办按 `members.account_id` 聚合，
   * 缺账号时出厂演示工作区恒空（M3 实测 groups:[]）。命名空间与酒店种子隔离（1390000200x）。
   */
  for (const m of MEMBERS) {
    const accountId = `acc-demo-aipm-${m.id.toLowerCase()}`;
    await q(
      `INSERT INTO accounts (id, phone, email, display_name, status)
       VALUES ($1,$2,$3,$4,'active')
       ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
      [accountId, `1390000200${m.id.slice(-1)}`, `${m.id.toLowerCase()}-aipm@demo.workloom.local`, m.name],
    );
    await q(
      `UPDATE members SET account_id=$1
        WHERE workspace_id=$2 AND member_no=$3 AND account_id IS DISTINCT FROM $1`,
      [accountId, WS_ID, m.id],
    );
  }
  console.log(`✓ 演示账号 ×${MEMBERS.length}（P28 统一待办数据源）`);

  for (const p of presets) {
    await q(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)
       ON CONFLICT (id) DO NOTHING`,
      [`agt-${p.preset_key}`, WS_ID, p.preset_key, p.name, p.version, p.kind, p.readonly,
       JSON.stringify(p.fence_bindings), JSON.stringify(p.skills),
       JSON.stringify({
         description: p.description,
         night_shift: p.night_shift,
         high_risk: p.high_risk,
         coverage: p.coverage,
         tools: p.tools,
         prompt: p.prompt,
       })],
    );
  }
  console.log(`✓ Agent 实例 ×${presets.length}（产品总监领队的 AI 产品研发团队）`);

  /**
   * MC-040：数字 CEO 是基座公共岗位（CEO Loop 节拍），不由行业 Bundle 声明；
   * 名册缺行会让 ceo.* 写动作被 F2.10 拒绝。这里与酒店种子同口径地补齐 CEO 岗位事实。
   */
  await q(
    `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
     VALUES ('agt-company-ceo',$1,'company-ceo','顾云峥','v1.0','commander',false,'["R1","R2"]','[]','ready',$2)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, JSON.stringify({ description: "公司负责人：主持经营晨报与 L2 裁决节拍", night_shift: false, high_risk: false })],
  );
  console.log("✓ 数字 CEO 岗位入册（company-ceo，绑定基线围栏 R1/R2）");

  // 示例团队也必须具备可运行的「档案 + 阶段 + 目标」三要素，不能出现首页看似
  // 就绪、首个任务却因缺档案被拒绝的断点。档案内容来自 ai-pm Bundle 种子，
  // 并明确标记为模拟数据；宪章仅为 shadow，允许演示推理与简报留痕但不执行
  // 真实外部动作。若用户已通过向导建立档案，重跑种子绝不覆盖其真实配置。
  const profileSeed = loadSeed<{ archive: Record<string, unknown>; forbidden: string[] }>("profile.json");
  await q(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,'ai-pm',$3,$4,NULL)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [WS_ID, TENANT_ID, JSON.stringify(profileSeed.archive), JSON.stringify(profileSeed.forbidden)],
  );

  // Bundle 专属存量迁移：仅处理本 Bundle 自带、仍明确标记为 simulated 的示例档案。
  // 真实用户档案继续由发布门禁拦截并要求所属行业包显式迁移；基座不会猜测其行业字段。
  const nextAutonomy = (profileSeed.archive.charter as { autonomy: unknown }).autonomy;
  await owner.query("BEGIN");
  try {
    await owner.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);
    await owner.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
    const migrated = await owner.query(
      `UPDATE profiles p
          SET archive = jsonb_set(p.archive, '{charter,autonomy}', $3::jsonb, true),
              updated_at = now()
         FROM workspaces w
        WHERE p.workspace_id=$1 AND p.tenant_id=$2
          AND w.id=p.workspace_id AND w.tenant_id=p.tenant_id
          AND w.bundle_id='ai-pm' AND w.is_example=true
          AND p.industry='ai-pm' AND p.archive->>'dataMode'='simulated'
          AND NOT (
            (p.archive #> '{charter,autonomy}') ? 'ranges'
            AND (p.archive #> '{charter,autonomy}') ? 'caps'
          )
        RETURNING p.workspace_id`,
      [WS_ID, TENANT_ID, JSON.stringify(nextAutonomy)],
    );
    if ((migrated.rowCount ?? 0) > 0) {
      await gatewayAppendOnClient(owner as unknown as pg.PoolClient, {
        tenantId: TENANT_ID,
        workspaceId: WS_ID,
        actor: { id: "system", type: "system" },
      }, {
        who: { type: "system", id: "system", version: "ai-pm-bundle/v3" },
        context: { tenant_id: TENANT_ID, workspace_id: WS_ID, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "bundle_migration", id: "ai-pm-charter-autonomy-v1" },
        decision: {
          action: "bundle.profile.migrate",
          after: { bundle: "ai-pm", contract: "autonomy-ranges-caps/v1" },
          basis: ["AI 产品经理示例 Bundle 的旧自治字段已迁移为通用 ranges/caps 契约"],
        },
        rule_impact: [],
      });
      console.log("✓ AI 产品经理示例档案迁移：旧自治字段 → ranges/caps（事件账本已留痕）");
    }
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  console.log("✓ 示例团队档案（模拟数据；影子模式不执行真实外部动作）");

  for (const r of fences) {
    await q(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,'v1',$3,$4,$5,$6,$7,$8,'active','system:seed')
       ON CONFLICT (rule_id, version, workspace_id) DO UPDATE
         SET is_baseline=EXCLUDED.is_baseline, match_spec=EXCLUDED.match_spec,
             level=EXCLUDED.level, name=EXCLUDED.name`,
      [`fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`, r.rule_id, WS_ID, r.name, r.level,
       JSON.stringify({ ...r.match, when: typeof r.when === "string" ? r.when : "" }),
       JSON.stringify({ result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked" }),
       r.is_baseline !== false],
    );
  }
  console.log(`✓ 基线围栏 ×${fences.length}（active）`);

  for (const s of skillsDocs) {
    const skillId = `skill-${s.name}`;
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official','ai-pm',$2,'1.0.0',$3,'[]',$4,false)
       ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body, version=EXCLUDED.version
       WHERE skills.version IS DISTINCT FROM EXCLUDED.version`,
      [skillId, s.name, s.description, s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       SELECT s.id, $2, 'MEM-001', s.fence_bindings, s.version FROM skills s WHERE s.id=$1
       ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 技能 ×${skillsDocs.length} 已安装`);

  // —— 业务种子进知识库（需求池/竞档/指标/反馈/文档） ——
  const colDefs: Array<{ name: string; desc: string; file: string; titleOf: (x: Record<string, unknown>, i: number) => string; items: (d: unknown) => Array<Record<string, unknown>> }> = [
    { name: "需求池", desc: "产品需求分诊台账", file: "requirements.json",
      items: (d) => (d as { items: Array<Record<string, unknown>> }).items,
      titleOf: (x) => `${x.id} ${x.title}` },
    { name: "竞品档案", desc: "竞品追踪与对比报告", file: "competitors.json",
      items: (d) => (d as { competitors: Array<Record<string, unknown>> }).competitors,
      titleOf: (x) => `${x.name}（${x.track}）威胁:${x.threat}` },
    { name: "用户反馈", desc: "反馈聚类与情绪", file: "feedback.json",
      items: (d) => (d as { items: Array<Record<string, unknown>> }).items,
      titleOf: (x) => `${x.id} [${x.type}] ${x.text}` },
    { name: "产出档案", desc: "PRD/报告/发布说明", file: "documents.json",
      items: (d) => (d as { documents: Array<Record<string, unknown>> }).documents,
      titleOf: (x) => `${x.title}` },
    // —— V3 新增：模型侧资产种子 ——
    { name: "评测中心", desc: "eval 集与回归跑分台账", file: "eval-sets.json",
      items: (d) => (d as { eval_sets: Array<Record<string, unknown>> }).eval_sets,
      titleOf: (x) => `${x.id} ${x.name}（${x.cases}案例）` },
    { name: "prompt版本库", desc: "生产 prompt 版本与回归记录", file: "prompts.json",
      items: (d) => (d as { prompts: Array<Record<string, unknown>> }).prompts,
      titleOf: (x) => `${x.id} ${x.name}（当前 ${x.current_version}）` },
    { name: "失败案例库", desc: "badcase 回流与归因", file: "badcases.json",
      items: (d) => (d as { badcases: Array<Record<string, unknown>> }).badcases,
      titleOf: (x) => `${x.id} ${x.summary}` },
  ];
  for (const col of colDefs) {
    const colId = `kc-${WS_ID}-${col.name}`;
    await q(
      `INSERT INTO kb_collections (id, workspace_id, name, description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [colId, WS_ID, col.name, col.desc],
    );
    const data = loadSeed<unknown>(col.file);
    const items = col.items(data);
    for (const [i, item] of items.entries()) {
      const title = col.titleOf(item, i);
      await q(
        `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
         VALUES ($1,$2,$3,$4,'manual',NULL,1,'active',$5,$6,now())
         ON CONFLICT (id) DO NOTHING`,
        [`kd-${WS_ID}-${col.name}-${i}`, WS_ID, colId, title, JSON.stringify(item, null, 1), `seedhash-${col.name}-${i}`],
      );
    }
    console.log(`✓ 知识集「${col.name}」×${items.length}`);
  }

  // —— 审批样例（方案 §12 approvals.json） ——
  const approvals = loadSeed<{ items: Array<{ title: string; from: string; kind: string }> }>("approvals.json");
  const gateway = new pg.Pool({ connectionString: GATEWAY_URL, max: 1 });
  try {
    for (const [i, a] of approvals.items.entries()) {
      const approvalId = `apr-seed-aipm-${i}`;
      const evId = `E-SEED-AIPM-APR-${i}`;
      const eventTime = new Date(Date.UTC(2026, 7, 16, 9, i)).toISOString();
      await appendEventIdempotent(gateway, { tenantId: TENANT_ID, workspaceId: WS_ID }, {
        event_id: evId,
        who: { type: "agent", id: a.from, version: "seed/v1" },
        context: { tenant_id: TENANT_ID, workspace_id: WS_ID, time: eventTime, channel: "inapp" },
        object: { type: "approval", id: approvalId },
        decision: { action: a.kind, after: { title: a.title } },
        rule_impact: [{
          rule_id: a.kind === "reply-draft" ? "R-PM5" : "R-PM1",
          version: "v1",
          result: "review",
        }],
      } as never);
      await q(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, gesture, snapshot, decided_by, decided_at)
         VALUES ($1,$2,$3,$4,'inapp','pending',NULL,$5,NULL,NULL)
         ON CONFLICT (approval_id) DO NOTHING`,
        [approvalId, TENANT_ID, WS_ID, evId,
         JSON.stringify({
           action: a.kind,
           title: a.title,
           after: { title: a.title },
           expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
         })],
      );
    }
  } finally {
    await gateway.end();
  }
  console.log(`✓ 审批样例 ×${approvals.items.length}（pending）`);

  // 晨报由夜班节拍运行时真实生成（night-shift/captain，系统无静态晨报表）——不在种子内伪造
  console.log("✓ 晨报：运行时夜班生成（种子不伪造）");

  // Bundle 声明的夜班任务必须真正进入公共触发器表，不能只停留在介绍 JSON。
  const nightJobs = loadSeed<{ jobs: Array<{ time: string; task: string; owner: string }> }>("night-jobs.json");
  for (const [index, job] of nightJobs.jobs.entries()) {
    const match = /^(\d{2}):(\d{2})$/.exec(job.time);
    if (!match) throw new Error(`night-jobs.json 时间格式无效：${job.time}`);
    const schedule = `${Number(match[2])} ${Number(match[1])} * * *`;
    await q(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,'cron',$4,$5,true,'system:seed-aipm')
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, schedule=EXCLUDED.schedule,
         action=EXCLUDED.action, enabled=true, updated_at=now()`,
      [`tg-aipm-night-${index}`, WS_ID, job.task, schedule,
       JSON.stringify({ dispatch: job.owner, template: "night.bundle-job", task: job.task })],
    );
  }
  await q(
    `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
     VALUES ('tg-aipm-brief-0830',$1,'每日运行简报','cron','30 8 * * *',$2,true,'system:seed-aipm')
     ON CONFLICT (id) DO UPDATE SET action=EXCLUDED.action, enabled=true, updated_at=now()`,
    [WS_ID, JSON.stringify({ beat: "daily" })],
  );
  console.log(`✓ 自动化触发器 ×${nightJobs.jobs.length + 1}（Bundle 夜班任务 + 每日运行简报）`);

  // —— 行业考题：只消费已验证 Bundle 声明的题集 ——
  for (const [i, qu] of evalPack.questions.entries()) {
    await q(
      `INSERT INTO eval_questions
         (id, workspace_id, subject, structure, primary_dimensions, red_line, difficulty, source, tags, scenario, assertions, judge_rubric, holdout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        bundleEvalQuestionId(WS_ID, evalPack.bundleId, i, qu), WS_ID, qu.subject, qu.structure,
        JSON.stringify(qu.primaryDimensions), qu.redLine, qu.difficulty, qu.source,
        JSON.stringify(qu.tags), JSON.stringify(qu.scenario),
        JSON.stringify(qu.assertions), qu.judgeRubric ? JSON.stringify(qu.judgeRubric) : null,
        qu.holdout ?? false,
      ],
    );
  }
  // 早期种子题使用全局固定题号，升级后保留历史答卷引用但退出抽题池；新题号
  // 绑定工作区与题面摘要，避免跨租户主键冲突。只退休本演示工作区的保留前缀。
  await q(
    `UPDATE eval_questions SET status='retired'
     WHERE workspace_id=$1 AND id LIKE 'evq-aipm-seed-%' AND status='active'`,
    [WS_ID],
  );
  console.log(`✓ 行业考题 ×${evalPack.questions.length}（已验证 Bundle）`);

  // —— bundle_installs 装配台账（一键清空的精确卸载依据，方案 V4 §3） ——
  await q(
    `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status)
     VALUES ($1,$2,'ai-pm',$3,'active')
     ON CONFLICT (id) DO NOTHING`,
    [`bi-${WS_ID}-ai-pm`, WS_ID,
     JSON.stringify({
       preset_ids: presets.map((p) => `agt-${p.preset_key}`),
       fence_rule_ids: fences.map((r) => `fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`),
       skill_ids: skillsDocs.map((s) => `skill-${s.name}`),
       kb_collection_ids: colDefs.map((c) => `kc-${WS_ID}-${c.name}`),
       seed_batch_id: `seed-aipm-${WS_ID}`,
     })],
  );
  console.log("✓ 装配台账登记（bundle_installs，清空可精确卸载）");

  await owner.end();
  console.log(`\n✅ ai-pm 示例包装配完成：${WS_NAME}——打开客户端即见 AI 产品经理团队在岗`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  seedAiPm().catch((e) => { console.error("seed-aipm 失败:", e); process.exit(1); });
}
