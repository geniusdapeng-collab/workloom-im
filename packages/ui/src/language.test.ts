import { describe, expect, it } from "vitest";
import {
  clientFieldEntries,
  clientFieldLabel,
  clientChineseText,
  clientIdentifierText,
  clientStatusLabel,
  clientValueText,
  isKnownClientField,
} from "./language";

describe("客户端中文显示边界", () => {
  it("统一映射 snake_case、camelCase 与状态枚举", () => {
    expect(clientFieldLabel("rule_id")).toBe("规则");
    expect(clientFieldLabel("bundleId")).toBe("行业包");
    expect(clientStatusLabel("pending_review")).toBe("待审核");
    expect(clientStatusLabel("backend_new_state")).toBe("状态待确认");
    expect(clientStatusLabel("人工确认中")).toBe("人工确认中");
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
  });
});
