import { describe, expect, it } from "vitest";
import {
  clientFieldEntries,
  clientFieldLabel,
  clientChineseText,
  clientIdentifierText,
  clientSafeTerms,
  clientStatusLabel,
  clientValueText,
  isKnownClientField,
  registerClientSafeTerms,
} from "./language";

describe("客户端中文显示边界", () => {
  it("统一映射 snake_case、camelCase 与状态枚举", () => {
    expect(clientFieldLabel("rule_id")).toBe("规则");
    expect(clientFieldLabel("bundleId")).toBe("行业包");
    expect(clientStatusLabel("pending_review")).toBe("待审核");
    expect(clientStatusLabel("backend_new_state")).toBe("状态待确认");
    expect(clientStatusLabel("人工确认中")).toBe("人工确认中");
    expect(clientStatusLabel("订单 orderStatus 更新中")).toBe("状态待确认");
  });

  it("普通模式不泄露未知底层字段", () => {
    expect(isKnownClientField("raw_secret_code")).toBe(false);
    expect(clientFieldLabel("raw_secret_code")).toBe("扩展信息");
    expect(clientFieldEntries({ raw_secret_code: "x" })).toEqual([
      { label: "扩展信息", value: "信息待确认" },
    ]);
  });

  it("只有显式诊断模式才返回原字段名", () => {
    expect(clientFieldEntries({ raw_secret_code: true }, { diagnostic: true })).toEqual([
      { label: "raw_secret_code", value: "是", internalKey: "raw_secret_code" },
    ]);
  });

  it("对象和数组使用中文摘要而不是原始 JSON", () => {
    expect(clientValueText([1, 2])).toBe("2 项");
    expect(clientValueText({ before: 1, after: 2 })).toBe("2 项信息");
    expect(clientValueText("premium")).toBe("高质量档");
    expect(clientValueText("stable")).toBe("稳定运行");
    expect(clientValueText("raw_backend_enum")).toBe("信息待确认");
    expect(clientValueText("Internal Server Error workspace_id missing")).toBe("信息待确认");
    expect(clientValueText("SELECT workspace_id FROM tenants")).toBe("信息待确认");
    expect(clientValueText("2026-09-15 10:30")).toBe("2026-09-15 10:30");
    expect(clientValueText("AI")).toBe("AI");
    expect(clientValueText("用户填写的说明")).toBe("用户填写的说明");
    expect(clientValueText("业务编号 A-1001")).toBe("业务编号 A-1001");
    expect(clientValueText("订单 private_field 更新")).toBe("信息待确认");
    expect(clientValueText("订单 orderStatus 更新")).toBe("信息待确认");
    expect(clientValueText("订单 order.status 更新")).toBe("信息待确认");
  });

  it("内部主键只展示可核对的脱敏尾号", () => {
    expect(clientIdentifierText("ticket-live-001928")).toBe("尾号 001928");
    expect(clientIdentifierText("550e8400-e29b-41d4-a716-446655440000")).toBe("尾号 440000");
    expect(clientIdentifierText("evt-secret-hash")).toBe("编号已记录");
    expect(clientIdentifierText(null)).toBe("编号待确认");
  });

  it("服务端自然语言使用中文白名单并对工程内容安全兜底", () => {
    expect(clientChineseText("请补充目标与完成时间", "请稍后重试")).toBe("请补充目标与完成时间");
    expect(clientChineseText("Please provide a goal", "请补充目标")).toBe("请补充目标");
    expect(clientChineseText("请按 F3.2 补充目标", "请补充目标")).toBe("请补充目标");
    expect(clientChineseText('{"说明":"中文但仍是原始 JSON"}', "信息待确认")).toBe("信息待确认");
    expect(clientChineseText("请核对 workspace_id", "请核对工作区")).toBe("请核对工作区");
    expect(clientChineseText("服务异常：Internal Server Error", "服务暂时不可用")).toBe("服务暂时不可用");
    expect(clientChineseText("订单 private_field 已更新", "订单信息已更新")).toBe("订单信息已更新");
    expect(clientChineseText("订单 orderStatus 已更新", "订单信息已更新")).toBe("订单信息已更新");
    expect(clientChineseText("订单 order.status 已更新", "订单信息已更新")).toBe("订单信息已更新");
    expect(clientChineseText("WorkLoom IM 的 AI 服务已连接", "服务已连接")).toBe("WorkLoom IM 的 AI 服务已连接");
    expect(clientChineseText("3D 汇报空间已就绪", "汇报空间已就绪")).toBe("3D 汇报空间已就绪");
  });

  /**
   * 行业术语白名单（合规注入通道）：行业包显式声明的通用词放行，
   * 未声明的行业词与平台红线一律保持原兜底行为。
   */
  describe("行业术语白名单", () => {
    it("未登记时保持基座默认边界", () => {
      registerClientSafeTerms([]);
      expect(clientChineseText("请连接客房 WiFi", "环境信息待确认")).toBe("环境信息待确认");
      expect(clientSafeTerms()).toEqual([]);
    });

    it("登记后放行行业通用词，且不放过平台红线", () => {
      registerClientSafeTerms(["WiFi", "OCC", "PMS", "RevPAR"]);
      expect(clientSafeTerms()).toEqual(["WiFi", "OCC", "PMS", "RevPAR"]);
      expect(clientChineseText("请连接客房 WiFi", "环境信息待确认")).toBe("请连接客房 WiFi");
      expect(clientChineseText("昨日 OCC 91%、每间可售房收入 ¥584", "信息待确认")).toBe("昨日 OCC 91%、每间可售房收入 ¥584");
      // Wi-Fi 与 WiFi 视为同一术语（分隔符位置可缺省）
      expect(clientChineseText("Wi-Fi 密码为房间号后四位", "信息待确认")).toBe("Wi-Fi 密码为房间号后四位");
      // 未登记的拉丁词仍整串回落
      expect(clientChineseText("请核对 orderStatus 字段", "信息待确认")).toBe("信息待确认");
      // 平台红线不接受行业声明
      expect(clientChineseText("请执行 SELECT * FROM orders", "信息待确认")).toBe("信息待确认");
      expect(clientChineseText('{"k":"v"} 是原始 JSON', "信息待确认")).toBe("信息待确认");
      expect(registerClientSafeTerms(["SELECT"])).toEqual([]);
      expect(clientChineseText("请执行 SELECT 查询", "信息待确认")).toBe("信息待确认");
    });

    it("只接受整词形态的短术语，超限与非法形态被丢弃", () => {
      const accepted = registerClientSafeTerms([
        "WIFI", "pms", "Wi-Fi", "order_status", "orderStatus", "A",
        "TOOLONGLATINTOKENVALUE", "OTA",
      ]);
      // Wi-Fi 与 WIFI 折叠为同一术语（保留先登记者）；下划线/小写驼峰/超长/单字符被丢弃
      expect(accepted).toEqual(["WIFI", "pms", "OTA"]);
      registerClientSafeTerms([]);
    });
  });
});
