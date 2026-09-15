/**
 * server · dialog 意图/置信度纯函数单测（不触 DB）
 * M8：与 base intents 同一张规则表——complaint>biz_query>service_request>kb_qa；
 *     疑问句优先 kb_qa；「修/修一下/坏了」直连 service_request。
 * H5：置信度归一化三档边界（≥0.72 直答 / 0.5–0.72 附提示 / <0.5 拒答）。
 */
import { describe, expect, it } from "vitest";
import {
  classify,
  tierOfScore,
  ticketKindOf,
  sharesDistinctiveEvidence,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
} from "./dialog.js";
import { hotelBizAdapter } from "../industry/hotel/service-front-adapter.js";

describe("classify 意图规则（M8 与 base 同表）", () => {
  const cases: Array<[string, string, string?, boolean?]> = [
    ["我要投诉房间太吵", "complaint"],
    ["查一下我的订单", "biz_query", "query_order", true],
    ["我的会员积分还有多少", "biz_query", "query_member", true],
    ["豪华大床房多少钱一晚", "biz_query", "query_catalog", true],
    ["我的工单进度怎么样了", "biz_query", "query_ticket"],
    ["送站巴士几点发车", "kb_qa"],            // 含「送」但疑问句 → kb_qa 不建单
    ["早餐几点开始？收费吗", "kb_qa"],
    ["空调坏了，帮我修一下", "service_request", undefined, true],
    ["帮我送两瓶矿泉水", "service_request", undefined, true],
    ["附近地铁站怎么走", "kb_qa"],            // 无规则命中 → 默认 kb_qa（低置信拒答）
  ];
  for (const [text, intent, tool, withHotel] of cases) {
    it(`「${text}」→ ${intent}${tool ? `/${tool}` : ""}`, () => {
      const r = classify(text, withHotel ? hotelBizAdapter : undefined);
      expect(r.intent).toBe(intent);
      if (tool) expect(r.tool).toBe(tool);
    });
  }

  it("未声明行业适配器时，订单/会员/房型文本不得触发酒店工具", () => {
    for (const text of ["查一下我的订单", "我的会员积分还有多少", "豪华大床房多少钱一晚"]) {
      expect(classify(text)).toEqual({ intent: "kb_qa" });
    }
  });
});

describe("ticketKindOf service_request → 工单类型", () => {
  it("修/坏类 → repair；送/拿类 → delivery；其余 → other", () => {
    expect(ticketKindOf("空调坏了，帮我修一下", hotelBizAdapter)).toBe("repair");
    expect(ticketKindOf("帮我送两瓶矿泉水", hotelBizAdapter)).toBe("delivery");
    expect(ticketKindOf("帮我安排一个安静点的房间", hotelBizAdapter)).toBe("other");
  });
});

describe("tierOfScore 置信度三档（H5，归一化 0..1）", () => {
  it("阈值边界", () => {
    expect(CONFIDENCE_HIGH).toBe(0.72);
    expect(CONFIDENCE_MEDIUM).toBe(0.45); // 评测校准：区分度地板与拒答边界拉开
    expect(tierOfScore(0.95)).toBe("high");
    expect(tierOfScore(0.72)).toBe("high");
    expect(tierOfScore(0.71)).toBe("medium");
    expect(tierOfScore(0.45)).toBe("medium");
    expect(tierOfScore(0.44)).toBe("low");
    expect(tierOfScore(0)).toBe("low");
    expect(tierOfScore(undefined)).toBe("low");
  });
  it("越界输入归一化", () => {
    expect(tierOfScore(1.2)).toBe("high");
    expect(tierOfScore(-0.3)).toBe("low");
  });
});

describe("知识块合并词义由活动 Bundle 注入", () => {
  const first = { heading: "订单", content: "第一段" };
  const second = { heading: "订单", content: "第二段" };

  it("基座默认不把业务词擅自降为弱词", () => {
    expect(sharesDistinctiveEvidence(first, second)).toBe(true);
  });

  it("显式词表可阻止仅共享弱词的知识块合并", () => {
    expect(sharesDistinctiveEvidence(first, second, { weakTokens: ["订单"] })).toBe(false);
  });
});
