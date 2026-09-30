/**
 * 酒店获客行业规划器单测（纯函数，不触 DB）。
 *
 * 关注的不是"能生成步骤"，而是**边界**：
 *  - 差评必须带评分（否则 R6 的 when 缺数据按 D27 熔断，闭环走不到挂起待审）；
 *  - 调价只写能推导的基准/目标，推不出来就不写（宁挂起不误放）；
 *  - 未知意图交回基座规划，行业化不吞通用能力。
 */
import { describe, expect, it } from "vitest";
import type { AssembledPreset, QuestStep } from "@workloom/runtime";
import { acquisitionQuestPlanner, claimsHotelDomain } from "./acquisition-planner.js";

function presetOf(tools: Array<{ name: string; access: "read" | "write" }>, archive: Record<string, unknown> = {}): AssembledPreset {
  return {
    presetKey: "probe",
    name: "探针岗位",
    version: "v1",
    kind: "probe",
    readonly: false,
    fenceBindings: ["R1"],
    skills: [],
    tools: tools.map((t) => ({ ...t, desc: t.name })),
    essentials: { archive },
  } as unknown as AssembledPreset;
}

const plan = (goal: string, preset: AssembledPreset): QuestStep[] => acquisitionQuestPlanner(goal)(goal, preset);

const pricingTools = [
  { name: "pms.price.read", access: "read" as const },
  { name: "pms.price.write", access: "write" as const },
];
const reviewTools = [
  { name: "review.list", access: "read" as const },
  { name: "review.reply", access: "write" as const },
];
const housekeepingTools = [{ name: "task.dispatch", access: "write" as const }];
const inspectionTools = [
  { name: "channel.status.read", access: "read" as const },
  { name: "price.scan", access: "read" as const },
  { name: "review.scan", access: "read" as const },
];

describe("口碑：差评回复带评分（R6 必审可判定）", () => {
  it("明说 2 分差评 → rating=2，两步（列表+回复）", () => {
    const steps = plan("处理这条 2 分差评", presetOf(reviewTools));
    expect(steps.map((s) => s.tool)).toEqual(["review.list", "review.reply"]);
    expect(steps[1]!.params.rating).toBe(2);
  });

  it("只说差评 → 取最差一档评分（宁可送审）", () => {
    const steps = plan("有差评要回复", presetOf(reviewTools));
    expect(steps[1]!.params.rating).toBe(2);
  });

  it("MC-304：口语词族（投诉/客服/答复/回评）同样走口碑链", () => {
    for (const goal of ["客户投诉要答复", "客服回评一下", "帮我把这条评价回复了"]) {
      const steps = plan(goal, presetOf(reviewTools));
      expect(steps.map((s) => s.tool)).toEqual(["review.list", "review.reply"]);
    }
  });
});

describe("MC-304 语义域判定（基座派遣试算的行业声明）", () => {
  it("口碑词族只认领持有 review.reply 的岗位", () => {
    expect(claimsHotelDomain("处理一条差评并回复", presetOf(reviewTools))).toBe(true);
    expect(claimsHotelDomain("客户投诉要跟进", presetOf(reviewTools))).toBe(true);
    expect(claimsHotelDomain("处理一条差评并回复", presetOf(pricingTools))).toBe(false);
    expect(claimsHotelDomain("处理一条差评并回复", presetOf(housekeepingTools))).toBe(false);
  });

  it("口语调价动词（上调/下调/降价）只认领定价岗位", () => {
    expect(claimsHotelDomain("把雅致大床房上调 3%", presetOf(pricingTools))).toBe(true);
    expect(claimsHotelDomain("把雅致大床房降价 20 元", presetOf(pricingTools))).toBe(true);
    expect(claimsHotelDomain("把雅致大床房上调 3%", presetOf(reviewTools))).toBe(false);
  });

  it("巡检/送物认领对应岗位；无域目标不得被任意岗位吞下（假交付回归闸）", () => {
    expect(claimsHotelDomain("每日巡检渠道价格与评价", presetOf(inspectionTools))).toBe(true);
    expect(claimsHotelDomain("给 1208 房送两瓶水", presetOf(housekeepingTools))).toBe(true);
    expect(claimsHotelDomain("并发用例 cap-3", presetOf(reviewTools))).toBe(false);
    expect(claimsHotelDomain("并发用例 cap-3", presetOf(pricingTools))).toBe(false);
    expect(claimsHotelDomain("例行行情比对", presetOf(inspectionTools))).toBe(false);
  });
});

