import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";
import {
  Avatar,
  Chart,
  Confidence,
  Delta,
  Dialog,
  ExportDialog,
  FilterBar,
  FullscreenSurface,
  Grid,
  Link,
  OverlayManager,
  Popover,
  SideNav,
  SplitView,
  Table,
  Tag,
  Timeline,
  Toast,
  Tooltip,
  WorkspaceSwitcher,
} from "./index";

vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode) => children,
}));

afterEach(() => vi.unstubAllGlobals());

describe("PRD 共享组件目录", () => {
  it("完整导出 PRD 规定的共享组件，不要求消费端复制实现", () => {
    const required = [
      "Button", "IconButton", "Link", "Input", "Select", "Combobox", "Textarea", "Checkbox", "Radio", "Switch", "Badge", "Tag", "Avatar", "StatusChip",
      "AppShell", "SideNav", "TopContextBar", "BottomTabs", "Grid", "ResizablePanel", "SplitView", "WorkspaceSwitcher",
      "Dialog", "ConfirmDialog", "Drawer", "Sheet", "Popover", "Tooltip", "Toast", "OverlayManager", "FullscreenSurface",
      "AsyncState", "EmptyState", "ErrorState", "OfflineState", "PermissionState", "DemoBanner", "Skeleton", "Progress",
      "AgentWorkCard", "DecisionPackage", "EvidenceList", "HumanActionBar", "Confidence", "ModelBadge", "ReceiptLink",
      "FenceBadge", "LedgerTimeline", "ExamGate", "MemorySource", "NightShiftStatus", "TenantScope",
      "MetricCard", "Delta", "Table", "FilterBar", "Timeline", "Chart", "ExportDialog",
    ] as const;
    for (const name of required) expect(UI[name], `缺少共享导出：${name}`).toBeDefined();
  });

  it("基础组件处理新窗口安全、中文长标签和无图片头像", () => {
    const html = renderToStaticMarkup(
      <Grid minItemWidth={220}>
        <Link href="https://example.test" external>查看完整的数字员工运行说明</Link>
        <Tag onRemove={() => undefined} removeLabel="移除待负责人确认标签">待负责人确认且内容很长的经营建议</Tag>
        <Avatar name="王小明" />
      </Grid>,
    );
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("在新窗口打开");
    expect(html).toContain('aria-label="移除待负责人确认标签"');
    expect(html).toContain('aria-label="王小明"');
    expect(html).toContain("王小");
    expect(html).toContain("--wl-grid-min:220px");
  });

  it("布局组件使用唯一导航实现并在选项中只展示业务名称", () => {
    const html = renderToStaticMarkup(
      <SplitView primary={<p>需要处理的事项</p>} secondary={<p>相关证据</p>} primaryPercent={65} />,
    );
    const switcherHtml = renderToStaticMarkup(
      <WorkspaceSwitcher
        value="workspace-secret-id"
        onValueChange={() => undefined}
        workspaces={[{ id: "workspace-secret-id", name: "华东经营中心", group: "示例企业" }]}
      />,
    );
    expect(typeof SideNav).toBe("function");
    expect(html).toContain('aria-label="主要区域"');
    expect(html).toContain("--wl-split-primary:65%");
    expect(switcherHtml).toContain("华东经营中心");
    expect(switcherHtml).toContain('label="示例企业"');
    expect(switcherHtml).not.toContain(">workspace-secret-id<");
  });

  it("浮层目录提供中文默认文案和完整可访问语义", () => {
    vi.stubGlobal("document", {});
    const html = renderToStaticMarkup(
      <OverlayManager toasts={<Toast tone="danger">请检查后重试</Toast>}>
        <Popover open onOpenChange={() => undefined} trigger="更多" title="可用操作"><button type="button">查看详情</button></Popover>
        <Tooltip content="查看完整证据"><button type="button">证据</button></Tooltip>
        <FullscreenSurface active={false} onActiveChange={() => undefined}><p>汇报内容</p></FullscreenSurface>
      </OverlayManager>,
    );
    const dialogHtml = renderToStaticMarkup(<Dialog open title="审批详情" onClose={() => undefined}>需要负责人确认</Dialog>);
    expect(html).toContain('aria-label="操作通知"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('role="tooltip"');
    expect(dialogHtml).toContain('aria-modal="true"');
    expect(html).toContain("进入全屏");
  });

  it("数据组件不依赖颜色单独表达，并为图表与表格提供读屏结构", () => {
    const rows = [{ id: "row-internal", name: "经营复盘", status: "等待确认" }];
    const html = renderToStaticMarkup(
      <>
        <Confidence value={82} description="依据已验证证据计算" />
        <Delta value={3.2} unit="%" goodWhen="up" />
        <FilterBar resultCount={1} onClear={() => undefined}><label>关键词<input /></label></FilterBar>
        <Table
          caption="任务清单"
          rows={rows}
          getRowId={(row) => row.id}
          columns={[
            { id: "name", header: "任务", cell: (row) => row.name },
            { id: "status", header: "状态", cell: (row) => row.status },
          ]}
        />
        <Timeline items={[{ id: "step-1", title: "分析完成", status: "已完成", time: "今天 09:30", dateTime: "2026-09-15T09:30:00+08:00", tone: "success" }]} />
        <Chart title="本周完成事项" description="按工作日统计" data={[{ id: "monday", label: "星期一", value: 12 }]} />
      </>,
    );
    for (const text of ["较高 · 82%", "上升", "共 1 条结果", "任务清单", "分析完成", "项目", "数值"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('data-label="状态"');
    expect(html).toContain('<meter');
    expect(html).toContain('<table');
  });

  it("导出对话框默认中文说明、原生单选和无格式禁用态", () => {
    vi.stubGlobal("document", {});
    const normal = renderToStaticMarkup(<ExportDialog open onClose={() => undefined} onExport={() => undefined} />);
    const empty = renderToStaticMarkup(<ExportDialog open formats={[]} onClose={() => undefined} onExport={() => undefined} />);
    expect(normal).toContain("请选择导出格式");
    expect(normal).toContain("Excel 工作簿");
    expect(normal).toContain('type="radio"');
    expect(empty).toContain("暂无可用的导出格式");
    expect(empty).toContain("disabled");
  });
});
