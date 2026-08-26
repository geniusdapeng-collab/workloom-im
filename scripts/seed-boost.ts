/**
 * scripts/seed-boost.ts · AI 公司全速运转运行态增强包（客群：搭建自有行业系统的企业/开发者）（SALES-DEMO）
 * 用法：pnpm db:seed:boost（幂等：事件存在即跳过、审批同 ID 跳过）
 */
import pg from "pg";
import { eventHash, safeParseReplayAwareEvent } from "@workloom/base/workdata";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom_im";
const GATEWAY_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom_im";
const TENANT_ID = "tenant-demo";
const WS_ID = "ws-yunqi";
const WS_NAME = "云栖酒店";
const FENCE_VERSION = "hotel-baseline/v1";
const GENESIS_HASH = "GENESIS";

const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const who = (id: string, version = "v3.0") => ({ type: "agent" as const, id, version });
const ctx = (time: string) => ({ tenant_id: TENANT_ID, workspace_id: WS_ID, time, stage: "stable", store: WS_NAME });
const mt = { model_id: "mock-001", tier: "standard", window: "peak", credits: 1 };
const receipt = (time: string) => ({ synced: true, snapshot_uri: "data/snapshots/boost.png", verified_at: time });
const ri = (rule_id: string, result = "pass") => [{ rule_id, version: FENCE_VERSION, result }];

const EVENTS: unknown[] = [
  { event_id: "E-SEED-BT-0201", who: who("captain"), context: ctx(at(2700)), object: { type: "thread", id: "T-201", label: "任务派发·市场" },
    decision: { action: "thread.dispatch", after: {"title": "三季度品牌焕新 Campaign", "steps": 5, "owner": "市场组", "deadline": "本周五"}, basis: ["QUEST 五步拆解"] },
    rule_impact: [], receipt: receipt(at(2700)), model_trace: mt },
  { event_id: "E-SEED-BT-0202", who: who("captain"), context: ctx(at(2650)), object: { type: "thread", id: "T-202", label: "任务派发·产品" },
    decision: { action: "thread.dispatch", after: {"title": "客服知识库 2.0 上线", "steps": 4, "owner": "产品组", "deadline": "下周三"}, basis: ["QUEST 五步拆解"] },
    rule_impact: [], receipt: receipt(at(2650)), model_trace: mt },
  { event_id: "E-SEED-BT-0203", who: who("captain"), context: ctx(at(2600)), object: { type: "thread", id: "T-203", label: "任务派发·销售" },
    decision: { action: "thread.dispatch", after: {"title": "重点客户季度回访 28 家", "steps": 3, "owner": "销售组", "deadline": "本月底"}, basis: ["QUEST 五步拆解"] },
    rule_impact: [], receipt: receipt(at(2600)), model_trace: mt },
  { event_id: "E-SEED-BT-0204", who: who("content-agent"), context: ctx(at(2400)), object: { type: "content", id: "cp-091", label: "市场活动发布" },
    decision: { action: "campaign.publish", after: {"campaign": "品牌焕新首发", "channels": ["企微", "官网", "行业社群"], "reach": 12600}, basis: ["活动管线"] },
    rule_impact: [], receipt: receipt(at(2400)), model_trace: mt },
  { event_id: "E-SEED-BT-0205", who: who("company-ceo"), context: ctx(at(2300)), object: { type: "thread", id: "T-201", label: "拍板留痕" },
    decision: { action: "approval.gesture", after: {"decision": "批准", "item": "品牌焕新预算 ¥86,000", "latency_min": 9}, basis: ["移动审批卡片"] },
    rule_impact: [], receipt: receipt(at(2300)), model_trace: mt },
  { event_id: "E-SEED-BT-0206", who: who("company-ceo"), context: ctx(at(2250)), object: { type: "thread", id: "T-202", label: "拍板留痕" },
    decision: { action: "approval.gesture", after: {"decision": "校准后批准", "item": "知识库 2.0 范围（砍掉 2 个低优模块）", "latency_min": 14}, basis: ["移动审批卡片"] },
    rule_impact: [], receipt: receipt(at(2250)), model_trace: mt },
  { event_id: "E-SEED-BT-0207", who: who("company-ceo"), context: ctx(at(2200)), object: { type: "thread", id: "T-203", label: "拍板留痕" },
    decision: { action: "approval.gesture", after: {"decision": "驳回", "item": "低价倾销提案（毛利率 -18%）", "reason": "破坏价格体系"}, basis: ["移动审批卡片"] },
    rule_impact: [], receipt: receipt(at(2200)), model_trace: mt },
  { event_id: "E-SEED-BT-0208", who: who("coupon-operator"), context: ctx(at(2000)), object: { type: "lead", id: "ld-208", label: "客户成功跟进" },
    decision: { action: "lead.follow", after: {"account": "华辰集团", "stage": "续约谈判", "amount": 240000, "health": "活跃"}, basis: ["客户成功 SOP"] },
    rule_impact: [], receipt: receipt(at(2000)), model_trace: mt },
  { event_id: "E-SEED-BT-0209", who: who("coupon-operator"), context: ctx(at(1900)), object: { type: "lead", id: "ld-209", label: "新客线索转化" },
    decision: { action: "lead.nurture", after: {"leads": 12, "from": "官网白皮书下载", "to": "3 家已约演示"}, basis: ["线索培育管线"] },
    rule_impact: [], receipt: receipt(at(1900)), model_trace: mt },
  { event_id: "E-SEED-BT-0210", who: who("content-agent"), context: ctx(at(1700)), object: { type: "content", id: "kb-20", label: "知识库 2.0 发布" },
    decision: { action: "kb.publish", after: {"docs": 47, "collections": 6, "coverage": "常见问题覆盖 92%"}, basis: ["知识管线"] },
    rule_impact: [], receipt: receipt(at(1700)), model_trace: mt },
  { event_id: "E-SEED-BT-0211", who: who("review-agent"), context: ctx(at(1500)), object: { type: "intent_signal", id: "trig-1", label: "触发器自动执行" },
    decision: { action: "trigger.fired", after: {"trigger": "周报生成（每周五 17:00）", "runs": 12, "failures": 0}, basis: ["自动化触发器"] },
    rule_impact: [], receipt: receipt(at(1500)), model_trace: mt },
  { event_id: "E-SEED-BT-0212", who: who("guest-success"), context: ctx(at(1300)), object: { type: "service_ticket", id: "tk-91", label: "服务工单推进" },
    decision: { action: "service.ticket.advance", after: {"tickets": 9, "sla_hit": "100%", "avg_min": 18}, basis: ["服务台"] },
    rule_impact: [], receipt: receipt(at(1300)), model_trace: mt },
  { event_id: "E-SEED-BT-0213", who: who("desktop-agent"), context: ctx(at(1200)), object: { type: "intent_signal", id: "insp-1", label: "自动巡检" },
    decision: { action: "inspection.scan", after: {"scope": "全员/权限/数据", "anomalies": 1, "action": "已派发处置"}, basis: ["巡检节拍"] },
    rule_impact: [], receipt: receipt(at(1200)), model_trace: mt },
  { event_id: "E-SEED-BT-0214", who: who("night-shift"), context: ctx(at(500)), object: { type: "night_package", id: "np-i", label: "夜班日报" },
    decision: { action: "night.package.deliver", after: {"overnight": {"tasks": 8, "completed": 8, "escalation": 0}, "note": "夜间任务全清"}, basis: ["夜班值守"] },
    rule_impact: [], receipt: receipt(at(500)), model_trace: mt },
  { event_id: "E-SEED-BT-0215", who: who("company-ceo"), context: ctx(at(60)), object: { type: "conversion", id: "brief-i", label: "CEO 晨报" },
    decision: { action: "ceo.briefing", after: {"yesterday": {"threads": 14, "decisions": 3, "events": 186}, "week": "营收管线 ¥412,000 · 线索转化 25%"}, basis: ["晨报节拍"] },
    rule_impact: [], receipt: receipt(at(60)), model_trace: mt },
];

