import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentWorkCard, DecisionPackage, ReceiptLink, TenantScope } from "./patterns";

describe("三端共享业务模式", () => {
  it("任务状态卡同时呈现人、阶段、人类动作、风险与回执", () => {
    const html = renderToStaticMarkup(
      <AgentWorkCard
        work={{
          id: "task-1",
          actor: "经营分析员",
          humanOwner: "王经理",
          goal: "形成今日经营复盘",
          stage: "等待审核",
          progress: { completed: 2, total: 3, next: "审核结论" },
          reason: "依据已验证数据",
          needsHuman: { action: "确认结论", consequence: "未确认前不会外发" },
          risk: "medium",
          receipt: { eventId: "event-1" },
          recovery: "可退回重做",
        }}
      />,
    );
    for (const text of ["经营分析员", "等待审核", "需要你处理", "中风险", "事件账本回执", "可退回重做"]) {
      expect(html).toContain(text);
    }
  });

  it("决策包固定呈现变更、影响、回滚和事件证据", () => {
    const html = renderToStaticMarkup(
      <DecisionPackage decision={{
        title: "调价建议",
        action: "调整公开价格",
        summary: "需要负责人裁决",
        before: "原价",
        after: "建议价",
        evidence: [{ title: "需求变化", source: "经营数据" }],
        risk: "high",
        impact: "公开渠道",
        rollback: "恢复原价",
        eventId: "event-2",
      }} />,
    );
    for (const text of ["变更前", "变更后", "影响范围", "回滚方式", "事件账本回执"]) {
      expect(html).toContain(text);
    }
  });

  it("租户范围不会隐藏当前环境", () => {
    const html = renderToStaticMarkup(<TenantScope tenant="示例企业" workspace="经营中心" environment="pilot" />);
    expect(html).toContain("示例企业");
    expect(html).toContain("经营中心");
    expect(html).toContain("灰度运行");
  });

  it("任务请求编号不会冒充事件账本编号", () => {
    const html = renderToStaticMarkup(<ReceiptLink requestId="request-1" />);
    expect(html).toContain("任务请求回执");
    expect(html).not.toContain("事件账本回执");
    expect(html).toContain("编号已记录");
    expect(html).not.toContain("request-1");
  });
});