describe("收益：调价参数只做确定性直译", () => {
  const archive = { business: { price_bands: { "雅致大床房": [398, 688] } } };

  it("百分比意图 + 点名房型 → 锚点取该档价带中值（真实价位，不撞保底价）", () => {
    const steps = plan("把雅致大床房调价 5%", presetOf(pricingTools, archive));
    const adjust = steps.find((s) => s.action === "price.adjust")!;
    expect(adjust.before).toEqual({ price: 543 });          // (398+688)/2
    expect(adjust.after).toEqual({ price: 570.15 });        // 543 × 1.05
    expect(adjust.params.room_type).toBe("雅致大床房");
    // 围栏规则要读 context：缺键会让求值器抛错并按 block 处理（夜班规则误熔断）
    expect(typeof adjust.context?.night_shift).toBe("boolean");
    expect(adjust.context?.channel_new).toBe(false);
  });

  it("百分比意图 + 只给房型词尾 → 命中多档时取最低中值（两个方向都最保守）", () => {
    // "飞猪大床房" 不是价带 key，但词尾「大床房」命中 雅致(543) 与 商旅(473) 两档；
    // 不猜具体房型，取最低中值：对标价 473。取高值只会在涨价时更容易被误放行。
    const multi = { business: { price_bands: { "雅致大床房": [398, 688], "亲子双床房": [468, 788], "商旅大床房": [358, 588] } } };
    const steps = plan("周五旺季调价 2%：飞猪大床房小幅上调", presetOf(pricingTools, multi));
    const adjust = steps.find((s) => s.action === "price.adjust")!;
    expect(adjust.before).toEqual({ price: 473 });          // (358+588)/2，两候选中最低
    expect(adjust.after).toEqual({ price: 482.46 });        // 473 × 1.02
  });

  it("百分比意图 + 价带里没有该房型 → 不编造 before/after（交围栏失败关闭）", () => {
    const steps = plan("把总统套房调价 5%", presetOf(pricingTools, archive));
    const adjust = steps.find((s) => s.action === "price.adjust")!;
    expect(adjust.before).toBeUndefined();
    expect(adjust.after).toBeUndefined();
  });

  it("绝对价 + 价带锚点 → before 取锚点，after 取目标价", () => {
    const steps = plan("把雅致大床房调到 600", presetOf(pricingTools, archive));
    const adjust = steps.find((s) => s.action === "price.adjust")!;
    expect(adjust.before).toEqual({ price: 543 });
    expect(adjust.after).toEqual({ price: 600 });
  });

  it("缺目标价/缺房型锚点 → 不编造 before/after（交围栏失败关闭）", () => {
    const noIntent = plan("把房价调整一下", presetOf(pricingTools, archive));
    expect(noIntent.find((s) => s.action === "price.adjust")!.before).toBeUndefined();
    const noBand = plan("把雅致大床房调到 600", presetOf(pricingTools, {}));
    const adjust = noBand.find((s) => s.action === "price.adjust")!;
    expect(adjust.before).toBeUndefined();
    expect(adjust.after).toBeUndefined();
  });
});

describe("履约与巡检", () => {
  it("送物/报修直译工单类型与房间号", () => {
    const delivery = plan("给 1208 房送两瓶矿泉水", presetOf(housekeepingTools));
    expect(delivery[0]!.params).toMatchObject({ kind: "delivery", room: "1208" });
    const repair = plan("301 房空调坏了需要报修", presetOf(housekeepingTools));
    expect(repair[0]!.params).toMatchObject({ kind: "repair", room: "301" });
  });

  it("巡检按装配工具生成只读三步", () => {
    const steps = plan("今天做一次渠道巡检", presetOf(inspectionTools));
    expect(steps.map((s) => s.tool)).toEqual(["channel.status.read", "price.scan", "review.scan"]);
  });
});

describe("边界", () => {
  it("未知意图交回基座确定性规划（不吞通用能力）", () => {
    const steps = plan("随便看看昨天的数据", presetOf([{ name: "order.list", access: "read" }]));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]!.tool).toBe("order.list");
  });

  it("意图与装配不匹配（无对应写工具）时退回通用规划", () => {
    const steps = plan("处理差评", presetOf([{ name: "order.list", access: "read" }]));
    expect(steps[0]!.tool).toBe("order.list");
  });
});