const APPROVALS = [
  { id: "apr-boost-i1", eventRef: "E-SEED-BT-0201",
    snapshot: { action: "deal.quote", summary: "季度市场预算审批：¥120,000（品牌焕新+获客投放）", title: "Q3 市场预算 ¥120,000",
      ceo_rationale: "其中获客投放 ¥80,000（预计 MQL 240 条，CPL ≤ ¥333）；品牌焕新 ¥40,000；ROI 目标 ≥ 3.5×", rule_version: "R16 baseline/v1", gate: "必审",
      params: {"amount": 120000, "split": {"获客投放": 80000, "品牌焕新": 40000}, "target_mql": 240},
      before: {"budget_q2": 96000}, after: {"budget_q3": 120000, "roi_target": "3.5×"} } },
  { id: "apr-boost-i2", eventRef: "E-SEED-BT-0213",
    snapshot: { action: "lead.assign", summary: "AI 员工扩编审批：新增 2 名（客户成功 Agent + 数据 Agent）", title: "AI 员工扩编 ×2",
      ceo_rationale: "客户成功工单周增 34%，现有坐席饱和度 87%；扩编后预计 SLA 提升至 99%，月成本 ¥1,200", rule_version: "R16 baseline/v1", gate: "必审",
      params: {"agents": ["客户成功 Agent", "数据 Agent"], "cost_month": 1200, "sla_target": "99%"},
      before: {"headcount": 14}, after: {"headcount": 16, "cost": "+¥1,200/月"} } },
];

async function main() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  let aprNew = 0;
  for (const a of APPROVALS) {
    const exists = await owner.query(`SELECT 1 FROM approvals WHERE approval_id=$1`, [a.id]);
    if ((exists.rowCount ?? 0) > 0) continue;
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, created_at)
       VALUES ($1,$2,$3,$4,'inapp','pending','l4_chairman',$5,$6)`,
      [a.id, TENANT_ID, WS_ID, (a as unknown as { eventRef: string }).eventRef, JSON.stringify(a.snapshot), at(90)],
    );
    aprNew++;
  }
  console.log(`✓ 待审批：新写入 ${aprNew} 条（L4 董事长级）`);
  await owner.end();

  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);
  const last = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`, [TENANT_ID, WS_ID]);
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;
  let inserted = 0, skipped = 0;
  for (const raw of EVENTS) {
    const ev = raw as { event_id: string; context: { time: string } };
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) throw new Error(`事件 ${ev.event_id} 未过校验：${checked.error.message}`);
    const dup = await gw.query(`SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`, [TENANT_ID, ev.event_id]);
    if ((dup.rowCount ?? 0) > 0) { skipped++; continue; }
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query<{ inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.event_id, TENANT_ID, WS_ID, null, payload, prevHash, hash, ev.context.time],
    );
    if (res.rows[0]?.inserted) { prevHash = hash; inserted++; } else skipped++;
  }
  await gw.query("COMMIT");
  await gw.end();
  console.log(`✓ 剧本事件：新写入 ${inserted} 条，幂等跳过 ${skipped} 条`);
  console.log("IM 基座饱满运行态就绪 ✅（任务-审批-夜班-晨报闭环 · 移动审批卡片 · L4决策2件）");
}

main().catch((e) => { console.error(e); process.exit(1); });
