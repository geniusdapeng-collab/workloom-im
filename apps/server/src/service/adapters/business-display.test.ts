import { describe, expect, it } from "vitest";
import {
  BusinessAdapterError,
  projectBusinessDialogMatch,
  projectBusinessIdentityChallenge,
  projectBusinessToolResult,
  type BusinessCatalogResult,
  type BusinessMemberResult,
  type BusinessOrderResult,
} from "./business.js";

describe("C 端行业业务展示投影", () => {
  it("只复制通用展示白名单，行业私有字段不会穿过网关", () => {
    const projected = projectBusinessToolResult("query_order", {
      demo: false,
      orders: [{
        id: "record-1",
        cardTitle: "我的业务记录",
        title: "标准服务方案",
        statusText: "已确认",
        referenceText: "业务编号 A-1001",
        details: [{ label: "服务日期", value: "2026-09-15" }],
        amountText: "¥1,176.00",
        privateIndustryField: "不得返回",
        status: "confirmed",
      }],
    } as unknown as BusinessOrderResult) as BusinessOrderResult;

    expect(projected.orders[0]).toEqual({
      id: "record-1",
      cardTitle: "我的业务记录",
      title: "标准服务方案",
      statusText: "已确认",
      referenceText: "业务编号 A-1001",
      details: [{ label: "服务日期", value: "2026-09-15" }],
      amountText: "¥1,176.00",
    });
    expect(projected.orders[0]).not.toHaveProperty("privateIndustryField");
    expect(projected.orders[0]).not.toHaveProperty("status");
  });

  it("权益与目录同样只返回中文、可直接展示的数据", () => {
    const member = projectBusinessToolResult("query_member", {
      demo: true,
      member: {
        title: "金卡会员",
        metric: { label: "当前积分", value: "2,680" },
        benefits: ["延迟办理服务"],
        level: "gold",
        points: 2680,
      },
    } as unknown as BusinessMemberResult) as BusinessMemberResult;
    expect(member.member).toEqual({
      title: "金卡会员",
      metric: { label: "当前积分", value: "2,680" },
      benefits: ["延迟办理服务"],
    });

    const catalog = projectBusinessToolResult("query_catalog", {
      demo: false,
      cardTitle: "服务方案与价格",
      items: [{
        id: "sku-internal",
        title: "标准服务方案",
        summary: "适合首次使用者",
        priceText: "¥588 / 次",
        details: [{ label: "服务周期", value: "三天" }],
        sku: "RAW-SKU",
        priceYuan: 588,
      }],
    } as unknown as BusinessCatalogResult) as BusinessCatalogResult;
    expect(catalog.items[0]).toEqual({
      id: "sku-internal",
      title: "标准服务方案",
      summary: "适合首次使用者",
      priceText: "¥588 / 次",
      details: [{ label: "服务周期", value: "三天" }],
    });
    expect(catalog.items[0]).not.toHaveProperty("sku");
    expect(catalog.items[0]).not.toHaveProperty("priceYuan");
  });

  it.each([
    ["英文状态", { demo: false, orders: [{ id: "1", cardTitle: "业务记录", title: "标准服务", statusText: "confirmed", details: [] }] }],
    ["原始字段标签", { demo: false, orders: [{ id: "1", cardTitle: "业务记录", title: "标准服务", statusText: "已确认", details: [{ label: "room_type", value: "标准服务" }] }] }],
    ["夹杂底层字段", { demo: false, orders: [{ id: "1", cardTitle: "业务记录", title: "标准服务 room_type", statusText: "已确认", details: [] }] }],
    ["夹杂英文枚举", { demo: false, orders: [{ id: "1", cardTitle: "业务记录", title: "标准服务", statusText: "confirmed 已确认", details: [] }] }],
    ["英文行业值", { demo: false, orders: [{ id: "1", cardTitle: "业务记录", title: "标准服务", statusText: "已确认", details: [{ label: "服务类型", value: "Deluxe King" }] }] }],
    ["服务端异常", { demo: false, orders: [{ id: "1", cardTitle: "业务记录", title: "Internal Server Error 工作区异常", statusText: "已确认", details: [] }] }],
  ])("拒绝%s，且只抛稳定中文错误", (_name, raw) => {
    try {
      projectBusinessToolResult("query_order", raw as unknown as BusinessOrderResult);
      throw new Error("预期展示投影校验失败");
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessAdapterError);
      expect((error as BusinessAdapterError).code).toBe("BUSINESS_PROJECTION_INVALID");
      expect((error as Error).message).toBe("行业展示数据未通过安全校验");
    }
  });

  it("对话动作、身份挑战等直达客户端的文案也经过同一中文边界", () => {
    expect(projectBusinessDialogMatch({
      tool: "query_order",
      answer: "正在查询您的业务记录。",
    })).toEqual({ tool: "query_order", answer: "正在查询您的业务记录。" });
    expect(projectBusinessIdentityChallenge({
      state: "demo",
      message: "演示环境不会发送短信，请输入验证码。",
      demoCode: "123456",
    })).toMatchObject({ state: "demo", demoCode: "123456" });
    expect(() => projectBusinessDialogMatch({
      tool: "query_order",
      answer: "query_order workspace_id 查询失败",
    })).toThrow(BusinessAdapterError);
    expect(() => projectBusinessIdentityChallenge({
      state: "pending",
      message: "Internal Server Error 身份服务异常",
    })).toThrow(BusinessAdapterError);
  });
});
