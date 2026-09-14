import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAFE_CONFIG, validateFrontConfig, type FrontConfig } from "./config";

const valid: FrontConfig = {
  workspaceKey: "public-site",
  brandName: "示例企业",
  agentName: "服务助手",
  logoText: "服",
  theme: { primary: "#334155", secondary: "#075985" },
  welcomeText: "欢迎使用服务中心",
  quickReplies: [{ label: "咨询", sendText: "我要咨询" }],
  serviceEntries: [{ kind: "consult", title: "咨询", desc: "提交咨询", icon: "咨", sla: "预计一天内回复" }],
  memberLevels: { visitor: { label: "访客" } },
  profile: {
    identityBinding: true,
    membership: true,
    orders: true,
    labels: {
      identity: "客户身份",
      membership: "会员权益",
      points: "当前积分",
      orders: "近期订单",
      emptyOrders: "暂无订单",
    },
  },
  enableTabs: ["chat", "service", "tickets", "messages", "me"],
  supportPhone: "",
  projection: {
    bundleId: "test-bundle",
    bundleVersion: "1.0.0",
    contractVersion: "1.0.0",
    uiVersion: "1.0.0",
    manifestDigest: "test-digest",
  },
};

describe("C 端前台配置安全态", () => {
  it("完整配置通过校验", () => {
    expect(validateFrontConfig(valid)).toBe(true);
  });

  it("当前由默认 Bundle 生成的客户端投影通过完整展示校验", () => {
    const generated = JSON.parse(readFileSync(
      new URL("../../public/service-front.config.json", import.meta.url),
      "utf8",
    )) as unknown;
    expect(validateFrontConfig(generated)).toBe(true);
  });

  it("缺失关键字段或站点键类型错误时拒绝启用", () => {
    expect(validateFrontConfig({ ...valid, brandName: "" })).toBe(false);
    expect(validateFrontConfig({ ...valid, workspaceKey: 42 })).toBe(false);
    expect(validateFrontConfig({ ...valid, theme: { primary: "gold", secondary: "#075985" } })).toBe(false);
    expect(validateFrontConfig({ ...valid, profile: { ...valid.profile, labels: { ...valid.profile.labels, orders: "orders" } } })).toBe(false);
  });

  it("服务卡、快捷入口与系统文案不得释放英文或底层字段", () => {
    expect(validateFrontConfig({
      ...valid,
      serviceEntries: [{ ...valid.serviceEntries[0]!, title: "room_type" }],
    })).toBe(false);
    expect(validateFrontConfig({
      ...valid,
      serviceEntries: [{ ...valid.serviceEntries[0]!, desc: "Internal Server Error 工作区" }],
    })).toBe(false);
    expect(validateFrontConfig({ ...valid, quickReplies: [{ label: "query_order", sendText: "我要查询" }] })).toBe(false);
    expect(validateFrontConfig({ ...valid, welcomeText: "欢迎使用 workspace_id 服务中心" })).toBe(false);
    expect(validateFrontConfig({ ...valid, welcomeText: "welcome" })).toBe(false);
  });

  it("品牌色在浅色背景上对比度不足时拒绝启用", () => {
    expect(validateFrontConfig({ ...valid, theme: { primary: "#5b8cff", secondary: "#075985" } })).toBe(false);
  });

  it("安全态不含酒店行业入口或联系方式", () => {
    expect(SAFE_CONFIG.brandName).toBe("企业服务中心");
    expect(SAFE_CONFIG.serviceEntries).toEqual([]);
    expect(SAFE_CONFIG.quickReplies).toEqual([]);
    expect(SAFE_CONFIG.supportPhone).toBe("");
    expect(SAFE_CONFIG.profile).toMatchObject({ identityBinding: false, membership: false, orders: false });
  });
});
